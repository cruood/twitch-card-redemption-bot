import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EnvFileTwitchTokenStore } from "../src/env-token-store.js";
import { TwitchHelixEventSubClient } from "../src/helix-eventsub.js";
import {
  RefreshingTwitchAccessTokenProvider,
  type TwitchTokenSnapshot,
  type TwitchTokenStore
} from "../src/twitch-tokens.js";

test("shared bot and broadcaster authorization rotates once and retries validation", async () => {
  let refreshRequests = 0;
  const store = new RecordingTokenStore();
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) {
      refreshRequests += 1;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("refresh_token"), "shared-refresh");
      return Response.json({
        access_token: "replacement-access",
        refresh_token: "replacement-refresh"
      });
    }
    if (url.endsWith("/oauth2/validate")) {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "OAuth expired-access") return new Response(null, { status: 401 });
      assert.equal(authorization, "OAuth replacement-access");
      return Response.json({
        client_id: "client-1",
        user_id: "user-1",
        scopes: [
          "user:read:chat",
          "user:write:chat",
          "channel:bot",
          "channel:read:redemptions"
        ]
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const provider = new RefreshingTwitchAccessTokenProvider(
    "client-1",
    "secret-1",
    sharedTokens("expired-access", "shared-refresh"),
    store,
    request
  );
  const helix = new TwitchHelixEventSubClient("client-1", provider, request);

  await helix.validateCredentials({ broadcasterUserId: "user-1", botUserId: "user-1" });

  assert.equal(refreshRequests, 1);
  assert.equal(store.snapshots.length, 1);
  assert.deepEqual(store.snapshots[0], sharedTokens("replacement-access", "replacement-refresh"));
  assert.equal(await provider.getAccessToken("bot"), "replacement-access");
  assert.equal(await provider.getAccessToken("broadcaster"), "replacement-access");
});

test("env token store preserves settings and writes owner-only credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cardbot-token-store-"));
  const path = join(directory, ".env");
  await writeFile(
    path,
    [
      "NODE_ENV=development",
      "TWITCH_BOT_ACCESS_TOKEN=old-bot",
      "TWITCH_BROADCASTER_ACCESS_TOKEN=old-broadcaster",
      "TWITCH_OPT_IN_COMMAND=!cards",
      ""
    ].join("\n")
  );
  const store = new EnvFileTwitchTokenStore(path);

  await store.persist({
    bot: { accessToken: "new-bot", refreshToken: "new-bot-refresh" },
    broadcaster: {
      accessToken: "new-broadcaster",
      refreshToken: "new-broadcaster-refresh"
    }
  });

  const contents = await readFile(path, "utf8");
  assert.match(contents, /^NODE_ENV=development$/m);
  assert.match(contents, /^TWITCH_OPT_IN_COMMAND=!cards$/m);
  assert.match(contents, /^TWITCH_BOT_ACCESS_TOKEN=new-bot$/m);
  assert.match(contents, /^TWITCH_BOT_REFRESH_TOKEN=new-bot-refresh$/m);
  assert.match(contents, /^TWITCH_BROADCASTER_ACCESS_TOKEN=new-broadcaster$/m);
  assert.match(contents, /^TWITCH_BROADCASTER_REFRESH_TOKEN=new-broadcaster-refresh$/m);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("shared persistent lock prevents duplicate refresh across providers", async () => {
  const store = new SharedLockedTokenStore(sharedTokens("expired-access", "shared-refresh"));
  let refreshRequests = 0;
  const request = (async () => {
    refreshRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      access_token: "replacement-access",
      refresh_token: "replacement-refresh"
    });
  }) as typeof fetch;
  const first = new RefreshingTwitchAccessTokenProvider(
    "client-1",
    "secret-1",
    sharedTokens("expired-access", "shared-refresh"),
    store,
    request
  );
  const second = new RefreshingTwitchAccessTokenProvider(
    "client-1",
    "secret-1",
    sharedTokens("expired-access", "shared-refresh"),
    store,
    request
  );

  const rejected = await Promise.all([
    first.getAccessToken("bot"),
    second.getAccessToken("bot")
  ]);
  const replacements = await Promise.all([
    first.refreshAccessToken("bot", rejected[0]!),
    second.refreshAccessToken("bot", rejected[1]!)
  ]);

  assert.deepEqual(replacements, ["replacement-access", "replacement-access"]);
  assert.equal(refreshRequests, 1);
  assert.deepEqual(await store.load(), sharedTokens("replacement-access", "replacement-refresh"));
});

test("persistent tokens allow restarts without bootstrap credentials", async () => {
  const store = new SharedLockedTokenStore(sharedTokens("stored-access", "stored-refresh"));
  const provider = new RefreshingTwitchAccessTokenProvider(
    "client-1",
    "secret-1",
    undefined,
    store
  );

  assert.equal(await provider.getAccessToken("bot"), "stored-access");
  assert.equal(await provider.getAccessToken("broadcaster"), "stored-access");
});

class RecordingTokenStore implements TwitchTokenStore {
  readonly snapshots: TwitchTokenSnapshot[] = [];

  async persist(tokens: TwitchTokenSnapshot): Promise<void> {
    this.snapshots.push(tokens);
  }
}

class SharedLockedTokenStore implements TwitchTokenStore {
  private tokens: TwitchTokenSnapshot;
  private queue = Promise.resolve();

  constructor(tokens: TwitchTokenSnapshot) {
    this.tokens = structuredClone(tokens);
  }

  async load(): Promise<TwitchTokenSnapshot> {
    return structuredClone(this.tokens);
  }

  async persist(tokens: TwitchTokenSnapshot): Promise<void> {
    this.tokens = structuredClone(tokens);
  }

  withRefreshLock<T>(work: (store: TwitchTokenStore) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => work(this));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sharedTokens(accessToken: string, refreshToken: string): TwitchTokenSnapshot {
  return {
    bot: { accessToken, refreshToken },
    broadcaster: { accessToken, refreshToken }
  };
}
