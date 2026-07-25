import { type TwitchChatCommandHandler } from "./chat-commands.js";

export interface TwitchEconomyEventSink {
  streamOnline(event: { id: string; startedAt: Date }): Promise<void>;
  streamOffline(event: { id: string; observedAt: Date }): Promise<void>;
  optInCommand(event: {
    twitchUserId: string;
    displayName: string;
    observedAt: Date;
  }): Promise<unknown>;
  chatMessage(event: {
    twitchUserId: string;
    displayName: string;
    observedAt: Date;
    eventMessageId?: string;
  }): Promise<boolean>;
  rewardRedemption(event: {
    twitchUserId: string;
    displayName: string;
    observedAt: Date;
    eventMessageId?: string;
  }): Promise<boolean>;
}

export class TwitchEventSubRouter {
  private readonly normalizedOptInCommand: string;

  constructor(
    private readonly economy: TwitchEconomyEventSink,
    optInCommand: string,
    private readonly commands?: TwitchChatCommandHandler
  ) {
    const normalized = optInCommand.trim().toLocaleLowerCase();
    if (!normalized.startsWith("!")) throw new TypeError("Twitch opt-in command must start with !");
    this.normalizedOptInCommand = normalized;
  }

  async route(
    subscriptionType: string,
    event: unknown,
    messageTimestamp: string,
    eventMessageId?: string
  ): Promise<void> {
    const observedAt = parseTimestamp(messageTimestamp);
    const data = readObject(event, "EventSub event");

    switch (subscriptionType) {
      case "stream.online":
        await this.economy.streamOnline({
          id: readString(data, "id"),
          startedAt: parseTimestamp(readString(data, "started_at"))
        });
        return;
      case "stream.offline":
        await this.economy.streamOffline({ id: readString(data, "id"), observedAt });
        return;
      case "channel.chat.message": {
        const message = readObject(data.message, "Chat message");
        const text = readString(message, "text");
        const viewer = {
          twitchUserId: readString(data, "chatter_user_id"),
          displayName: readString(data, "chatter_user_name"),
          observedAt
        };
        if (this.commands && eventMessageId) {
          const handled = await this.commands.handle({
            ...viewer,
            eventMessageId,
            chatMessageId: readString(data, "message_id"),
            text
          });
          if (handled) return;
        }
        if (text.trim().toLocaleLowerCase() === this.normalizedOptInCommand) {
          await this.economy.optInCommand(viewer);
        } else {
          await this.economy.chatMessage({ ...viewer, ...(eventMessageId ? { eventMessageId } : {}) });
        }
        return;
      }
      case "channel.channel_points_custom_reward_redemption.add":
        await this.economy.rewardRedemption({
          twitchUserId: readString(data, "user_id"),
          displayName: readString(data, "user_name"),
          observedAt,
          ...(eventMessageId ? { eventMessageId } : {})
        });
        return;
      default:
        throw new Error(`Unsupported EventSub subscription: ${subscriptionType}`);
    }
  }
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`EventSub ${key} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid EventSub timestamp: ${value}`);
  return date;
}
