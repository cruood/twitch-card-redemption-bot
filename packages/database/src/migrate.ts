import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
let migrationLockHeld = false;

try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["cardbot_schema_migrations"]);
  migrationLockHeld = true;

  const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of migrationNames) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await client.query<{ checksum: string | null }>(
      "SELECT checksum FROM schema_migrations WHERE name = $1",
      [name]
    );
    const existing = applied.rows[0];
    if (existing) {
      if (existing.checksum && existing.checksum !== checksum) {
        throw new Error(`Applied migration checksum does not match: ${name}`);
      }
      if (!existing.checksum) {
        await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1", [
          name,
          checksum
        ]);
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        name,
        checksum
      ]);
      await client.query("COMMIT");
      console.log(`Applied migration: ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  if (migrationLockHeld) {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["cardbot_schema_migrations"]);
  }
  client.release();
  await pool.end();
}
