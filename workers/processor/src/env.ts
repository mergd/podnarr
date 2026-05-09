import type { PostQueueMessage } from "@podnarr/shared/queue";
import type { TtsProvider } from "@podnarr/shared/tts";

export interface Env {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  PROCESSING_QUEUE: Queue<PostQueueMessage>;
  AUDIO_SERVICE_URL: string;
  AUDIO_SERVICE_TOKEN?: string;
  PROCESSING_VERSION: string;
  DEFAULT_TTS_PROVIDER?: TtsProvider;
  DEFAULT_TTS_MODEL?: string;
  DEFAULT_TTS_VOICE?: string;
  DISCORD_WEBHOOK_URL?: string;
}
