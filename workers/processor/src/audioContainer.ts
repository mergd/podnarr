import { env } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";

import type { Env } from "./env";

const workerEnv = env as Env;

export class AudioServiceContainer extends Container<Env> {
  defaultPort = 8000;
  // Narration state and PCM chunks live in D1/R2. The container is only a
  // request-activated renderer/assembler and should scale back to zero.
  sleepAfter = "1m";
  envVars = {
    ENABLE_MOCK_RENDERER: "false",
    OPENROUTER_API_KEY: workerEnv.OPENROUTER_API_KEY ?? "",
    OPENROUTER_IMAGE_MODEL: workerEnv.OPENROUTER_IMAGE_MODEL ?? "openai/gpt-5.6-luna",
    AI_GATEWAY_API_KEY: workerEnv.AI_GATEWAY_API_KEY ?? "",
    FISH_AUDIO_API_KEY: workerEnv.FISH_AUDIO_API_KEY ?? "",
    FISH_AUDIO_VOICE: workerEnv.FISH_AUDIO_VOICE ?? workerEnv.DEFAULT_TTS_VOICE ?? "",
    AUDIO_SERVICE_TOKEN: workerEnv.AUDIO_SERVICE_TOKEN ?? "",
    DISCORD_WEBHOOK_URL: workerEnv.DISCORD_WEBHOOK_URL ?? "",
    PODNARR_SITE_URL: workerEnv.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com",
    JINGLE_VOLUME: "1.6",
    NARRATION_TEMPO: "1.16"
  };
}
