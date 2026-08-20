import { splitNarrationScript } from "@podnarr/shared/narration";
import type { NarrationRequest } from "@podnarr/shared/tts";

export interface ChunkDescriptor {
  key: string;
  fileName: string;
  text: string;
  label: string;
}

function formatSpokenDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

export function buildOpeningLine(body: NarrationRequest): string {
  const show = body.publicationTitle?.trim() || "this publication";
  const date = formatSpokenDate(body.pubDate);
  const dateLine = date ? ` Published ${date}.` : "";
  return `You're listening to ${show}. Today's article is ${body.title}.${dateLine}`;
}

export function buildClosingLine(sitePlug: string): string {
  return `That was today's narration. Find the feed and more episodes at ${sitePlug}.`;
}

export function buildEpisodeChunks(body: NarrationRequest, sitePlug: string): ChunkDescriptor[] {
  const scriptChunks = splitNarrationScript(body.script);
  const chunks: ChunkDescriptor[] = [
    { key: "opening", fileName: "opening.pcm", text: buildOpeningLine(body), label: "opening" }
  ];

  for (const [index, text] of scriptChunks.entries()) {
    chunks.push({
      key: String(index),
      fileName: `${index}.pcm`,
      text,
      label: `chunk-${index + 1}/${scriptChunks.length}`
    });
  }

  chunks.push({
    key: "closing",
    fileName: "closing.pcm",
    text: buildClosingLine(sitePlug),
    label: "closing"
  });

  return chunks;
}
