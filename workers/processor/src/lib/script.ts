interface VisualMetadata {
  kind?: string;
  src?: string;
  alt?: string;
  caption?: string;
}

function parseVisuals(value: string): VisualMetadata[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is VisualMetadata => Boolean(entry && typeof entry === "object")) : [];
  } catch {
    return [];
  }
}

function visualLine(visual: VisualMetadata, index: number): string {
  if (visual.kind === "table") {
    return `Visual note ${index}: the article includes a table. Describe the table briefly and do not invent precise values unless they are stated in the article text.`;
  }

  const label = visual.alt || visual.caption || "an image or figure";
  return `Visual note ${index}: the article includes ${label}. Describe only what is available from the caption or alt text.`;
}

export function buildNarrationScript(input: {
  title: string;
  author: string | null;
  textContent: string | null;
  visualMetadataJson: string;
}): string {
  const body = input.textContent?.trim() || "This post did not include extractable text.";

  return body;
}

export function estimateAudioMinutes(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.25, words / 155);
}
