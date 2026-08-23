import type { PostQueueMessage } from "@podnarr/shared/queue";
import type { TtsProvider } from "@podnarr/shared/tts";

import type { AudioServiceContainer } from "./audioContainer";

export interface Env {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  PROCESSING_QUEUE: Queue<PostQueueMessage>;
  AUDIO_SERVICE: DurableObjectNamespace<AudioServiceContainer>;
  AUDIO_SERVICE_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_IMAGE_MODEL?: string;
  AI_GATEWAY_API_KEY?: string;
  FISH_AUDIO_VOICE?: string;
  PODNARR_SITE_URL?: string;
  PROCESSING_VERSION: string;
  DEFAULT_TTS_PROVIDER?: TtsProvider;
  DEFAULT_TTS_MODEL?: string;
  DEFAULT_TTS_VOICE?: string;
  DISCORD_WEBHOOK_URL?: string;
}
