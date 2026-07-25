import {
  requestWithTwitchToken,
  type TwitchAccessTokenProvider,
  type TwitchTokenAudience
} from "./twitch-tokens.js";

export {
  RefreshingTwitchAccessTokenProvider,
  StaticTwitchAccessTokenProvider,
  type TwitchAccessTokenProvider,
  type TwitchTokenAudience
} from "./twitch-tokens.js";

export interface EventSubRegistrationConfig {
  broadcasterUserId: string;
  botUserId: string;
}

interface EventSubSubscriptionSpec {
  type: string;
  version: "1";
  condition: Record<string, string>;
  tokenAudience: TwitchTokenAudience;
}

export class TwitchHelixEventSubClient {
  constructor(
    private readonly clientId: string,
    private readonly tokens: TwitchAccessTokenProvider,
    private readonly request: typeof fetch = fetch
  ) {}

  async validateCredentials(config: EventSubRegistrationConfig): Promise<void> {
    await Promise.all([
      this.validateToken("bot", config.botUserId, ["user:read:chat", "user:write:chat"]),
      this.validateToken("broadcaster", config.broadcasterUserId, [
        "channel:bot",
        "channel:read:redemptions"
      ])
    ]);
  }

  async registerWebSocketSubscriptions(
    sessionId: string,
    config: EventSubRegistrationConfig
  ): Promise<void> {
    assertIdentifier(sessionId, "EventSub session ID");
    const specs = subscriptionSpecs(config);
    await Promise.all(specs.map((spec) => this.createSubscription(sessionId, spec)));
  }

  private async createSubscription(
    sessionId: string,
    spec: EventSubSubscriptionSpec
  ): Promise<void> {
    const response = await requestWithTwitchToken(this.tokens, spec.tokenAudience, (accessToken) =>
      this.request("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Client-Id": this.clientId,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: spec.type,
          version: spec.version,
          condition: spec.condition,
          transport: { method: "websocket", session_id: sessionId }
        })
      })
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Twitch EventSub ${spec.type} registration failed (${response.status}): ${body}`);
    }
  }

  private async validateToken(
    audience: TwitchTokenAudience,
    expectedUserId: string,
    requiredScopes: readonly string[]
  ): Promise<void> {
    const response = await requestWithTwitchToken(this.tokens, audience, (accessToken) =>
      this.request("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${accessToken}` }
      })
    );
    if (!response.ok) {
      throw new Error(`Twitch ${audience} token validation failed (${response.status})`);
    }
    const body = readValidationResponse(await response.json());
    if (body.clientId !== this.clientId) {
      throw new Error(`Twitch ${audience} token belongs to a different client ID`);
    }
    if (body.userId !== expectedUserId) {
      throw new Error(`Twitch ${audience} token belongs to user ${body.userId}, expected ${expectedUserId}`);
    }
    const missingScopes = requiredScopes.filter((scope) => !body.scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new Error(`Twitch ${audience} token is missing scopes: ${missingScopes.join(", ")}`);
    }
  }
}

function subscriptionSpecs(config: EventSubRegistrationConfig): EventSubSubscriptionSpec[] {
  assertIdentifier(config.broadcasterUserId, "Broadcaster user ID");
  assertIdentifier(config.botUserId, "Bot user ID");
  return [
    {
      type: "stream.online",
      version: "1",
      condition: { broadcaster_user_id: config.broadcasterUserId },
      tokenAudience: "bot"
    },
    {
      type: "stream.offline",
      version: "1",
      condition: { broadcaster_user_id: config.broadcasterUserId },
      tokenAudience: "bot"
    },
    {
      type: "channel.chat.message",
      version: "1",
      condition: {
        broadcaster_user_id: config.broadcasterUserId,
        user_id: config.botUserId
      },
      tokenAudience: "bot"
    },
    {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: config.broadcasterUserId },
      tokenAudience: "broadcaster"
    }
  ];
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(`${label} is invalid`);
}

function readValidationResponse(value: unknown): {
  clientId: string;
  userId: string;
  scopes: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Twitch token validation response must be an object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.client_id !== "string" || typeof body.user_id !== "string") {
    throw new TypeError("Twitch token validation response is missing client_id or user_id");
  }
  if (!Array.isArray(body.scopes) || !body.scopes.every((scope) => typeof scope === "string")) {
    throw new TypeError("Twitch token validation response has invalid scopes");
  }
  return { clientId: body.client_id, userId: body.user_id, scopes: body.scopes };
}
