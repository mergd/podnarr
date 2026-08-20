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
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? "",
      OPENROUTER_IMAGE_MODEL: env.OPENROUTER_IMAGE_MODEL ?? "openai/gpt-5.6-luna",
      FISH_AUDIO_API_KEY: env.FISH_AUDIO_API_KEY ?? "",
      FISH_AUDIO_VOICE: env.FISH_AUDIO_VOICE ?? "",
      AUDIO_SERVICE_TOKEN: env.AUDIO_SERVICE_TOKEN ?? "",
      DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL ?? "",
      PODNARR_SITE_URL: env.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com",
      JINGLE_VOLUME: "1.6",
      NARRATION_TEMPO: "1.16"
    };
  }
}
