import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import Fastify from "fastify";
import type {
  NarrationJobResponse,
  NarrationPollResponse,
  NarrationRequest,
  PrepareScriptRequest,
  PrepareScriptResponse,
  TtsProvider
} from "@podnarr/shared/tts";
import { DEFAULT_TTS_CONFIG } from "@podnarr/shared/tts";

import { assembleEpisodeMp3 } from "./episodeAssembly.js";
import { advanceGeminiBatchJob, createStoredJob, hydrateStoredJob } from "./geminiBatchRender.js";
import { getGeminiUsageSnapshot, geminiJson, isGeminiDailyBudgetExhausted } from "./geminiClient.js";
import { generateGeminiPcm } from "./geminiTts.js";
import {
  jobChunkDir,
  loadStoredJob,
  saveStoredJob,
  writeChunkPcm,
  type StoredJobRecord
} from "./jobStore.js";

const PORT = Number(process.env.PORT) || 8000;
const SERVICE_TOKEN = process.env.AUDIO_SERVICE_TOKEN ?? "";
const PUBLIC_BASE_URL = process.env.PUBLIC_AUDIO_SERVICE_URL ?? `http://localhost:${PORT}`;
const RENDER_DIR = process.env.RENDER_DIR ?? path.join(tmpdir(), "podnarr-audio");
const ENABLE_MOCK_RENDERER = process.env.ENABLE_MOCK_RENDERER !== "false";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const GEMINI_SCRIPT_MODEL = process.env.GEMINI_SCRIPT_MODEL ?? "gemini-3-flash-preview";
const SITE_PLUG = process.env.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com";
const JINGLE_DIR = path.join(RENDER_DIR, "assets");
const INTRO_JINGLE_PATH = path.join(JINGLE_DIR, "intro-jingle-v7.mp3");
const OUTRO_JINGLE_PATH = path.join(JINGLE_DIR, "outro-jingle-broadcast-sparkle-v1.mp3");
const OUTRO_CHIME_SAMPLE_RATE = 44_100;
const OUTRO_CHIME_EVENTS = [
  { frequency: 293.66, start: 0, length: 1.15, amplitude: 0.17, decay: 0.7, release: 0.34, harmonics: [1, 0.22, 0.08] },
  { frequency: 440, start: 0.22, length: 1.12, amplitude: 0.15, decay: 0.68, release: 0.32, harmonics: [1, 0.2, 0.07] },
  { frequency: 587.33, start: 0.48, length: 1.15, amplitude: 0.17, decay: 0.74, release: 0.36, harmonics: [1, 0.17, 0.05] },
  { frequency: 880, start: 0.84, length: 1.7, amplitude: 0.11, decay: 0.95, release: 0.52, harmonics: [1, 0.1, 0.03] },
  { frequency: 146.83, start: 0, length: 2.7, amplitude: 0.08, attack: 0.06, decay: 1.35, release: 0.55, harmonics: [1, 0.16] }
] as const;
const GENERIC_IMAGE_DESCRIPTIONS = [
  /image appears here/i,
  /there is an image/i,
  /an image is shown/i,
  /the image (?:shows|depicts) an image/i,
  /^in the image,\s*(?:an? )?image/i
];

const jobs = new Map<string, StoredJobRecord>();
const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });

function isAuthorized(authHeader: string | undefined): boolean {
  return !SERVICE_TOKEN || authHeader === `Bearer ${SERVICE_TOKEN}`;
}

function estimateAudioMinutes(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.25, words / 155);
}

function costPerMinute(provider: TtsProvider, model: string): number {
  if (provider === "gemini_batch") return 0.015;
  if (provider === "gemini_standard") return 0.03;
  if (provider === "elevenlabs" && model.includes("turbo")) return 0.05;
  if (provider === "inworld" && model.includes("mini")) return 0.025;
  if (provider === "inworld") return 0.035;
  if (provider === "minimax" && model.includes("turbo")) return 0.06;
  if (provider === "minimax") return 0.1;
  if (provider === "openai") return 0.015;
  return DEFAULT_TTS_CONFIG.estimatedCostPerAudioMinuteUsd;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with ${code}`));
      }
    });
  });
}

function parseTextResponse(payload: unknown): string {
  const root = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return root.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("").trim() ?? "";
}

function chimeEnvelope(
  time: number,
  start: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
  length: number
): number {
  const localTime = time - start;
  if (localTime < 0 || localTime > length) {
    return 0;
  }
  if (localTime < attack) {
    return localTime / Math.max(attack, 0.001);
  }
  if (localTime < length - release) {
    return sustain + (1 - sustain) * Math.exp(-(localTime - attack) / Math.max(decay, 0.001));
  }
  const tailStart = Math.max(attack, length - release);
  const tailLevel = sustain + (1 - sustain) * Math.exp(-(tailStart - attack) / Math.max(decay, 0.001));
  return tailLevel * Math.max(0, 1 - (localTime - tailStart) / Math.max(release, 0.001));
}

function chimeTone(
  time: number,
  event: {
    frequency: number;
    start: number;
    length: number;
    amplitude: number;
    attack?: number;
    decay: number;
    sustain?: number;
    release: number;
    harmonics: readonly number[];
  }
): number {
  const attack = event.attack ?? 0.012;
  const sustain = event.sustain ?? 0;
  const envelope = chimeEnvelope(time, event.start, attack, event.decay, sustain, event.release, event.length);
  if (envelope <= 0) {
    return 0;
  }

  const localTime = time - event.start;
  const harmonicValue = event.harmonics.reduce(
    (sum, weight, index) => sum + weight * Math.sin(2 * Math.PI * event.frequency * (index + 1) * localTime),
    0
  );
  return event.amplitude * envelope * harmonicValue;
}

function softClip(sample: number): number {
  return Math.tanh(1.4 * sample) / Math.tanh(1.4);
}

function buildBroadcastSparklePcm(): Buffer {
  const durationSeconds = 3.45;
  const sampleCount = Math.floor(durationSeconds * OUTRO_CHIME_SAMPLE_RATE);
  const dry = new Float64Array(sampleCount);
  const wet = new Float64Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / OUTRO_CHIME_SAMPLE_RATE;
    let sample = 0.012 * Math.sin(2 * Math.PI * 15 * time) * Math.exp(-Math.max(0, time - 0.5) / 2.5);
    for (const event of OUTRO_CHIME_EVENTS) {
      sample += chimeTone(time, event);
    }
    dry[index] = softClip(sample);
    wet[index] = dry[index];
  }

  for (const [delaySeconds, gain] of [
    [0.055, 0.2],
    [0.118, 0.11],
    [0.205, 0.064]
  ] as const) {
    const delay = Math.floor(delaySeconds * OUTRO_CHIME_SAMPLE_RATE);
    for (let index = delay; index < sampleCount; index += 1) {
      wet[index] += dry[index - delay] * gain;
    }
  }

  const fadeInSamples = Math.floor(0.025 * OUTRO_CHIME_SAMPLE_RATE);
  const fadeOutSamples = Math.floor(0.38 * OUTRO_CHIME_SAMPLE_RATE);
  for (let index = 0; index < Math.min(fadeInSamples, sampleCount); index += 1) {
    wet[index] *= index / fadeInSamples;
  }
  for (let index = Math.max(0, sampleCount - fadeOutSamples); index < sampleCount; index += 1) {
    wet[index] *= (sampleCount - index) / fadeOutSamples;
  }

  let peak = 0.01;
  for (const sample of wet) {
    peak = Math.max(peak, Math.abs(sample));
  }
  const scale = 0.92 / peak;
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, wet[index] * scale));
    buffer.writeInt16LE(Math.round(sample * 32_767), index * 2);
  }
  return buffer;
}

function markerAttr(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}="((?:\\\\.|[^"])*)"`, "i").exec(attrs);
  return match?.[1]?.replace(/\\"/g, "\"").replace(/\\\\/g, "\\") ?? null;
}

async function describeImage(src: string): Promise<string | null> {
  try {
    const image = await fetch(src);
    if (!image.ok) {
      throw new Error(`image fetch failed with ${image.status}`);
    }
    const mimeType = image.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const data = Buffer.from(await image.arrayBuffer()).toString("base64");
    const payload = await geminiJson<unknown>(`models/${encodeURIComponent(GEMINI_SCRIPT_MODEL)}:generateContent`, {
      method: "POST",
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  [
                    "You are describing the actual pixels of an article image for a podcast listener.",
                    "Return one concise spoken sentence that says what the image, chart, table, or screenshot visibly contains.",
                    "If it is a chart, mention the visible axes, labels, trend, or comparison when legible.",
                    "Do not say 'Visual:', 'image appears here', 'an image is shown', or any placeholder wording.",
                    "Do not mention alt text, filenames, URLs, or uncertainty unless the image is unreadable.",
                    "Start with natural spoken phrasing such as 'The image shows...' or 'The chart shows...'."
                  ].join(" ")
              },
              { inlineData: { mimeType, data } }
            ]
          }
        ]
      })
    });
    const description = parseTextResponse(payload)?.replace(/^Visual:\s*/i, "").trim();
    if (!description || GENERIC_IMAGE_DESCRIPTIONS.some((pattern) => pattern.test(description))) {
      app.log.warn({ src, description }, "Image description was generic");
      return null;
    }
    return description;
  } catch (error) {
    app.log.warn({ error, src }, "Image description failed");
    return null;
  }
}

async function prepareReadAloudScript(script: string): Promise<string> {
  const visualPattern = /\[\[podnarr-visual([^\]]*)\]\]/g;
  const pieces: string[] = [];
  let cursor = 0;

  for (const match of script.matchAll(visualPattern)) {
    pieces.push(script.slice(cursor, match.index));
    const src = markerAttr(match[1] ?? "", "src");
    const description = src ? await describeImage(src) : null;
    pieces.push(description ?? "The article includes an image at this point, but I could not inspect it clearly.");
    cursor = (match.index ?? 0) + match[0].length;
  }

  pieces.push(script.slice(cursor));
  return pieces.join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function alertDiscord(title: string, description: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
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
    app.log.warn({ error }, "Discord alert failed");
  }
}

async function ensureJingleAssets(): Promise<void> {
  await mkdir(JINGLE_DIR, { recursive: true });
  if (!existsSync(INTRO_JINGLE_PATH)) {
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=523.25:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=659.25:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=783.99:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1046.5:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=261.63:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=329.63:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=392:duration=6.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=523.25:duration=6.8",
      "-filter_complex",
      "[0:a]atrim=0:1.05,adelay=0|0,afade=t=out:st=0.18:d=0.87,volume=0.30[h0];[4:a]atrim=0:1.05,adelay=0|0,afade=t=out:st=0.18:d=0.87,volume=0.11[l0];[1:a]atrim=0:1.05,adelay=500|500,afade=t=out:st=0.18:d=0.87,volume=0.27[h1];[5:a]atrim=0:1.05,adelay=500|500,afade=t=out:st=0.18:d=0.87,volume=0.10[l1];[2:a]atrim=0:1.15,adelay=1000|1000,afade=t=out:st=0.20:d=0.95,volume=0.31[h2];[6:a]atrim=0:1.15,adelay=1000|1000,afade=t=out:st=0.20:d=0.95,volume=0.12[l2];[3:a]atrim=0:1.75,adelay=1520|1520,afade=t=out:st=0.32:d=1.43,volume=0.26[h3];[7:a]atrim=0:1.75,adelay=1520|1520,afade=t=out:st=0.32:d=1.43,volume=0.10[l3];[h0][l0][h1][l1][h2][l2][h3][l3]amix=inputs=8:duration=longest:normalize=0,afade=t=in:st=0:d=0.04,afade=t=out:st=2.95:d=0.65,aecho=0.35:0.25:75:0.10,loudnorm=I=-17:TP=-1.5:LRA=7[a]",
      "-map",
      "[a]",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      INTRO_JINGLE_PATH
    ]);
  }

  if (!existsSync(OUTRO_JINGLE_PATH)) {
    const outroPcmPath = path.join(JINGLE_DIR, "outro-jingle-broadcast-sparkle.pcm");
    await writeFile(outroPcmPath, buildBroadcastSparklePcm());
    try {
      await runFfmpeg([
        "-f",
        "s16le",
        "-ar",
        String(OUTRO_CHIME_SAMPLE_RATE),
        "-ac",
        "1",
        "-i",
        outroPcmPath,
        "-filter:a",
        "loudnorm=I=-17:TP=-1.5:LRA=7",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "128k",
        OUTRO_JINGLE_PATH
      ]);
    } finally {
      await rm(outroPcmPath, { force: true });
    }
  }
}

async function getJob(externalJobId: string): Promise<StoredJobRecord | null> {
  const cached = jobs.get(externalJobId);
  if (cached) {
    return cached;
  }

  const stored = await hydrateStoredJob(RENDER_DIR, externalJobId);
  if (stored) {
    jobs.set(externalJobId, stored);
  }
  return stored;
}

async function deferJobOnDailyBudget(job: StoredJobRecord, error: unknown): Promise<boolean> {
  if (!isGeminiDailyBudgetExhausted(error)) {
    return false;
  }

  job.status = "running";
  job.error = null;
  await saveStoredJob(RENDER_DIR, job);
  return true;
}

async function renderGeminiStandard(job: StoredJobRecord): Promise<void> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  await mkdir(RENDER_DIR, { recursive: true });
  await ensureJingleAssets();
  await saveStoredJob(RENDER_DIR, job);

  const chunkDir = jobChunkDir(RENDER_DIR, job.externalJobId);
  await mkdir(chunkDir, { recursive: true });
  job.status = "running";

  try {
    for (const chunk of job.chunks) {
      const chunkPath = path.join(chunkDir, chunk.fileName);
      if (!existsSync(chunkPath)) {
        const pcm = await generateGeminiPcm(job.model, job.voice, chunk.text, chunk.label);
        await writeChunkPcm(RENDER_DIR, job.externalJobId, chunk, pcm);
      }
    }
  } catch (error) {
    if (await deferJobOnDailyBudget(job, error)) {
      return;
    }
    throw error;
  }

  const outputPath = path.join(RENDER_DIR, `${job.externalJobId}.mp3`);
  const assembled = await assembleEpisodeMp3({
    body: job.body,
    chunkDir,
    chunks: job.chunks,
    introJinglePath: INTRO_JINGLE_PATH,
    outroJinglePath: OUTRO_JINGLE_PATH,
    outputPath
  });

  job.audioPath = outputPath;
  job.durationSeconds = assembled.durationSeconds;
  job.status = "succeeded";
  job.error = null;
  await saveStoredJob(RENDER_DIR, job);
}

async function renderGeminiBatch(job: StoredJobRecord): Promise<void> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  await mkdir(RENDER_DIR, { recursive: true });
  await ensureJingleAssets();
  await saveStoredJob(RENDER_DIR, job);
  job.status = "running";
  try {
    await advanceGeminiBatchJob(RENDER_DIR, job, INTRO_JINGLE_PATH, OUTRO_JINGLE_PATH);
  } catch (error) {
    if (await deferJobOnDailyBudget(job, error)) {
      return;
    }
    throw error;
  }
}

async function renderMockPodcast(job: StoredJobRecord): Promise<void> {
  await mkdir(RENDER_DIR, { recursive: true });
  await ensureJingleAssets();
  const outputPath = path.join(RENDER_DIR, `${job.externalJobId}.mp3`);
  const duration = Math.min(45, Math.max(8, Math.round(estimateAudioMinutes(job.body.script) * 6)));
  const safeTitle = job.body.title.replace(/[^\w .-]+/g, "").slice(0, 80) || "Podnarr episode";

  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:duration=${duration}`,
    "-i",
    INTRO_JINGLE_PATH,
    "-i",
    OUTRO_JINGLE_PATH,
    "-filter_complex",
    "[1:a][0:a][2:a]concat=n=3:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[a]",
    "-map",
    "[a]",
    "-metadata",
    `title=${safeTitle}`,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    outputPath
  ]);

  job.audioPath = outputPath;
  job.durationSeconds = duration + 11;
  job.status = "succeeded";
  job.error = null;
  await saveStoredJob(RENDER_DIR, job);
}

function toJobResponse(job: StoredJobRecord): NarrationJobResponse {
  return {
    provider: job.provider,
    model: job.model,
    voice: job.voice,
    externalJobId: job.externalJobId,
    status: job.status,
    estimatedAudioMinutes: job.estimatedAudioMinutes,
    estimatedCostUsd: job.estimatedCostUsd
  };
}

function toPollResponse(job: StoredJobRecord): NarrationPollResponse {
  return {
    ...toJobResponse(job),
    audioUrl: job.audioPath ? `${PUBLIC_BASE_URL}/v1/narrations/${job.externalJobId}/audio` : null,
    audioContentType: job.audioPath ? "audio/mpeg" : null,
    durationSeconds: job.durationSeconds,
    error: job.error
  };
}

async function restorePersistedJobs(): Promise<void> {
  await mkdir(RENDER_DIR, { recursive: true });
  const entries = await readdir(RENDER_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const stored = await loadStoredJob(RENDER_DIR, entry.name);
    if (stored && stored.status === "running") {
      jobs.set(stored.externalJobId, stored);
    }
  }
}

app.get("/health", async () => ({
  status: "ok",
  renderer: ENABLE_MOCK_RENDERER ? "mock-ffmpeg" : DEFAULT_TTS_CONFIG.provider,
  default_provider: DEFAULT_TTS_CONFIG.provider,
  public_base_url: PUBLIC_BASE_URL,
  gemini: await getGeminiUsageSnapshot()
}));

app.post<{ Body: PrepareScriptRequest }>("/v1/scripts/prepare", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const body = request.body;
  if (!body?.script) {
    return reply.status(400).send({ error: "script is required" });
  }

  const script = await prepareReadAloudScript(body.script);
  return reply.send({ script } satisfies PrepareScriptResponse);
});

app.post<{ Body: NarrationRequest }>("/v1/narrations", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const body = request.body;
  if (!body?.postId || !body.script || !body.title) {
    return reply.status(400).send({ error: "postId, title, and script are required" });
  }

  const provider = body.provider ?? DEFAULT_TTS_CONFIG.provider;
  const model = body.model ?? DEFAULT_TTS_CONFIG.model;
  const voice = body.voice ?? DEFAULT_TTS_CONFIG.voice;
  const estimatedAudioMinutes = estimateAudioMinutes(body.script);
  const job = createStoredJob({
    provider,
    model,
    voice,
    externalJobId: crypto.randomUUID(),
    postId: body.postId,
    estimatedAudioMinutes,
    estimatedCostUsd: estimatedAudioMinutes * costPerMinute(provider, model),
    body,
    sitePlug: SITE_PLUG
  });
  jobs.set(job.externalJobId, job);

  const renderer =
    ENABLE_MOCK_RENDERER || !GEMINI_API_KEY
      ? renderMockPodcast
      : provider === "gemini_batch"
        ? renderGeminiBatch
        : renderGeminiStandard;

  renderer(job).catch(async (error: unknown) => {
    if (await deferJobOnDailyBudget(job, error)) {
      return;
    }
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    void saveStoredJob(RENDER_DIR, job);
    void alertDiscord(
      "Podnarr audio render failed",
      `postId=${body.postId}\nexternalJobId=${job.externalJobId}\nvoice=${job.voice}\nmodel=${job.model}\nprovider=${job.provider}\n${job.error}`
    );
  });

  return reply.send(toJobResponse(job));
});

app.get<{ Params: { id: string } }>("/v1/narrations/:id", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const job = await getJob(request.params.id);
  if (!job) {
    return reply.status(404).send({ error: "Not found" });
  }

  if (job.provider === "gemini_batch" && job.status === "running") {
    try {
      await advanceGeminiBatchJob(RENDER_DIR, job, INTRO_JINGLE_PATH, OUTRO_JINGLE_PATH);
      jobs.set(job.externalJobId, job);
    } catch (error) {
      if (await deferJobOnDailyBudget(job, error)) {
        jobs.set(job.externalJobId, job);
        return reply.send(toPollResponse(job));
      }
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      await saveStoredJob(RENDER_DIR, job);
    }
  }

  return reply.send(toPollResponse(job));
});

app.get<{ Params: { id: string } }>("/v1/narrations/:id/audio", async (request, reply) => {
  const job = await getJob(request.params.id);
  if (!job?.audioPath || !existsSync(job.audioPath)) {
    return reply.status(404).send({ error: "Not found" });
  }
  const info = await stat(job.audioPath);
  reply.header("content-type", "audio/mpeg");
  reply.header("content-length", String(info.size));
  return reply.send(createReadStream(job.audioPath));
});

await restorePersistedJobs();
await app.listen({ port: PORT, host: "0.0.0.0" });
