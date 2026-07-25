import { randomUUID } from "node:crypto";
import {
  calculatePassiveAccrualResult,
  calculateNextAttendanceStreak,
  type StreamEconomyStore,
  type ActiveStreamState,
  type StreamStartedInput,
  StreamNotFoundError,
  type ViewerOptInInput,
  type ViewerOptInResult
} from "@cardbot/economy";
import { type CardDefinition } from "@cardbot/inventory";
import {
  RARITIES,
  type GlobalRarityBudget,
  type ParticipationSignals,
  type Rarity,
  replenishGlobalRarityBudget
} from "@cardbot/rarity";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  type PackOpeningTransaction,
  type PackOpeningTransactionRunner,
  type PersistPackOpeningInput
} from "./pack-opening.js";
import {
  type PersistTradeInInput,
  type TradeInTransaction,
  type TradeInTransactionRunner
} from "./trade-in.js";
import {
  type InventorySummaryItem,
  type ViewerEconomyStore,
  type ViewerRecord
} from "./viewer-economy.js";

export interface SqlExecutor {
  query<T>(sql: string, values?: readonly unknown[]): Promise<readonly T[]>;
}

export class PostgresDatabase
  implements
    SqlExecutor,
    PackOpeningTransactionRunner,
    TradeInTransactionRunner,
    StreamEconomyStore,
    ViewerEconomyStore
{
  private readonly pool: Pool;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
  }

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<readonly T[]> {
    const result = await this.pool.query(sql, [...values]);
    return result.rows as T[];
  }

  async runPackOpeningTransaction<T>(
    work: (transaction: PackOpeningTransaction) => Promise<T>
  ): Promise<T> {
    return this.runSqlTransaction((sql) => work(new PostgresPackOpeningTransaction(sql)));
  }

  async runTradeInTransaction<T>(
    work: (transaction: TradeInTransaction) => Promise<T>
  ): Promise<T> {
    return this.runSqlTransaction((sql) => work(new PostgresTradeInTransaction(sql)));
  }

  async withAdvisoryLock<T>(
    key: string,
    work: (database: SqlExecutor) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      return await work(new PoolClientExecutor(client));
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
      client.release();
    }
  }

  async recordStreamStarted(input: StreamStartedInput): Promise<string> {
    const retentionBoundary = new Date(input.startedAt.getTime() - 7 * 86_400_000);
    await this.query("DELETE FROM eventsub_messages WHERE processed_at < $1", [retentionBoundary]);
    const [row] = await this.query<{ id: string }>(
      `INSERT INTO streams (id, twitch_stream_id, started_at, last_live_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (twitch_stream_id) DO UPDATE
       SET started_at = LEAST(streams.started_at, EXCLUDED.started_at),
           last_live_at = GREATEST(streams.last_live_at, EXCLUDED.last_live_at)
       RETURNING id`,
      [randomUUID(), input.twitchStreamId, input.startedAt]
    );
    return row!.id;
  }

  async recordStreamEnded(twitchStreamId: string, endedAt: Date): Promise<void> {
    const rows = await this.query<{ id: string }>(
      `UPDATE streams SET ended_at = COALESCE(ended_at, $2)
       WHERE twitch_stream_id = $1 RETURNING id`,
      [twitchStreamId, endedAt]
    );
    if (rows.length === 0) throw new StreamNotFoundError(twitchStreamId);
  }

  async recordStreamObservedLive(twitchStreamId: string, observedAt: Date): Promise<void> {
    const rows = await this.query<{ id: string }>(
      `UPDATE streams
       SET last_live_at = GREATEST(last_live_at, $2)
       WHERE twitch_stream_id = $1 AND ended_at IS NULL
       RETURNING id`,
      [twitchStreamId, observedAt]
    );
    if (rows.length === 0) throw new StreamNotFoundError(twitchStreamId);
  }

  async optInViewer(input: ViewerOptInInput): Promise<ViewerOptInResult> {
    return this.runSqlTransaction(async (sql) => {
      const [stream] = await sql.query<{ id: string; started_at: Date | string }>(
        `SELECT id, started_at FROM streams
         WHERE twitch_stream_id = $1 AND ended_at IS NULL FOR SHARE`,
        [input.twitchStreamId]
      );
      if (!stream) throw new StreamNotFoundError(input.twitchStreamId);

      const [user] = await sql.query<{
        id: string;
        attendance_streak: number;
      }>(
        `INSERT INTO users (id, twitch_user_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (twitch_user_id) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, attendance_streak`,
        [randomUUID(), input.twitchUserId, input.displayName]
      );
      if (!user) throw new Error("User upsert did not return a row");

      const [existing] = await sql.query<{ opted_in_at: Date | string | null }>(
        `SELECT opted_in_at FROM stream_participation
         WHERE user_id = $1 AND stream_id = $2 FOR UPDATE`,
        [user.id, stream.id]
      );
      if (existing?.opted_in_at) {
        return {
          userId: user.id,
          streamId: stream.id,
          newlyOptedIn: false,
          attendanceStreak: user.attendance_streak
        };
      }

      const [previous] = await sql.query<{ attended_previous: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM stream_participation previous_participation
           WHERE previous_participation.user_id = $1
             AND previous_participation.stream_id = (
               SELECT previous_stream.id FROM streams previous_stream
               WHERE previous_stream.started_at < $2
               ORDER BY previous_stream.started_at DESC
               LIMIT 1
             )
             AND previous_participation.opted_in_at IS NOT NULL
         ) AS attended_previous`,
        [user.id, new Date(stream.started_at)]
      );
      const attendanceStreak = calculateNextAttendanceStreak(
        user.attendance_streak,
        previous?.attended_previous ?? false
      );

      await sql.query(
        `INSERT INTO stream_participation (user_id, stream_id, opted_in_at, last_accrued_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, stream_id) DO UPDATE
         SET opted_in_at = COALESCE(stream_participation.opted_in_at, EXCLUDED.opted_in_at),
             last_accrued_at = COALESCE(stream_participation.last_accrued_at, EXCLUDED.last_accrued_at)`,
        [user.id, stream.id, input.optedInAt]
      );
      await sql.query("UPDATE users SET attendance_streak = $2 WHERE id = $1", [
        user.id,
        attendanceStreak
      ]);

      return {
        userId: user.id,
        streamId: stream.id,
        newlyOptedIn: true,
        attendanceStreak
      };
    });
  }

  async listOptedInUserIds(twitchStreamId: string): Promise<readonly string[]> {
    const rows = await this.query<{ user_id: string }>(
      `SELECT sp.user_id FROM stream_participation sp
       JOIN streams s ON s.id = sp.stream_id
       WHERE s.twitch_stream_id = $1 AND sp.opted_in_at IS NOT NULL
       ORDER BY sp.user_id`,
      [twitchStreamId]
    );
    return rows.map((row) => row.user_id);
  }

  async getActiveTwitchStreamId(): Promise<string | null> {
    const [row] = await this.query<{ twitch_stream_id: string }>(
      `SELECT twitch_stream_id FROM streams
       WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
    );
    return row?.twitch_stream_id ?? null;
  }

  async getActiveStreamState(): Promise<ActiveStreamState | null> {
    const [row] = await this.query<{
      twitch_stream_id: string;
      started_at: Date | string;
      last_live_at: Date | string;
    }>(
      `SELECT twitch_stream_id, started_at, last_live_at FROM streams
       WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
    );
    return row
      ? {
          twitchStreamId: row.twitch_stream_id,
          startedAt: new Date(row.started_at),
          lastLiveAt: new Date(row.last_live_at)
        }
      : null;
  }

  async findViewerByTwitchId(twitchUserId: string): Promise<ViewerRecord | null> {
    const [row] = await this.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE twitch_user_id = $1",
      [twitchUserId]
    );
    return row ? { id: row.id, displayName: row.display_name } : null;
  }

  async findActiveStreamInternalId(twitchStreamId: string): Promise<string | null> {
    const [row] = await this.query<{ id: string }>(
      "SELECT id FROM streams WHERE twitch_stream_id = $1 AND ended_at IS NULL",
      [twitchStreamId]
    );
    return row?.id ?? null;
  }

  async getCurrencyBalance(userId: string): Promise<number> {
    const [row] = await this.query<{ balance: string | number }>(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM currency_ledger WHERE user_id = $1",
      [userId]
    );
    return Number(row?.balance ?? 0);
  }

  async getInventorySummary(userId: string): Promise<readonly InventorySummaryItem[]> {
    const rows = await this.query<{
      card_id: string;
      name: string;
      rarity: string;
      count: string | number;
    }>(
      `SELECT i.card_id, c.name, c.rarity, COUNT(*) AS count
       FROM inventory i
       JOIN card_definitions c ON c.id = i.card_id
       WHERE i.user_id = $1 AND i.consumed_at IS NULL
       GROUP BY i.card_id, c.name, c.rarity
       ORDER BY MAX(i.acquired_at) DESC`,
      [userId]
    );
    return rows.map((row) => {
      if (!isRarity(row.rarity)) throw new Error(`Unknown inventory rarity: ${row.rarity}`);
      return {
        cardId: row.card_id,
        name: row.name,
        rarity: row.rarity,
        count: Number(row.count)
      };
    });
  }

  async incrementMessageCount(
    twitchUserId: string,
    twitchStreamId: string,
    eventMessageId?: string
  ): Promise<boolean> {
    return this.incrementParticipationCounter(
      "message_count",
      twitchUserId,
      twitchStreamId,
      "channel.chat.message",
      eventMessageId
    );
  }

  async incrementRewardRedemptionCount(
    twitchUserId: string,
    twitchStreamId: string,
    eventMessageId?: string
  ): Promise<boolean> {
    return this.incrementParticipationCounter(
      "reward_redemption_count",
      twitchUserId,
      twitchStreamId,
      "channel.channel_points_custom_reward_redemption.add",
      eventMessageId
    );
  }

  async accrueOptedInUser(
    userId: string,
    twitchStreamId: string,
    now: Date
  ): Promise<number> {
    return this.runSqlTransaction(async (sql) => {
      const lockedUsers = await sql.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [userId]
      );
      if (lockedUsers.length === 0) return 0;

      const [row] = await sql.query<{
        stream_id: string;
        opted_in_at: Date | string | null;
        last_accrued_at: Date | string | null;
        ended_at: Date | string | null;
      }>(
        `SELECT sp.stream_id, sp.opted_in_at, sp.last_accrued_at, s.ended_at
         FROM stream_participation sp
         JOIN streams s ON s.id = sp.stream_id
         WHERE sp.user_id = $1 AND s.twitch_stream_id = $2
         FOR UPDATE OF sp`,
        [userId, twitchStreamId]
      );
      if (!row?.opted_in_at || !row.last_accrued_at) return 0;

      const endedAt = row.ended_at ? new Date(row.ended_at) : null;
      const effectiveNow = endedAt && endedAt < now ? endedAt : now;
      const accrual = calculatePassiveAccrualResult(
        {
          userId,
          streamId: row.stream_id,
          optedInAt: new Date(row.opted_in_at),
          lastAccruedAt: new Date(row.last_accrued_at)
        },
        effectiveNow
      );
      if (accrual.amount === 0) return 0;

      await sql.query(
        `INSERT INTO currency_ledger (id, user_id, stream_id, amount, reason, created_at)
         VALUES ($1, $2, $3, $4, 'passive_accrual', $5)`,
        [randomUUID(), userId, row.stream_id, accrual.amount, effectiveNow]
      );
      await sql.query(
        `UPDATE stream_participation SET last_accrued_at = $3
         WHERE user_id = $1 AND stream_id = $2`,
        [userId, row.stream_id, accrual.checkpoint]
      );
      return accrual.amount;
    });
  }

  private async runSqlTransaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PoolClientExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async incrementParticipationCounter(
    column: "message_count" | "reward_redemption_count",
    twitchUserId: string,
    twitchStreamId: string,
    subscriptionType: string,
    eventMessageId: string | undefined
  ): Promise<boolean> {
    return this.runSqlTransaction(async (sql) => {
      if (eventMessageId) {
        const claimed = await sql.query<{ message_id: string }>(
          `INSERT INTO eventsub_messages (message_id, subscription_type)
           VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
          [eventMessageId, subscriptionType]
        );
        if (claimed.length === 0) return false;
      }
      const rows = await sql.query<{ user_id: string }>(
        `UPDATE stream_participation sp
         SET ${column} = ${column} + 1
         FROM users u, streams s
         WHERE sp.user_id = u.id
           AND sp.stream_id = s.id
           AND u.twitch_user_id = $1
           AND s.twitch_stream_id = $2
           AND sp.opted_in_at IS NOT NULL
         RETURNING sp.user_id`,
        [twitchUserId, twitchStreamId]
      );
      return rows.length === 1;
    });
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

class PoolClientExecutor implements SqlExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<readonly T[]> {
    const result = await this.client.query(sql, [...values]);
    return result.rows as T[];
  }
}

class PostgresPackOpeningTransaction implements PackOpeningTransaction {
  constructor(private readonly sql: SqlExecutor) {}

  async lockUser(userId: string): Promise<boolean> {
    const rows = await this.sql.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    return rows.length === 1;
  }

  async getCurrencyBalance(userId: string): Promise<number> {
    const [row] = await this.sql.query<{ balance: string | number }>(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM currency_ledger WHERE user_id = $1",
      [userId]
    );
    return Number(row?.balance ?? 0);
  }

  async hasProcessedSourceEvent(sourceEventId: string): Promise<boolean> {
    const rows = await this.sql.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM currency_ledger WHERE source_event_id = $1) AS exists",
      [sourceEventId]
    );
    return rows[0]?.exists ?? false;
  }

  async getParticipationSignals(
    userId: string,
    streamId: string | null,
    now: Date
  ): Promise<ParticipationSignals> {
    if (!streamId) return emptySignals();

    const [row] = await this.sql.query<{
      opted_in_minutes: string | number;
      message_count: number;
      reward_redemption_count: number;
      attendance_streak: number;
    }>(
      `SELECT
         GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - sp.opted_in_at)) / 60) AS opted_in_minutes,
         sp.message_count,
         sp.reward_redemption_count,
         u.attendance_streak
       FROM stream_participation sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.user_id = $1 AND sp.stream_id = $2 AND sp.opted_in_at IS NOT NULL`,
      [userId, streamId, now]
    );
    if (!row) return emptySignals();

    return {
      optedInMinutes: Number(row.opted_in_minutes),
      messageCount: row.message_count,
      channelRewardRedemptions: row.reward_redemption_count,
      attendanceStreak: row.attendance_streak
    };
  }

  async getCardCatalog(): Promise<readonly CardDefinition[]> {
    const rows = await this.sql.query<{
      id: string;
      name: string;
      rarity: string;
      trade_in_reward_id: string | null;
    }>("SELECT id, name, rarity, trade_in_reward_id FROM card_definitions WHERE active = TRUE");

    return rows.map((row) => {
      if (!isRarity(row.rarity)) throw new Error(`Unknown card rarity in database: ${row.rarity}`);
      return {
        id: row.id,
        name: row.name,
        rarity: row.rarity,
        ...(row.trade_in_reward_id ? { tradeInRewardId: row.trade_in_reward_id } : {})
      };
    });
  }

  async getRarityBudget(now: Date): Promise<GlobalRarityBudget> {
    const [row] = await this.sql.query<{
      legendary_available: string | number;
      mythical_available: string | number;
      updated_at: Date | string;
    }>(
      `SELECT legendary_available, mythical_available, updated_at
       FROM global_rarity_budget WHERE singleton = TRUE FOR UPDATE`
    );
    if (!row) throw new Error("Global rarity budget row is missing");

    const updatedAt = new Date(row.updated_at);
    const elapsedDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / 86_400_000);
    return replenishGlobalRarityBudget(
      {
        legendaryAvailable: Number(row.legendary_available),
        mythicalAvailable: Number(row.mythical_available)
      },
      elapsedDays
    );
  }

  async recordPackOpening(input: PersistPackOpeningInput): Promise<string> {
    const openingId = randomUUID();
    await this.sql.query(
      `INSERT INTO pack_openings
         (id, user_id, stream_id, batch_size, currency_cost, source_event_id,
          participation_signals, legendary_budget_before, legendary_budget_after,
          mythical_budget_before, mythical_budget_after, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        openingId,
        input.userId,
        input.streamId,
        input.batchSize,
        input.currencyCost,
        input.sourceEventId ?? null,
        JSON.stringify(input.signals),
        input.budgetBefore.legendaryAvailable,
        input.budget.legendaryAvailable,
        input.budgetBefore.mythicalAvailable,
        input.budget.mythicalAvailable,
        input.openedAt
      ]
    );
    await this.sql.query(
      `INSERT INTO currency_ledger
         (id, user_id, stream_id, amount, reason, source_event_id, created_at)
       VALUES ($1, $2, $3, $4, 'pack_purchase', $5, $6)`,
      [
        randomUUID(),
        input.userId,
        input.streamId,
        -input.currencyCost,
        input.sourceEventId ?? null,
        input.openedAt
      ]
    );

    for (const card of input.cards) {
      await this.sql.query(
        `INSERT INTO inventory (id, user_id, card_id, pack_opening_id, acquired_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), input.userId, card.cardId, openingId, card.acquiredAt]
      );
    }


    for (const [ordinal, pull] of input.pulls.entries()) {
      await this.sql.query(
        `INSERT INTO pack_opening_pulls
           (opening_id, ordinal, card_id, rarity, boost_multiplier, rarity_roll)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          openingId,
          ordinal,
          pull.cardId,
          pull.rarity,
          pull.boostMultiplier,
          pull.rarityRoll
        ]
      );
    }

    await this.sql.query(
      `UPDATE global_rarity_budget
       SET legendary_available = $1, mythical_available = $2, updated_at = $3
       WHERE singleton = TRUE`,
      [input.budget.legendaryAvailable, input.budget.mythicalAvailable, input.openedAt]
    );
    return openingId;
  }
}

class PostgresTradeInTransaction implements TradeInTransaction {
  constructor(private readonly sql: SqlExecutor) {}

  async lockUser(userId: string): Promise<boolean> {
    const rows = await this.sql.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    return rows.length === 1;
  }

  async hasProcessedSourceEvent(sourceEventId: string): Promise<boolean> {
    const [row] = await this.sql.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM trade_ins WHERE source_event_id = $1) AS exists",
      [sourceEventId]
    );
    return row?.exists ?? false;
  }

  async getAvailableTradeInCard(userId: string, cardId: string) {
    const [row] = await this.sql.query<{
      inventory_id: string;
      trade_in_reward_id: string | null;
    }>(
      `SELECT i.id AS inventory_id, c.trade_in_reward_id
       FROM inventory i
       JOIN card_definitions c ON c.id = i.card_id
       WHERE i.user_id = $1
         AND i.card_id = $2
         AND i.consumed_at IS NULL
       ORDER BY i.acquired_at, i.id
       LIMIT 1
       FOR UPDATE OF i`,
      [userId, cardId]
    );
    return row
      ? { inventoryId: row.inventory_id, rewardId: row.trade_in_reward_id }
      : null;
  }

  async isProtectedTarget(twitchUserId: string): Promise<boolean> {
    const [row] = await this.sql.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM protected_targets WHERE twitch_user_id = $1) AS exists",
      [twitchUserId]
    );
    return row?.exists ?? false;
  }

  async recordTradeIn(input: PersistTradeInInput): Promise<string> {
    const consumed = await this.sql.query<{ id: string }>(
      `UPDATE inventory
       SET consumed_at = $2
       WHERE id = $1 AND user_id = $3 AND consumed_at IS NULL
       RETURNING id`,
      [input.inventoryId, input.requestedAt, input.userId]
    );
    if (consumed.length !== 1) {
      throw new Error("Trade-in inventory item is no longer available");
    }

    const id = randomUUID();
    await this.sql.query(
      `INSERT INTO trade_ins
         (id, user_id, inventory_id, target_twitch_user_id, reward_id, status,
          source_event_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [
        id,
        input.userId,
        input.inventoryId,
        input.targetTwitchUserId,
        input.rewardId,
        input.sourceEventId ?? null,
        input.requestedAt
      ]
    );
    return id;
  }
}

function emptySignals(): ParticipationSignals {
  return {
    optedInMinutes: 0,
    messageCount: 0,
    channelRewardRedemptions: 0,
    attendanceStreak: 0
  };
}

function isRarity(value: string): value is Rarity {
  return (RARITIES as readonly string[]).includes(value);
}
