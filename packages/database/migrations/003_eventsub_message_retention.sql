CREATE INDEX IF NOT EXISTS eventsub_messages_processed_idx
ON eventsub_messages (processed_at);
