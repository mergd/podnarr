ALTER TABLE narration_jobs ADD COLUMN pcm_cleaned_at TEXT;
ALTER TABLE narration_jobs ADD COLUMN pcm_cleanup_attempted_at TEXT;

CREATE INDEX narration_jobs_pcm_cleanup_idx
  ON narration_jobs(pcm_cleanup_attempted_at, id)
  WHERE status = 'succeeded' AND pcm_cleaned_at IS NULL;
