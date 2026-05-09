import type { SourcePost } from "./substack";

export interface SkipDecision {
  shouldSkip: boolean;
  reason: string | null;
}

const TITLE_SKIP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bhidden\s+open\s+thread\b/i, reason: "hidden_open_thread" },
  { pattern: /\bopen\s+thread\b/i, reason: "open_thread" },
  { pattern: /\bmeetup(?:s)?\b/i, reason: "meetup_announcement" },
  { pattern: /\b(?:update|announcement)\b/i, reason: "announcement" }
];

const BODY_SKIP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bthis is (?:an? )?open thread\b/i, reason: "open_thread_body" },
  { pattern: /\bthread for discussion\b/i, reason: "discussion_thread" }
];

export function shouldSkipPost(post: SourcePost): SkipDecision {
  for (const { pattern, reason } of TITLE_SKIP_PATTERNS) {
    if (pattern.test(post.title)) {
      return { shouldSkip: true, reason };
    }
  }

  const text = post.textContent ?? post.description ?? "";
  for (const { pattern, reason } of BODY_SKIP_PATTERNS) {
    if (pattern.test(text)) {
      return { shouldSkip: true, reason };
    }
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 0 && wordCount < 220) {
    return { shouldSkip: true, reason: "too_short" };
  }

  return { shouldSkip: false, reason: null };
}
