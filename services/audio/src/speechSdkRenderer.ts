import { generateSpeech } from "@speech-sdk/core";
import { createFishAudio, createGoogle } from "@speech-sdk/core/providers";

import type { TtsProvider } from "@podnarr/shared/tts";

const NARRATION_STYLE_PROMPT =
  process.env.NARRATION_STYLE_PROMPT ??
  "Read this as an American male podcast host with a dry, deadpan, slightly dramatic delivery: calm, serious, precise, and restrained. Keep the cadence brisk and conversational. Use natural, brief pauses around quotations and section transitions. Avoid cheerfulness, sales energy, theatricality, exaggerated intonation, and long pauses.";

const FISH_FREE_MODEL = "s2.1-pro-free";
const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_FALLBACK_VOICE = process.env.GEMINI_TTS_FALLBACK_VOICE ?? "Orus";

export interface SpeechRenderResult {
  audio: Uint8Array;
  mediaType: string;
  provider: "fish_audio" | "gemini_standard";
  usedFallback: boolean;
}

function fishModel(model: string) {
  return createFishAudio({ apiKey: process.env.FISH_AUDIO_API_KEY })(model || FISH_FREE_MODEL);
}

function geminiModel(model: string) {
  return createGoogle({ apiKey: process.env.GEMINI_API_KEY })(model || GEMINI_FALLBACK_MODEL);
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

async function renderGemini(text: string, model: string, voice: string): Promise<SpeechRenderResult> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured for fallback narration.");
  }

  const result = await generateSpeech({
    model: geminiModel(model),
    text,
    voice: voice || GEMINI_FALLBACK_VOICE,
    instructions: NARRATION_STYLE_PROMPT,
    maxRetries: 4
  });
  return { audio: result.audio.uint8Array, mediaType: result.audio.mediaType, provider: "gemini_standard", usedFallback: true };
}

/** Render one short narration chunk, falling back to Gemini if Fish is unavailable. */
export async function renderSpeechChunk(input: {
  provider: TtsProvider;
  model: string;
  voice: string;
  text: string;
}): Promise<SpeechRenderResult> {
  if (input.provider === "fish_audio") {
    try {
      return await renderFish(input.text, input.model || FISH_FREE_MODEL, input.voice || process.env.FISH_AUDIO_VOICE || "");
    } catch (fishError) {
      try {
        return await renderGemini(input.text, GEMINI_FALLBACK_MODEL, GEMINI_FALLBACK_VOICE);
      } catch (geminiError) {
        const fishMessage = fishError instanceof Error ? fishError.message : String(fishError);
        const geminiMessage = geminiError instanceof Error ? geminiError.message : String(geminiError);
        throw new Error(`Fish narration failed (${fishMessage}); Gemini fallback failed (${geminiMessage}).`);
      }
    }
  }

  if (input.provider === "gemini_batch" || input.provider === "gemini_standard") {
    return renderGemini(input.text, input.model, input.voice);
  }

  throw new Error(`SpeechSDK narration does not yet support provider ${input.provider}.`);
}
