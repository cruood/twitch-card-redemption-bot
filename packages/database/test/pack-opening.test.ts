import assert from "node:assert/strict";
import test from "node:test";
import { type CardDefinition } from "@cardbot/inventory";
import { type GlobalRarityBudget, type ParticipationSignals } from "@cardbot/rarity";
import {
  DuplicateCommandError,
  InsufficientCurrencyError,
  type PackOpeningTransaction,
  type PackOpeningTransactionRunner,
  PackOpeningService,
  type PersistPackOpeningInput,
  UserNotFoundError
} from "../src/pack-opening.js";

const catalog: CardDefinition[] = [
  { id: "common-1", name: "Hydrate", rarity: "common" },
  { id: "uncommon-1", name: "Sound Alert", rarity: "uncommon" },
  { id: "rare-1", name: "One Minute Timeout", rarity: "rare" },
  { id: "epic-1", name: "Ten Minute Timeout", rarity: "epic" },
  { id: "legendary-1", name: "Vote Remove Moderator", rarity: "legendary" },
  { id: "mythical-1", name: "Permanent Ban Vote", rarity: "mythical" }
];

test("pack purchase records cards, debit cost, and remaining balance atomically", async () => {
  const transaction = new FakeTransaction();
  const service = new PackOpeningService(transaction);
  const result = await service.purchaseAndOpen({
    userId: "user-1",
    streamId: "stream-1",
    batchSize: 5,
    now: new Date("2026-07-21T18:00:00Z"),
    random: () => 0
  });

  assert.equal(result.openingId, "opening-1");
  assert.equal(result.currencyCost, 2500);
  assert.equal(result.remainingBalance, 2500);
  assert.equal(result.cards.length, 5);
  assert.equal(transaction.recorded?.currencyCost, 2500);
  assert.equal(transaction.recorded?.cards.length, 5);
});

test("insufficient balance fails before rarity state or inventory is touched", async () => {
  const transaction = new FakeTransaction();
  transaction.balance = 499;
  const service = new PackOpeningService(transaction);

  await assert.rejects(
    service.purchaseAndOpen({
      userId: "user-1",
      streamId: "stream-1",
      batchSize: 1,
      now: new Date("2026-07-21T18:00:00Z"),
      random: () => 0
    }),
    (error: unknown) =>
      error instanceof InsufficientCurrencyError && error.available === 499 && error.required === 500
  );
  assert.equal(transaction.recorded, undefined);
  assert.equal(transaction.budgetReads, 0);
});

test("unknown users fail under the user lock", async () => {
  const transaction = new FakeTransaction();
  transaction.userExists = false;
  const service = new PackOpeningService(transaction);

  await assert.rejects(
    service.purchaseAndOpen({
      userId: "missing",
      streamId: null,
      batchSize: 1,
      now: new Date("2026-07-21T18:00:00Z"),
      random: () => 0
    }),
    UserNotFoundError
  );
  assert.equal(transaction.recorded, undefined);
});

test("consumed global rarity tokens are included in the persisted opening", async () => {
  const transaction = new FakeTransaction();
  const service = new PackOpeningService(transaction);
  const values = [0.994, 0];

  const result = await service.purchaseAndOpen({
    userId: "user-1",
    streamId: "stream-1",
    batchSize: 1,
    now: new Date("2026-07-21T18:00:00Z"),
    random: () => values.shift()!
  });

  assert.equal(result.cards[0]?.cardId, "legendary-1");
  assert.equal(transaction.recorded?.budget.legendaryAvailable, 0);
});

test("duplicate source events are rejected before balance or rarity work", async () => {
  const transaction = new FakeTransaction();
  transaction.processedSourceEvent = true;
  const service = new PackOpeningService(transaction);

  await assert.rejects(
    service.purchaseAndOpen({
      userId: "user-1",
      streamId: "stream-1",
      batchSize: 1,
      now: new Date("2026-07-21T18:00:00Z"),
      random: () => 0,
      sourceEventId: "event-1"
    }),
    DuplicateCommandError
  );
  assert.equal(transaction.budgetReads, 0);
  assert.equal(transaction.recorded, undefined);
});

class FakeTransaction implements PackOpeningTransaction, PackOpeningTransactionRunner {
  userExists = true;
  balance = 5000;
  budgetReads = 0;
  recorded: PersistPackOpeningInput | undefined;
  processedSourceEvent = false;

  runPackOpeningTransaction<T>(
    work: (transaction: PackOpeningTransaction) => Promise<T>
  ): Promise<T> {
    return work(this);
  }

  async lockUser(): Promise<boolean> {
    return this.userExists;
  }

  async getCurrencyBalance(): Promise<number> {
    return this.balance;
  }

  async hasProcessedSourceEvent(): Promise<boolean> {
    return this.processedSourceEvent;
  }

  async getParticipationSignals(): Promise<ParticipationSignals> {
    return {
      optedInMinutes: 0,
      messageCount: 0,
      channelRewardRedemptions: 0,
      attendanceStreak: 0
    };
  }

  async getCardCatalog(): Promise<readonly CardDefinition[]> {
    return catalog;
  }

  async getRarityBudget(): Promise<GlobalRarityBudget> {
    this.budgetReads += 1;
    return { legendaryAvailable: 1, mythicalAvailable: 1 };
  }

  async recordPackOpening(input: PersistPackOpeningInput): Promise<string> {
    this.recorded = input;
    return "opening-1";
  }
}
