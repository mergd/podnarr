import type { PostSummary, PublicationSummary } from "@podnarr/shared/api";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function optionalTag(tag: string, value: string | null | undefined): string {
  return value ? `<${tag}>${escapeXml(value)}</${tag}>` : "";
}

function episodeDescription(post: PostSummary): string | null {
  const parts = [post.description?.trim()].filter((part): part is string => Boolean(part));
  if (post.canonicalUrl) {
    parts.push(`Original article: ${post.canonicalUrl}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function toRfc2822(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return `${DAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")} +0000`;
}

export function buildPodcastRss(publication: PublicationSummary, posts: PostSummary[]): string {
  const readyPosts = posts.filter((post) => post.status === "ready" && post.audioUrl);
  const publicationImageUrl = publication.brandedImageUrl ?? publication.imageUrl;
  const channelImage = publicationImageUrl
    ? `<image>${optionalTag("url", publicationImageUrl)}${optionalTag("title", publication.title)}${optionalTag("link", publication.siteUrl)}</image><itunes:image href="${escapeXml(publicationImageUrl)}" />`
    : "";
  const items = readyPosts
    .map((post) => {
      const guid = post.canonicalUrl ?? `${publication.slug}-${post.id}`;
      const duration = post.durationSeconds ? String(post.durationSeconds) : null;
      const sourceUrl = post.canonicalUrl ?? publication.siteUrl;
      return `<item>
        ${optionalTag("title", post.title)}
        ${optionalTag("description", episodeDescription(post))}
        ${optionalTag("link", sourceUrl)}
        <guid isPermaLink="${post.canonicalUrl ? "true" : "false"}">${escapeXml(guid)}</guid>
        ${optionalTag("author", post.author)}
        ${optionalTag("itunes:author", post.author)}
        ${optionalTag("pubDate", toRfc2822(post.pubDate))}
        ${optionalTag("itunes:duration", duration)}
        ${post.imageUrl ? `<itunes:image href="${escapeXml(post.imageUrl)}" />` : ""}
        <enclosure url="${escapeXml(post.audioUrl ?? "")}" type="audio/mpeg" />
      </item>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <atom:link href="${escapeXml(publication.rssUrl)}" rel="self" type="application/rss+xml" />
    ${optionalTag("title", publication.title)}
    ${optionalTag("description", publication.description)}
    ${optionalTag("link", publication.siteUrl)}
    ${optionalTag("language", "en-us")}
    ${optionalTag("itunes:author", publication.author)}
    ${channelImage}
    ${items}
  </channel>
</rss>`;
}
