import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

import { generateGeminiPcm, splitScript } from "./geminiTts.js";

const PORT = Number(process.env.PORT) || 8000;
const SERVICE_TOKEN = process.env.AUDIO_SERVICE_TOKEN ?? "";
const PUBLIC_BASE_URL = process.env.PUBLIC_AUDIO_SERVICE_URL ?? `http://localhost:${PORT}`;
const RENDER_DIR = process.env.RENDER_DIR ?? path.join(tmpdir(), "podnarr-audio");
const ENABLE_MOCK_RENDERER = process.env.ENABLE_MOCK_RENDERER !== "false";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const GEMINI_TTS_MODE = process.env.GEMINI_TTS_MODE ?? "auto";
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION ?? "v1beta";
const GEMINI_SCRIPT_MODEL = process.env.GEMINI_SCRIPT_MODEL ?? "gemini-3-flash-preview";
const SITE_PLUG = process.env.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com";
const NARRATION_TEMPO = Number(process.env.NARRATION_TEMPO) || 1.16;
const JINGLE_VOLUME = Number(process.env.JINGLE_VOLUME) || 1.6;
const JINGLE_DIR = path.join(RENDER_DIR, "assets");
const INTRO_JINGLE_PATH = path.join(JINGLE_DIR, "intro-jingle-v7.mp3");
const OUTRO_JINGLE_PATH = path.join(JINGLE_DIR, "outro-jingle-v7.mp3");
const GENERIC_IMAGE_DESCRIPTIONS = [
  /image appears here/i,
  /there is an image/i,
  /an image is shown/i,
  /the image (?:shows|depicts) an image/i,
  /^in the image,\s*(?:an? )?image/i
];

interface JobRecord {
  provider: TtsProvider;
  model: string;
  voice: string;
  externalJobId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  estimatedAudioMinutes: number;
  estimatedCostUsd: number;
  audioPath: string | null;
  durationSeconds: number | null;
  error: string | null;
}

const jobs = new Map<string, JobRecord>();
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

function tempoValue(): number {
  return Math.min(1.35, Math.max(0.8, NARRATION_TEMPO));
}

function parseTextResponse(payload: unknown): string {
  const root = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return root.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("").trim() ?? "";
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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${encodeURIComponent(GEMINI_SCRIPT_MODEL)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
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
      }
    );
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const error = payload as { error?: { message?: string } };
      throw new Error(error.error?.message ?? `image description failed with ${response.status}`);
    }
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

function formatSpokenDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function buildOpeningLine(body: NarrationRequest): string {
  const show = body.publicationTitle?.trim() || "this publication";
  const date = formatSpokenDate(body.pubDate);
  const dateLine = date ? ` Published ${date}.` : "";
  return `You're listening to ${show}. Today's article is ${body.title}.${dateLine}`;
}

function buildClosingLine(): string {
  return `That was today's narration. Find the feed and more episodes at ${SITE_PLUG}.`;
}

async function ensureJingleAssets(): Promise<void> {
  await mkdir(JINGLE_DIR, { recursive: true });
  // Jingles are deterministic runtime assets owned by the Railway audio service.
  // The Worker only receives the finished MP3 in R2; it does not need these committed.
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
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1046.5:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=783.99:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=659.25:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=523.25:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=523.25:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=392:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=329.63:duration=6.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=261.63:duration=6.2",
      "-filter_complex",
      "[0:a]atrim=0:1.05,adelay=0|0,afade=t=out:st=0.18:d=0.87,volume=0.28[h0];[4:a]atrim=0:1.05,adelay=0|0,afade=t=out:st=0.18:d=0.87,volume=0.10[l0];[1:a]atrim=0:1.05,adelay=500|500,afade=t=out:st=0.18:d=0.87,volume=0.27[h1];[5:a]atrim=0:1.05,adelay=500|500,afade=t=out:st=0.18:d=0.87,volume=0.10[l1];[2:a]atrim=0:1.15,adelay=1000|1000,afade=t=out:st=0.20:d=0.95,volume=0.30[h2];[6:a]atrim=0:1.15,adelay=1000|1000,afade=t=out:st=0.20:d=0.95,volume=0.12[l2];[3:a]atrim=0:1.8,adelay=1520|1520,afade=t=out:st=0.32:d=1.48,volume=0.27[h3];[7:a]atrim=0:1.8,adelay=1520|1520,afade=t=out:st=0.32:d=1.48,volume=0.11[l3];[h0][l0][h1][l1][h2][l2][h3][l3]amix=inputs=8:duration=longest:normalize=0,afade=t=in:st=0:d=0.04,afade=t=out:st=3.0:d=0.65,aecho=0.35:0.25:85:0.10,loudnorm=I=-17:TP=-1.5:LRA=7[a]",
      "-map",
      "[a]",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      OUTRO_JINGLE_PATH
    ]);
  }
}

async function renderGeminiStandard(job: JobRecord, body: NarrationRequest): Promise<void> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  await mkdir(RENDER_DIR, { recursive: true });
  await ensureJingleAssets();
  const chunkDir = path.join(RENDER_DIR, job.externalJobId);
  await mkdir(chunkDir, { recursive: true });
  const rawPath = path.join(RENDER_DIR, `${job.externalJobId}.pcm`);
  const openingPath = path.join(chunkDir, "opening.pcm");
  const closingPath = path.join(chunkDir, "closing.pcm");
  const outputPath = path.join(RENDER_DIR, `${job.externalJobId}.mp3`);
  const chunks = splitScript(body.script);
  const pcmChunks: Buffer[] = [];

  async function loadOrGenerateChunk(fileName: string, label: string, text: string): Promise<Buffer> {
    const chunkPath = path.join(chunkDir, fileName);
    if (existsSync(chunkPath)) {
      return readFile(chunkPath);
    }
    const pcm = await generateGeminiPcm(job.model, job.voice, text, label);
    await writeFile(chunkPath, pcm);
    return pcm;
  }

  const openingPcm = await loadOrGenerateChunk("opening.pcm", "opening", buildOpeningLine(body));
  const closingPcm = await loadOrGenerateChunk("closing.pcm", "closing", buildClosingLine());

  for (const [index, chunk] of chunks.entries()) {
    pcmChunks.push(await loadOrGenerateChunk(`${index}.pcm`, `chunk-${index + 1}/${chunks.length}`, chunk));
  }

  const rawAudio = Buffer.concat(pcmChunks);
  await writeFile(rawPath, rawAudio);
  const durationSeconds = rawAudio.length / (24_000 * 2);
  const safeTitle = body.title.replace(/[^\w .-]+/g, "").slice(0, 80) || "Podnarr episode";

  await runFfmpeg([
    "-i",
    INTRO_JINGLE_PATH,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    openingPath,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    rawPath,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    closingPath,
    "-i",
    OUTRO_JINGLE_PATH,
    "-filter_complex",
    `[0:a]volume=${JINGLE_VOLUME.toFixed(2)}[intro];[1:a]atempo=${tempoValue().toFixed(2)},volume=1[opening];[2:a]atempo=${tempoValue().toFixed(2)},volume=1[narr];[3:a]atempo=${tempoValue().toFixed(2)},volume=1[closing];[4:a]volume=${JINGLE_VOLUME.toFixed(2)}[outro];[intro][opening][narr][closing][outro]concat=n=5:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
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

  // Ensure ffmpeg finished writing a non-empty file before reporting success.
  await readFile(outputPath);
  job.audioPath = outputPath;
  const spokenBumperSeconds = (openingPcm.length + closingPcm.length) / (24_000 * 2);
  job.durationSeconds = Math.round((durationSeconds + spokenBumperSeconds) / tempoValue() + 8);
  job.status = "succeeded";
}

async function renderMockPodcast(job: JobRecord, body: NarrationRequest): Promise<void> {
  await mkdir(RENDER_DIR, { recursive: true });
  await ensureJingleAssets();
  const outputPath = path.join(RENDER_DIR, `${job.externalJobId}.mp3`);
  const duration = Math.min(45, Math.max(8, Math.round(estimateAudioMinutes(body.script) * 6)));
  const safeTitle = body.title.replace(/[^\w .-]+/g, "").slice(0, 80) || "Podnarr episode";

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
}

function toJobResponse(job: JobRecord): NarrationJobResponse {
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

function toPollResponse(job: JobRecord): NarrationPollResponse {
  return {
    ...toJobResponse(job),
    audioUrl: job.audioPath ? `${PUBLIC_BASE_URL}/v1/narrations/${job.externalJobId}/audio` : null,
    audioContentType: job.audioPath ? "audio/mpeg" : null,
    durationSeconds: job.durationSeconds,
    error: job.error
  };
}

app.get("/health", async () => ({
  status: "ok",
  renderer: ENABLE_MOCK_RENDERER ? "mock-ffmpeg" : `gemini-${GEMINI_TTS_MODE}`,
  default_provider: DEFAULT_TTS_CONFIG.provider,
  public_base_url: PUBLIC_BASE_URL
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
  const job: JobRecord = {
    provider,
    model,
    voice,
    externalJobId: crypto.randomUUID(),
    status: "queued",
    estimatedAudioMinutes,
    estimatedCostUsd: estimatedAudioMinutes * costPerMinute(provider, model),
    audioPath: null,
    durationSeconds: null,
    error: null
  };
  jobs.set(job.externalJobId, job);

  job.status = "running";
  const renderer = ENABLE_MOCK_RENDERER || !GEMINI_API_KEY ? renderMockPodcast : renderGeminiStandard;
  renderer(job, body).catch((error: unknown) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      void alertDiscord(
        "Podnarr audio render failed",
        `postId=${body.postId}\nexternalJobId=${job.externalJobId}\nvoice=${job.voice}\nmodel=${job.model}\n${job.error}`
      );
    });

  return reply.send(toJobResponse(job));
});

app.get<{ Params: { id: string } }>("/v1/narrations/:id", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  const job = jobs.get(request.params.id);
  return job ? reply.send(toPollResponse(job)) : reply.status(404).send({ error: "Not found" });
});

app.get<{ Params: { id: string } }>("/v1/narrations/:id/audio", async (request, reply) => {
  const job = jobs.get(request.params.id);
  if (!job?.audioPath || !existsSync(job.audioPath)) {
    return reply.status(404).send({ error: "Not found" });
  }
  const info = await stat(job.audioPath);
  reply.header("content-type", "audio/mpeg");
  reply.header("content-length", String(info.size));
  return reply.send(createReadStream(job.audioPath));
});

await app.listen({ port: PORT, host: "0.0.0.0" });
