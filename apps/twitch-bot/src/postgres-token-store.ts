import { type PostgresDatabase, type SqlExecutor } from "@cardbot/database";
import { type TwitchTokenSnapshot, type TwitchTokenStore } from "./twitch-tokens.js";

const REFRESH_LOCK_KEY = "cardbot_twitch_oauth_refresh";

export class PostgresTwitchTokenStore implements TwitchTokenStore {
  constructor(
    private readonly database: SqlExecutor,
    private readonly lockDatabase?: PostgresDatabase
  ) {}

  async load(): Promise<TwitchTokenSnapshot | null> {
    const rows = await this.database.query<{
      audience: "bot" | "broadcaster";
      access_token: string;
      refresh_token: string;
    }>(
      `SELECT audience, access_token, refresh_token
       FROM twitch_oauth_tokens
       WHERE audience IN ('bot', 'broadcaster')`
    );
    if (rows.length === 0) return null;

    const pairs = new Map(rows.map((row) => [row.audience, {
      accessToken: row.access_token,
      refreshToken: row.refresh_token
    }]));
    const bot = pairs.get("bot");
    const broadcaster = pairs.get("broadcaster");
    if (!bot || !broadcaster) {
      throw new Error("PostgreSQL Twitch token store is incomplete");
    }
    return { bot, broadcaster };
  }

  async persist(tokens: TwitchTokenSnapshot): Promise<void> {
    await this.database.query(
      `INSERT INTO twitch_oauth_tokens (audience, access_token, refresh_token, updated_at)
       VALUES
         ('bot', $1, $2, now()),
         ('broadcaster', $3, $4, now())
       ON CONFLICT (audience) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           updated_at = EXCLUDED.updated_at`,
      [
        tokens.bot.accessToken,
        tokens.bot.refreshToken,
        tokens.broadcaster.accessToken,
        tokens.broadcaster.refreshToken
      ]
    );
  }

  withRefreshLock<T>(work: (store: TwitchTokenStore) => Promise<T>): Promise<T> {
    if (!this.lockDatabase) return work(this);
    return this.lockDatabase.withAdvisoryLock(REFRESH_LOCK_KEY, (database) =>
      work(new PostgresTwitchTokenStore(database))
    );
  }
}
