import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { parseCatalog, PostgresDatabase, REQUIRED_TABLES } from "@cardbot/database";
import { verifyRedisConnection } from "@cardbot/queue";
import { loadConfig } from "@cardbot/shared-config";
import { TwitchHelixEventSubClient } from "./helix-eventsub.js";
import { createTwitchTokenProvider } from "./index.js";
import { TwitchHelixStreamStatusClient } from "./stream-reconciler.js";

const config = loadConfig(process.env);
const required: Record<string, string | undefined> = {
  DATABASE_URL: config.databaseUrl,
  REDIS_URL: config.redisUrl,
  TWITCH_CLIENT_ID: config.twitchClientId,
  TWITCH_CLIENT_SECRET: config.twitchClientSecret,
  TWITCH_BROADCASTER_ID: config.twitchBroadcasterId,
  TWITCH_BOT_USER_ID: config.twitchBotUserId
};
if (config.twitchTokenStore === "env") {
  required.TWITCH_BOT_ACCESS_TOKEN = config.twitchBotAccessToken;
  required.TWITCH_BROADCASTER_ACCESS_TOKEN = config.twitchBroadcasterAccessToken;
  required.TWITCH_BOT_REFRESH_TOKEN = config.twitchBotRefreshToken;
  required.TWITCH_BROADCASTER_REFRESH_TOKEN = config.twitchBroadcasterRefreshToken;
}
const missing = Object.entries(required)
  .filter(([, value]) => !value?.trim())
  .map(([key]) => key);
if (missing.length > 0) throw new Error(`Missing required configuration: ${missing.join(", ")}`);

if (config.twitchTokenStore === "env") {
  await access(config.twitchTokenStorePath, constants.R_OK | constants.W_OK);
  const tokenFile = await stat(config.twitchTokenStorePath);
  if ((tokenFile.mode & 0o077) !== 0) {
    throw new Error(`${config.twitchTokenStorePath} must not grant group or world permissions`);
  }
  console.log("OK token store is readable, writable, and owner-only");
}

const database = new PostgresDatabase({ connectionString: config.databaseUrl! });
try {
  await database.query("SELECT 1");
  const tables = await database.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'`
  );
  const available = new Set(tables.map((row) => row.table_name));
  const missingTables: string[] = REQUIRED_TABLES.filter((table) => !available.has(table));
  if (!available.has("schema_migrations")) missingTables.push("schema_migrations");
  if (missingTables.length > 0) {
    throw new Error(`Database is missing tables: ${missingTables.join(", ")}`);
  }
  const migrations = await database.query<{ name: string; checksum: string | null }>(
    "SELECT name, checksum FROM schema_migrations ORDER BY name"
  );
  if (migrations.length === 0 || migrations.some((migration) => !migration.checksum)) {
    throw new Error("Database migrations are missing checksums; run npm run db:migrate");
  }
  const migrationDirectory = new URL("../../../packages/database/migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  for (const name of migrationNames) {
    const source = await readFile(new URL(name, migrationDirectory), "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    if (applied.get(name) !== checksum) {
      throw new Error(`Database migration is missing or has a checksum mismatch: ${name}`);
    }
  }
  const unexpected = migrations.filter((migration) => !migrationNames.includes(migration.name));
  if (unexpected.length > 0) {
    throw new Error(`Database has unknown migrations: ${unexpected.map((item) => item.name).join(", ")}`);
  }
  console.log(`OK PostgreSQL schema has ${available.size} tables and ${migrations.length} migrations`);

  const tokens = createTwitchTokenProvider(config, database);
  if (!tokens) throw new Error("Twitch token provider could not be configured");
  await tokens.getAccessToken("bot");
  await tokens.getAccessToken("broadcaster");
  console.log(`OK Twitch token persistence is initialized in ${config.twitchTokenStore}`);

  const registration = {
    broadcasterUserId: config.twitchBroadcasterId!,
    botUserId: config.twitchBotUserId!
  };
  await new TwitchHelixEventSubClient(config.twitchClientId!, tokens).validateCredentials(registration);
  console.log("OK Twitch token owners, client ID, and required scopes are valid");

  const current = await new TwitchHelixStreamStatusClient(
    config.twitchClientId!,
    config.twitchBroadcasterId!,
    tokens
  ).getCurrentStream();
  console.log(`OK Twitch Helix is reachable; channel is ${current ? "live" : "offline"}`);
} finally {
  await database.close();
}

const catalogSource = await readFile(new URL("../../../catalog/cards.json", import.meta.url), "utf8");
const catalog = parseCatalog(JSON.parse(catalogSource) as unknown);
console.log(`OK card catalog has ${catalog.length} active definitions across all rarities`);

await verifyRedisConnection(config.redisUrl!);
console.log("OK Redis and BullMQ connection is ready");

console.log("Production dependency checks passed");
