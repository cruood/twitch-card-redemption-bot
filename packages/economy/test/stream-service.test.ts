import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNextAttendanceStreak,
  StreamEconomyService,
  type StreamEconomyStore,
  type StreamStartedInput,
  type ViewerOptInInput,
  type ViewerOptInResult
} from "../src/stream-service.js";

test("attendance streak increments only when the immediately previous stream was attended", () => {
  assert.equal(calculateNextAttendanceStreak(4, true), 5);
  assert.equal(calculateNextAttendanceStreak(4, false), 1);
  assert.throws(() => calculateNextAttendanceStreak(-1, true), /non-negative integer/);
});

test("stream accrual summarizes opted-in viewers and awarded currency", async () => {
  const store = new FakeStreamEconomyStore();
  store.userIds = ["u1", "u2", "u3"];
  store.awards = new Map([
    ["u1", 100],
    ["u2", 0],
    ["u3", 200]
  ]);
  const service = new StreamEconomyService(store);

  const result = await service.accrueStream("stream-1", new Date("2026-07-21T18:30:00Z"));

  assert.deepEqual(result, {
    participantCount: 3,
    creditedParticipantCount: 2,
    currencyAwarded: 300
  });
  assert.deepEqual(store.accruedUsers, ["u1", "u2", "u3"]);
});

test("ending a stream records its end before final accrual", async () => {
  const calls: string[] = [];
  const store = new FakeStreamEconomyStore(calls);
  store.userIds = ["u1"];
  store.awards.set("u1", 100);
  const service = new StreamEconomyService(store);

  await service.endStream("stream-1", new Date("2026-07-21T20:00:00Z"));

  assert.deepEqual(calls, ["end", "list", "accrue:u1"]);
});

class FakeStreamEconomyStore implements StreamEconomyStore {
  userIds: string[] = [];
  awards = new Map<string, number>();
  accruedUsers: string[] = [];

  constructor(private readonly calls: string[] = []) {}

  async recordStreamStarted(_input: StreamStartedInput): Promise<string> {
    return "stream-1";
  }

  async recordStreamEnded(): Promise<void> {
    this.calls.push("end");
  }

  async recordStreamObservedLive(): Promise<void> {}

  async optInViewer(_input: ViewerOptInInput): Promise<ViewerOptInResult> {
    return {
      userId: "u1",
      streamId: "stream-1",
      newlyOptedIn: true,
      attendanceStreak: 1
    };
  }

  async listOptedInUserIds(): Promise<readonly string[]> {
    this.calls.push("list");
    return this.userIds;
  }

  async accrueOptedInUser(userId: string): Promise<number> {
    this.calls.push(`accrue:${userId}`);
    this.accruedUsers.push(userId);
    return this.awards.get(userId) ?? 0;
  }

  async incrementMessageCount(): Promise<boolean> {
    return true;
  }

  async incrementRewardRedemptionCount(): Promise<boolean> {
    return true;
  }

  async getActiveTwitchStreamId(): Promise<string | null> {
    return "stream-1";
  }

  async getActiveStreamState() {
    return {
      twitchStreamId: "stream-1",
      startedAt: new Date("2026-07-21T18:00:00Z"),
      lastLiveAt: new Date("2026-07-21T18:20:00Z")
    };
  }
}
