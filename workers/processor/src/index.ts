import type { PostQueueMessage } from "@podnarr/shared/queue";
import { MAX_NARRATION_POLL_ATTEMPTS, MAX_SCRIPT_PREP_POLL_ATTEMPTS } from "@podnarr/shared/queue";
import {
  DEFAULT_TTS_CONFIG,
  type NarrationJobResponse,
  type NarrationPollResponse,
  type PrepareScriptJobResponse,
  type PrepareScriptPollResponse
} from "@podnarr/shared/tts";

import type { Env } from "./env";
import { buildNarrationScript, estimateAudioMinutes } from "./lib/script";

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

async function markJob(db: D1Database, id: string, status: string, error: string | null = null): Promise<void> {
  await db
    .prepare("UPDATE jobs SET status = ?2, last_error = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
    .bind(id, status, error)
    .run();
}

async function alertDiscord(env: Env, title: string, description: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description: description.slice(0, 3800),
            color: 0xd92d20,
            timestamp: new Date().toISOString()
          }
        ]
      })
    });
  } catch (error) {
    console.warn("Discord alert failed", error);
  }
}

async function fetchAudioService<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (env.AUDIO_SERVICE_TOKEN) {
    headers.set("authorization", `Bearer ${env.AUDIO_SERVICE_TOKEN}`);
  }
  const response = await fetch(`${env.AUDIO_SERVICE_URL}${path}`, { ...init, headers });
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    const snippet = raw.trim().slice(0, 200);
    if (/error code:\s*524/i.test(snippet)) {
      throw new Error("Audio service timed out (524)");
    }
    throw new Error(`Audio service returned non-JSON (${response.status}): ${snippet}`);
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Audio service failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function handleGenerate(env: Env, message: Extract<PostQueueMessage, { type: "post.generate" }>): Promise<void> {
  const post = await env.DB
    .prepare(
      `SELECT posts.*, publications.title AS publication_title
      FROM posts
      JOIN publications ON publications.id = posts.publication_id
      WHERE posts.id = ?1`
    )
    .bind(message.postId)
    .first<PostRow>();
  if (!post) {
    throw new Error(`Post ${message.postId} was not found.`);
  }

  const extractedScript = buildNarrationScript({
    title: post.title,
    author: post.author,
    textContent: post.text_content,
    visualMetadataJson: post.visual_metadata_json
  });
  const prepared = await fetchAudioService<PrepareScriptJobResponse>(env, "/v1/scripts/prepare", {
    method: "POST",
    body: JSON.stringify({ script: extractedScript })
  });

  const pollMessage: PostQueueMessage = {
    type: "post.poll_script_prep",
    jobId: crypto.randomUUID(),
    publicationId: message.publicationId,
    postId: message.postId,
    prepareJobId: prepared.externalJobId,
    enqueuedAt: new Date().toISOString(),
    attempt: 0
  };
  await env.PROCESSING_QUEUE.send(pollMessage, { delaySeconds: 10 });
}

async function handlePollScriptPrep(
  env: Env,
  message: Extract<PostQueueMessage, { type: "post.poll_script_prep" }>
): Promise<void> {
  const poll = await fetchAudioService<PrepareScriptPollResponse>(
    env,
    `/v1/scripts/prepare/${encodeURIComponent(message.prepareJobId)}`
  );

  if (poll.status === "failed") {
    const error = poll.error ?? "Script preparation failed";
    await env.DB
      .prepare("UPDATE posts SET status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
      .bind(message.postId, error)
      .run();
    await alertDiscord(env, "Podnarr script prep failed", `postId=${message.postId}\nprepareJobId=${message.prepareJobId}\n${error}`);
    return;
  }

  if (poll.status !== "succeeded" || !poll.script) {
    if (message.attempt >= MAX_SCRIPT_PREP_POLL_ATTEMPTS) {
      throw new Error("Script preparation polling exceeded retry limit.");
    }
    await env.PROCESSING_QUEUE.send({ ...message, jobId: crypto.randomUUID(), attempt: message.attempt + 1 }, { delaySeconds: 45 });
    return;
  }

  const post = await env.DB
    .prepare(
      `SELECT posts.*, publications.title AS publication_title
      FROM posts
      JOIN publications ON publications.id = posts.publication_id
      WHERE posts.id = ?1`
    )
    .bind(message.postId)
    .first<PostRow>();
  if (!post) {
    throw new Error(`Post ${message.postId} was not found.`);
  }

  const script = poll.script;
  const estimatedMinutes = estimateAudioMinutes(script);
  const provider = (post.tts_provider ?? env.DEFAULT_TTS_PROVIDER ?? DEFAULT_TTS_CONFIG.provider) as typeof DEFAULT_TTS_CONFIG.provider;
  const model = post.tts_model ?? env.DEFAULT_TTS_MODEL ?? DEFAULT_TTS_CONFIG.model;
  const voice = post.tts_voice ?? env.DEFAULT_TTS_VOICE ?? DEFAULT_TTS_CONFIG.voice;

  await env.DB
    .prepare(
      `UPDATE posts
      SET status = 'scripted', script = ?2, tts_provider = ?3, tts_model = ?4, tts_voice = ?5,
        estimated_cost_usd = ?6, processing_version = ?7, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?1`
    )
    .bind(message.postId, script, provider, model, voice, estimatedMinutes * DEFAULT_TTS_CONFIG.estimatedCostPerAudioMinuteUsd, env.PROCESSING_VERSION)
    .run();

  const narration = await fetchAudioService<NarrationJobResponse>(env, "/v1/narrations", {
    method: "POST",
    body: JSON.stringify({
      postId: message.postId,
      publicationTitle: post.publication_title,
      title: post.title,
      pubDate: post.pub_date,
      script,
      provider,
      model,
      voice
    })
  });

  await env.DB
    .prepare(
      `UPDATE posts
      SET status = 'narrating', narration_job_id = ?2, narration_job_status = ?3,
        estimated_cost_usd = ?4, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?1`
    )
    .bind(message.postId, narration.externalJobId, narration.status, narration.estimatedCostUsd)
    .run();

  const pollMessage: PostQueueMessage = {
    type: "post.poll_narration",
    jobId: crypto.randomUUID(),
    publicationId: message.publicationId,
    postId: message.postId,
    externalJobId: narration.externalJobId,
    enqueuedAt: new Date().toISOString(),
    attempt: 0
  };
  await env.PROCESSING_QUEUE.send(pollMessage, { delaySeconds: narration.status === "succeeded" ? 1 : 300 });
}

async function handlePoll(env: Env, message: Extract<PostQueueMessage, { type: "post.poll_narration" }>): Promise<void> {
  const poll = await fetchAudioService<NarrationPollResponse>(env, `/v1/narrations/${encodeURIComponent(message.externalJobId)}`);
  if (poll.status === "failed") {
    const existing = await env.DB
      .prepare("SELECT audio_key FROM posts WHERE id = ?1")
      .bind(message.postId)
      .first<{ audio_key: string | null }>();
    if (existing?.audio_key) {
      await env.DB
        .prepare(
          `UPDATE posts
          SET status = 'ready', narration_job_status = 'succeeded', last_error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?1`
        )
        .bind(message.postId)
        .run();
      return;
    }

    const error = poll.error ?? "Narration failed";
    await env.DB
      .prepare("UPDATE posts SET status = 'failed', narration_job_status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
      .bind(message.postId, error)
      .run();
    await alertDiscord(env, "Podnarr narration failed", `postId=${message.postId}\nexternalJobId=${message.externalJobId}\n${error}`);
    return;
  }

  if (poll.status !== "succeeded" || !poll.audioUrl) {
    if (message.attempt >= MAX_NARRATION_POLL_ATTEMPTS) {
      throw new Error("Narration polling exceeded retry limit.");
    }
    await env.DB
      .prepare("UPDATE posts SET narration_job_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
      .bind(message.postId, poll.status)
      .run();
    await env.PROCESSING_QUEUE.send({ ...message, jobId: crypto.randomUUID(), attempt: message.attempt + 1 }, { delaySeconds: 900 });
    return;
  }

  const audioResponse = await fetch(poll.audioUrl);
  if (!audioResponse.ok || !audioResponse.body) {
    throw new Error(`Could not download rendered audio: ${audioResponse.status}`);
  }

  const key = `episodes/${message.publicationId}/${message.postId}.mp3`;
  await env.AUDIO_BUCKET.put(key, audioResponse.body, {
    httpMetadata: {
      contentType: poll.audioContentType ?? "audio/mpeg",
      cacheControl: "public, max-age=31536000, immutable"
    }
  });
  await env.DB
    .prepare(
      `UPDATE posts
      SET status = 'ready', audio_key = ?2, duration_seconds = ?3, narration_job_status = 'succeeded',
        last_processed_at = ?4, last_error = NULL, updated_at = ?4
      WHERE id = ?1`
    )
    .bind(message.postId, key, poll.durationSeconds, new Date().toISOString())
    .run();
}

async function handleMessage(env: Env, message: PostQueueMessage): Promise<void> {
  if (message.type === "post.generate") {
    await handleGenerate(env, message);
  } else if (message.type === "post.poll_script_prep") {
    await handlePollScriptPrep(env, message);
  } else {
    await handlePoll(env, message);
  }
}

export default {
  async queue(batch: MessageBatch<PostQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleMessage(env, message.body);
        await markJob(env.DB, message.body.jobId, "complete");
        message.ack();
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await markJob(env.DB, message.body.jobId, "failed", messageText);
        const shouldFailPost =
          message.body.type === "post.generate" ||
          (message.body.type === "post.poll_script_prep" && message.body.attempt >= MAX_SCRIPT_PREP_POLL_ATTEMPTS) ||
          (message.body.type === "post.poll_narration" && message.body.attempt >= MAX_NARRATION_POLL_ATTEMPTS);
        if (shouldFailPost) {
          await env.DB
            .prepare("UPDATE posts SET status = 'failed', last_error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1")
            .bind(message.body.postId, messageText)
            .run();
          await alertDiscord(
            env,
            "Podnarr processing failed",
            `postId=${message.body.postId}\njobId=${message.body.jobId}\ntype=${message.body.type}\n${messageText}`
          );
        }
        message.retry();
      }
    }
  }
};
