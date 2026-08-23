import { Container } from "@cloudflare/containers";

import type { Env } from "./env";

export function audioServiceEnvVars(source: Env): Record<string, string> {
  return {
    ENABLE_MOCK_RENDERER: "false",
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY ?? "",
    OPENROUTER_IMAGE_MODEL: source.OPENROUTER_IMAGE_MODEL ?? "openai/gpt-5.6-luna",
    AI_GATEWAY_API_KEY: source.AI_GATEWAY_API_KEY ?? "",
    FISH_AUDIO_API_KEY: source.FISH_AUDIO_API_KEY ?? "",
    FISH_AUDIO_VOICE: source.FISH_AUDIO_VOICE ?? source.DEFAULT_TTS_VOICE ?? "",
    AUDIO_SERVICE_TOKEN: source.AUDIO_SERVICE_TOKEN ?? "",
    DISCORD_WEBHOOK_URL: source.DISCORD_WEBHOOK_URL ?? "",
    PODNARR_SITE_URL: source.PODNARR_SITE_URL ?? "podnarr.yet-to-be.com",
    JINGLE_VOLUME: "1.6",
    NARRATION_TEMPO: "1.16"
  };
}

export class AudioServiceContainer extends Container<Env> {
  defaultPort = 8000;
  // Narration state and PCM chunks live in D1/R2. The container is only a
  // request-activated renderer/assembler and should scale back to zero.
  sleepAfter = "1m";

  override async onActivityExpired(): Promise<void> {
    console.log("Audio service idle timeout expired, destroying container");
    await this.destroy();
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = audioServiceEnvVars(env);
  }
}
