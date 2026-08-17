# Podnarr

Substack-to-podcast narration service.

Podnarr turns Substack posts into narrated podcast episodes through a private admin API and exposes public listener pages plus podcast RSS feeds. The first quality/cost target is Gemini Flash TTS through the Gemini Batch API when supported, with provider contracts kept open for ElevenLabs, Inworld, MiniMax, OpenAI, and local experiments.

## Workspace

- `ui`: Vite React public listener UI.
- `workers/api`: Cloudflare Worker for admin/public APIs, D1, R2, RSS, scheduled refresh.
- `workers/processor`: Cloudflare Queue consumer for article narration jobs.
- `services/audio`: Fastify service for TTS batch orchestration and ffmpeg assembly, deployed as a Cloudflare Container attached to the processor worker.
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

The audio service runs as a single Cloudflare Container instance (`AudioServiceContainer` Durable Object on `podnarr-processor`). The processor reaches it through the `AUDIO_SERVICE` binding, so it has no public URL. Job state lives on the container's ephemeral disk; the container stays awake for 30 minutes after the last request (longer than the 15-minute poll gap) and scales to zero when idle. Deploying the processor replaces the container, which drops in-flight narration jobs — same as a Railway redeploy did. Container secrets (`GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`, optional `AUDIO_SERVICE_TOKEN`) are set as worker secrets on `podnarr-processor` and forwarded into the container.

Narration uses SpeechSDK direct-provider adapters. The default is Fish Audio's temporary `s2.1-pro-free` model; set `FISH_AUDIO_API_KEY` and `FISH_AUDIO_VOICE` (a Fish reference voice id) on `podnarr-processor`. If a Fish chunk fails, Podnarr retries that chunk with Gemini 3.1 Flash TTS using `GEMINI_API_KEY` and optional `GEMINI_TTS_FALLBACK_VOICE` (default: `Orus`).

The API skips obvious non-episode posts before queueing narration, including Open Threads, hidden open threads, meetup announcements, simple announcements, and very short posts.
