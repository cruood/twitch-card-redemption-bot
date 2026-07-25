-- Initial economy, pack-opening, and moderation-audit schema.
CREATE TABLE users (
  id UUID PRIMARY KEY,
  twitch_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  attendance_streak INTEGER NOT NULL DEFAULT 0 CHECK (attendance_streak >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE streams (
  id UUID PRIMARY KEY,
  twitch_stream_id TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE INDEX streams_started_idx ON streams (started_at DESC);

CREATE TABLE stream_participation (
  user_id UUID NOT NULL REFERENCES users(id),
  stream_id UUID NOT NULL REFERENCES streams(id),
  opted_in_at TIMESTAMPTZ,
  last_accrued_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  reward_redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (reward_redemption_count >= 0),
  PRIMARY KEY (user_id, stream_id)
);

CREATE TABLE currency_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  stream_id UUID REFERENCES streams(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source_event_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX currency_ledger_user_created_idx
ON currency_ledger (user_id, created_at);

CREATE TABLE card_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical')),
  trade_in_reward_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE pack_openings (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  stream_id UUID REFERENCES streams(id),
  batch_size INTEGER NOT NULL CHECK (batch_size IN (1, 5, 10)),
  currency_cost INTEGER NOT NULL CHECK (currency_cost >= 0),
  source_event_id TEXT UNIQUE,
  participation_signals JSONB NOT NULL,
  legendary_budget_before NUMERIC NOT NULL,
  legendary_budget_after NUMERIC NOT NULL,
  mythical_budget_before NUMERIC NOT NULL,
  mythical_budget_after NUMERIC NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pack_openings_user_opened_idx
ON pack_openings (user_id, opened_at);

CREATE TABLE inventory (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES card_definitions(id),
  pack_opening_id UUID NOT NULL REFERENCES pack_openings(id),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);

CREATE TABLE pack_opening_pulls (
  opening_id UUID NOT NULL REFERENCES pack_openings(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  card_id TEXT NOT NULL REFERENCES card_definitions(id),
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical')),
  boost_multiplier NUMERIC NOT NULL CHECK (boost_multiplier >= 1),
  rarity_roll DOUBLE PRECISION NOT NULL CHECK (rarity_roll >= 0 AND rarity_roll < 1),
  PRIMARY KEY (opening_id, ordinal)
);

CREATE INDEX inventory_user_available_idx
ON inventory (user_id, acquired_at)
WHERE consumed_at IS NULL;

CREATE TABLE global_rarity_budget (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  legendary_available NUMERIC NOT NULL CHECK (legendary_available BETWEEN 0 AND 1),
  mythical_available NUMERIC NOT NULL CHECK (mythical_available BETWEEN 0 AND 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO global_rarity_budget (legendary_available, mythical_available)
VALUES (1, 1);

CREATE TABLE eventsub_messages (
  message_id TEXT PRIMARY KEY,
  subscription_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trade_ins (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  target_twitch_user_id TEXT,
  reward_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE protected_targets (
  twitch_user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
