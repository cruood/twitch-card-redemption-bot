import assert from "node:assert/strict";
import test from "node:test";
import { TwitchEventSubRouter, type TwitchEconomyEventSink } from "../src/eventsub-router.js";
import { parseEventSubEnvelope } from "../src/eventsub-websocket.js";
import {
  StaticTwitchAccessTokenProvider,
  TwitchHelixEventSubClient
} from "../src/helix-eventsub.js";
import { TwitchHelixChatClient } from "../src/helix-chat.js";
import { TwitchHelixStreamStatusClient } from "../src/stream-reconciler.js";

test("Helix registers the four economy subscriptions with their required token audiences", async () => {
  const requests: Array<{ authorization: string; body: Record<string, unknown> }> = [];
  const request = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get("Authorization") ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const helix = new TwitchHelixEventSubClient(
    "client-1",
    new StaticTwitchAccessTokenProvider("bot-token", "broadcaster-token"),
    request
  );

  await helix.registerWebSocketSubscriptions("session-1", {
    broadcasterUserId: "100",
    botUserId: "200"
  });

  assert.equal(requests.length, 4);
  assert.equal(requests.filter((item) => item.authorization === "Bearer bot-token").length, 3);
  assert.equal(
    requests.filter((item) => item.authorization === "Bearer broadcaster-token").length,
    1
  );
  assert.deepEqual(
    requests.map((item) => item.body.type).sort(),
    [
      "channel.channel_points_custom_reward_redemption.add",
      "channel.chat.message",
      "stream.offline",
      "stream.online"
    ]
  );
  assert.ok(
    requests.every(
      (item) =>
        (item.body.transport as Record<string, unknown>).session_id === "session-1"
    )
  );
});

test("Twitch credentials are checked for token owner, client, and required scopes", async () => {
  const request = (async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    const isBot = authorization === "OAuth bot-token";
    return Response.json({
      client_id: "client-1",
      user_id: isBot ? "200" : "100",
      scopes: isBot
        ? ["user:read:chat", "user:write:chat", "user:bot"]
        : ["channel:bot", "channel:read:redemptions"]
    });
  }) as typeof fetch;
  const helix = new TwitchHelixEventSubClient(
    "client-1",
    new StaticTwitchAccessTokenProvider("bot-token", "broadcaster-token"),
    request
  );

  await helix.validateCredentials({ broadcasterUserId: "100", botUserId: "200" });
});

test("Helix chat replies use the bot identity and parent message", async () => {
  let body: Record<string, unknown> | undefined;
  const request = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: [{ message_id: "sent-1", is_sent: true, drop_reason: null }] });
  }) as typeof fetch;
  const chat = new TwitchHelixChatClient(
    "client-1",
    "broadcaster-1",
    "bot-1",
    new StaticTwitchAccessTokenProvider("bot-token", "broadcaster-token"),
    request
  );

  await chat.sendMessage("Pack opened", "chat-1");

  assert.deepEqual(body, {
    broadcaster_id: "broadcaster-1",
    sender_id: "bot-1",
    message: "Pack opened",
    reply_parent_message_id: "chat-1"
  });
});

test("Helix stream status maps live and offline channel state", async () => {
  let live = true;
  const request = (async (input: string | URL | Request) => {
    assert.match(String(input), /helix\/streams\?user_id=broadcaster-1/);
    return Response.json({
      data: live
        ? [{ id: "stream-1", started_at: "2026-07-21T18:00:00Z" }]
        : []
    });
  }) as typeof fetch;
  const status = new TwitchHelixStreamStatusClient(
    "client-1",
    "broadcaster-1",
    new StaticTwitchAccessTokenProvider("bot-token", "broadcaster-token"),
    request
  );

  assert.deepEqual(await status.getCurrentStream(), {
    id: "stream-1",
    startedAt: new Date("2026-07-21T18:00:00Z")
  });
  live = false;
  assert.equal(await status.getCurrentStream(), null);
});

test("EventSub router maps stream, opt-in, message, and redemption notifications", async () => {
  const sink = new RecordingSink();
  const router = new TwitchEventSubRouter(sink, "!cards");
  const timestamp = "2026-07-21T18:05:00Z";

  await router.route("stream.online", { id: "123", started_at: "2026-07-21T18:00:00Z" }, timestamp);
  await router.route(
    "channel.chat.message",
    {
      chatter_user_id: "viewer-1",
      chatter_user_name: "Viewer",
      message: { text: "  !CARDS " }
    },
    timestamp,
    "event-opt-in"
  );
  await router.route(
    "channel.chat.message",
    {
      chatter_user_id: "viewer-1",
      chatter_user_name: "Viewer",
      message: { text: "hello" }
    },
    timestamp,
    "event-chat"
  );
  await router.route(
    "channel.channel_points_custom_reward_redemption.add",
    { user_id: "viewer-1", user_name: "Viewer" },
    timestamp,
    "event-reward"
  );
  await router.route("stream.offline", { id: "123" }, "2026-07-21T20:00:00Z");

  assert.deepEqual(sink.calls, [
    "online:123",
    "opt-in:viewer-1",
    "chat:viewer-1:event-chat",
    "reward:viewer-1:event-reward",
    "offline:123"
  ]);
});

test("EventSub envelopes are parsed without trusting arbitrary payload shapes", () => {
  const envelope = parseEventSubEnvelope(
    JSON.stringify({
      metadata: {
        message_id: "message-1",
        message_type: "notification",
        message_timestamp: "2026-07-21T18:00:00Z",
        subscription_type: "stream.online"
      },
      payload: { event: { id: "123" } }
    })
  );

  assert.equal(envelope.metadata.messageId, "message-1");
  assert.equal(envelope.metadata.subscriptionType, "stream.online");
  assert.throws(() => parseEventSubEnvelope("{}"), /metadata/);
});

class RecordingSink implements TwitchEconomyEventSink {
  calls: string[] = [];

  async streamOnline(event: { id: string }): Promise<void> {
    this.calls.push(`online:${event.id}`);
  }

  async streamOffline(event: { id: string }): Promise<void> {
    this.calls.push(`offline:${event.id}`);
  }

  async optInCommand(event: { twitchUserId: string }): Promise<void> {
    this.calls.push(`opt-in:${event.twitchUserId}`);
  }

  async chatMessage(event: { twitchUserId: string; eventMessageId?: string }): Promise<boolean> {
    this.calls.push(`chat:${event.twitchUserId}:${event.eventMessageId}`);
    return true;
  }

  async rewardRedemption(event: { twitchUserId: string; eventMessageId?: string }): Promise<boolean> {
    this.calls.push(`reward:${event.twitchUserId}:${event.eventMessageId}`);
    return true;
  }
}
