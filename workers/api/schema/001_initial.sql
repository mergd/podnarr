CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Substack',
  description TEXT,
  author TEXT,
  image_url TEXT,
  site_url TEXT,
  language TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_refreshed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS publications_normalized_url_idx
  ON publications(normalized_url);

CREATE UNIQUE INDEX IF NOT EXISTS publications_url_hash_idx
  ON publications(url_hash);

CREATE UNIQUE INDEX IF NOT EXISTS publications_slug_idx
  ON publications(slug);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  post_key TEXT NOT NULL,
  guid TEXT,
  title TEXT NOT NULL DEFAULT 'Untitled post',
  canonical_url TEXT,
  description TEXT,
  html_content TEXT,
  text_content TEXT,
  visual_metadata_json TEXT NOT NULL DEFAULT '[]',
  author TEXT,
  image_url TEXT,
  pub_date TEXT,
  pub_date_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  script TEXT,
  script_hash TEXT,
  audio_key TEXT,
  duration_seconds INTEGER,
  tts_provider TEXT,
  tts_model TEXT,
  tts_voice TEXT,
  estimated_cost_usd REAL,
  narration_job_id TEXT,
  narration_job_status TEXT,
  processing_details_json TEXT NOT NULL DEFAULT '{}',
  processing_version TEXT,
  last_processed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS posts_publication_post_key_idx
  ON posts(publication_id, post_key);

CREATE INDEX IF NOT EXISTS posts_publication_pub_date_idx
  ON posts(publication_id, pub_date_ms DESC);

CREATE INDEX IF NOT EXISTS posts_status_idx
  ON posts(status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  publication_id INTEGER REFERENCES publications(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS jobs_status_kind_idx
  ON jobs(status, kind);
