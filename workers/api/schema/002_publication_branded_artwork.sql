-- Store a podnarr-branded version of each publication's artwork (source image + P corner badge)
-- so podcast clients display the generated podcast identity in their UI.
ALTER TABLE publications ADD COLUMN branded_image_key TEXT;
ALTER TABLE publications ADD COLUMN branded_image_source_url TEXT;
ALTER TABLE publications ADD COLUMN branded_image_updated_at TEXT;
