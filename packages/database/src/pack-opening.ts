import { calculatePackPurchaseCost } from "@cardbot/economy";
import { type CardDefinition, type OpenPacksResult, openPacks } from "@cardbot/inventory";
import { type GlobalRarityBudget, type ParticipationSignals } from "@cardbot/rarity";

export interface PurchasePacksInput {
  userId: string;
  streamId: string | null;
  batchSize: number;
  now: Date;
  random: () => number;
  sourceEventId?: string;
}

export interface PersistPackOpeningInput {
  userId: string;
  streamId: string | null;
  batchSize: number;
  currencyCost: number;
  cards: OpenPacksResult["cards"];
  pulls: OpenPacksResult["pulls"];
  signals: ParticipationSignals;
  budgetBefore: GlobalRarityBudget;
  budget: GlobalRarityBudget;
  openedAt: Date;
  sourceEventId?: string;
}

export interface PurchasePacksResult extends OpenPacksResult {
  openingId: string;
  remainingBalance: number;
}

export interface PackOpeningTransaction {
  lockUser(userId: string): Promise<boolean>;
  getCurrencyBalance(userId: string): Promise<number>;
  hasProcessedSourceEvent(sourceEventId: string): Promise<boolean>;
  getParticipationSignals(
    userId: string,
    streamId: string | null,
    now: Date
  ): Promise<ParticipationSignals>;
  getCardCatalog(): Promise<readonly CardDefinition[]>;
  getRarityBudget(now: Date): Promise<GlobalRarityBudget>;
  recordPackOpening(input: PersistPackOpeningInput): Promise<string>;
}

export interface PackOpeningTransactionRunner {
  runPackOpeningTransaction<T>(
    work: (transaction: PackOpeningTransaction) => Promise<T>
  ): Promise<T>;
}

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

export class InsufficientCurrencyError extends Error {
  constructor(
    public readonly available: number,
    public readonly required: number
  ) {
    super(`Insufficient currency: ${available} available, ${required} required`);
    this.name = "InsufficientCurrencyError";
  }
}

export class DuplicateCommandError extends Error {
  constructor(sourceEventId: string) {
    super(`Command was already processed: ${sourceEventId}`);
    this.name = "DuplicateCommandError";
  }
}

export class PackOpeningService {
  constructor(private readonly transactions: PackOpeningTransactionRunner) {}

  purchaseAndOpen(input: PurchasePacksInput): Promise<PurchasePacksResult> {
    const currencyCost = calculatePackPurchaseCost(input.batchSize);

    return this.transactions.runPackOpeningTransaction(async (transaction) => {
      if (!(await transaction.lockUser(input.userId))) {
        throw new UserNotFoundError(input.userId);
      }

      if (input.sourceEventId && await transaction.hasProcessedSourceEvent(input.sourceEventId)) {
        throw new DuplicateCommandError(input.sourceEventId);
      }

      const balance = await transaction.getCurrencyBalance(input.userId);
      if (balance < currencyCost) {
        throw new InsufficientCurrencyError(balance, currencyCost);
      }

      // A PostgreSQL transaction uses one client, so its queries must not overlap.
      const signals = await transaction.getParticipationSignals(input.userId, input.streamId, input.now);
      const catalog = await transaction.getCardCatalog();
      const budget = await transaction.getRarityBudget(input.now);
      const opened = openPacks({
        userId: input.userId,
        batchSize: input.batchSize,
        catalog,
        signals,
        budget,
        random: input.random,
        now: input.now
      });
      const openingId = await transaction.recordPackOpening({
        userId: input.userId,
        streamId: input.streamId,
        batchSize: input.batchSize,
        currencyCost,
        cards: opened.cards,
        pulls: opened.pulls,
        signals,
        budgetBefore: budget,
        budget: opened.budget,
        openedAt: input.now,
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {})
      });

      return {
        ...opened,
        openingId,
        remainingBalance: balance - currencyCost
      };
    });
  }
}
