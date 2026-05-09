export type PostQueueMessage =
  | {
      type: "post.generate";
      jobId: string;
      publicationId: number;
      postId: number;
      enqueuedAt: string;
      attempt: number;
    }
  | {
      type: "post.poll_narration";
      jobId: string;
      publicationId: number;
      postId: number;
      externalJobId: string;
      enqueuedAt: string;
      attempt: number;
    };

export const MAX_POST_PROCESSING_ATTEMPTS = 4;
export const MAX_NARRATION_POLL_ATTEMPTS = 96;
