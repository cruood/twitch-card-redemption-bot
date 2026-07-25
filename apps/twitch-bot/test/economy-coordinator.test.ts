import assert from "node:assert/strict";
import test from "node:test";
import { StreamEconomyService, type StreamEconomyStore } from "@cardbot/economy";
import { type EconomyQueuePort } from "@cardbot/queue";
import { TwitchEconomyCoordinator } from "../src/economy-coordinator.js";

test("stream online persistence happens before its scheduler is created", async () => {
  const calls: string[] = [];
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(new RecordingStore(calls)),
    new RecordingQueue(calls)
  );

  await coordinator.streamOnline({
    id: "12345",
    startedAt: new Date("2026-07-21T18:00:00Z")
  });

  assert.deepEqual(calls, ["start:12345", "schedule:12345"]);
});

test("startup reconciles a confirmed live database stream with its BullMQ scheduler", async () => {
  const calls: string[] = [];
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(new RecordingStore(calls)),
    new RecordingQueue(calls)
  );

  await coordinator.initialize();
  await coordinator.reconcileCurrentStream(
    { id: "12345", startedAt: new Date("2026-07-21T18:00:00Z") },
    new Date("2026-07-21T18:30:00Z"),
    new Date("2026-07-21T18:30:01Z")
  );

  assert.deepEqual(calls, ["observe:12345:2026-07-21T18:30:01.000Z", "schedule:12345"]);
});

test("startup closes a stale stream at its last confirmed live heartbeat", async () => {
  const calls: string[] = [];
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(new RecordingStore(calls)),
    new RecordingQueue(calls)
  );

  await coordinator.initialize();
  await coordinator.reconcileCurrentStream(null, new Date("2026-07-22T09:00:00Z"));

  assert.deepEqual(calls, [
    "end:12345:2026-07-21T18:20:00.000Z",
    "finalize:12345:2026-07-21T18:20:00.000Z"
  ]);
});

test("reconciliation ignores a status response older than the latest live heartbeat", async () => {
  const calls: string[] = [];
  const store = new RecordingStore(calls, new Date("2026-07-21T18:31:00Z"));
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(store),
    new RecordingQueue(calls)
  );

  await coordinator.reconcileCurrentStream(null, new Date("2026-07-21T18:30:00Z"));

  assert.deepEqual(calls, []);
});

test("stream offline delivery removes periodic accrual and queues one finalization", async () => {
  const calls: string[] = [];
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(new RecordingStore(calls)),
    new RecordingQueue(calls)
  );

  await coordinator.streamOffline({
    id: "12345",
    observedAt: new Date("2026-07-21T20:00:00Z")
  });

  assert.deepEqual(calls, [
    "end:12345:2026-07-21T20:00:00.000Z",
    "finalize:12345:2026-07-21T20:00:00.000Z"
  ]);
});

test("viewer events only count engagement after repository opt-in checks", async () => {
  const calls: string[] = [];
  const coordinator = new TwitchEconomyCoordinator(
    new StreamEconomyService(new RecordingStore(calls)),
    new RecordingQueue(calls)
  );
  const viewer = {
    twitchUserId: "viewer-1",
    displayName: "Viewer",
    twitchStreamId: "12345",
    observedAt: new Date("2026-07-21T18:05:00Z")
  };

  await coordinator.optInCommand(viewer);
  await coordinator.chatMessage(viewer);
  await coordinator.rewardRedemption(viewer);

  assert.deepEqual(calls, ["opt-in:viewer-1", "message:viewer-1", "reward:viewer-1"]);
});

class RecordingQueue implements EconomyQueuePort {
  constructor(private readonly calls: string[]) {}

  async scheduleStreamAccrual(twitchStreamId: string): Promise<void> {
    this.calls.push(`schedule:${twitchStreamId}`);
  }

  async stopAccrualAndFinalize(twitchStreamId: string, endedAt: Date): Promise<void> {
    this.calls.push(`finalize:${twitchStreamId}:${endedAt.toISOString()}`);
  }
}

class RecordingStore implements StreamEconomyStore {
  constructor(
    private readonly calls: string[],
    private readonly lastLiveAt = new Date("2026-07-21T18:20:00Z")
  ) {}

  async recordStreamStarted(input: { twitchStreamId: string }): Promise<string> {
    this.calls.push(`start:${input.twitchStreamId}`);
    return "stream-internal";
  }

  async recordStreamEnded(twitchStreamId: string, endedAt: Date): Promise<void> {
    this.calls.push(`end:${twitchStreamId}:${endedAt.toISOString()}`);
  }

  async recordStreamObservedLive(twitchStreamId: string, observedAt: Date): Promise<void> {
    this.calls.push(`observe:${twitchStreamId}:${observedAt.toISOString()}`);
  }

  async optInViewer(input: { twitchUserId: string }) {
    this.calls.push(`opt-in:${input.twitchUserId}`);
    return {
      userId: "user-internal",
      streamId: "stream-internal",
      newlyOptedIn: true,
      attendanceStreak: 1
    };
  }

  async listOptedInUserIds(): Promise<readonly string[]> {
    return [];
  }

  async accrueOptedInUser(): Promise<number> {
    return 0;
  }

  async incrementMessageCount(twitchUserId: string): Promise<boolean> {
    this.calls.push(`message:${twitchUserId}`);
    return true;
  }

  async incrementRewardRedemptionCount(twitchUserId: string): Promise<boolean> {
    this.calls.push(`reward:${twitchUserId}`);
    return true;
  }

  async getActiveTwitchStreamId(): Promise<string | null> {
    return "12345";
  }

  async getActiveStreamState() {
    return {
      twitchStreamId: "12345",
      startedAt: new Date("2026-07-21T18:00:00Z"),
      lastLiveAt: this.lastLiveAt
    };
  }
}
