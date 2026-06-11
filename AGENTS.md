# Agent guidance

## TTS and Gemini API cost

Narration uses **Gemini TTS** (`gemini-3.1-flash-tts-preview` via batch by default). Each episode is split into many chunks; every chunk is a paid API call (batch is ~50% cheaper than sync, but still adds up).

When verifying audio/TTS changes:

- **Keep test scripts short** — a sentence or two is enough for smoke tests, not full articles or 50-chunk episodes.
- **Do not loop full-episode renders** to debug retry/batch logic; test one chunk or a tiny 2–3 chunk script.
- **Prefer local mock rendering** — leave `ENABLE_MOCK_RENDERER` unset (defaults on) or set it explicitly when you only need pipeline/ffmpeg behavior, not real voice quality.
- **Avoid re-running production narrations** unless the user asks; use admin generate on a single post sparingly.
- **Production auto-queues new episodes on refresh** (`AUTO_QUEUE_NARRATION=true`, `MAX_POSTS_PER_REFRESH=1`). Only `pending` posts without an in-flight `post.generate` job are queued; `failed` posts are not retried automatically. Manual override: `POST /admin/posts/:id/generate`.
- **Batch jobs are async** — polling is expected; do not hammer create/poll in tight loops.

For unit-level checks, mock `fetch` or test pure helpers (`splitScript`, batch response parsing, job manifest) instead of calling Google.
