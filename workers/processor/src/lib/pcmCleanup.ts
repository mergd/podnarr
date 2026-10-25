import type { Env } from "../env";

const CLEANUP_JOBS_PER_RUN = 10;
const DELETE_BATCH_SIZE = 100;

export async function cleanupNarrationPcm(env: Env, jobId: string): Promise<number> {
  const job = await env.DB.prepare(
    `SELECT j.id, j.post_id, j.publication_id, p.audio_key
     FROM narration_jobs j JOIN posts p ON p.id = j.post_id
     WHERE j.id = ?1 AND j.status = 'succeeded' AND j.pcm_cleaned_at IS NULL
       AND j.completed_chunks = j.total_chunks
       AND p.status = 'ready' AND p.narration_job_id = j.id`
  ).bind(jobId).first<{ id: string; post_id: number; publication_id: number; audio_key: string | null }>();
  if (!job) return 0;

  await env.DB.prepare(
    "UPDATE narration_jobs SET pcm_cleanup_attempted_at = CURRENT_TIMESTAMP WHERE id = ?1"
  ).bind(jobId).run();
  if (job.audio_key !== `episodes/${job.publication_id}/${job.post_id}.mp3`) return 0;
  const audio = await env.AUDIO_BUCKET.head(job.audio_key);
  if (!audio || audio.size === 0) return 0;

  let afterIndex = -1;
  let deleted = 0;
  while (true) {
    const chunks = await env.DB.prepare(
      `SELECT chunk_index, r2_key FROM narration_chunks
       WHERE narration_job_id = ?1 AND chunk_index > ?2 ORDER BY chunk_index LIMIT ?3`
    ).bind(jobId, afterIndex, DELETE_BATCH_SIZE).all<{ chunk_index: number; r2_key: string }>();
    if (chunks.results.length === 0) break;
    const keys = chunks.results.map(chunk => {
      if (chunk.r2_key !== `narration-chunks/${jobId}/${chunk.chunk_index}.pcm`) {
        throw new Error(`Unexpected PCM key for narration ${jobId}`);
      }
      return chunk.r2_key;
    });
    // Retrying after a partial deletion is safe: R2 delete is idempotent.
    await env.AUDIO_BUCKET.delete(keys);
    deleted += keys.length;
    afterIndex = chunks.results[chunks.results.length - 1]!.chunk_index;
  }
  await env.DB.prepare(
    "UPDATE narration_jobs SET pcm_cleaned_at = CURRENT_TIMESTAMP WHERE id = ?1 AND status = 'succeeded'"
  ).bind(jobId).run();
  return deleted;
}

export async function tryCleanupNarrationPcm(env: Env, jobId: string): Promise<void> {
  try {
    await cleanupNarrationPcm(env, jobId);
  } catch (error) {
    // Cleanup failures must not send a completed narration back through assembly.
    console.warn("PCM cleanup deferred to scheduled retry", { jobId, error: String(error) });
  }
}

export async function cleanupCompletedNarrationPcm(env: Env): Promise<void> {
  const jobs = await env.DB.prepare(
    `SELECT j.id FROM narration_jobs j JOIN posts p ON p.id = j.post_id
     WHERE j.status = 'succeeded' AND j.pcm_cleaned_at IS NULL
       AND j.completed_chunks = j.total_chunks
       AND p.status = 'ready' AND p.narration_job_id = j.id
     ORDER BY j.pcm_cleanup_attempted_at, j.id LIMIT ?1`
  ).bind(CLEANUP_JOBS_PER_RUN).all<{ id: string }>();
  for (const job of jobs.results) await tryCleanupNarrationPcm(env, job.id);
}
