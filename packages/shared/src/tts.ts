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

export interface NarrationPollResponse extends NarrationJobResponse {
  audioUrl: string | null;
  audioContentType: string | null;
  durationSeconds: number | null;
  error: string | null;
}
