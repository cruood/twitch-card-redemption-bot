import assert from "node:assert/strict";
import test from "node:test";
import { StreamEconomyService, type StreamEconomyStore } from "@cardbot/economy";
import {
  ECONOMY_JOB_NAMES,
  createEconomyJobProcessor,
  redisConnectionFromUrl
} from "../src/index.js";

test("accrual jobs use worker time while finalization uses Twitch event time", async () => {
  const store = new RecordingStore();
  const economy = new StreamEconomyService(store);
  const workerNow = new Date("2026-07-21T18:20:00Z");
  const processJob = createEconomyJobProcessor(economy, () => workerNow);

  await processJob({
    name: ECONOMY_JOB_NAMES.accrueStream,
    data: { twitchStreamId: "12345" }
  });
  await processJob({
    name: ECONOMY_JOB_NAMES.finalizeStream,
    data: { twitchStreamId: "12345", endedAt: "2026-07-21T19:00:00Z" }
  });

  assert.deepEqual(store.accrualTimes, [workerNow, new Date("2026-07-21T19:00:00Z")]);
  assert.deepEqual(store.endedTimes, [new Date("2026-07-21T19:00:00Z")]);
});

test("job payloads and Redis URLs are validated", async () => {
  const processJob = createEconomyJobProcessor(
    new StreamEconomyService(new RecordingStore())
  );

  await assert.rejects(
    processJob({ name: ECONOMY_JOB_NAMES.accrueStream, data: { twitchStreamId: "bad:id" } }),
    /letters, numbers/
  );
  assert.throws(() => redisConnectionFromUrl("https://localhost:6379"), /redis:\/\//);
  assert.throws(() => redisConnectionFromUrl("redis://localhost/not-a-number"), /database/);
  assert.deepEqual(redisConnectionFromUrl("rediss://bot:secret@redis.example:6380/2"), {
    host: "redis.example",
    port: 6380,
    username: "bot",
    password: "secret",
    db: 2,
    tls: {}
  });
});

class RecordingStore implements StreamEconomyStore {
  accrualTimes: Date[] = [];
  endedTimes: Date[] = [];

  async recordStreamStarted(): Promise<string> {
    return "stream-internal";
  }

  async recordStreamEnded(_streamId: string, endedAt: Date): Promise<void> {
    this.endedTimes.push(endedAt);
  }

  async recordStreamObservedLive(): Promise<void> {}

  async optInViewer() {
    return {
      userId: "user-internal",
      streamId: "stream-internal",
      newlyOptedIn: true,
      attendanceStreak: 1
    };
  }

  async listOptedInUserIds(): Promise<readonly string[]> {
    return ["user-internal"];
  }

  async accrueOptedInUser(_userId: string, _streamId: string, now: Date): Promise<number> {
    this.accrualTimes.push(now);
    return 0;
  }

  async incrementMessageCount(): Promise<boolean> {
    return true;
  }

  async incrementRewardRedemptionCount(): Promise<boolean> {
    return true;
  }

  async getActiveTwitchStreamId(): Promise<string | null> {
    return "12345";
  }

  async getActiveStreamState() {
    return {
      twitchStreamId: "12345",
      startedAt: new Date("2026-07-21T18:00:00Z"),
      lastLiveAt: new Date("2026-07-21T18:20:00Z")
    };
  }
}
