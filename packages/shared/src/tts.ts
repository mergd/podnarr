export type TtsProvider =
  | "fish_audio"
  | "gemini_batch"
  | "gemini_standard"
  | "elevenlabs"
  | "inworld"
  | "minimax"
  | "openai"
  | "deepgram"
  | "polly"
  | "local";

export interface TtsProviderConfig {
  provider: TtsProvider;
  model: string;
  voice: string;
  estimatedCostPerAudioMinuteUsd: number;
}

export const DEFAULT_TTS_CONFIG: TtsProviderConfig = {
  provider: "fish_audio",
  model: "fish-audio/s2.1-pro",
  voice: "",
  estimatedCostPerAudioMinuteUsd: 0
};

export function isGeminiTtsProvider(provider: TtsProvider): boolean {
  return provider === "gemini_batch" || provider === "gemini_standard";
}

export function resolveActiveTtsConfig(
  requested: { provider?: TtsProvider | null; model?: string | null; voice?: string | null },
  fallback: TtsProviderConfig = DEFAULT_TTS_CONFIG
): TtsProviderConfig {
  const provider = requested.provider ?? fallback.provider;
  if (isGeminiTtsProvider(provider)) {
    return { ...fallback };
  }
  return {
    provider,
    model: requested.model || fallback.model,
    voice: requested.voice || fallback.voice,
    estimatedCostPerAudioMinuteUsd: provider === "fish_audio" ? 0 : fallback.estimatedCostPerAudioMinuteUsd
  };
}

export const GEMINI_TTS_MODEL_OPTIONS: Array<TtsProviderConfig & { note: string }> = [
  {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    estimatedCostPerAudioMinuteUsd: 0.015,
    note: "Non-Gemini fallback candidate once wired in the audio service."
  }
];

export const TTS_BAKEOFF_CONFIGS: TtsProviderConfig[] = [
  DEFAULT_TTS_CONFIG,
  {
    provider: "elevenlabs",
    model: "eleven_turbo_v2_5",
    voice: "default",
    estimatedCostPerAudioMinuteUsd: 0.05
  },
  {
    provider: "inworld",
    model: "tts-1.5-max",
    voice: "default",
    estimatedCostPerAudioMinuteUsd: 0.035
  },
  {
    provider: "inworld",
    model: "tts-1.5-mini",
    voice: "default",
    estimatedCostPerAudioMinuteUsd: 0.025
  },
  {
    provider: "minimax",
    model: "speech-2.8-hd",
    voice: "default",
    estimatedCostPerAudioMinuteUsd: 0.1
  },
  {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    estimatedCostPerAudioMinuteUsd: 0.015
  }
];

export interface NarrationRequest {
  postId: number;
  publicationTitle?: string;
  title: string;
  pubDate?: string | null;
  script: string;
  provider?: TtsProvider;
  model?: string;
  voice?: string;
  callbackUrl?: string;
}

export type NarrationJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface NarrationJobResponse {
  provider: TtsProvider;
  model: string;
  voice: string;
  externalJobId: string;
  status: NarrationJobStatus;
  estimatedAudioMinutes: number;
  estimatedCostUsd: number;
}

export interface PrepareScriptRequest {
  script: string;
}

export type ScriptPrepJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface PrepareScriptJobResponse {
  externalJobId: string;
  status: ScriptPrepJobStatus;
}

export interface PrepareScriptPollResponse {
  externalJobId: string;
  status: ScriptPrepJobStatus;
  script: string | null;
  error: string | null;
}

export interface NarrationPollResponse extends NarrationJobResponse {
  audioUrl: string | null;
  audioContentType: string | null;
  durationSeconds: number | null;
  error: string | null;
}
