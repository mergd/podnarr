import type {
  HomeResponse,
  PostDetailResponse,
  PostSummary,
  PublicationDetailResponse,
  PublicationSummary,
  RegisterPublicationResponse
} from "@podnarr/shared/api";
import type { PostQueueMessage } from "@podnarr/shared/queue";

import type { Env } from "../env";
import { sha256Hex, slugify } from "./crypto";
import { shouldSkipPost } from "./postFilter";
import type { SourcePost, SourcePublication } from "./substack";

export interface PublicationRow {
  id: number;
  source_url: string;
  feed_url: string;
  normalized_url: string;
  url_hash: string;
  slug: string;
  title: string;
  description: string | null;
  author: string | null;
  image_url: string | null;
  branded_image_key: string | null;
  branded_image_source_url: string | null;
  branded_image_updated_at: string | null;
  site_url: string | null;
  language: string | null;
  status: string;
  last_refreshed_at: string | null;
  last_error: string | null;
}

export interface PostRow {
  id: number;
  publication_id: number;
  publication_slug?: string;
  post_key: string;
  guid: string | null;
  title: string;
  canonical_url: string | null;
  description: string | null;
  html_content: string | null;
  text_content: string | null;
  visual_metadata_json: string;
  author: string | null;
  image_url: string | null;
  pub_date: string | null;
  pub_date_ms: number | null;
  status: string;
  audio_key: string | null;
  duration_seconds: number | null;
  tts_provider: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  estimated_cost_usd: number | null;
  narration_job_id: string | null;
  narration_job_status: string | null;
  last_error: string | null;
  script?: string | null;
}

function parseStatus(value: string): PublicationSummary["status"] {
  return value === "active" || value === "failed" ? value : "pending";
}

function parsePostStatus(value: string): PostSummary["status"] {
  switch (value) {
    case "scripted":
    case "narrating":
    case "ready":
    case "failed":
    case "skipped":
      return value;
    default:
      return "pending";
  }
}

function audioUrl(baseUrl: string, row: PostRow): string | null {
  return row.audio_key ? `${baseUrl}/audio/${row.id}.mp3` : null;
}

export function brandedImageUrlForPublication(
  row: Pick<PublicationRow, "slug" | "branded_image_key">,
  baseUrl: string
): string | null {
  return row.branded_image_key ? `${baseUrl}/publication-artwork/${row.slug}.png` : null;
}

export function toPublicationSummary(row: PublicationRow, baseUrl: string): PublicationSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    author: row.author,
    imageUrl: row.image_url,
    brandedImageUrl: brandedImageUrlForPublication(row, baseUrl),
    siteUrl: row.site_url,
    rssUrl: `${baseUrl}/shows/${row.slug}/rss.xml`,
    status: parseStatus(row.status),
    lastRefreshedAt: row.last_refreshed_at
  };
}

export function toPostSummary(row: PostRow, baseUrl: string): PostSummary {
  return {
    id: row.id,
    publicationSlug: row.publication_slug ?? "",
    title: row.title,
    canonicalUrl: row.canonical_url,
    description: row.description,
    imageUrl: row.image_url,
    author: row.author,
    pubDate: row.pub_date,
    status: parsePostStatus(row.status),
    audioUrl: audioUrl(baseUrl, row),
    durationSeconds: row.duration_seconds,
    estimatedCostUsd: row.estimated_cost_usd,
    ttsProvider: row.tts_provider as PostSummary["ttsProvider"],
    ttsModel: row.tts_model,
    ttsVoice: row.tts_voice,
    narrationJobStatus: row.narration_job_status as PostSummary["narrationJobStatus"]
  };
}

async function uniqueSlug(db: D1Database, title: string, hash: string): Promise<string> {
  const base = slugify(title);
  const existing = await db.prepare("SELECT id FROM publications WHERE slug = ?1").bind(base).first();
  return existing ? `${base}-${hash.slice(0, 8)}` : base;
}

export async function getPublicationBySlug(db: D1Database, slug: string): Promise<PublicationRow | null> {
  return db.prepare("SELECT * FROM publications WHERE slug = ?1").bind(slug).first<PublicationRow>();
}

export async function getPublicationByNormalizedUrl(db: D1Database, normalizedUrl: string): Promise<PublicationRow | null> {
  return db.prepare("SELECT * FROM publications WHERE normalized_url = ?1").bind(normalizedUrl).first<PublicationRow>();
}

export async function registerPublication(
  db: D1Database,
  sourceUrl: string,
  feedUrl: string,
  normalizedUrl: string,
  source: SourcePublication,
  baseUrl: string
): Promise<RegisterPublicationResponse> {
  const existing = await getPublicationByNormalizedUrl(db, normalizedUrl);
  if (existing) {
    return { created: false, publication: toPublicationSummary(existing, baseUrl) };
  }

  const hash = await sha256Hex(normalizedUrl);
  const slug = await uniqueSlug(db, source.title, hash);
  await db
    .prepare(
      `INSERT INTO publications (
        source_url, feed_url, normalized_url, url_hash, slug, title, description, author, image_url, site_url, language, status
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active')`
    )
    .bind(
      sourceUrl,
      feedUrl,
      normalizedUrl,
      hash,
      slug,
      source.title,
      source.description,
      source.author,
      source.imageUrl,
      source.siteUrl,
      source.language
    )
    .run();

  const created = await getPublicationBySlug(db, slug);
  if (!created) {
    throw new Error("Publication was inserted but could not be reloaded.");
  }

  return { created: true, publication: toPublicationSummary(created, baseUrl) };
}

export async function updatePublicationFromSource(
  db: D1Database,
  publication: PublicationRow,
  source: SourcePublication
): Promise<void> {
  await db
    .prepare(
      `UPDATE publications
      SET title = ?2, description = ?3, author = ?4, image_url = ?5, site_url = ?6, language = ?7,
        status = 'active', last_refreshed_at = ?8, last_error = NULL, updated_at = ?8
      WHERE id = ?1`
    )
    .bind(
      publication.id,
      source.title,
      source.description,
      source.author,
      source.imageUrl,
      source.siteUrl,
      source.language,
      new Date().toISOString()
    )
    .run();
}

export async function updatePublicationBrandedArtwork(
  db: D1Database,
  publicationId: number,
  key: string,
  sourceImageUrl: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE publications
      SET branded_image_key = ?2,
          branded_image_source_url = ?3,
          branded_image_updated_at = ?4,
          updated_at = ?4
      WHERE id = ?1`
    )
    .bind(publicationId, key, sourceImageUrl, now)
    .run();
}

export async function getPublicationBrandedArtworkKey(db: D1Database, slug: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT branded_image_key FROM publications WHERE slug = ?1 LIMIT 1")
    .bind(slug)
    .first<{ branded_image_key: string | null }>();
  return row?.branded_image_key ?? null;
}

export async function upsertPosts(db: D1Database, publicationId: number, source: SourcePublication): Promise<number[]> {
  const insertedOrPendingIds: number[] = [];
  for (const post of source.posts) {
    const skip = shouldSkipPost(post);
    await db
      .prepare(
        `INSERT INTO posts (
          publication_id, post_key, guid, title, canonical_url, description, html_content, text_content,
          visual_metadata_json, author, image_url, pub_date, pub_date_ms, status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(publication_id, post_key) DO UPDATE SET
          title = excluded.title,
          canonical_url = COALESCE(excluded.canonical_url, posts.canonical_url),
          description = COALESCE(excluded.description, posts.description),
          html_content = COALESCE(excluded.html_content, posts.html_content),
          text_content = COALESCE(excluded.text_content, posts.text_content),
          visual_metadata_json = excluded.visual_metadata_json,
          author = COALESCE(excluded.author, posts.author),
          image_url = COALESCE(excluded.image_url, posts.image_url),
          pub_date = COALESCE(excluded.pub_date, posts.pub_date),
          pub_date_ms = COALESCE(excluded.pub_date_ms, posts.pub_date_ms),
          status = CASE
            WHEN posts.status IN ('ready', 'narrating', 'scripted') THEN posts.status
            WHEN excluded.status = 'skipped' THEN 'skipped'
            ELSE posts.status
          END,
          processing_details_json = CASE
            WHEN excluded.status = 'skipped' THEN json_set(posts.processing_details_json, '$.skipReason', ?15)
            ELSE posts.processing_details_json
          END,
          updated_at = CURRENT_TIMESTAMP`
      )
      .bind(
        publicationId,
        post.postKey,
        post.guid,
        post.title,
        post.canonicalUrl,
        post.description,
        post.htmlContent,
        post.textContent,
        JSON.stringify(post.visualMetadata),
        post.author,
        post.imageUrl,
        post.pubDate,
        post.pubDateMs,
        skip.shouldSkip ? "skipped" : "pending",
        skip.reason
      )
      .run();

    const row = await db
      .prepare("SELECT id, status FROM posts WHERE publication_id = ?1 AND post_key = ?2")
      .bind(publicationId, post.postKey)
      .first<{ id: number; status: string }>();
    if (row && !skip.shouldSkip && (row.status === "pending" || row.status === "failed")) {
      insertedOrPendingIds.push(row.id);
    }
  }

  return insertedOrPendingIds;
}

export async function enqueuePosts(env: Env, publicationId: number, postIds: number[]): Promise<number> {
  const now = new Date().toISOString();
  const messages: PostQueueMessage[] = postIds.map((postId) => ({
    type: "post.generate",
    jobId: crypto.randomUUID(),
    publicationId,
    postId,
    enqueuedAt: now,
    attempt: 0
  }));

  for (const message of messages) {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, kind, publication_id, post_id, status, payload_json)
        VALUES (?1, ?2, ?3, ?4, 'queued', ?5)`
      )
      .bind(message.jobId, message.type, publicationId, message.postId, JSON.stringify(message))
      .run();
  }

  if (messages.length > 0) {
    await env.PROCESSING_QUEUE.sendBatch(messages.map((body) => ({ body })));
  }

  return messages.length;
}

export async function getPublicationDetail(
  db: D1Database,
  slug: string,
  baseUrl: string
): Promise<PublicationDetailResponse | null> {
  const publication = await getPublicationBySlug(db, slug);
  if (!publication) {
    return null;
  }
  const posts = await db
    .prepare(
      `SELECT posts.*, publications.slug AS publication_slug
      FROM posts
      JOIN publications ON publications.id = posts.publication_id
      WHERE publication_id = ?1
      ORDER BY COALESCE(pub_date_ms, CAST(strftime('%s', posts.created_at) AS INTEGER) * 1000) DESC, posts.id DESC
      LIMIT 100`
    )
    .bind(publication.id)
    .all<PostRow & { publication_slug: string }>();

  return {
    publication: toPublicationSummary(publication, baseUrl),
    posts: posts.results.map((post) => toPostSummary(post, baseUrl))
  };
}

export async function getPostDetail(db: D1Database, postId: number, baseUrl: string): Promise<PostDetailResponse | null> {
  const post = await db
    .prepare(
      `SELECT posts.*, publications.slug AS publication_slug
      FROM posts
      JOIN publications ON publications.id = posts.publication_id
      WHERE posts.id = ?1`
    )
    .bind(postId)
    .first<PostRow & { publication_slug: string; script: string | null }>();
  if (!post) {
    return null;
  }

  let visualMetadata: PostDetailResponse["post"]["visualMetadata"] = [];
  try {
    const parsed = JSON.parse(post.visual_metadata_json) as unknown;
    visualMetadata = Array.isArray(parsed) ? parsed.filter((item): item is PostDetailResponse["post"]["visualMetadata"][number] => Boolean(item && typeof item === "object")) : [];
  } catch {
    visualMetadata = [];
  }

  return {
    post: {
      ...toPostSummary(post, baseUrl),
      textContent: post.text_content,
      script: post.script ?? null,
      visualMetadata,
      lastError: post.last_error
    }
  };
}

export async function getHome(db: D1Database, baseUrl: string): Promise<HomeResponse> {
  const publications = await db
    .prepare(
      `SELECT *
      FROM publications
      WHERE status != 'failed'
      ORDER BY COALESCE(last_refreshed_at, created_at) DESC
      LIMIT 24`
    )
    .all<PublicationRow>();
  const posts = await db
    .prepare(
      `SELECT posts.*, publications.slug AS publication_slug
      FROM posts
      JOIN publications ON publications.id = posts.publication_id
      WHERE posts.status IN ('ready', 'narrating', 'pending', 'failed')
      ORDER BY COALESCE(posts.pub_date_ms, CAST(strftime('%s', posts.created_at) AS INTEGER) * 1000) DESC, posts.id DESC
      LIMIT 24`
    )
    .all<PostRow & { publication_slug: string }>();

  return {
    publications: publications.results.map((publication) => toPublicationSummary(publication, baseUrl)),
    latestPosts: posts.results.map((post) => toPostSummary(post, baseUrl))
  };
}

export async function getAudioSource(db: D1Database, postId: number): Promise<{ key: string } | null> {
  const row = await db
    .prepare("SELECT audio_key FROM posts WHERE id = ?1 AND audio_key IS NOT NULL")
    .bind(postId)
    .first<{ audio_key: string }>();
  return row ? { key: row.audio_key } : null;
}
