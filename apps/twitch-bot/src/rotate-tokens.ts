import { loadConfig } from "@cardbot/shared-config";
import { PostgresDatabase } from "@cardbot/database";
import { createTwitchTokenProvider } from "./index.js";

const config = loadConfig(process.env);
const database = config.databaseUrl
  ? new PostgresDatabase({ connectionString: config.databaseUrl })
  : undefined;

try {
  const provider = createTwitchTokenProvider(config, database);
  if (!provider?.refreshAccessToken) {
    throw new Error(
      "Token rotation requires Twitch client credentials plus access and refresh tokens for both audiences"
    );
  }

  const [botToken, broadcasterToken] = await Promise.all([
    provider.getAccessToken("bot"),
    provider.getAccessToken("broadcaster")
  ]);
  await Promise.all([
    provider.refreshAccessToken("bot", botToken),
    provider.refreshAccessToken("broadcaster", broadcasterToken)
  ]);
  console.log("Rotated and persisted Twitch access and refresh tokens");
} finally {
  await database?.close();
}
