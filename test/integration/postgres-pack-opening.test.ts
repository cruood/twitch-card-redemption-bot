import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { DuplicateCommandError, PackOpeningService, PostgresDatabase } from "@cardbot/database";
import { Pool } from "pg";

test("PostgreSQL serializes duplicate pack commands and persists one complete audit", async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const schema = `cardbot_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const client = await pool.connect();
  try {
    const migrationDirectory = new URL("../../packages/database/migrations/", import.meta.url);
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(new URL(migration, migrationDirectory), "utf8"));
    }
    const catalog = JSON.parse(
      await readFile(new URL("../../catalog/cards.json", import.meta.url), "utf8")
    ) as Array<{ id: string; name: string; rarity: string }>;
    for (const card of catalog) {
      await client.query(
        "INSERT INTO card_definitions (id, name, rarity) VALUES ($1, $2, $3)",
        [card.id, card.name, card.rarity]
      );
    }

    const userId = randomUUID();
    const streamId = randomUUID();
    const now = new Date("2026-07-22T12:00:00Z");
    await client.query(
      "INSERT INTO users (id, twitch_user_id, display_name) VALUES ($1, 'viewer-1', 'Viewer')",
      [userId]
    );
    await client.query(
      `INSERT INTO streams (id, twitch_stream_id, started_at, last_live_at)
       VALUES ($1, 'stream-1', $2, $2)`,
      [streamId, now]
    );
    await client.query(
      `INSERT INTO stream_participation
         (user_id, stream_id, opted_in_at, last_accrued_at)
       VALUES ($1, $2, $3, $3)`,
      [userId, streamId, now]
    );
    await client.query(
      `INSERT INTO currency_ledger (id, user_id, stream_id, amount, reason)
       VALUES ($1, $2, $3, 500, 'integration_test_credit')`,
      [randomUUID(), userId, streamId]
    );
  } finally {
    client.release();
  }

  const database = new PostgresDatabase(pool);
  const packs = new PackOpeningService(database);
  try {
    const input = {
      userId: (await database.query<{ id: string }>("SELECT id FROM users"))[0]!.id,
      streamId: (await database.query<{ id: string }>("SELECT id FROM streams"))[0]!.id,
      batchSize: 1,
      now: new Date("2026-07-22T12:05:00Z"),
      random: () => 0,
      sourceEventId: "event-duplicate-1"
    };
    const outcomes = await Promise.allSettled([
      packs.purchaseAndOpen(input),
      packs.purchaseAndOpen(input)
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof DuplicateCommandError);

    const [counts] = await database.query<{
      openings: string;
      pulls: string;
      cards: string;
      balance: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM pack_openings) AS openings,
         (SELECT COUNT(*) FROM pack_opening_pulls) AS pulls,
         (SELECT COUNT(*) FROM inventory) AS cards,
         (SELECT SUM(amount) FROM currency_ledger) AS balance`
    );
    assert.deepEqual(counts, { openings: "1", pulls: "1", cards: "1", balance: "0" });
  } finally {
    await database.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
