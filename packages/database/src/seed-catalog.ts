import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { parseCatalog } from "./catalog.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed the card catalog");

const source = await readFile(new URL("../../../catalog/cards.json", import.meta.url), "utf8");
const cards = parseCatalog(JSON.parse(source) as unknown);
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("UPDATE card_definitions SET active = FALSE");
  for (const card of cards) {
    await client.query(
      `INSERT INTO card_definitions (id, name, rarity, trade_in_reward_id, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           rarity = EXCLUDED.rarity,
           trade_in_reward_id = EXCLUDED.trade_in_reward_id,
           active = TRUE`,
      [card.id, card.name, card.rarity, card.tradeInRewardId ?? null]
    );
  }
  await client.query("COMMIT");
  console.log(`Seeded ${cards.length} active cards`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
