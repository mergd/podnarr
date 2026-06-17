export type TtsProvider =
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
  provider: "gemini_batch",
  model: "gemini-3.1-flash-tts-preview",
  voice: "Orus",
  estimatedCostPerAudioMinuteUsd: 0.015
};

export const GEMINI_TTS_MODEL_OPTIONS: Array<TtsProviderConfig & { note: string }> = [
  {
    provider: "gemini_batch",
    model: "gemini-3.1-flash-tts-preview",
    voice: "Orus",
    estimatedCostPerAudioMinuteUsd: 0.015,
    note: "Default. Same 3.1 voice quality at half the Gemini API cost via batchGenerateContent."
  },
  {
    provider: "gemini_standard",
    model: "gemini-3.1-flash-tts-preview",
    voice: "Orus",
    estimatedCostPerAudioMinuteUsd: 0.03,
    note: "Immediate sync TTS when you need the episode right away."
  },
  {
    provider: "gemini_standard",
    model: "gemini-2.5-flash-preview-tts",
    voice: "Orus",
    estimatedCostPerAudioMinuteUsd: 0.015,
    note: "Cheaper fallback when cost or long-job stability matters more than expressiveness."
  },
  {
    provider: "gemini_standard",
    model: "gemini-2.5-pro-preview-tts",
    voice: "Orus",
    estimatedCostPerAudioMinuteUsd: 0.025,
    note: "Higher-quality 2.5 tier when flash preview sounds too thin."
  },
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
