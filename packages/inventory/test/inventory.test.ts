import test from "node:test";
import assert from "node:assert/strict";
import { openPacks, type CardDefinition } from "../src/index.js";

const catalog: CardDefinition[] = [
  { id: "common-1", name: "Hydrate", rarity: "common" },
  { id: "uncommon-1", name: "Sound Alert", rarity: "uncommon" },
  { id: "rare-1", name: "One Minute Timeout", rarity: "rare" },
  { id: "epic-1", name: "Ten Minute Timeout", rarity: "epic" },
  { id: "legendary-1", name: "Vote Remove Moderator", rarity: "legendary" },
  { id: "mythical-1", name: "Permanent Ban Vote", rarity: "mythical" }
];

test("open packs enforces allowed batch sizes", () => {
  assert.throws(
    () =>
      openPacks({
        userId: "u1",
        batchSize: 25,
        catalog,
        signals: { optedInMinutes: 0, messageCount: 0, channelRewardRedemptions: 0, attendanceStreak: 0 },
        budget: { legendaryAvailable: 1, mythicalAvailable: 1 },
        random: () => 0,
        now: new Date("2026-07-21T18:00:00Z")
      }),
    /1, 5, 10/
  );
});

test("open packs returns owned cards for the requesting user", () => {
  const result = openPacks({
    userId: "u1",
    batchSize: 5,
    catalog,
    signals: { optedInMinutes: 0, messageCount: 0, channelRewardRedemptions: 0, attendanceStreak: 0 },
    budget: { legendaryAvailable: 1, mythicalAvailable: 1 },
    random: () => 0,
    now: new Date("2026-07-21T18:00:00Z")
  });

  assert.equal(result.cards.length, 5);
  assert.equal(result.pulls.length, 5);
  assert.equal(result.pulls[0]?.name, "Hydrate");
  assert.equal(result.pulls[0]?.rarityRoll, 0);
  assert.equal(result.pulls[0]?.boostMultiplier, 1);
  assert.ok(result.cards.every((card) => card.userId === "u1"));
  assert.equal(result.currencyCost, 2500);
});

test("card selection rejects an invalid random source", () => {
  assert.throws(
    () =>
      openPacks({
        userId: "u1",
        batchSize: 1,
        catalog,
        signals: { optedInMinutes: 0, messageCount: 0, channelRewardRedemptions: 0, attendanceStreak: 0 },
        budget: { legendaryAvailable: 0, mythicalAvailable: 0 },
        random: (() => {
          const values = [0, 1];
          return () => values.shift()!;
        })(),
        now: new Date("2026-07-21T18:00:00Z")
      }),
    /\[0, 1\)/
  );
});
