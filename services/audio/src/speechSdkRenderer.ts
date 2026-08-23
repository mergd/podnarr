import { experimental_generateSpeech as generateSpeech } from "ai";
import { gateway } from "@ai-sdk/gateway";

import type { TtsProvider } from "@podnarr/shared/tts";

const FISH_GATEWAY_MODEL = "fish-audio/s2.1-pro-free";

export interface SpeechRenderResult {
  audio: Uint8Array;
  mediaType: string;
  provider: "fish_audio";
  usedFallback: boolean;
}

function fishGatewayModelId(model: string): string {
  if (model.startsWith("fish-audio/")) {
    return model.endsWith("-free") ? model : `${model}-free`;
  }
  if (!model || model === "s2.1-pro" || model === "s2.1-pro-free") {
    return FISH_GATEWAY_MODEL;
  }
  return `fish-audio/${model.endsWith("-free") ? model : `${model}-free`}`;
}

async function renderFish(text: string, model: string, voice: string): Promise<SpeechRenderResult> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error("AI_GATEWAY_API_KEY is not configured.");
  }
  if (!voice) {
    throw new Error("FISH_AUDIO_VOICE must be configured with a Fish reference voice id.");
  }

  const result = await generateSpeech({
    model: gateway.speechModel(fishGatewayModelId(model)),
    text,
    voice,
    outputFormat: "mp3",
    maxRetries: 4
  });
  return {
    audio: result.audio.uint8Array,
    mediaType: result.audio.mediaType,
    provider: "fish_audio",
    usedFallback: false
  };
}

/** Render one short narration chunk through Vercel AI Gateway Fish TTS. */
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
    return renderFish(
      input.text,
      input.model || FISH_GATEWAY_MODEL,
      input.voice || process.env.FISH_AUDIO_VOICE || ""
    );
  }

  throw new Error(`SpeechSDK narration does not yet support provider ${input.provider}.`);
}
