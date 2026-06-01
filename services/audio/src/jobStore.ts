import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NarrationRequest, TtsProvider } from "@podnarr/shared/tts";

import type { ChunkDescriptor } from "./episodePlan.js";

export interface StoredJobRecord {
  provider: TtsProvider;
  model: string;
  voice: string;
  externalJobId: string;
  postId: number;
  status: "queued" | "running" | "succeeded" | "failed";
  estimatedAudioMinutes: number;
  estimatedCostUsd: number;
  audioPath: string | null;
  durationSeconds: number | null;
  error: string | null;
  geminiBatchJobName: string | null;
  chunkRetryCounts: Record<string, number>;
  body: NarrationRequest;
  chunks: ChunkDescriptor[];
}

export function jobManifestPath(renderDir: string, externalJobId: string): string {
  return path.join(renderDir, externalJobId, "job.json");
}

export function jobChunkDir(renderDir: string, externalJobId: string): string {
  return path.join(renderDir, externalJobId);
}

export async function saveStoredJob(renderDir: string, job: StoredJobRecord): Promise<void> {
  const chunkDir = jobChunkDir(renderDir, job.externalJobId);
  await mkdir(chunkDir, { recursive: true });
  await writeFile(jobManifestPath(renderDir, job.externalJobId), JSON.stringify(job, null, 2));
}

export async function loadStoredJob(renderDir: string, externalJobId: string): Promise<StoredJobRecord | null> {
  const manifestPath = jobManifestPath(renderDir, externalJobId);
  if (!existsSync(manifestPath)) {
    return null;
  }

  const raw = await readFile(manifestPath, "utf8");
  return JSON.parse(raw) as StoredJobRecord;
}

export function missingChunks(job: StoredJobRecord, renderDir: string): ChunkDescriptor[] {
  const chunkDir = jobChunkDir(renderDir, job.externalJobId);
  return job.chunks.filter((chunk) => !existsSync(path.join(chunkDir, chunk.fileName)));
}

export function allChunksPresent(job: StoredJobRecord, renderDir: string): boolean {
  return missingChunks(job, renderDir).length === 0;
}

export async function writeChunkPcm(renderDir: string, externalJobId: string, chunk: ChunkDescriptor, pcm: Buffer): Promise<void> {
  const chunkDir = jobChunkDir(renderDir, externalJobId);
  await mkdir(chunkDir, { recursive: true });
  await writeFile(path.join(chunkDir, chunk.fileName), pcm);
}

export function incrementChunkRetry(job: StoredJobRecord, chunkKey: string): number {
  const next = (job.chunkRetryCounts[chunkKey] ?? 0) + 1;
  job.chunkRetryCounts[chunkKey] = next;
  return next;
}

export const MAX_BATCH_CHUNK_ATTEMPTS = Number(process.env.GEMINI_BATCH_CHUNK_ATTEMPTS) || 3;
