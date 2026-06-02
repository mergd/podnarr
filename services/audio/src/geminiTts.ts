import { geminiJson, isTransientGeminiError } from "./geminiClient.js";

const NARRATION_STYLE_PROMPT =
  process.env.NARRATION_STYLE_PROMPT ??
  "Read this as an American male podcast host with a dry, deadpan, slightly dramatic delivery: calm, serious, precise, and restrained. Keep the cadence brisk and conversational. Use natural, brief pauses around quotations and section transitions. Avoid cheerfulness, sales energy, theatricality, exaggerated intonation, and long pauses.";
const GEMINI_CHUNK_RETRIES = Number(process.env.GEMINI_CHUNK_RETRIES) || 5;
const GEMINI_CHUNK_DELAY_MS = Number(process.env.GEMINI_CHUNK_DELAY_MS) || 0;
const GEMINI_MIN_SPLIT_BYTES = Number(process.env.GEMINI_MIN_SPLIT_BYTES) || 240;

export const GEMINI_TTS_MODELS = {
  default: "gemini-3.1-flash-tts-preview",
  flash: "gemini-2.5-flash-preview-tts",
  pro: "gemini-2.5-pro-preview-tts"
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAudioResponse(payload: unknown): Buffer {
  const root = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> };
      finishReason?: string;
    }>;
  };
  const data = root.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data;
  if (!data) {
    const finishReason = root.candidates?.[0]?.finishReason;
    const text = root.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    const detail = [finishReason ? `finishReason=${finishReason}` : null, text ? `text=${text.slice(0, 160)}` : null]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Gemini response did not include inline audio data${detail ? ` (${detail})` : ""}.`);
  }
  return Buffer.from(data, "base64");
}

export function buildTtsGenerateContentRequest(text: string, voice: string): Record<string, unknown> {
  return {
    contents: [
      {
        parts: [
          {
            text: `${NARRATION_STYLE_PROMPT}\n\n${text}`
          }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice
          }
        }
      }
    }
  };
}

export { isTransientGeminiError, parseAudioResponse };

async function generateGeminiPcmOnce(model: string, voice: string, text: string): Promise<Buffer> {
  const payload = await geminiJson<unknown>(`models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    body: JSON.stringify(buildTtsGenerateContentRequest(text, voice))
  });

  return parseAudioResponse(payload);
}

function splitTextInHalf(text: string): [string, string] | null {
  if (Buffer.byteLength(text, "utf8") < GEMINI_MIN_SPLIT_BYTES * 2) {
    return null;
  }

  const midpoint = Math.floor(text.length / 2);
  const windowStart = Math.max(0, midpoint - 180);
  const windowEnd = Math.min(text.length, midpoint + 180);
  const window = text.slice(windowStart, windowEnd);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const match of window.matchAll(/[.!?]\s+/g)) {
    const absoluteIndex = windowStart + (match.index ?? 0) + match[0].length;
    const distance = Math.abs(absoluteIndex - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = absoluteIndex;
    }
  }

  if (bestIndex <= 0 || bestIndex >= text.length) {
    return null;
  }

  const left = text.slice(0, bestIndex).trim();
  const right = text.slice(bestIndex).trim();
  if (!left || !right) {
    return null;
  }

  return [left, right];
}

async function generateGeminiPcmWithRetries(
  model: string,
  voice: string,
  text: string,
  label: string
): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= GEMINI_CHUNK_RETRIES; attempt += 1) {
    try {
      if (attempt > 0) {
        await sleep(2_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 1_000));
      }
      return await generateGeminiPcmOnce(model, voice, text);
    } catch (error) {
      lastError = error;
      if (attempt >= GEMINI_CHUNK_RETRIES || !isTransientGeminiError(error)) {
        break;
      }
    }
  }

  const halves = splitTextInHalf(text);
  if (halves) {
    const [left, right] = halves;
    const leftAudio = await generateGeminiPcm(model, voice, left, `${label}.a`);
    await sleep(GEMINI_CHUNK_DELAY_MS);
    const rightAudio = await generateGeminiPcm(model, voice, right, `${label}.b`);
    return Buffer.concat([leftAudio, rightAudio]);
  }

  const message = geminiErrorMessage(lastError);
  throw new Error(`Gemini TTS chunk failed after ${GEMINI_CHUNK_RETRIES + 1} attempts (${label}, ${Buffer.byteLength(text, "utf8")} bytes): ${message}`);
}

export async function generateGeminiPcm(
  model: string,
  voice: string,
  text: string,
  label = "chunk"
): Promise<Buffer> {
  const pcm = await generateGeminiPcmWithRetries(model, voice, text, label);
  await sleep(GEMINI_CHUNK_DELAY_MS);
  return pcm;
}

export function splitScript(script: string, maxBytes = 1200): string[] {
  const paragraphs = script.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (Buffer.byteLength(paragraph, "utf8") <= maxBytes) {
      current = paragraph;
      continue;
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]+|\S+/g) ?? [paragraph];
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (Buffer.byteLength(next, "utf8") > maxBytes && current) {
        chunks.push(current);
        current = sentence.trim();
      } else {
        current = next;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [script.slice(0, maxBytes)];
}
