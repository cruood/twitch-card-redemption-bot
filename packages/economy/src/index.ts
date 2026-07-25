export interface EconomyConfig {
  currencyPerInterval: number;
  intervalMinutes: number;
  packCost: number;
  allowedPackBatchSizes: readonly number[];
}

export * from "./stream-service.js";

export interface StreamParticipation {
  userId: string;
  streamId: string;
  optedInAt: Date | null;
  lastAccruedAt: Date | null;
}

export interface PassiveAccrualResult {
  amount: number;
  completedIntervals: number;
  checkpoint: Date;
}

export const DEFAULT_ECONOMY_CONFIG: EconomyConfig = {
  currencyPerInterval: 100,
  intervalMinutes: 10,
  packCost: 500,
  allowedPackBatchSizes: [1, 5, 10]
};

export function optInForStream(
  userId: string,
  streamId: string,
  now: Date
): StreamParticipation {
  return {
    userId,
    streamId,
    optedInAt: now,
    lastAccruedAt: now
  };
}

export function calculatePassiveAccrual(
  participation: StreamParticipation,
  now: Date,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG
): number {
  return calculatePassiveAccrualResult(participation, now, config).amount;
}

export function calculatePassiveAccrualResult(
  participation: StreamParticipation,
  now: Date,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG
): PassiveAccrualResult {
  assertValidEconomyConfig(config);

  if (!participation.optedInAt || !participation.lastAccruedAt) {
    return { amount: 0, completedIntervals: 0, checkpoint: now };
  }

  const elapsedMs = now.getTime() - participation.lastAccruedAt.getTime();
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const completedIntervals = Math.floor(elapsedMinutes / config.intervalMinutes);
  const amount = completedIntervals * config.currencyPerInterval;
  const checkpoint = new Date(
    participation.lastAccruedAt.getTime() + completedIntervals * config.intervalMinutes * 60_000
  );
  return { amount, completedIntervals, checkpoint };
}

export function assertAllowedPackBatchSize(
  batchSize: number,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG
): void {
  assertValidEconomyConfig(config);
  if (!config.allowedPackBatchSizes.includes(batchSize)) {
    throw new RangeError(`Pack openings must be one of: ${config.allowedPackBatchSizes.join(", ")}`);
  }
}

export function calculatePackPurchaseCost(
  batchSize: number,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG
): number {
  assertAllowedPackBatchSize(batchSize, config);
  return batchSize * config.packCost;
}

function assertValidEconomyConfig(config: EconomyConfig): void {
  if (config.intervalMinutes <= 0 || config.currencyPerInterval < 0 || config.packCost < 0) {
    throw new RangeError("Economy values must use a positive interval and non-negative amounts");
  }
  if (
    config.allowedPackBatchSizes.length === 0 ||
    config.allowedPackBatchSizes.some((size) => !Number.isInteger(size) || size <= 0)
  ) {
    throw new RangeError("Allowed pack batch sizes must be positive integers");
  }
}
