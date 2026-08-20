# Podnarr

Substack-to-podcast narration service.

Podnarr turns Substack posts into narrated podcast episodes through a private admin API and exposes public listener pages plus podcast RSS feeds. The first quality/cost target is Fish Audio (`s2.1-pro-free`) through SpeechSDK, with provider contracts kept open for ElevenLabs, Inworld, MiniMax, OpenAI, and local experiments. Gemini TTS is unwired.

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

Gemini Batch is unwired. Narration jobs render Fish Audio chunks synchronously in the audio container and persist progress in D1/R2.

The audio service generates intro/outro jingle assets deterministically at runtime and reuses them from its render directory. Workers do not need committed jingle MP3s; they only store and serve final episode MP3s from R2.

The audio service runs as a single Cloudflare Container instance (`AudioServiceContainer` Durable Object on `podnarr-processor`). The processor reaches it through the `AUDIO_SERVICE` binding, so it has no public URL. Job state lives on the container's ephemeral disk; the container stays awake for 30 minutes after the last request (longer than the 15-minute poll gap) and scales to zero when idle. Deploying the processor replaces the container, which drops in-flight narration jobs — same as a Railway redeploy did. Container secrets (`FISH_AUDIO_API_KEY`, `OPENROUTER_API_KEY`, `DISCORD_WEBHOOK_URL`, optional `AUDIO_SERVICE_TOKEN`) are set as worker secrets on `podnarr-processor` and forwarded into the container. Optional `OPENROUTER_IMAGE_MODEL` defaults to `openai/gpt-5.6-luna`.

Narration uses SpeechSDK with Fish Audio's temporary `s2.1-pro-free` model. Set `FISH_AUDIO_API_KEY` and `FISH_AUDIO_VOICE` (a Fish reference voice id) on `podnarr-processor`. Failed Fish chunks fail the job; they do not fall back to Gemini TTS.

The API skips obvious non-episode posts before queueing narration, including Open Threads, hidden open threads, meetup announcements, simple announcements, and very short posts.
