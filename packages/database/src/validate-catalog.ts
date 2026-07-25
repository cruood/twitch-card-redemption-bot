import { readFile } from "node:fs/promises";
import { RARITIES } from "@cardbot/rarity";
import { parseCatalog } from "./catalog.js";

const sourcePath = process.argv[2];
const source = sourcePath
  ? await readFile(sourcePath, "utf8")
  : await readFile(new URL("../../../catalog/cards.json", import.meta.url), "utf8");
const cards = parseCatalog(JSON.parse(source) as unknown);

const rarityCounts = RARITIES.map((rarity) => ({
  rarity,
  cards: cards.filter((card) => card.rarity === rarity).length,
  tradeInRewards: cards.filter(
    (card) => card.rarity === rarity && card.tradeInRewardId
  ).length
}));

console.table(rarityCounts);
console.log(
  `Valid catalog: ${cards.length} cards, ` +
  `${cards.filter((card) => card.tradeInRewardId).length} trade-in reward mappings`
);
