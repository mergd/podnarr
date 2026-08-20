# Agent guidance

## TTS cost

Narration uses **Fish Audio** (`s2.1-pro-free` via SpeechSDK). Gemini TTS is unwired and must not be called for audio. Article image descriptions use OpenRouter (`OPENROUTER_API_KEY`, default model `openai/gpt-5.6-luna`).

When verifying audio/TTS changes:

- **Keep test scripts short** — a sentence or two is enough for smoke tests, not full articles or 50-chunk episodes.
- **Do not loop full-episode renders** to debug retry logic; test one chunk or a tiny 2–3 chunk script.
- **Prefer local mock rendering** — leave `ENABLE_MOCK_RENDERER` unset (defaults on) or set it explicitly when you only need pipeline/ffmpeg behavior, not real voice quality.
- **Avoid re-running production narrations** unless the user asks; use admin generate on a single post sparingly.
- **Production auto-queues new episodes on refresh** (`AUTO_QUEUE_NARRATION=true`, `MAX_POSTS_PER_REFRESH=1`). Only `pending` posts without an in-flight `post.generate` job are queued; `failed` posts are not retried automatically. Manual override: `POST /admin/posts/:id/generate`.

For unit-level checks, mock `fetch` or test pure helpers (`splitNarrationScript`, job manifest) instead of calling paid APIs.
