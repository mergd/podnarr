# Podnarr

Substack-to-podcast narration service.

Podnarr turns Substack posts into narrated podcast episodes through a private admin API and exposes public listener pages plus podcast RSS feeds. The first quality/cost target is Gemini Flash TTS through the Gemini Batch API when supported, with provider contracts kept open for ElevenLabs, Inworld, MiniMax, OpenAI, and local experiments.

## Workspace

- `ui`: Vite React public listener UI.
- `workers/api`: Cloudflare Worker for admin/public APIs, D1, R2, RSS, scheduled refresh.
- `workers/processor`: Cloudflare Queue consumer for article narration jobs.
- `services/audio`: Railway Fastify service for TTS batch orchestration and ffmpeg assembly.
- `packages/shared`: shared API, queue, and TTS contracts.

## Scripts

- `bun run dev:ui`
- `bun run dev:api`
- `bun run dev:processor`
- `bun run dev:audio`
- `bun run typecheck`
- `bun run build`

## Runtime Notes

The public frontend does not create podcasts. Add and refresh publications through admin endpoints with `x-admin-secret`.

Gemini Batch is asynchronous and targets lower cost rather than immediate output. The processor stores narration job metadata and requeues polling messages until the audio service reports completion.

The audio service generates intro/outro jingle assets deterministically at runtime and reuses them from its render directory. Workers do not need committed jingle MP3s; they only store and serve final episode MP3s from R2.

The API skips obvious non-episode posts before queueing narration, including Open Threads, hidden open threads, meetup announcements, simple announcements, and very short posts.
