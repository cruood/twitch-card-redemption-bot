import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BullMqEconomyQueue } from "@cardbot/queue";
import { Queue } from "bullmq";

test("BullMQ removes stream accrual scheduling and enqueues one finalization", async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for integration tests");
  const queueName = `stream-economy-integration-${randomUUID()}`;
  const economy = new BullMqEconomyQueue(redisUrl, queueName);
  const inspector = new Queue(queueName, { connection: { url: redisUrl } });
  try {
    await economy.scheduleStreamAccrual("stream-1");
    assert.equal((await inspector.getJobSchedulers()).length, 1);

    const endedAt = new Date("2026-07-22T12:30:00Z");
    await economy.stopAccrualAndFinalize("stream-1", endedAt);

    assert.equal((await inspector.getJobSchedulers()).length, 0);
    const finalization = await inspector.getJob("finalize-stream-stream-1");
    assert.ok(finalization);
    assert.deepEqual(finalization.data, {
      twitchStreamId: "stream-1",
      endedAt: endedAt.toISOString()
    });
  } finally {
    await economy.close();
    await inspector.obliterate({ force: true });
    await inspector.close();
  }
});
