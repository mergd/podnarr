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
      type: "post.poll_script_prep";
      jobId: string;
      publicationId: number;
      postId: number;
      prepareJobId: string;
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
    }
  | {
      type: "narration.render_chunk";
      jobId: string;
      publicationId: number;
      postId: number;
      narrationJobId: string;
      chunkIndex: number;
      enqueuedAt: string;
      attempt: number;
    }
  | {
      type: "narration.assemble";
      jobId: string;
      publicationId: number;
      postId: number;
      narrationJobId: string;
      enqueuedAt: string;
      attempt: number;
    };

export const MAX_POST_PROCESSING_ATTEMPTS = 4;
export const MAX_SCRIPT_PREP_POLL_ATTEMPTS = 40;
export const MAX_NARRATION_POLL_ATTEMPTS = 96;
export const MAX_NARRATION_CHUNK_ATTEMPTS = 5;
export const MAX_NARRATION_ASSEMBLY_ATTEMPTS = 4;
