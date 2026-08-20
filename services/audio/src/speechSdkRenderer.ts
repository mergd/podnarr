import { generateSpeech } from "@speech-sdk/core";
import { createFishAudio } from "@speech-sdk/core/providers";

import type { TtsProvider } from "@podnarr/shared/tts";

const FISH_FREE_MODEL = "s2.1-pro-free";

export interface SpeechRenderResult {
  audio: Uint8Array;
  mediaType: string;
  provider: "fish_audio";
  usedFallback: boolean;
}

function fishModel(model: string) {
  return createFishAudio({ apiKey: process.env.FISH_AUDIO_API_KEY })(model || FISH_FREE_MODEL);
}

async function renderFish(text: string, model: string, voice: string): Promise<SpeechRenderResult> {
  if (!process.env.FISH_AUDIO_API_KEY) {
    throw new Error("FISH_AUDIO_API_KEY is not configured.");
  }
  if (!voice) {
    throw new Error("FISH_AUDIO_VOICE must be configured with a Fish reference voice id.");
  }

  const result = await generateSpeech({
    model: fishModel(model),
    text,
    voice,
    // S2.1 Pro Free is newer than SpeechSDK's static Fish model list. The API
    // accepts this model header, while WAV keeps our ffmpeg assembly lossless.
    providerOptions: { format: "wav", sample_rate: 24_000, normalize: true },
    maxRetries: 4
  });
  return { audio: result.audio.uint8Array, mediaType: result.audio.mediaType, provider: "fish_audio", usedFallback: false };
}

/** Render one short narration chunk with Fish Audio. Gemini TTS is unwired. */
export async function renderSpeechChunk(input: {
  provider: TtsProvider;
  model: string;
  voice: string;
  text: string;
}): Promise<SpeechRenderResult> {
  if (input.provider === "gemini_batch" || input.provider === "gemini_standard") {
    throw new Error("Gemini TTS is disabled. Use fish_audio.");
  }

  if (input.provider === "fish_audio") {
    return renderFish(input.text, input.model || FISH_FREE_MODEL, input.voice || process.env.FISH_AUDIO_VOICE || "");
  }

  throw new Error(`SpeechSDK narration does not yet support provider ${input.provider}.`);
}
