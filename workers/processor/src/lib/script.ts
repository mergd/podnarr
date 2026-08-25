import { htmlToNarrationScript } from "@podnarr/shared/htmlToSpeech";

export function buildNarrationScript(input: {
  title: string;
  author: string | null;
  htmlContent?: string | null;
  textContent: string | null;
  visualMetadataJson: string;
}): string {
  return (
    htmlToNarrationScript(input.htmlContent ?? null) ||
    input.textContent?.trim() ||
    "This post did not include extractable text."
  );
}

export function estimateAudioMinutes(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.25, words / 155);
}
