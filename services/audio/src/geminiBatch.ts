import { buildTtsGenerateContentRequest, parseAudioResponse } from "./geminiTts.js";
import { geminiJson } from "./geminiClient.js";
import type { ChunkDescriptor } from "./episodePlan.js";

export type GeminiBatchState =
  | "BATCH_STATE_PENDING"
  | "BATCH_STATE_RUNNING"
  | "BATCH_STATE_SUCCEEDED"
  | "BATCH_STATE_FAILED"
  | "BATCH_STATE_CANCELLED"
  | "BATCH_STATE_EXPIRED"
  | "JOB_STATE_PENDING"
  | "JOB_STATE_RUNNING"
  | "JOB_STATE_SUCCEEDED"
  | "JOB_STATE_FAILED"
  | "JOB_STATE_CANCELLED"
  | "JOB_STATE_EXPIRED";

export interface GeminiBatchStatus {
  name: string;
  state: GeminiBatchState | string;
  done: boolean;
  succeeded: boolean;
  failed: boolean;
  error: string | null;
  responses: Map<string, Buffer>;
  failedKeys: Map<string, string>;
}

function isTerminalBatchState(state: string): boolean {
  return /(?:BATCH|JOB)_STATE_(?:SUCCEEDED|FAILED|CANCELLED|EXPIRED)$/.test(state);
}

function isSuccessfulBatchState(state: string): boolean {
  return state === "BATCH_STATE_SUCCEEDED" || state === "JOB_STATE_SUCCEEDED";
}

function isFailedBatchState(state: string): boolean {
  return /(?:BATCH|JOB)_STATE_(?:FAILED|CANCELLED|EXPIRED)$/.test(state);
}

interface InlinedBatchEntry {
  metadata?: { key?: string };
  response?: unknown;
  error?: unknown;
}

function unwrapInlinedResponseList(value: unknown): InlinedBatchEntry[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const nested = (value as { inlinedResponses?: unknown }).inlinedResponses;
    if (Array.isArray(nested)) {
      return nested;
    }
  }

  return [];
}

function readInlineResponses(payload: Record<string, unknown>): Array<{ key: string; response?: unknown; error?: unknown }> {
  const batch = (payload.response ?? payload) as Record<string, unknown>;
  const output = batch.output as Record<string, unknown> | undefined;
  const dest = payload.dest as Record<string, unknown> | undefined;
  const inlineResponses = unwrapInlinedResponseList(
    output?.inlinedResponses ?? batch.inlinedResponses ?? dest?.inlinedResponses
  );

  return inlineResponses.map((entry, index) => ({
    key: entry.metadata?.key ?? String(index),
    response: entry.response,
    error: entry.error
  }));
}

export async function createGeminiTtsBatchJob(
  model: string,
  voice: string,
  chunks: ChunkDescriptor[],
  displayName: string
): Promise<string> {
  if (chunks.length === 0) {
    throw new Error("Cannot create a Gemini batch job with zero chunks.");
  }

  const payload = await geminiJson<{ name?: string; error?: { message?: string } }>(
    `models/${encodeURIComponent(model)}:batchGenerateContent`,
    {
      method: "POST",
      body: JSON.stringify({
        batch: {
          displayName,
          inputConfig: {
            requests: {
              requests: chunks.map((chunk) => ({
                request: buildTtsGenerateContentRequest(chunk.text, voice),
                metadata: { key: chunk.key }
              }))
            }
          }
        }
      })
    },
    { usageUnits: chunks.length }
  );

  if (!payload.name) {
    throw new Error(payload.error?.message ?? "Gemini batch create failed without a job name.");
  }

  return payload.name;
}

export async function getGeminiBatchStatus(batchName: string): Promise<GeminiBatchStatus> {
  const payload = await geminiJson<Record<string, unknown>>(batchName);
  const metadata = payload.metadata as { state?: string; error?: { message?: string } } | undefined;
  const state = metadata?.state ?? (payload.state as string | undefined) ?? "BATCH_STATE_PENDING";
  const done = Boolean(payload.done) || isTerminalBatchState(state);
  const succeeded = isSuccessfulBatchState(state);
  const failed = isFailedBatchState(state);
  const topLevelError = payload.error as { message?: string } | string | undefined;
  const error =
    typeof topLevelError === "string"
      ? topLevelError
      : topLevelError?.message ?? metadata?.error?.message ?? null;

  const responses = new Map<string, Buffer>();
  const failedKeys = new Map<string, string>();

  if (succeeded) {
    for (const entry of readInlineResponses(payload)) {
      if (entry.error) {
        failedKeys.set(entry.key, JSON.stringify(entry.error));
        continue;
      }

      try {
        responses.set(entry.key, parseAudioResponse(entry.response));
      } catch (error) {
        failedKeys.set(entry.key, error instanceof Error ? error.message : String(error));
      }
    }
  }

  return {
    name: (payload.name as string | undefined) ?? batchName,
    state,
    done,
    succeeded,
    failed,
    error,
    responses,
    failedKeys
  };
}
