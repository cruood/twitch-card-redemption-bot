CREATE TABLE twitch_oauth_tokens (
  audience TEXT PRIMARY KEY CHECK (audience IN ('bot', 'broadcaster')),
  access_token TEXT NOT NULL CHECK (length(access_token) > 0),
  refresh_token TEXT NOT NULL CHECK (length(refresh_token) > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
