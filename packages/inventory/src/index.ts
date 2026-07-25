import { assertAllowedPackBatchSize, calculatePackPurchaseCost } from "@cardbot/economy";
import {
  type GlobalRarityBudget,
  type ParticipationSignals,
  type Rarity,
  rollRarity
} from "@cardbot/rarity";

export interface CardDefinition {
  id: string;
  name: string;
  rarity: Rarity;
  tradeInRewardId?: string;
}

export interface OwnedCard {
  cardId: string;
  userId: string;
  acquiredAt: Date;
}

export interface PackPull {
  cardId: string;
  name: string;
  rarity: Rarity;
  boostMultiplier: number;
  rarityRoll: number;
}

export interface OpenPacksInput {
  userId: string;
  batchSize: number;
  catalog: readonly CardDefinition[];
  signals: ParticipationSignals;
  budget: GlobalRarityBudget;
  random: () => number;
  now: Date;
}

export interface OpenPacksResult {
  cards: OwnedCard[];
  pulls: PackPull[];
  budget: GlobalRarityBudget;
  currencyCost: number;
}

export function openPacks(input: OpenPacksInput): OpenPacksResult {
  assertAllowedPackBatchSize(input.batchSize);

  let budget = input.budget;
  const cards: OwnedCard[] = [];
  const pulls: PackPull[] = [];

  for (let index = 0; index < input.batchSize; index += 1) {
    const roll = rollRarity({
      signals: input.signals,
      budget,
      random: input.random
    });
    budget = roll.budget;

    const card = chooseCardForRarity(input.catalog, roll.rarity, input.random);
    cards.push({
      cardId: card.id,
      userId: input.userId,
      acquiredAt: input.now
    });
    pulls.push({
      cardId: card.id,
      name: card.name,
      rarity: card.rarity,
      boostMultiplier: roll.boostMultiplier,
      rarityRoll: roll.roll
    });
  }

  return {
    cards,
    pulls,
    budget,
    currencyCost: calculatePackPurchaseCost(input.batchSize)
  };
}

export function chooseCardForRarity(
  catalog: readonly CardDefinition[],
  rarity: Rarity,
  random: () => number
): CardDefinition {
  const matches = catalog.filter((card) => card.rarity === rarity);
  if (matches.length === 0) {
    throw new Error(`No cards configured for rarity: ${rarity}`);
  }

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("Random source must return a finite value in [0, 1)");
  }
  const index = Math.floor(randomValue * matches.length);
  return matches[index]!;
}
