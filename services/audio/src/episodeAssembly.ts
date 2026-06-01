import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { NarrationRequest } from "@podnarr/shared/tts";

import type { ChunkDescriptor } from "./episodePlan.js";

const NARRATION_TEMPO = Number(process.env.NARRATION_TEMPO) || 1.16;
const JINGLE_VOLUME = Number(process.env.JINGLE_VOLUME) || 1.6;

function tempoValue(): number {
  return Math.min(1.35, Math.max(0.8, NARRATION_TEMPO));
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

export async function assembleEpisodeMp3(input: {
  body: NarrationRequest;
  chunkDir: string;
  chunks: ChunkDescriptor[];
  introJinglePath: string;
  outroJinglePath: string;
  outputPath: string;
}): Promise<{ durationSeconds: number; openingPcmBytes: number; closingPcmBytes: number; narrationPcmBytes: number }> {
  const openingPath = path.join(input.chunkDir, "opening.pcm");
  const closingPath = path.join(input.chunkDir, "closing.pcm");
  const rawPath = path.join(input.chunkDir, "narration.pcm");
  const narrationChunks = input.chunks.filter((chunk) => chunk.key !== "opening" && chunk.key !== "closing");
  const pcmChunks = await Promise.all(
    narrationChunks.map(async (chunk) => readFile(path.join(input.chunkDir, chunk.fileName)))
  );
  const rawAudio = Buffer.concat(pcmChunks);
  await writeFile(rawPath, rawAudio);

  const safeTitle = input.body.title.replace(/[^\w .-]+/g, "").slice(0, 80) || "Podnarr episode";
  await runFfmpeg([
    "-i",
    input.introJinglePath,
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
    input.outroJinglePath,
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
    input.outputPath
  ]);

  await readFile(input.outputPath);
  const openingPcm = await readFile(openingPath);
  const closingPcm = await readFile(closingPath);
  const spokenBumperSeconds = (openingPcm.length + closingPcm.length) / (24_000 * 2);
  const narrationSeconds = rawAudio.length / (24_000 * 2);
  return {
    durationSeconds: Math.round((narrationSeconds + spokenBumperSeconds) / tempoValue() + 8),
    openingPcmBytes: openingPcm.length,
    closingPcmBytes: closingPcm.length,
    narrationPcmBytes: rawAudio.length
  };
}
