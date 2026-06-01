import path from "node:path";

import { createGeminiTtsBatchJob, getGeminiBatchStatus } from "./geminiBatch.js";
import { assembleEpisodeMp3 } from "./episodeAssembly.js";
import { buildEpisodeChunks } from "./episodePlan.js";
import { generateGeminiPcm } from "./geminiTts.js";
import {
  allChunksPresent,
  incrementChunkRetry,
  jobChunkDir,
  loadStoredJob,
  MAX_BATCH_CHUNK_ATTEMPTS,
  missingChunks,
  saveStoredJob,
  writeChunkPcm,
  type StoredJobRecord
} from "./jobStore.js";

export async function advanceGeminiBatchJob(
  renderDir: string,
  job: StoredJobRecord,
  introJinglePath: string,
  outroJinglePath: string
): Promise<void> {
  if (job.status === "succeeded" || job.status === "failed") {
    return;
  }

  job.status = "running";

  if (job.geminiBatchJobName) {
    const batch = await getGeminiBatchStatus(job.geminiBatchJobName);
    if (!batch.done) {
      await saveStoredJob(renderDir, job);
      return;
    }

    if (batch.failed) {
      job.geminiBatchJobName = null;
      for (const chunk of missingChunks(job, renderDir)) {
        incrementChunkRetry(job, chunk.key);
      }

      const remaining = missingChunks(job, renderDir);
      const exhausted = remaining.filter((chunk) => (job.chunkRetryCounts[chunk.key] ?? 0) >= MAX_BATCH_CHUNK_ATTEMPTS);
      if (remaining.length > 0 && exhausted.length === remaining.length) {
        job.error = batch.error ?? `Gemini batch failed with state ${batch.state}`;
        job.status = "failed";
        await saveStoredJob(renderDir, job);
        return;
      }

      await saveStoredJob(renderDir, job);
      return;
    }

    for (const chunk of job.chunks) {
      const pcm = batch.responses.get(chunk.key);
      if (pcm) {
        await writeChunkPcm(renderDir, job.externalJobId, chunk, pcm);
        continue;
      }

      if (batch.failedKeys.has(chunk.key)) {
        incrementChunkRetry(job, chunk.key);
      }
    }

    job.geminiBatchJobName = null;
    await saveStoredJob(renderDir, job);
  }

  const stillMissing = missingChunks(job, renderDir);
  if (stillMissing.length > 0) {
    const batchCandidates = stillMissing.filter((chunk) => (job.chunkRetryCounts[chunk.key] ?? 0) < MAX_BATCH_CHUNK_ATTEMPTS);
    const fallbackCandidates = stillMissing.filter((chunk) => (job.chunkRetryCounts[chunk.key] ?? 0) >= MAX_BATCH_CHUNK_ATTEMPTS);

    for (const chunk of fallbackCandidates) {
      const pcm = await generateGeminiPcm(job.model, job.voice, chunk.text, `${chunk.label}-standard-fallback`);
      await writeChunkPcm(renderDir, job.externalJobId, chunk, pcm);
    }

    if (batchCandidates.length > 0) {
      job.geminiBatchJobName = await createGeminiTtsBatchJob(
        job.model,
        job.voice,
        batchCandidates,
        `podnarr-${job.postId}-${job.externalJobId.slice(0, 8)}`
      );
      await saveStoredJob(renderDir, job);
      return;
    }
  }

  if (!allChunksPresent(job, renderDir)) {
    job.error = "Gemini batch finished but narration chunks are still missing.";
    job.status = "failed";
    await saveStoredJob(renderDir, job);
    return;
  }

  const mp3Path = path.join(renderDir, `${job.externalJobId}.mp3`);

  const assembled = await assembleEpisodeMp3({
    body: job.body,
    chunkDir: jobChunkDir(renderDir, job.externalJobId),
    chunks: job.chunks,
    introJinglePath,
    outroJinglePath,
    outputPath: mp3Path
  });

  job.audioPath = mp3Path;
  job.durationSeconds = assembled.durationSeconds;
  job.status = "succeeded";
  job.error = null;
  await saveStoredJob(renderDir, job);
}

export async function hydrateStoredJob(renderDir: string, externalJobId: string): Promise<StoredJobRecord | null> {
  return loadStoredJob(renderDir, externalJobId);
}

export function createStoredJob(input: {
  provider: StoredJobRecord["provider"];
  model: string;
  voice: string;
  externalJobId: string;
  postId: number;
  estimatedAudioMinutes: number;
  estimatedCostUsd: number;
  body: StoredJobRecord["body"];
  sitePlug: string;
}): StoredJobRecord {
  return {
    provider: input.provider,
    model: input.model,
    voice: input.voice,
    externalJobId: input.externalJobId,
    postId: input.postId,
    status: "queued",
    estimatedAudioMinutes: input.estimatedAudioMinutes,
    estimatedCostUsd: input.estimatedCostUsd,
    audioPath: null,
    durationSeconds: null,
    error: null,
    geminiBatchJobName: null,
    chunkRetryCounts: {},
    body: input.body,
    chunks: buildEpisodeChunks(input.body, input.sitePlug)
  };
}
