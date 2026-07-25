import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePackPurchaseCost,
  calculatePassiveAccrual,
  calculatePassiveAccrualResult,
  optInForStream
} from "../src/index.js";

test("passive currency accrues only in complete ten-minute intervals", () => {
  const participation = optInForStream("u1", "s1", new Date("2026-07-21T18:00:00Z"));
  const earned = calculatePassiveAccrual(participation, new Date("2026-07-21T18:29:59Z"));

  assert.equal(earned, 200);
});

test("accrual result preserves leftover partial minutes in its ledger checkpoint", () => {
  const participation = optInForStream("u1", "s1", new Date("2026-07-21T18:00:00Z"));
  const result = calculatePassiveAccrualResult(
    participation,
    new Date("2026-07-21T18:29:59Z")
  );

  assert.equal(result.amount, 200);
  assert.equal(result.completedIntervals, 2);
  assert.equal(result.checkpoint.toISOString(), "2026-07-21T18:20:00.000Z");
});

test("clock rollback never creates negative currency", () => {
  const participation = optInForStream("u1", "s1", new Date("2026-07-21T18:00:00Z"));
  const result = calculatePassiveAccrualResult(
    participation,
    new Date("2026-07-21T17:59:00Z")
  );

  assert.equal(result.amount, 0);
  assert.equal(result.checkpoint.toISOString(), "2026-07-21T18:00:00.000Z");
});

test("pack purchases are restricted to 1, 5, or 10 packs", () => {
  assert.equal(calculatePackPurchaseCost(1), 500);
  assert.equal(calculatePackPurchaseCost(5), 2500);
  assert.equal(calculatePackPurchaseCost(10), 5000);
  assert.throws(() => calculatePackPurchaseCost(25), /1, 5, 10/);
});
