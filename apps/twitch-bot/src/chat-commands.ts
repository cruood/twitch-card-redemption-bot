import { randomBytes } from "node:crypto";
import {
  DuplicateCommandError,
  InsufficientCurrencyError,
  ViewerEconomyService,
  ViewerNotFoundError
} from "@cardbot/database";
import { RARITY_DEFINITIONS, type Rarity } from "@cardbot/rarity";
import { type TwitchEconomyCoordinator } from "./economy-coordinator.js";
import { type TwitchChatGateway } from "./helix-chat.js";

export interface TwitchChatCommandEvent {
  eventMessageId: string;
  chatMessageId: string;
  twitchUserId: string;
  displayName: string;
  text: string;
  observedAt: Date;
}

export interface TwitchChatCommandHandler {
  handle(event: TwitchChatCommandEvent): Promise<boolean>;
}

export class TwitchEconomyCommandService implements TwitchChatCommandHandler {
  constructor(
    private readonly coordinator: TwitchEconomyCoordinator,
    private readonly viewers: ViewerEconomyService,
    private readonly chat: TwitchChatGateway,
    private readonly optInCommand = "!cards"
  ) {}

  async handle(event: TwitchChatCommandEvent): Promise<boolean> {
    const [command, argument] = event.text.trim().toLowerCase().split(/\s+/, 2);
    switch (command) {
      case this.optInCommand.toLowerCase():
        await this.handleOptIn(event);
        return true;
      case "!balance":
        await this.handleBalance(event);
        return true;
      case "!inventory":
        await this.handleInventory(event);
        return true;
      case "!open":
        await this.handleOpen(event, argument);
        return true;
      default:
        return false;
    }
  }

  private async handleOptIn(event: TwitchChatCommandEvent): Promise<void> {
    const twitchStreamId = await this.coordinator.getActiveStreamId();
    if (!twitchStreamId) {
      await this.reply(event, `@${event.displayName}, opt-in is available while the channel is live.`);
      return;
    }
    const result = await this.coordinator.optInCommand({
      twitchUserId: event.twitchUserId,
      displayName: event.displayName,
      twitchStreamId,
      observedAt: event.observedAt
    });
    const message = result.newlyOptedIn
      ? `@${event.displayName}, you're opted in. Attendance streak: ${result.attendanceStreak}.`
      : `@${event.displayName}, you're already opted in for this stream.`;
    await this.reply(event, message);
  }

  private async handleBalance(event: TwitchChatCommandEvent): Promise<void> {
    try {
      const result = await this.viewers.getBalance(event.twitchUserId);
      await this.reply(event, `@${result.displayName}, balance: ${result.balance} currency.`);
    } catch (error) {
      if (error instanceof ViewerNotFoundError) {
        await this.reply(event, `@${event.displayName}, use ${this.optInCommand} first.`);
        return;
      }
      throw error;
    }
  }

  private async handleInventory(event: TwitchChatCommandEvent): Promise<void> {
    try {
      const result = await this.viewers.getInventory(event.twitchUserId);
      if (result.cards.length === 0) {
        await this.reply(event, `@${result.displayName}, your card inventory is empty.`);
        return;
      }
      const cards = result.cards
        .slice(0, 8)
        .map((card) => `${stars(card.rarity)} ${card.name} x${card.count}`)
        .join(" | ");
      const suffix = result.cards.length > 8 ? ` | +${result.cards.length - 8} more` : "";
      await this.reply(event, truncate(`@${result.displayName}: ${cards}${suffix}`));
    } catch (error) {
      if (error instanceof ViewerNotFoundError) {
        await this.reply(event, `@${event.displayName}, use ${this.optInCommand} first.`);
        return;
      }
      throw error;
    }
  }

  private async handleOpen(event: TwitchChatCommandEvent, argument: string | undefined): Promise<void> {
    const batchSize = Number(argument);
    if (![1, 5, 10].includes(batchSize)) {
      await this.reply(event, `@${event.displayName}, use !open 1, !open 5, or !open 10.`);
      return;
    }

    try {
      const twitchStreamId = await this.coordinator.getActiveStreamId();
      if (!twitchStreamId) {
        await this.reply(event, `@${event.displayName}, packs can only be opened during a live stream.`);
        return;
      }
      const result = await this.viewers.openPacks({
        twitchUserId: event.twitchUserId,
        twitchStreamId,
        batchSize,
        now: event.observedAt,
        random: secureRandom,
        sourceEventId: event.eventMessageId
      });
      const pulls = result.pulls
        .map((pull) => `${stars(pull.rarity)} ${pull.name}`)
        .join(" | ");
      await this.reply(
        event,
        truncate(`@${event.displayName} opened ${batchSize}: ${pulls}. Balance: ${result.remainingBalance}.`)
      );
    } catch (error) {
      if (error instanceof DuplicateCommandError) return;
      if (error instanceof ViewerNotFoundError) {
        await this.reply(event, `@${event.displayName}, use ${this.optInCommand} first.`);
        return;
      }
      if (error instanceof InsufficientCurrencyError) {
        await this.reply(
          event,
          `@${event.displayName}, that costs ${error.required}; your balance is ${error.available}.`
        );
        return;
      }
      throw error;
    }
  }

  private reply(event: TwitchChatCommandEvent, message: string): Promise<void> {
    return this.chat.sendMessage(message, event.chatMessageId);
  }
}

function secureRandom(): number {
  return randomBytes(6).readUIntBE(0, 6) / 281_474_976_710_656;
}

function stars(rarity: Rarity): string {
  return "*".repeat(RARITY_DEFINITIONS[rarity].stars);
}

function truncate(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}
