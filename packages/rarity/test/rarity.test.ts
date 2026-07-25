import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateRarePlusBoost,
  initialGlobalRarityBudget,
  replenishGlobalRarityBudget,
  rollRarity,
  spendBudget
} from "../src/index.js";
import { createSeededRandom, simulateRarity } from "../src/simulation.js";

test("boosts are capped and never become unbounded", () => {
  const boost = calculateRarePlusBoost({
    optedInMinutes: 9999,
    messageCount: 9999,
    channelRewardRedemptions: 9999,
    attendanceStreak: 9999
  });

  assert.equal(boost, 1.8);
});

test("legendary and mythical budgets are consumed by matching pulls", () => {
  const afterLegendary = spendBudget(initialGlobalRarityBudget(), "legendary");
  assert.equal(afterLegendary.legendaryAvailable, 0);

  const afterMythical = spendBudget({ legendaryAvailable: 1, mythicalAvailable: 1 }, "mythical");
  assert.equal(afterMythical.mythicalAvailable, 0);
});

test("global budgets replenish on separate seven and ten-and-a-half day schedules", () => {
  const replenished = replenishGlobalRarityBudget(
    { legendaryAvailable: 0, mythicalAvailable: 0 },
    7
  );

  assert.equal(replenished.legendaryAvailable, 1);
  assert.equal(replenished.mythicalAvailable, 2 / 3);
});

test("seeded simulations are repeatable", () => {
  const options = {
    streams: 12,
    pullsPerStream: 100,
    runs: 3,
    seed: 42,
    daysBetweenStreams: 1
  };

  assert.deepEqual(simulateRarity(options), simulateRarity(options));
  assert.equal(createSeededRandom(42)(), createSeededRandom(42)());
});

test("simulation calibrates rare and epic pulls near their per-stream targets", () => {
  const result = simulateRarity({
    streams: 120,
    pullsPerStream: 400,
    runs: 20,
    seed: 42,
    daysBetweenStreams: 1
  });
  const rare = result.rows.find((row) => row.rarity === "rare")!;
  const epic = result.rows.find((row) => row.rarity === "epic")!;
  const legendary = result.rows.find((row) => row.rarity === "legendary")!;
  const mythical = result.rows.find((row) => row.rarity === "mythical")!;

  assert.ok(rare.averagePerStream >= 20 && rare.averagePerStream <= 30);
  assert.ok(epic.averagePerStream >= 0.7 && epic.averagePerStream <= 1.3);
  assert.ok(legendary.averageStreamsPerPull! >= 7 && legendary.averageStreamsPerPull! <= 9);
  assert.ok(mythical.averageStreamsPerPull! >= 10 && mythical.averageStreamsPerPull! <= 12);
});

test("global budget blocks legendary pulls even with maximum boosts", () => {
  const result = rollRarity({
    signals: {
      optedInMinutes: 9999,
      messageCount: 9999,
      channelRewardRedemptions: 9999,
      attendanceStreak: 9999
    },
    budget: { legendaryAvailable: 0, mythicalAvailable: 0 },
    random: () => 0.999999
  });

  assert.notEqual(result.rarity, "legendary");
  assert.notEqual(result.rarity, "mythical");
});
