import type { NarrationRequest } from "./tts.js";

export interface NarrationChunk {
  index: number;
  key: string;
  text: string;
  label: string;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function splitNarrationScript(script: string, maxBytes = 1200): string[] {
  const paragraphs = script.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (byteLength(paragraph) <= maxBytes) {
      current = paragraph;
      continue;
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]+|\S+/g) ?? [paragraph];
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (byteLength(next) > maxBytes && current) {
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

function formatSpokenDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

export function buildNarrationChunks(body: NarrationRequest, sitePlug: string): NarrationChunk[] {
  const opening = `You're listening to ${body.publicationTitle?.trim() || "this publication"}. Today's article is ${body.title}.${
    formatSpokenDate(body.pubDate) ? ` Published ${formatSpokenDate(body.pubDate)}.` : ""
  }`;
  const content = splitNarrationScript(body.script);
  const chunks: NarrationChunk[] = [{ index: 0, key: "opening", text: opening, label: "opening" }];

  for (const [index, text] of content.entries()) {
    chunks.push({ index: index + 1, key: String(index), text, label: `chunk-${index + 1}/${content.length}` });
  }

  chunks.push({
    index: chunks.length,
    key: "closing",
    text: `That was today's narration. Find the feed and more episodes at ${sitePlug}.`,
    label: "closing"
  });
  return chunks;
}
