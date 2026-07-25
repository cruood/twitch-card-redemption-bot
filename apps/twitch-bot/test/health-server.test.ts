import assert from "node:assert/strict";
import test from "node:test";
import { startHealthServer } from "../src/health-server.js";

test("health server exposes readiness and reports shutdown", async () => {
  const server = await startHealthServer("test-service", 0, "127.0.0.1");
  assert.ok(server);
  try {
    const healthy = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { service: "test-service", status: "ok" });

    server.markStopping();
    const stopping = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    assert.equal(stopping.status, 503);
  } finally {
    await server.close();
  }
});

test("health server stays disabled without a configured port", async () => {
  assert.equal(await startHealthServer("test-service", undefined), undefined);
});
