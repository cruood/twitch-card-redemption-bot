export interface RequestTradeInInput {
  userId: string;
  cardId: string;
  targetTwitchUserId?: string;
  sourceEventId?: string;
  requestedAt: Date;
}

export interface AvailableTradeInCard {
  inventoryId: string;
  rewardId: string | null;
}

export interface PersistTradeInInput {
  userId: string;
  inventoryId: string;
  rewardId: string;
  targetTwitchUserId: string | null;
  sourceEventId?: string;
  requestedAt: Date;
}

export interface TradeInRequest {
  id: string;
  rewardId: string;
  targetTwitchUserId: string | null;
  status: "pending";
}

export interface TradeInTransaction {
  lockUser(userId: string): Promise<boolean>;
  hasProcessedSourceEvent(sourceEventId: string): Promise<boolean>;
  getAvailableTradeInCard(userId: string, cardId: string): Promise<AvailableTradeInCard | null>;
  isProtectedTarget(twitchUserId: string): Promise<boolean>;
  recordTradeIn(input: PersistTradeInInput): Promise<string>;
}

export interface TradeInTransactionRunner {
  runTradeInTransaction<T>(work: (transaction: TradeInTransaction) => Promise<T>): Promise<T>;
}

export class TradeInUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "TradeInUserNotFoundError";
  }
}

export class AvailableCardNotFoundError extends Error {
  constructor(cardId: string) {
    super(`No available owned card found: ${cardId}`);
    this.name = "AvailableCardNotFoundError";
  }
}

export class CardNotTradeableError extends Error {
  constructor(cardId: string) {
    super(`Card has no configured trade-in reward: ${cardId}`);
    this.name = "CardNotTradeableError";
  }
}

export class ProtectedTradeInTargetError extends Error {
  constructor(twitchUserId: string) {
    super(`Trade-in target is protected: ${twitchUserId}`);
    this.name = "ProtectedTradeInTargetError";
  }
}

export class DuplicateTradeInError extends Error {
  constructor(sourceEventId: string) {
    super(`Trade-in event was already processed: ${sourceEventId}`);
    this.name = "DuplicateTradeInError";
  }
}

export class TradeInService {
  constructor(
    private readonly transactions: TradeInTransactionRunner,
    private readonly broadcasterTwitchUserId: string
  ) {
    if (!broadcasterTwitchUserId.trim()) {
      throw new TypeError("Broadcaster Twitch user ID is required");
    }
  }

  request(input: RequestTradeInInput): Promise<TradeInRequest> {
    assertRequest(input);

    return this.transactions.runTradeInTransaction(async (transaction) => {
      if (!(await transaction.lockUser(input.userId))) {
        throw new TradeInUserNotFoundError(input.userId);
      }

      if (
        input.sourceEventId &&
        await transaction.hasProcessedSourceEvent(input.sourceEventId)
      ) {
        throw new DuplicateTradeInError(input.sourceEventId);
      }

      const card = await transaction.getAvailableTradeInCard(input.userId, input.cardId);
      if (!card) throw new AvailableCardNotFoundError(input.cardId);
      if (!card.rewardId) throw new CardNotTradeableError(input.cardId);

      const targetTwitchUserId = input.targetTwitchUserId?.trim() || null;
      if (
        targetTwitchUserId &&
        (
          targetTwitchUserId === this.broadcasterTwitchUserId ||
          await transaction.isProtectedTarget(targetTwitchUserId)
        )
      ) {
        throw new ProtectedTradeInTargetError(targetTwitchUserId);
      }

      const id = await transaction.recordTradeIn({
        userId: input.userId,
        inventoryId: card.inventoryId,
        rewardId: card.rewardId,
        targetTwitchUserId,
        requestedAt: input.requestedAt,
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {})
      });

      return {
        id,
        rewardId: card.rewardId,
        targetTwitchUserId,
        status: "pending"
      };
    });
  }
}

function assertRequest(input: RequestTradeInInput): void {
  if (!input.userId.trim()) throw new TypeError("User ID is required");
  if (!input.cardId.trim()) throw new TypeError("Card ID is required");
  if (input.sourceEventId !== undefined && !input.sourceEventId.trim()) {
    throw new TypeError("Source event ID cannot be empty");
  }
  if (Number.isNaN(input.requestedAt.getTime())) {
    throw new TypeError("Requested time must be a valid date");
  }
}
