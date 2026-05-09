import type { NarrationJobStatus, TtsProvider } from "./tts";

export type PublicationStatus = "pending" | "active" | "failed";
export type PostStatus = "pending" | "scripted" | "narrating" | "ready" | "failed" | "skipped";

export interface RegisterPublicationRequest {
  url: string;
}

export interface RegisterPublicationResponse {
  created: boolean;
  publication: PublicationSummary;
}

export interface AdminRefreshResponse {
  publication: PublicationSummary;
  discoveredPosts: number;
  queuedPosts: number;
}

export interface HomeResponse {
  publications: PublicationSummary[];
  latestPosts: PostSummary[];
}

export interface PublicationSummary {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  author: string | null;
  imageUrl: string | null;
  brandedImageUrl: string | null;
  siteUrl: string | null;
  rssUrl: string;
  status: PublicationStatus;
  lastRefreshedAt: string | null;
}

export interface PublicationDetailResponse {
  publication: PublicationSummary;
  posts: PostSummary[];
}

export interface PostDetailResponse {
  post: PostSummary & {
    textContent: string | null;
    script: string | null;
    visualMetadata: Array<{
      kind?: string;
      src?: string;
      alt?: string;
      caption?: string;
    }>;
    lastError: string | null;
  };
}

export interface PostSummary {
  id: number;
  publicationSlug: string;
  title: string;
  canonicalUrl: string | null;
  description: string | null;
  imageUrl: string | null;
  author: string | null;
  pubDate: string | null;
  status: PostStatus;
  audioUrl: string | null;
  durationSeconds: number | null;
  estimatedCostUsd: number | null;
  ttsProvider: TtsProvider | null;
  ttsModel: string | null;
  ttsVoice: string | null;
  narrationJobStatus: NarrationJobStatus | null;
}
