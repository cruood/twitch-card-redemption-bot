import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/index.js";

test("runtime config maps refresh credentials and safe defaults", () => {
  const config = loadConfig({
    TWITCH_BOT_REFRESH_TOKEN: "bot-refresh",
    TWITCH_BROADCASTER_REFRESH_TOKEN: "broadcaster-refresh",
    TWITCH_TOKEN_STORE_PATH: "/run/secrets/cardbot.env"
  });

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.twitchOptInCommand, "!cards");
  assert.equal(config.twitchBotRefreshToken, "bot-refresh");
  assert.equal(config.twitchBroadcasterRefreshToken, "broadcaster-refresh");
  assert.equal(config.twitchTokenStore, "env");
  assert.equal(config.twitchTokenStorePath, "/run/secrets/cardbot.env");
});

test("runtime config defaults token persistence to the local env file", () => {
  assert.equal(loadConfig({}).twitchTokenStorePath, ".env");
});

test("runtime config accepts PostgreSQL token persistence", () => {
  assert.equal(loadConfig({ TWITCH_TOKEN_STORE: "postgres" }).twitchTokenStore, "postgres");
  assert.throws(
    () => loadConfig({ TWITCH_TOKEN_STORE: "memory" }),
    /TWITCH_TOKEN_STORE must be env or postgres/
  );
});

test("runtime config reads the Railway health port", () => {
  assert.equal(loadConfig({ PORT: "3000" }).healthPort, 3000);
  assert.equal(loadConfig({ HEALTH_PORT: "3001" }).healthPort, 3001);
  assert.equal(loadConfig({}).healthPort, undefined);
  assert.throws(() => loadConfig({ PORT: "0" }), /PORT must be an integer/);
});
