import { Container } from "@cloudflare/containers";

import type { Env } from "./env";

export class AudioServiceContainer extends Container<Env> {
  defaultPort = 8000;
  // Narration state and PCM chunks live in D1/R2. The container is only a
  // request-activated renderer/assembler and should scale back to zero.
  sleepAfter = "1m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ENABLE_MOCK_RENDERER: "false",
      GEMINI_API_KEY: env.GEMINI_API_KEY ?? "",
      FISH_AUDIO_API_KEY: env.FISH_AUDIO_API_KEY ?? "",
      FISH_AUDIO_VOICE: env.FISH_AUDIO_VOICE ?? "",
      GEMINI_TTS_FALLBACK_VOICE: env.GEMINI_TTS_FALLBACK_VOICE ?? "Orus",
      AUDIO_SERVICE_TOKEN: env.AUDIO_SERVICE_TOKEN ?? "",
      DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL ?? "",
      PODNARR_SITE_URL: env.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com",
      GEMINI_API_VERSION: "v1beta",
      GEMINI_CHUNK_RETRIES: "3",
      JINGLE_VOLUME: "1.6",
      NARRATION_TEMPO: "1.16"
    };
  }
}
