import type { RegisterPublicationRequest } from "@podnarr/shared/api";
import type { TtsProvider } from "@podnarr/shared/tts";

import type { Env } from "./env";
import { brandedArtworkSourceKey, generateBrandedArtwork } from "./lib/artwork";
import {
  enqueuePosts,
  getAudioSource,
  getHome,
  getPostDetail,
  getPublicationBrandedArtworkKey,
  getPublicationBySlug,
  getPublicationDetail,
  registerPublication,
  toPublicationSummary,
  updatePublicationBrandedArtwork,
  updatePublicationFromSource,
  upsertPosts
} from "./lib/registry";
import { buildPodcastRss } from "./lib/rss";
import { fetchSubstackFeed, normalizeSubstackUrl } from "./lib/substack";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS,HEAD",
  "access-control-allow-headers": "content-type,x-admin-secret"
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(data) ?? "null", { status, headers: { "content-type": "application/json" } }));
}

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return withCors(new Response(body, { status, headers: { "content-type": contentType } }));
}

function baseUrl(request: Request, env: Env): string {
  return env.APP_BASE_URL?.trim() || new URL(request.url).origin;
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function verifyAdmin(request: Request, env: Env): boolean {
  return Boolean(env.ADMIN_SECRET) && request.headers.get("x-admin-secret") === env.ADMIN_SECRET;
}

function autoQueueNarration(env: Env): boolean {
  const raw = (env.AUTO_QUEUE_NARRATION ?? "false").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function maxPostsPerRefresh(env: Env): number {
  const parsed = Number.parseInt(env.MAX_POSTS_PER_REFRESH ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function brandedArtworkKey(slug: string): string {
  return `publication-artwork/${slug}.png`;
}

async function syncBrandedArtwork(env: Env, publication: Awaited<ReturnType<typeof getPublicationBySlug>>, sourceImageUrl: string | null): Promise<void> {
  if (!publication || !sourceImageUrl) {
    return;
  }

  const sourceKey = brandedArtworkSourceKey(sourceImageUrl);
  const alreadyBrandedForThisSource =
    publication.branded_image_key !== null && publication.branded_image_source_url === sourceKey;
  if (alreadyBrandedForThisSource) {
    return;
  }

  try {
    const { bytes, contentType } = await generateBrandedArtwork(sourceImageUrl);
    const key = brandedArtworkKey(publication.slug);
    await env.AUDIO_BUCKET.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=86400" }
    });
    await updatePublicationBrandedArtwork(env.DB, publication.id, key, sourceKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[artwork] failed to generate branded artwork for ${publication.slug}: ${message}`);
  }
}

async function refreshPublication(env: Env, slug: string, requestBaseUrl: string) {
  const publication = await getPublicationBySlug(env.DB, slug);
  if (!publication) {
    return null;
  }

  const source = await fetchSubstackFeed(publication.feed_url);
  await updatePublicationFromSource(env.DB, publication, source);
  const pendingPostIds = await upsertPosts(env.DB, publication.id, source);
  await syncBrandedArtwork(env, publication, source.imageUrl);
  const queueLimit = autoQueueNarration(env) ? maxPostsPerRefresh(env) : 0;
  const queuedIds = pendingPostIds.slice(0, queueLimit);
  const queuedPosts = queuedIds.length > 0 ? await enqueuePosts(env, publication.id, queuedIds) : 0;
  const updated = await getPublicationBySlug(env.DB, slug);

  return {
    publication: toPublicationSummary(updated ?? publication, requestBaseUrl),
    discoveredPosts: source.posts.length,
    pendingPosts: pendingPostIds.length,
    queuedPosts,
    autoQueueNarration: autoQueueNarration(env)
  };
}

async function handleAdminRegister(request: Request, env: Env): Promise<Response> {
  if (!verifyAdmin(request, env)) {
    return unauthorized();
  }

  const body = (await request.json()) as Partial<RegisterPublicationRequest>;
  if (!body.url) {
    return json({ error: "A Substack URL is required." }, 400);
  }

  const normalized = normalizeSubstackUrl(body.url);
  const source = await fetchSubstackFeed(normalized.feedUrl);
  const result = await registerPublication(
    env.DB,
    normalized.sourceUrl,
    normalized.feedUrl,
    normalized.normalizedUrl,
    source,
    baseUrl(request, env)
  );
  const refreshed = await refreshPublication(env, result.publication.slug, baseUrl(request, env));
  return json({ ...result, refresh: refreshed });
}

async function handleAdminRefresh(request: Request, env: Env, slug: string): Promise<Response> {
  if (!verifyAdmin(request, env)) {
    return unauthorized();
  }
  const refreshed = await refreshPublication(env, slug, baseUrl(request, env));
  return refreshed ? json(refreshed) : json({ error: "Not found" }, 404);
}

async function handleAdminGenerate(request: Request, env: Env, postId: number): Promise<Response> {
  if (!verifyAdmin(request, env)) {
    return unauthorized();
  }
  const body = request.headers.get("content-type")?.includes("application/json")
    ? ((await request.json()) as Partial<{ provider: TtsProvider; model: string; voice: string }>)
    : {};
  const row = await env.DB
    .prepare("SELECT publication_id FROM posts WHERE id = ?1")
    .bind(postId)
    .first<{ publication_id: number }>();
  if (!row) {
    return json({ error: "Not found" }, 404);
  }
  await env.DB
    .prepare(
      `UPDATE posts
      SET status = 'pending',
        tts_provider = COALESCE(?2, tts_provider),
        tts_model = COALESCE(?3, tts_model),
        tts_voice = COALESCE(?4, tts_voice),
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?1`
    )
    .bind(postId, body.provider ?? null, body.model ?? null, body.voice ?? null)
    .run();
  const queuedPosts = await enqueuePosts(env, row.publication_id, [postId]);
  return json({ queuedPosts, overrides: { provider: body.provider ?? null, model: body.model ?? null, voice: body.voice ?? null } });
}

async function handleAudio(request: Request, env: Env, postId: number): Promise<Response> {
  const source = await getAudioSource(env.DB, postId);
  if (!source) {
    return json({ error: "Not found" }, 404);
  }
  const head = await env.AUDIO_BUCKET.head(source.key);
  if (!head) {
    return json({ error: "Not found" }, 404);
  }

  const rangeHeader = request.headers.get("range");
  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "audio/mpeg");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=300");

  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
      if (start < head.size && end >= start) {
        const length = end - start + 1;
        headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
        headers.set("content-length", String(length));
        if (request.method === "HEAD") {
          return withCors(new Response(null, { status: 206, headers }));
        }
        const object = await env.AUDIO_BUCKET.get(source.key, { range: { offset: start, length } });
        return object ? withCors(new Response(object.body, { status: 206, headers })) : json({ error: "Not found" }, 404);
      }
    }
  }

  headers.set("content-length", String(head.size));
  if (request.method === "HEAD") {
    return withCors(new Response(null, { headers }));
  }
  const object = await env.AUDIO_BUCKET.get(source.key);
  return object ? withCors(new Response(object.body, { headers })) : json({ error: "Not found" }, 404);
}

async function handlePublicationArtwork(request: Request, env: Env, slug: string): Promise<Response> {
  const key = await getPublicationBrandedArtworkKey(env.DB, slug);
  if (!key) {
    return json({ error: "Not found" }, 404);
  }

  const isHead = request.method === "HEAD";
  const object = isHead ? await env.AUDIO_BUCKET.head(key) : await env.AUDIO_BUCKET.get(key);
  if (!object) {
    return json({ error: "Not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "image/png");
  headers.set("cache-control", "public, max-age=86400");
  if (object.etag) {
    headers.set("etag", `"${object.etag}"`);
  }

  if (isHead) {
    return withCors(new Response(null, { status: 200, headers }));
  }
  return withCors(new Response((object as R2ObjectBody).body, { status: 200, headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/g, "") || "/";

    try {
      if (request.method === "GET" && path === "/api/home") {
        return json(await getHome(env.DB, baseUrl(request, env)));
      }
      if (request.method === "POST" && path === "/admin/publications") {
        return handleAdminRegister(request, env);
      }
      const refreshMatch = /^\/admin\/publications\/([^/]+)\/refresh$/.exec(path);
      if (request.method === "POST" && refreshMatch?.[1]) {
        return handleAdminRefresh(request, env, refreshMatch[1]);
      }
      const generateMatch = /^\/admin\/posts\/(\d+)\/generate$/.exec(path);
      if (request.method === "POST" && generateMatch?.[1]) {
        return handleAdminGenerate(request, env, Number(generateMatch[1]));
      }
      const showMatch = /^\/api\/shows\/([^/]+)$/.exec(path);
      if (request.method === "GET" && showMatch?.[1]) {
        const detail = await getPublicationDetail(env.DB, showMatch[1], baseUrl(request, env));
        return detail ? json(detail) : json({ error: "Not found" }, 404);
      }
      const postMatch = /^\/api\/posts\/(\d+)$/.exec(path);
      if (request.method === "GET" && postMatch?.[1]) {
        const detail = await getPostDetail(env.DB, Number(postMatch[1]), baseUrl(request, env));
        return detail ? json(detail) : json({ error: "Not found" }, 404);
      }
      const rssMatch = /^\/shows\/([^/]+)\/rss\.xml$/.exec(path);
      if (request.method === "GET" && rssMatch?.[1]) {
        const detail = await getPublicationDetail(env.DB, rssMatch[1], baseUrl(request, env));
        return detail ? text(buildPodcastRss(detail.publication, detail.posts), 200, "application/rss+xml; charset=utf-8") : json({ error: "Not found" }, 404);
      }
      const audioMatch = /^\/audio\/(\d+)\.mp3$/.exec(path);
      if ((request.method === "GET" || request.method === "HEAD") && audioMatch?.[1]) {
        return handleAudio(request, env, Number(audioMatch[1]));
      }
      const artworkMatch = /^\/publication-artwork\/([^/]+)\.png$/.exec(path);
      if ((request.method === "GET" || request.method === "HEAD") && artworkMatch?.[1]) {
        return handlePublicationArtwork(request, env, artworkMatch[1]);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      return json({ error: message }, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const publications = await env.DB
      .prepare("SELECT slug FROM publications WHERE status != 'failed' ORDER BY COALESCE(last_refreshed_at, created_at) ASC LIMIT 10")
      .all<{ slug: string }>();
    for (const publication of publications.results) {
      await refreshPublication(env, publication.slug, env.APP_BASE_URL ?? "https://api.podnarr.example");
    }
  }
};
