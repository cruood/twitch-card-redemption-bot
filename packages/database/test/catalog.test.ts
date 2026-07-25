import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { RARITIES } from "@cardbot/rarity";
import { parseCatalog } from "../src/catalog.js";

test("starter catalog is valid and covers every rarity", async () => {
  const source = await readFile(new URL("../../../catalog/cards.json", import.meta.url), "utf8");
  const cards = parseCatalog(JSON.parse(source) as unknown);

  assert.ok(cards.length >= RARITIES.length);
  for (const rarity of RARITIES) {
    assert.ok(cards.some((card) => card.rarity === rarity));
  }
});

test("catalog validation rejects duplicate IDs and missing rarity coverage", () => {
  assert.throws(
    () => parseCatalog([{ id: "one", name: "One", rarity: "common" }]),
    /must include at least one uncommon/
  );
});
