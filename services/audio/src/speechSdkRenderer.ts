import { experimental_generateSpeech as generateSpeech } from "ai";
import { gateway } from "@ai-sdk/gateway";

import type { TtsProvider } from "@podnarr/shared/tts";

const FISH_GATEWAY_MODEL = "fish-audio/s2.1-pro-free";
const FISH_DIRECT_MODEL = "s2.1-pro-free";

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

function fishDirectModelId(model: string): string {
  const id = model.startsWith("fish-audio/") ? model.slice("fish-audio/".length) : model;
  if (!id || id === "s2.1-pro") return FISH_DIRECT_MODEL;
  return id;
}

function isGatewayBillingBlock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credit card on file/i.test(message) || /AI Gateway requires a valid credit card/i.test(message);
}

async function renderFishViaGateway(text: string, model: string, voice: string): Promise<SpeechRenderResult> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error("AI_GATEWAY_API_KEY is not configured.");
  }

  const result = await generateSpeech({
    model: gateway.speechModel(fishGatewayModelId(model)),
    text,
    voice,
    outputFormat: "mp3",
    maxRetries: 2
  });
  return {
    audio: result.audio.uint8Array,
    mediaType: result.audio.mediaType,
    provider: "fish_audio",
    usedFallback: false
  };
}

async function renderFishDirect(text: string, model: string, voice: string): Promise<SpeechRenderResult> {
  if (!process.env.FISH_AUDIO_API_KEY) {
    throw new Error("FISH_AUDIO_API_KEY is not configured.");
  }

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
      "content-type": "application/json",
      model: fishDirectModelId(model)
    },
    body: JSON.stringify({
      text,
      reference_id: voice,
      format: "mp3",
      sample_rate: 24_000,
      normalize: true
    })
  });
  if (!response.ok) {
    throw new Error(`Fish TTS failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get("content-type") || "audio/mpeg",
    provider: "fish_audio",
    usedFallback: true
  };
}

async function renderFish(text: string, model: string, voice: string): Promise<SpeechRenderResult> {
  if (!voice) {
    throw new Error("FISH_AUDIO_VOICE must be configured with a Fish reference voice id.");
  }
  try {
    return await renderFishViaGateway(text, model, voice);
  } catch (error) {
    if (!isGatewayBillingBlock(error) && process.env.AI_GATEWAY_API_KEY) {
      throw error;
    }
    return renderFishDirect(text, model, voice);
  }
}

/** Render one short narration chunk through Vercel AI Gateway Fish TTS, with a direct Fish fallback. */
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
