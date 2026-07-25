export interface RuntimeConfig {
  nodeEnv: string;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  twitchClientId: string | undefined;
  twitchClientSecret: string | undefined;
  twitchBroadcasterId: string | undefined;
  twitchBotUserId: string | undefined;
  twitchBotAccessToken: string | undefined;
  twitchBroadcasterAccessToken: string | undefined;
  twitchBotRefreshToken: string | undefined;
  twitchBroadcasterRefreshToken: string | undefined;
  twitchTokenStore: "env" | "postgres";
  twitchTokenStorePath: string;
  twitchOptInCommand: string;
  discordToken: string | undefined;
  healthPort: number | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    twitchClientId: env.TWITCH_CLIENT_ID,
    twitchClientSecret: env.TWITCH_CLIENT_SECRET,
    twitchBroadcasterId: env.TWITCH_BROADCASTER_ID,
    twitchBotUserId: env.TWITCH_BOT_USER_ID,
    twitchBotAccessToken: env.TWITCH_BOT_ACCESS_TOKEN,
    twitchBroadcasterAccessToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN,
    twitchBotRefreshToken: env.TWITCH_BOT_REFRESH_TOKEN,
    twitchBroadcasterRefreshToken: env.TWITCH_BROADCASTER_REFRESH_TOKEN,
    twitchTokenStore: readTokenStore(env.TWITCH_TOKEN_STORE),
    twitchTokenStorePath: env.TWITCH_TOKEN_STORE_PATH ?? ".env",
    twitchOptInCommand: env.TWITCH_OPT_IN_COMMAND ?? "!cards",
    discordToken: env.DISCORD_TOKEN,
    healthPort: readOptionalPort(env.PORT ?? env.HEALTH_PORT)
  };
}

function readOptionalPort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("PORT must be an integer from 1 to 65535");
  }
  return port;
}

function readTokenStore(value: string | undefined): "env" | "postgres" {
  if (value === undefined || value === "env") return "env";
  if (value === "postgres") return value;
  throw new TypeError("TWITCH_TOKEN_STORE must be env or postgres");
}
