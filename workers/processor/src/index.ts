import { getContainer } from "@cloudflare/containers";

import { buildNarrationChunks } from "@podnarr/shared/narration";
import type { PostQueueMessage } from "@podnarr/shared/queue";
import {
  MAX_NARRATION_ASSEMBLY_ATTEMPTS,
  MAX_NARRATION_CHUNK_ATTEMPTS
} from "@podnarr/shared/queue";
import { DEFAULT_TTS_CONFIG, resolveActiveTtsConfig, type NarrationRequest, type TtsProvider } from "@podnarr/shared/tts";

import { audioServiceEnvVars, AudioServiceContainer } from "./audioContainer";
import type { Env } from "./env";
import { buildNarrationScript, estimateAudioMinutes } from "./lib/script";

export { AudioServiceContainer };

type NarrationStatus = "queued" | "running" | "assembling" | "succeeded" | "failed";

interface PostRow {
  id: number;
  publication_id: number;
  publication_title: string;
  title: string;
  author: string | null;
  pub_date: string | null;
  text_content: string | null;
  visual_metadata_json: string;
  tts_provider: string | null;
  tts_model: string | null;
  tts_voice: string | null;
}

interface NarrationJobRow {
  id: string;
  post_id: number;
  publication_id: number;
  provider: TtsProvider;
  model: string;
  voice: string;
  status: NarrationStatus;
  total_chunks: number;
  completed_chunks: number;
  assembly_attempts: number;
  last_error: string | null;
}

interface NarrationChunkRow {
  narration_job_id: string;
  chunk_index: number;
  chunk_key: string;
  label: string;
  text: string;
  r2_key: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
}

function backoffSeconds(attempt: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
}

async function markJob(db: D1Database, id: string, status: string, error: string | null = null): Promise<void> {
  await db
    .prepare("UPDATE jobs SET status = ?2, last_error = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
    .bind(id, status, error)
    .run();
}

async function alertDiscord(env: Env, title: string, description: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [{ title, description: description.slice(0, 3800), color: 0xd92d20, timestamp: new Date().toISOString() }]
      })
    });
  } catch (error) {
    console.warn("Discord alert failed", error);
  }
}

async function audioServiceRequest(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (env.AUDIO_SERVICE_TOKEN) headers.set("authorization", `Bearer ${env.AUDIO_SERVICE_TOKEN}`);
  const container = getContainer(env.AUDIO_SERVICE);
  await container.startAndWaitForPorts({
    startOptions: { envVars: audioServiceEnvVars(env) }
  });
  return container.fetch(new Request(`http://audio-service${path}`, { ...init, headers }));
}

async function fetchAudioService<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await audioServiceRequest(env, path, init);
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Audio service returned non-JSON (${response.status}): ${raw.trim().slice(0, 200)}`);
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Audio service failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function loadPost(env: Env, postId: number): Promise<PostRow> {
  const post = await env.DB
    .prepare(
      `SELECT posts.*, publications.title AS publication_title
       FROM posts JOIN publications ON publications.id = posts.publication_id
       WHERE posts.id = ?1`
    )
    .bind(postId)
    .first<PostRow>();
  if (!post) throw new Error(`Post ${postId} was not found.`);
  return post;
}

async function loadNarrationJob(env: Env, narrationJobId: string): Promise<NarrationJobRow | null> {
  return env.DB.prepare("SELECT * FROM narration_jobs WHERE id = ?1").bind(narrationJobId).first<NarrationJobRow>();
}

async function createNarrationJob(env: Env, post: PostRow, script: string): Promise<NarrationJobRow> {
  const existing = await env.DB
    .prepare("SELECT * FROM narration_jobs WHERE post_id = ?1")
    .bind(post.id)
    .first<NarrationJobRow>();
  if (existing && existing.status !== "failed") return existing;
  if (existing) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM narration_chunks WHERE narration_job_id = ?1").bind(existing.id),
      env.DB.prepare("DELETE FROM narration_jobs WHERE id = ?1").bind(existing.id)
    ]);
  }

  const tts = resolveActiveTtsConfig(
    {
      provider: post.tts_provider as TtsProvider | null,
      model: post.tts_model,
      voice: post.tts_voice
    },
    {
      provider: env.DEFAULT_TTS_PROVIDER ?? DEFAULT_TTS_CONFIG.provider,
      model: env.DEFAULT_TTS_MODEL ?? DEFAULT_TTS_CONFIG.model,
      voice: env.DEFAULT_TTS_VOICE ?? DEFAULT_TTS_CONFIG.voice,
      estimatedCostPerAudioMinuteUsd: 0
    }
  );
  const { provider, model, voice } = tts;
  const body: NarrationRequest = {
    postId: post.id,
    publicationTitle: post.publication_title,
    title: post.title,
    pubDate: post.pub_date,
    script,
    provider,
    model,
    voice
  };
  const jobId = crypto.randomUUID();
  const chunks = buildNarrationChunks(body, env.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com");
  const estimatedCost = provider === "fish_audio" ? 0 : estimateAudioMinutes(script) * DEFAULT_TTS_CONFIG.estimatedCostPerAudioMinuteUsd;
  const statements = [
    env.DB
      .prepare(
        `INSERT INTO narration_jobs
          (id, post_id, publication_id, provider, model, voice, status, total_chunks, completed_chunks, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, 0, CURRENT_TIMESTAMP)`
      )
      .bind(jobId, post.id, post.publication_id, provider, model, voice, chunks.length),
    env.DB
      .prepare(
        `UPDATE posts
         SET status = 'narrating', script = ?2, narration_job_id = ?3, narration_job_status = 'queued',
             estimated_cost_usd = ?4, processing_version = ?5, last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1`
      )
      .bind(post.id, script, jobId, estimatedCost, env.PROCESSING_VERSION),
    ...chunks.map((chunk) =>
      env.DB
        .prepare(
          `INSERT INTO narration_chunks (narration_job_id, chunk_index, chunk_key, label, text, r2_key)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(jobId, chunk.index, chunk.key, chunk.label, chunk.text, `narration-chunks/${jobId}/${chunk.index}.pcm`)
    )
  ];
  await env.DB.batch(statements);
  return {
    id: jobId,
    post_id: post.id,
    publication_id: post.publication_id,
    provider,
    model,
    voice,
    status: "queued",
    total_chunks: chunks.length,
    completed_chunks: 0,
    assembly_attempts: 0,
    last_error: null
  };
}

async function enqueueIncompleteChunks(env: Env, job: NarrationJobRow): Promise<void> {
  const chunks = await env.DB
    .prepare("SELECT * FROM narration_chunks WHERE narration_job_id = ?1 AND status != 'succeeded' ORDER BY chunk_index")
    .bind(job.id)
    .all<NarrationChunkRow>();
  await Promise.all(
    chunks.results.map((chunk) =>
      env.PROCESSING_QUEUE.send({
        type: "narration.render_chunk",
        jobId: crypto.randomUUID(),
        publicationId: job.publication_id,
        postId: job.post_id,
        narrationJobId: job.id,
        chunkIndex: chunk.chunk_index,
        enqueuedAt: new Date().toISOString(),
        attempt: chunk.attempts
      })
    )
  );
}

async function handleGenerate(env: Env, message: Extract<PostQueueMessage, { type: "post.generate" }>): Promise<void> {
  const post = await loadPost(env, message.postId);
  const existing = await env.DB.prepare("SELECT * FROM narration_jobs WHERE post_id = ?1").bind(post.id).first<NarrationJobRow>();
  if (existing && existing.status !== "failed") {
    await enqueueIncompleteChunks(env, existing);
    return;
  }

  const sourceScript = buildNarrationScript({
    title: post.title,
    author: post.author,
    textContent: post.text_content,
    visualMetadataJson: post.visual_metadata_json
  });
  const prepared = await fetchAudioService<{ script: string }>(env, "/v1/scripts/prepare", {
    method: "POST",
    body: JSON.stringify({ script: sourceScript })
  });
  if (!prepared.script) throw new Error("Audio service returned an empty narration script.");
  const job = await createNarrationJob(env, post, prepared.script);
  await enqueueIncompleteChunks(env, job);
}

async function retryChunkOrFail(
  env: Env,
  message: Extract<PostQueueMessage, { type: "narration.render_chunk" }>,
  chunk: NarrationChunkRow,
  error: unknown
): Promise<void> {
  const messageText = error instanceof Error ? error.message : String(error);
  const nextAttempt = chunk.attempts + 1;
  if (nextAttempt >= MAX_NARRATION_CHUNK_ATTEMPTS) {
    await env.DB.batch([
      env.DB
        .prepare("UPDATE narration_chunks SET status = 'failed', attempts = ?3, last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE narration_job_id = ?1 AND chunk_index = ?4")
        .bind(message.narrationJobId, messageText, nextAttempt, message.chunkIndex),
      env.DB
        .prepare("UPDATE narration_jobs SET status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
        .bind(message.narrationJobId, messageText),
      env.DB
        .prepare("UPDATE posts SET status = 'failed', narration_job_status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
        .bind(message.postId, `Narration chunk ${chunk.label} failed: ${messageText}`)
    ]);
    await alertDiscord(env, "Podnarr narration chunk failed", `postId=${message.postId}\njob=${message.narrationJobId}\nchunk=${chunk.label}\n${messageText}`);
    return;
  }

  await env.DB
    .prepare("UPDATE narration_chunks SET status = 'queued', attempts = ?3, last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE narration_job_id = ?1 AND chunk_index = ?4")
    .bind(message.narrationJobId, messageText, nextAttempt, message.chunkIndex)
    .run();
  await env.PROCESSING_QUEUE.send(
    { ...message, jobId: crypto.randomUUID(), attempt: nextAttempt, enqueuedAt: new Date().toISOString() },
    { delaySeconds: backoffSeconds(nextAttempt) }
  );
}

async function enqueueAssembly(env: Env, job: NarrationJobRow, attempt = 0): Promise<void> {
  await env.PROCESSING_QUEUE.send({
    type: "narration.assemble",
    jobId: crypto.randomUUID(),
    publicationId: job.publication_id,
    postId: job.post_id,
    narrationJobId: job.id,
    enqueuedAt: new Date().toISOString(),
    attempt
  });
}

async function handleRenderChunk(
  env: Env,
  message: Extract<PostQueueMessage, { type: "narration.render_chunk" }>
): Promise<void> {
  const job = await loadNarrationJob(env, message.narrationJobId);
  if (!job || job.status === "succeeded" || job.status === "failed") return;
  const chunk = await env.DB
    .prepare("SELECT * FROM narration_chunks WHERE narration_job_id = ?1 AND chunk_index = ?2")
    .bind(message.narrationJobId, message.chunkIndex)
    .first<NarrationChunkRow>();
  if (!chunk || chunk.status === "succeeded") return;

  await env.DB.batch([
    env.DB
      .prepare("UPDATE narration_chunks SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE narration_job_id = ?1 AND chunk_index = ?2")
      .bind(job.id, chunk.chunk_index),
    env.DB
      .prepare("UPDATE narration_jobs SET status = 'running', last_progress_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
      .bind(job.id)
  ]);

  try {
    const response = await audioServiceRequest(env, "/v1/tts/chunk", {
      method: "POST",
      body: JSON.stringify({ provider: job.provider, model: job.model, voice: job.voice, text: chunk.text })
    });
    if (!response.ok || !response.body) throw new Error(`TTS chunk request failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const pcm = await response.arrayBuffer();
    if (pcm.byteLength === 0) throw new Error("TTS chunk request returned empty audio.");
    await env.AUDIO_BUCKET.put(chunk.r2_key, pcm, {
      httpMetadata: { contentType: "application/x-podnarr-pcm" }
    });
    const providerUsed = response.headers.get("x-podnarr-provider") ?? job.provider;
    await env.DB.batch([
      env.DB
        .prepare("UPDATE narration_chunks SET status = 'succeeded', provider_used = ?3, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE narration_job_id = ?1 AND chunk_index = ?2")
        .bind(job.id, chunk.chunk_index, providerUsed),
      env.DB
        .prepare(
          `UPDATE narration_jobs
           SET completed_chunks = (SELECT COUNT(*) FROM narration_chunks WHERE narration_job_id = ?1 AND status = 'succeeded'),
               status = 'running', last_error = NULL, last_progress_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?1`
        )
        .bind(job.id),
      env.DB
        .prepare("UPDATE posts SET narration_job_status = 'running', last_error = NULL WHERE id = ?1")
        .bind(job.post_id)
    ]);
    const refreshed = await loadNarrationJob(env, job.id);
    if (refreshed && refreshed.completed_chunks === refreshed.total_chunks) await enqueueAssembly(env, refreshed);
  } catch (error) {
    await retryChunkOrFail(env, message, chunk, error);
  }
}

function r2PcmStream(env: Env, chunks: NarrationChunkRow[]): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (!reader) {
          const chunk = chunks[index++];
          if (!chunk) return controller.close();
          const object = await env.AUDIO_BUCKET.get(chunk.r2_key);
          if (!object?.body) throw new Error(`Durable narration chunk is missing: ${chunk.r2_key}`);
          reader = object.body.getReader();
        }
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          reader = null;
          continue;
        }
        controller.enqueue(next.value);
        return;
      }
    }
  });
}

async function retryAssemblyOrFail(
  env: Env,
  message: Extract<PostQueueMessage, { type: "narration.assemble" }>,
  job: NarrationJobRow,
  error: unknown
): Promise<void> {
  const messageText = error instanceof Error ? error.message : String(error);
  const nextAttempt = job.assembly_attempts + 1;
  if (nextAttempt >= MAX_NARRATION_ASSEMBLY_ATTEMPTS) {
    await env.DB.batch([
      env.DB.prepare("UPDATE narration_jobs SET status = 'failed', assembly_attempts = ?2, last_error = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?1").bind(job.id, nextAttempt, messageText),
      env.DB.prepare("UPDATE posts SET status = 'failed', narration_job_status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1").bind(job.post_id, `Narration assembly failed: ${messageText}`)
    ]);
    await alertDiscord(env, "Podnarr narration assembly failed", `postId=${job.post_id}\njob=${job.id}\n${messageText}`);
    return;
  }
  await env.DB
    .prepare("UPDATE narration_jobs SET status = 'running', assembly_attempts = ?2, last_error = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
    .bind(job.id, nextAttempt, messageText)
    .run();
  await env.PROCESSING_QUEUE.send(
    { ...message, jobId: crypto.randomUUID(), attempt: nextAttempt, enqueuedAt: new Date().toISOString() },
    { delaySeconds: backoffSeconds(nextAttempt) }
  );
}

async function handleAssemble(env: Env, message: Extract<PostQueueMessage, { type: "narration.assemble" }>): Promise<void> {
  const job = await loadNarrationJob(env, message.narrationJobId);
  if (!job || job.status === "succeeded" || job.status === "failed") return;
  if (job.completed_chunks !== job.total_chunks) {
    await enqueueIncompleteChunks(env, job);
    return;
  }
  const post = await loadPost(env, job.post_id);
  const chunks = await env.DB
    .prepare("SELECT * FROM narration_chunks WHERE narration_job_id = ?1 ORDER BY chunk_index")
    .bind(job.id)
    .all<NarrationChunkRow>();
  if (chunks.results.length !== job.total_chunks || chunks.results.some((chunk) => chunk.status !== "succeeded")) {
    throw new Error("Cannot assemble while narration chunks are incomplete.");
  }

  await env.DB.prepare("UPDATE narration_jobs SET status = 'assembling', updated_at = CURRENT_TIMESTAMP WHERE id = ?1").bind(job.id).run();
  try {
    const response = await audioServiceRequest(env, "/v1/episodes/assemble", {
      method: "POST",
      headers: {
        "content-type": "application/x-podnarr-pcm",
        "x-podnarr-metadata": JSON.stringify({ title: post.title, publicationTitle: post.publication_title })
      },
      body: r2PcmStream(env, chunks.results)
    });
    if (!response.ok || !response.body) throw new Error(`Episode assembly failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const mp3 = await response.arrayBuffer();
    if (mp3.byteLength === 0) throw new Error("Episode assembly returned empty audio.");
    const key = `episodes/${job.publication_id}/${job.post_id}.mp3`;
    await env.AUDIO_BUCKET.put(key, mp3, {
      httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" }
    });
    const durationSeconds = Number(response.headers.get("x-podnarr-duration-seconds")) || null;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE narration_jobs SET status = 'succeeded', last_error = NULL, last_progress_at = ?2, updated_at = ?2 WHERE id = ?1").bind(job.id, now),
      env.DB
        .prepare(
          `UPDATE posts SET status = 'ready', audio_key = ?2, duration_seconds = ?3, narration_job_status = 'succeeded',
           last_processed_at = ?4, last_error = NULL, updated_at = ?4 WHERE id = ?1`
        )
        .bind(job.post_id, key, durationSeconds, now)
    ]);
  } catch (error) {
    await retryAssemblyOrFail(env, message, job, error);
  }
}

async function recoverStaleNarrations(env: Env): Promise<void> {
  const jobs = await env.DB
    .prepare("SELECT * FROM narration_jobs WHERE status IN ('queued', 'running', 'assembling') AND last_progress_at < datetime('now', '-20 minutes')")
    .all<NarrationJobRow>();
  for (const job of jobs.results) {
    await env.DB.batch([
      env.DB.prepare("UPDATE narration_chunks SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE narration_job_id = ?1 AND status = 'running'").bind(job.id),
      env.DB.prepare("UPDATE narration_jobs SET status = 'running', last_error = 'Recovered by stale-job watchdog', last_progress_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1").bind(job.id)
    ]);
    if (job.completed_chunks === job.total_chunks) await enqueueAssembly(env, job, job.assembly_attempts);
    else await enqueueIncompleteChunks(env, job);
  }

  await env.DB
    .prepare(
      `UPDATE posts
       SET status = 'failed', narration_job_status = 'failed',
           last_error = 'Narration state was lost before durable recovery was deployed. Requeue this post to render it again.',
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'narrating' AND narration_job_id IS NOT NULL
         AND id NOT IN (SELECT post_id FROM narration_jobs)
         AND last_processed_at IS NULL`
    )
    .run();
}

async function handleMessage(env: Env, message: PostQueueMessage): Promise<void> {
  if (message.type === "post.generate") return handleGenerate(env, message);
  if (message.type === "narration.render_chunk") return handleRenderChunk(env, message);
  if (message.type === "narration.assemble") return handleAssemble(env, message);
  // Legacy poll messages cannot be resumed safely because their container-only
  // state predates durable narration. The watchdog makes these posts visible.
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/health") return new Response("Not found", { status: 404 });
    if (env.AUDIO_SERVICE_TOKEN && request.headers.get("authorization") !== `Bearer ${env.AUDIO_SERVICE_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    return audioServiceRequest(env, "/health");
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await recoverStaleNarrations(env);
  },

  async queue(batch: MessageBatch<PostQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleMessage(env, message.body);
        await markJob(env.DB, message.body.jobId, "complete");
        message.ack();
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await markJob(env.DB, message.body.jobId, "failed", messageText);
        if (message.body.type === "post.generate") {
          await env.DB.prepare("UPDATE posts SET status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1").bind(message.body.postId, messageText).run();
          await alertDiscord(env, "Podnarr processing failed", `postId=${message.body.postId}\n${messageText}`);
        }
        message.retry();
      }
    }
  }
};
