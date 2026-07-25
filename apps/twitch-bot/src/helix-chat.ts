import {
  requestWithTwitchToken,
  type TwitchAccessTokenProvider
} from "./twitch-tokens.js";

export interface TwitchChatGateway {
  sendMessage(message: string, replyParentMessageId?: string): Promise<void>;
}

export class TwitchHelixChatClient implements TwitchChatGateway {
  constructor(
    private readonly clientId: string,
    private readonly broadcasterUserId: string,
    private readonly senderUserId: string,
    private readonly tokens: TwitchAccessTokenProvider,
    private readonly request: typeof fetch = fetch
  ) {}

  async sendMessage(message: string, replyParentMessageId?: string): Promise<void> {
    const normalized = message.trim();
    if (normalized.length === 0 || normalized.length > 500) {
      throw new RangeError("Twitch chat messages must contain 1 to 500 characters");
    }
    const response = await requestWithTwitchToken(this.tokens, "bot", (accessToken) =>
      this.request("https://api.twitch.tv/helix/chat/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Client-Id": this.clientId,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          broadcaster_id: this.broadcasterUserId,
          sender_id: this.senderUserId,
          message: normalized,
          ...(replyParentMessageId ? { reply_parent_message_id: replyParentMessageId } : {})
        })
      })
    );
    if (!response.ok) {
      throw new Error(`Twitch chat send failed (${response.status}): ${await response.text()}`);
    }
    const body = await response.json() as {
      data?: Array<{ is_sent?: boolean; drop_reason?: { message?: string } | null }>;
    };
    const result = body.data?.[0];
    if (!result?.is_sent) {
      throw new Error(`Twitch rejected chat message: ${result?.drop_reason?.message ?? "unknown reason"}`);
    }
  }
}
