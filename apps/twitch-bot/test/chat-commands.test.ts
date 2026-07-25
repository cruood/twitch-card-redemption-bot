import assert from "node:assert/strict";
import test from "node:test";
import {
  PackOpeningService,
  type PackOpeningTransaction,
  type PackOpeningTransactionRunner,
  type PersistPackOpeningInput,
  ViewerEconomyService,
  type ViewerEconomyStore
} from "@cardbot/database";
import { type CardDefinition } from "@cardbot/inventory";
import { StreamEconomyService, type StreamEconomyStore } from "@cardbot/economy";
import { type EconomyQueuePort } from "@cardbot/queue";
import { TwitchEconomyCommandService } from "../src/chat-commands.js";
import { TwitchEconomyCoordinator } from "../src/economy-coordinator.js";
import { type TwitchChatGateway } from "../src/helix-chat.js";

test("balance and inventory commands produce compact Twitch replies", async () => {
  const fixture = createFixture();

  await fixture.commands.handle(command("!balance"));
  await fixture.commands.handle(command("!inventory"));

  assert.match(fixture.chat.messages[0]!, /balance: 5000 currency/);
  assert.match(fixture.chat.messages[1]!, /\* Hydrate x2/);
});

test("open command maps Twitch identities and persists its EventSub source ID", async () => {
  const fixture = createFixture();

  const handled = await fixture.commands.handle(command("!open 1"));

  assert.equal(handled, true);
  assert.equal(fixture.packTransaction.recorded?.sourceEventId, "event-1");
  assert.equal(fixture.packTransaction.recorded?.streamId, "stream-internal");
  assert.match(fixture.chat.messages[0]!, /opened 1:/);
  assert.match(fixture.chat.messages[0]!, /Balance: 4500/);
});

test("open command rejects unsafe batch sizes before touching pack state", async () => {
  const fixture = createFixture();

  await fixture.commands.handle(command("!open 25"));

  assert.equal(fixture.packTransaction.recorded, undefined);
  assert.match(fixture.chat.messages[0]!, /!open 1, !open 5, or !open 10/);
});

test("opt-in command explains when the channel is offline", async () => {
  const fixture = createFixture(null);

  await fixture.commands.handle(command("!cards"));

  assert.match(fixture.chat.messages[0]!, /while the channel is live/);
});

function createFixture(activeStreamId: string | null = "stream-twitch") {
  const streamStore = new FakeStreamStore(activeStreamId);
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(streamStore),
    new FakeQueue()
  );
  const packTransaction = new FakePackTransaction();
  const viewerStore = new FakeViewerStore();
  const viewers = new ViewerEconomyService(
    viewerStore,
    new PackOpeningService(packTransaction)
  );
  const chat = new FakeChat();
  return {
    commands: new TwitchEconomyCommandService(coordinator, viewers, chat),
    packTransaction,
    chat
  };
}

function command(text: string) {
  return {
    eventMessageId: "event-1",
    chatMessageId: "chat-1",
    twitchUserId: "viewer-twitch",
    displayName: "Viewer",
    text,
    observedAt: new Date("2026-07-21T18:30:00Z")
  };
}

class FakeChat implements TwitchChatGateway {
  messages: string[] = [];

  async sendMessage(message: string): Promise<void> {
    this.messages.push(message);
  }
}

class FakeViewerStore implements ViewerEconomyStore {
  async findViewerByTwitchId() {
    return { id: "user-internal", displayName: "Viewer" };
  }

  async findActiveStreamInternalId(): Promise<string> {
    return "stream-internal";
  }

  async getCurrencyBalance(): Promise<number> {
    return 5000;
  }

  async getInventorySummary() {
    return [{ cardId: "common-hydrate", name: "Hydrate", rarity: "common" as const, count: 2 }];
  }
}

class FakePackTransaction implements PackOpeningTransaction, PackOpeningTransactionRunner {
  recorded: PersistPackOpeningInput | undefined;

  runPackOpeningTransaction<T>(
    work: (transaction: PackOpeningTransaction) => Promise<T>
  ): Promise<T> {
    return work(this);
  }

  async lockUser(): Promise<boolean> { return true; }
  async getCurrencyBalance(): Promise<number> { return 5000; }
  async hasProcessedSourceEvent(): Promise<boolean> { return false; }
  async getParticipationSignals() {
    return { optedInMinutes: 30, messageCount: 3, channelRewardRedemptions: 1, attendanceStreak: 2 };
  }
  async getCardCatalog(): Promise<readonly CardDefinition[]> { return catalog; }
  async getRarityBudget() { return { legendaryAvailable: 1, mythicalAvailable: 1 }; }
  async recordPackOpening(input: PersistPackOpeningInput): Promise<string> {
    this.recorded = input;
    return "opening-1";
  }
}

class FakeStreamStore implements StreamEconomyStore {
  constructor(private readonly activeStreamId: string | null) {}

  async recordStreamStarted(): Promise<string> { return "stream-internal"; }
  async recordStreamEnded(): Promise<void> {}
  async recordStreamObservedLive(): Promise<void> {}
  async optInViewer() {
    return { userId: "user-internal", streamId: "stream-internal", newlyOptedIn: true, attendanceStreak: 2 };
  }
  async listOptedInUserIds(): Promise<readonly string[]> { return []; }
  async accrueOptedInUser(): Promise<number> { return 0; }
  async incrementMessageCount(): Promise<boolean> { return true; }
  async incrementRewardRedemptionCount(): Promise<boolean> { return true; }
  async getActiveTwitchStreamId(): Promise<string | null> { return this.activeStreamId; }
  async getActiveStreamState() {
    return this.activeStreamId
      ? {
          twitchStreamId: this.activeStreamId,
          startedAt: new Date("2026-07-21T18:00:00Z"),
          lastLiveAt: new Date("2026-07-21T18:30:00Z")
        }
      : null;
  }
}

class FakeQueue implements EconomyQueuePort {
  async scheduleStreamAccrual(): Promise<void> {}
  async stopAccrualAndFinalize(): Promise<void> {}
}

const catalog: CardDefinition[] = [
  { id: "common-hydrate", name: "Hydrate", rarity: "common" },
  { id: "uncommon-sound", name: "Sound", rarity: "uncommon" },
  { id: "rare-spotlight", name: "Spotlight", rarity: "rare" },
  { id: "epic-golden", name: "Golden", rarity: "epic" },
  { id: "legendary-crown", name: "Crown", rarity: "legendary" },
  { id: "mythical-broadcast", name: "Broadcast", rarity: "mythical" }
];
