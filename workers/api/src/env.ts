import type { PostQueueMessage } from "@podnarr/shared/queue";

export interface Env {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  PROCESSING_QUEUE: Queue<PostQueueMessage>;
  ASSETS: Fetcher;
  ADMIN_SECRET?: string;
  APP_BASE_URL?: string;
  PUBLIC_UI_BASE_URL?: string;
  PROCESSING_VERSION: string;
  MAX_POSTS_PER_REFRESH?: string;
  AUTO_QUEUE_NARRATION?: string;
}
