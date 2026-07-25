export * from "./pack-opening.js";
export * from "./postgres.js";
export * from "./catalog.js";
export * from "./viewer-economy.js";

export interface CurrencyLedgerEntry {
  id: string;
  userId: string;
  streamId: string | null;
  amount: number;
  reason: "passive_accrual" | "pack_purchase" | "admin_adjustment" | "trade_in";
  createdAt: Date;
}

export interface ProtectedTarget {
  twitchUserId: string;
  reason: string;
  createdBy: string;
  createdAt: Date;
}

export const REQUIRED_TABLES = [
  "users",
  "streams",
  "stream_participation",
  "currency_ledger",
  "card_definitions",
  "inventory",
  "pack_openings",
  "pack_opening_pulls",
  "global_rarity_budget",
  "eventsub_messages",
  "trade_ins",
  "protected_targets",
  "twitch_oauth_tokens"
] as const;
