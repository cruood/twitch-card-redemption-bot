ALTER TABLE streams
ADD COLUMN IF NOT EXISTS last_live_at TIMESTAMPTZ;

UPDATE streams
SET last_live_at = COALESCE(ended_at, started_at)
WHERE last_live_at IS NULL;

ALTER TABLE streams
ALTER COLUMN last_live_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS streams_active_idx
ON streams (started_at DESC)
WHERE ended_at IS NULL;
