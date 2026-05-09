import { XMLParser } from "fast-xml-parser";

export interface SourcePublication {
  title: string;
  description: string | null;
  author: string | null;
  imageUrl: string | null;
  siteUrl: string | null;
  language: string | null;
  posts: SourcePost[];
}

export interface SourcePost {
  postKey: string;
  guid: string | null;
  title: string;
  canonicalUrl: string | null;
  description: string | null;
  htmlContent: string | null;
  textContent: string | null;
  visualMetadata: VisualMetadata[];
  author: string | null;
  imageUrl: string | null;
  pubDate: string | null;
  pubDateMs: number | null;
}

export interface VisualMetadata {
  kind: "image" | "figure" | "table";
  src?: string;
  alt?: string;
  caption?: string;
}

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object" && "#text" in value) {
    return getString((value as { "#text"?: unknown })["#text"]);
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const next = getString(value);
    if (next) {
      return next;
    }
  }
  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function attrValue(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(attrs);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() || null : null;
}

function escapeMarkerValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function imageNarrationMarker(attrs: string): string {
  const src = attrValue(attrs, "src");
  const parts = [src ? `src="${escapeMarkerValue(src)}"` : null].filter(Boolean);
  return parts.length > 0 ? `\n\n[[podnarr-visual ${parts.join(" ")}]]\n\n` : "\n\n[[podnarr-visual]]\n\n";
}

function stripHtml(html: string | null): string | null {
  if (!html) {
    return null;
  }

  const withSectionLabels = html
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_match, heading: string) => {
      const label = decodeHtmlEntities(heading.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim());
      return label ? `\n\nSection: ${label}\n\n` : "\n\n";
    })
    .replace(/<blockquote\b[^>]*>/gi, "\n\nBegin quote.\n\n")
    .replace(/<\/blockquote>/gi, "\n\nEnd quote.\n\n")
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => imageNarrationMarker(attrs));

  const text = withSectionLabels
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, (entity) => decodeHtmlEntities(entity))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}

function normalizeIsoDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

// Substack often serves images via a CDN with `_/w_NNN` size hints. Strip them so
// we get the largest available rendition and let downstream consumers resize.
function upgradeImageQuality(src: string): string {
  return src.replace(/\/w_\d+(?:,[^,/]+)*\b/g, "/w_1200");
}

function isUsablePostImage(src: string): boolean {
  if (!/^https?:\/\//i.test(src)) {
    return false;
  }
  const lower = src.toLowerCase();
  // Filter out tracking pixels, share buttons, signup CTAs, and other chrome.
  if (/\b(?:pixel|spacer|1x1|tracker)\b/.test(lower)) {
    return false;
  }
  if (/substackcdn\.com\/image\/fetch\/.+\/(?:icon|button|share)/.test(lower)) {
    return false;
  }
  return true;
}

function pickImageFromHtml(html: string | null): string | null {
  if (!html) {
    return null;
  }
  const imgPattern = /<img\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgPattern.exec(html)) !== null) {
    const src = attrValue(match[1] ?? "", "src");
    if (src && isUsablePostImage(src)) {
      return upgradeImageQuality(src);
    }
  }
  return null;
}

function pickImage(
  node: Record<string, unknown>,
  channel: Record<string, unknown>,
  htmlContent: string | null
): string | null {
  const mediaContent = node["media:content"];
  if (mediaContent && typeof mediaContent === "object" && "url" in mediaContent) {
    const url = getString((mediaContent as { url?: unknown }).url);
    if (url) return url;
  }

  const enclosure = node.enclosure;
  if (enclosure && typeof enclosure === "object" && "type" in enclosure) {
    const type = getString((enclosure as { type?: unknown }).type);
    if (type?.startsWith("image/")) {
      const url = getString((enclosure as { url?: unknown }).url);
      if (url) return url;
    }
  }

  const image = node["itunes:image"] ?? channel["itunes:image"];
  if (image && typeof image === "object" && "href" in image) {
    const url = getString((image as { href?: unknown }).href);
    if (url) return url;
  }

  return pickImageFromHtml(htmlContent);
}

function extractVisualMetadata(html: string | null): VisualMetadata[] {
  if (!html) {
    return [];
  }

  const visuals: VisualMetadata[] = [];
  const imgPattern = /<img\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgPattern.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const src = attrValue(attrs, "src") ?? undefined;
    const alt = attrValue(attrs, "alt") ?? undefined;
    visuals.push({ kind: "image", src, alt });
  }

  if (/<table\b/i.test(html)) {
    visuals.push({ kind: "table", caption: "The article includes a table." });
  }

  return visuals.slice(0, 24);
}

export function normalizeSubstackUrl(input: string): { sourceUrl: string; feedUrl: string; normalizedUrl: string } {
  const raw = input.trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  parsed.hash = "";
  parsed.search = "";

  const hostname = parsed.hostname.toLowerCase();
  const basePath = parsed.pathname.replace(/\/feed\/?$/i, "").replace(/\/+$/g, "");
  const sourceUrl = `${parsed.protocol}//${hostname}${basePath || ""}`;
  const feedUrl = `${sourceUrl}/feed`;
  return {
    sourceUrl,
    feedUrl,
    normalizedUrl: feedUrl.toLowerCase()
  };
}

export async function fetchSubstackFeed(feedUrl: string): Promise<SourcePublication> {
  const response = await fetch(feedUrl, {
    headers: {
      "user-agent": "podnarr-bot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Substack feed fetch failed with status ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml) as { rss?: { channel?: Record<string, unknown> } };
  const channel = parsed.rss?.channel;
  if (!channel) {
    throw new Error("Substack feed did not contain an RSS channel.");
  }

  const channelImage = channel.image as { url?: unknown } | undefined;
  const items = asArray(channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const posts: SourcePost[] = items.map((item) => {
    const guid = firstString(item.guid);
    const canonicalUrl = firstString(item.link);
    const title = firstString(item.title) ?? "Untitled post";
    const htmlContent = firstString(item["content:encoded"], item.description);
    const textContent = stripHtml(htmlContent);
    const pubDate = normalizeIsoDate(firstString(item.pubDate));
    const pubDateMs = pubDate ? Date.parse(pubDate) : null;
    const postKey = guid ?? canonicalUrl ?? `${title}::${pubDate ?? "unknown-date"}`;

    return {
      postKey,
      guid,
      title,
      canonicalUrl,
      description: stripHtml(firstString(item.description)),
      htmlContent,
      textContent,
      visualMetadata: extractVisualMetadata(htmlContent),
      author: firstString(item["dc:creator"], item.author, channel["dc:creator"], channel.managingEditor),
      imageUrl: pickImage(item, channel, htmlContent),
      pubDate,
      pubDateMs: Number.isFinite(pubDateMs) ? pubDateMs : null
    };
  });

  return {
    title: firstString(channel.title) ?? "Untitled Substack",
    description: stripHtml(firstString(channel.description)),
    author: firstString(channel["dc:creator"], channel.managingEditor),
    imageUrl: firstString(channelImage?.url),
    siteUrl: firstString(channel.link),
    language: firstString(channel.language),
    posts
  };
}
