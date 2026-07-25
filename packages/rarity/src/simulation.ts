import {
  type GlobalRarityBudget,
  type ParticipationSignals,
  RARITIES,
  type Rarity,
  initialGlobalRarityBudget,
  replenishGlobalRarityBudget,
  rollRarity
} from "./index.js";

export interface RaritySimulationOptions {
  streams: number;
  pullsPerStream: number;
  runs: number;
  seed: number;
  daysBetweenStreams: number;
}

export interface RaritySimulationRow {
  rarity: Rarity;
  totalPulls: number;
  averagePerStream: number;
  averageStreamsPerPull: number | null;
}

export interface RaritySimulationResult {
  options: RaritySimulationOptions;
  rows: RaritySimulationRow[];
}

export function simulateRarity(options: RaritySimulationOptions): RaritySimulationResult {
  assertSimulationOptions(options);
  const totals = Object.fromEntries(RARITIES.map((rarity) => [rarity, 0])) as Record<Rarity, number>;
  const random = createSeededRandom(options.seed);

  for (let run = 0; run < options.runs; run += 1) {
    let budget: GlobalRarityBudget = initialGlobalRarityBudget();

    for (let stream = 1; stream <= options.streams; stream += 1) {
      const signals = representativeSignals(stream);

      for (let pull = 0; pull < options.pullsPerStream; pull += 1) {
        const result = rollRarity({ signals, budget, random });
        totals[result.rarity] += 1;
        budget = result.budget;
      }

      budget = replenishGlobalRarityBudget(budget, options.daysBetweenStreams);
    }
  }

  const totalSimulatedStreams = options.streams * options.runs;
  return {
    options,
    rows: RARITIES.map((rarity) => ({
      rarity,
      totalPulls: totals[rarity],
      averagePerStream: totals[rarity] / totalSimulatedStreams,
      averageStreamsPerPull:
        totals[rarity] === 0 ? null : totalSimulatedStreams / totals[rarity]
    }))
  };
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function representativeSignals(stream: number): ParticipationSignals {
  return {
    optedInMinutes: 180,
    messageCount: 80 + (stream % 5) * 20,
    channelRewardRedemptions: 4 + (stream % 3),
    attendanceStreak: Math.min(stream, 20)
  };
}

function assertSimulationOptions(options: RaritySimulationOptions): void {
  for (const [name, value] of Object.entries({
    streams: options.streams,
    pullsPerStream: options.pullsPerStream,
    runs: options.runs,
    daysBetweenStreams: options.daysBetweenStreams
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
  if (![options.streams, options.pullsPerStream, options.runs].every(Number.isInteger)) {
    throw new RangeError("Streams, pulls, and runs must be integers");
  }
  if (!Number.isSafeInteger(options.seed)) throw new RangeError("Seed must be a safe integer");
}
