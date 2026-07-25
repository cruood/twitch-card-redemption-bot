import assert from "node:assert/strict";
import test from "node:test";
import {
  AvailableCardNotFoundError,
  CardNotTradeableError,
  DuplicateTradeInError,
  ProtectedTradeInTargetError,
  TradeInService,
  type AvailableTradeInCard,
  type PersistTradeInInput,
  type TradeInTransaction,
  type TradeInTransactionRunner
} from "../src/trade-in.js";

const requestedAt = new Date("2026-07-25T12:00:00.000Z");

test("trade-in consumes an owned configured card into a pending audit request", async () => {
  const store = new FakeTradeInStore();
  const service = new TradeInService(store, "broadcaster");

  const result = await service.request({
    userId: "user-1",
    cardId: "epic-card",
    targetTwitchUserId: "viewer-2",
    sourceEventId: "event-1",
    requestedAt
  });

  assert.deepEqual(result, {
    id: "trade-in-1",
    rewardId: "timeout-10m",
    targetTwitchUserId: "viewer-2",
    status: "pending"
  });
  assert.deepEqual(store.persisted, {
    userId: "user-1",
    inventoryId: "inventory-1",
    rewardId: "timeout-10m",
    targetTwitchUserId: "viewer-2",
    sourceEventId: "event-1",
    requestedAt
  });
});

test("broadcaster is protected even without a protected-target database row", async () => {
  const store = new FakeTradeInStore();
  const service = new TradeInService(store, "broadcaster");

  await assert.rejects(
    service.request({
      userId: "user-1",
      cardId: "epic-card",
      targetTwitchUserId: "broadcaster",
      requestedAt
    }),
    ProtectedTradeInTargetError
  );
  assert.equal(store.persisted, null);
  assert.equal(store.protectionChecks, 0);
});

test("manually protected targets are rejected before a card is consumed", async () => {
  const store = new FakeTradeInStore();
  store.protectedTargets.add("protected-viewer");
  const service = new TradeInService(store, "broadcaster");

  await assert.rejects(
    service.request({
      userId: "user-1",
      cardId: "epic-card",
      targetTwitchUserId: "protected-viewer",
      requestedAt
    }),
    ProtectedTradeInTargetError
  );
  assert.equal(store.persisted, null);
});

test("unowned, non-tradeable, and duplicate requests fail without persistence", async () => {
  const store = new FakeTradeInStore();
  const service = new TradeInService(store, "broadcaster");

  store.card = null;
  await assert.rejects(
    service.request({ userId: "user-1", cardId: "missing", requestedAt }),
    AvailableCardNotFoundError
  );

  store.card = { inventoryId: "inventory-2", rewardId: null };
  await assert.rejects(
    service.request({ userId: "user-1", cardId: "common-card", requestedAt }),
    CardNotTradeableError
  );

  store.card = { inventoryId: "inventory-1", rewardId: "timeout-10m" };
  store.processedEvents.add("event-1");
  await assert.rejects(
    service.request({
      userId: "user-1",
      cardId: "epic-card",
      sourceEventId: "event-1",
      requestedAt
    }),
    DuplicateTradeInError
  );
  assert.equal(store.persisted, null);
});

class FakeTradeInStore implements TradeInTransactionRunner, TradeInTransaction {
  userExists = true;
  card: AvailableTradeInCard | null = {
    inventoryId: "inventory-1",
    rewardId: "timeout-10m"
  };
  readonly protectedTargets = new Set<string>();
  readonly processedEvents = new Set<string>();
  persisted: PersistTradeInInput | null = null;
  protectionChecks = 0;

  runTradeInTransaction<T>(
    work: (transaction: TradeInTransaction) => Promise<T>
  ): Promise<T> {
    return work(this);
  }

  async lockUser(): Promise<boolean> {
    return this.userExists;
  }

  async hasProcessedSourceEvent(sourceEventId: string): Promise<boolean> {
    return this.processedEvents.has(sourceEventId);
  }

  async getAvailableTradeInCard(): Promise<AvailableTradeInCard | null> {
    return this.card;
  }

  async isProtectedTarget(twitchUserId: string): Promise<boolean> {
    this.protectionChecks += 1;
    return this.protectedTargets.has(twitchUserId);
  }

  async recordTradeIn(input: PersistTradeInInput): Promise<string> {
    this.persisted = input;
    return "trade-in-1";
  }
}
