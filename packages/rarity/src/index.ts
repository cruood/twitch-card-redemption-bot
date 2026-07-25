export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythical"] as const;

export type Rarity = (typeof RARITIES)[number];

export interface RarityDefinition {
  rarity: Rarity;
  stars: 1 | 2 | 3 | 4 | 5 | 6;
  label: string;
}

export interface ParticipationSignals {
  optedInMinutes: number;
  messageCount: number;
  channelRewardRedemptions: number;
  attendanceStreak: number;
}

export interface GlobalRarityBudget {
  legendaryAvailable: number;
  mythicalAvailable: number;
}

export interface RarityBudgetPolicy {
  legendaryTokensPerDay: number;
  mythicalTokensPerDay: number;
  capacity: number;
}

export interface RarityRollInput {
  signals: ParticipationSignals;
  budget: GlobalRarityBudget;
  random: () => number;
}

export interface RarityRollResult {
  rarity: Rarity;
  budget: GlobalRarityBudget;
  boostMultiplier: number;
  roll: number;
}

export const RARITY_DEFINITIONS: Record<Rarity, RarityDefinition> = {
  common: { rarity: "common", stars: 1, label: "Common" },
  uncommon: { rarity: "uncommon", stars: 2, label: "Uncommon" },
  rare: { rarity: "rare", stars: 3, label: "Rare" },
  epic: { rarity: "epic", stars: 4, label: "Epic" },
  legendary: { rarity: "legendary", stars: 5, label: "Legendary" },
  mythical: { rarity: "mythical", stars: 6, label: "Mythical" }
};

export const BASE_PULL_WEIGHTS: Record<Rarity, number> = {
  common: 72_000,
  uncommon: 24_000,
  rare: 3_600,
  epic: 160,
  legendary: 400,
  mythical: 300
};

export const DEFAULT_RARITY_BUDGET_POLICY: RarityBudgetPolicy = {
  legendaryTokensPerDay: 1 / 7,
  mythicalTokensPerDay: 1 / 10.5,
  capacity: 1
};

export function calculateRarePlusBoost(signals: ParticipationSignals): number {
  assertParticipationSignals(signals);
  const optedInTimeBoost = Math.min(signals.optedInMinutes / 240, 0.25);
  const messageBoost = Math.min(signals.messageCount / 250, 0.2);
  const redemptionBoost = Math.min(signals.channelRewardRedemptions / 30, 0.15);
  const streakBoost = Math.min(signals.attendanceStreak / 20, 0.2);
  return roundTo(1 + optedInTimeBoost + messageBoost + redemptionBoost + streakBoost, 3);
}

export function initialGlobalRarityBudget(): GlobalRarityBudget {
  return {
    legendaryAvailable: 1,
    mythicalAvailable: 1
  };
}

/** @deprecated Use initialGlobalRarityBudget. */
export const initialWeeklyBudget = initialGlobalRarityBudget;

export function replenishGlobalRarityBudget(
  budget: GlobalRarityBudget,
  elapsedDays: number,
  policy: RarityBudgetPolicy = DEFAULT_RARITY_BUDGET_POLICY
): GlobalRarityBudget {
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0) {
    throw new RangeError("Elapsed days must be a non-negative finite number");
  }
  if (!Number.isFinite(policy.capacity) || policy.capacity < 1) {
    throw new RangeError("Rarity budget capacity must allow at least one token");
  }
  if (
    !Number.isFinite(policy.legendaryTokensPerDay) ||
    !Number.isFinite(policy.mythicalTokensPerDay) ||
    policy.legendaryTokensPerDay < 0 ||
    policy.mythicalTokensPerDay < 0
  ) {
    throw new RangeError("Rarity budget replenishment rates must be non-negative finite numbers");
  }

  return {
    legendaryAvailable: Math.min(
      policy.capacity,
      Math.max(0, budget.legendaryAvailable) + policy.legendaryTokensPerDay * elapsedDays
    ),
    mythicalAvailable: Math.min(
      policy.capacity,
      Math.max(0, budget.mythicalAvailable) + policy.mythicalTokensPerDay * elapsedDays
    )
  };
}

export function rollRarity(input: RarityRollInput): RarityRollResult {
  const boostMultiplier = calculateRarePlusBoost(input.signals);
  const weights = boostedWeights(boostMultiplier, input.budget);
  const roll = readRandom(input.random);
  const rarity = chooseWeighted(weights, roll);
  const budget = spendBudget(input.budget, rarity);
  return { rarity, budget, boostMultiplier, roll };
}

export function boostedWeights(
  boostMultiplier: number,
  budget: GlobalRarityBudget
): Record<Rarity, number> {
  const rare = BASE_PULL_WEIGHTS.rare * boostMultiplier;
  const epic = BASE_PULL_WEIGHTS.epic * boostMultiplier;
  const legendary = budget.legendaryAvailable >= 1 ? BASE_PULL_WEIGHTS.legendary * boostMultiplier : 0;
  const mythical = budget.mythicalAvailable >= 1 ? BASE_PULL_WEIGHTS.mythical * boostMultiplier : 0;

  return {
    common: BASE_PULL_WEIGHTS.common,
    uncommon: BASE_PULL_WEIGHTS.uncommon,
    rare,
    epic,
    legendary,
    mythical
  };
}

export function spendBudget(budget: GlobalRarityBudget, rarity: Rarity): GlobalRarityBudget {
  if (rarity === "legendary") {
    return { ...budget, legendaryAvailable: Math.max(0, budget.legendaryAvailable - 1) };
  }
  if (rarity === "mythical") {
    return { ...budget, mythicalAvailable: Math.max(0, budget.mythicalAvailable - 1) };
  }
  return { ...budget };
}

function chooseWeighted(weights: Record<Rarity, number>, randomValue: number): Rarity {
  const entries = RARITIES.map((rarity) => [rarity, weights[rarity]] as const);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = randomValue * total;

  for (const [rarity, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) {
      return rarity;
    }
  }

  return "common";
}

function readRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Random source must return a finite value in [0, 1)");
  }
  return value;
}

function assertParticipationSignals(signals: ParticipationSignals): void {
  for (const [name, value] of Object.entries(signals)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative finite number`);
    }
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
