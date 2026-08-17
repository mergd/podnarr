CREATE TABLE IF NOT EXISTS narration_jobs (
  id TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  voice TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  assembly_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_progress_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS narration_jobs_status_progress_idx
  ON narration_jobs(status, last_progress_at);

CREATE TABLE IF NOT EXISTS narration_chunks (
  narration_job_id TEXT NOT NULL REFERENCES narration_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_key TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_used TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (narration_job_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS narration_chunks_status_idx
  ON narration_chunks(narration_job_id, status, chunk_index);
