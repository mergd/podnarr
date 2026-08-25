export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function htmlAttrValue(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(attrs);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() || null : null;
}

function escapeMarkerValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export function imageNarrationMarker(attrs: string): string {
  const src = htmlAttrValue(attrs, "src");
  const parts = [src ? `src="${escapeMarkerValue(src)}"` : null].filter(Boolean);
  return parts.length > 0 ? `\n\n[[podnarr-visual ${parts.join(" ")}]]\n\n` : "\n\n[[podnarr-visual]]\n\n";
}

type ConvertMode = "plain" | "speech";

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function flattenRemainder(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<br\s*\/?>/gi, "\n\n")
      .replace(/<hr\b[^>]*>/gi, "\n\n")
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-zA-Z0-9#]+;/g, (entity) => decodeHtmlEntities(entity))
  );
}

function wrapAsQuote(text: string): string {
  const trimmed = text.trim();
  if (/^["“]/.test(trimmed) && /["”]$/.test(trimmed)) {
    return trimmed;
  }
  return `"${trimmed}"`;
}

function replaceHeadings(html: string): string {
  return html.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_match, heading: string) => {
    const label = flattenRemainder(heading);
    return label ? `\n\n${label}\n\n` : "\n\n";
  });
}

function replaceLists(html: string, mode: ConvertMode): string {
  return html.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, inner: string) => {
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((item) => flattenRemainder(item[1] ?? ""))
      .filter(Boolean)
      .flatMap((item) => (mode === "speech" ? splitParagraphs(item) : [item]));
    return items.length > 0 ? `\n\n${items.join("\n\n")}\n\n` : "\n\n";
  });
}

function replaceBlockquotes(html: string, mode: ConvertMode): string {
  return html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
    const prepared = replaceHeadings(replaceLists(inner, mode));
    const paragraphs = splitParagraphs(flattenRemainder(prepared));
    if (paragraphs.length === 0) {
      return "\n\n";
    }
    const quoted = paragraphs.map((paragraph) => {
      const wrapped = wrapAsQuote(paragraph);
      return mode === "speech" ? `[quoting] ${wrapped}` : wrapped;
    });
    return `\n\n${quoted.join("\n\n")}\n\n`;
  });
}

function convertHtml(html: string, mode: ConvertMode): string {
  const prepared = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => imageNarrationMarker(attrs));

  return normalizeWhitespace(flattenRemainder(replaceHeadings(replaceLists(replaceBlockquotes(prepared, mode), mode))));
}

function withParagraphPauses(text: string): string {
  return splitParagraphs(text)
    .map((paragraph) => (/\s\[pause\]$/i.test(paragraph) ? paragraph : `${paragraph} [pause]`))
    .join("\n\n");
}

export function htmlToPlainText(html: string | null): string | null {
  if (!html?.trim()) {
    return null;
  }
  return convertHtml(html, "plain") || null;
}

export function htmlToNarrationScript(html: string | null): string | null {
  if (!html?.trim()) {
    return null;
  }
  return withParagraphPauses(convertHtml(html, "speech")) || null;
}
