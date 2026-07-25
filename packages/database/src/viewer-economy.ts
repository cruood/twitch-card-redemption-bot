import { type Rarity } from "@cardbot/rarity";
import { PackOpeningService, type PurchasePacksResult } from "./pack-opening.js";

export interface ViewerRecord {
  id: string;
  displayName: string;
}

export interface InventorySummaryItem {
  cardId: string;
  name: string;
  rarity: Rarity;
  count: number;
}

export interface OpenViewerPacksInput {
  twitchUserId: string;
  twitchStreamId: string;
  batchSize: number;
  now: Date;
  random: () => number;
  sourceEventId?: string;
}

export interface ViewerEconomyStore {
  findViewerByTwitchId(twitchUserId: string): Promise<ViewerRecord | null>;
  findActiveStreamInternalId(twitchStreamId: string): Promise<string | null>;
  getCurrencyBalance(userId: string): Promise<number>;
  getInventorySummary(userId: string): Promise<readonly InventorySummaryItem[]>;
}

export class ViewerNotFoundError extends Error {
  constructor(twitchUserId: string) {
    super(`Viewer has not opted in yet: ${twitchUserId}`);
    this.name = "ViewerNotFoundError";
  }
}

export class ViewerEconomyService {
  constructor(
    private readonly store: ViewerEconomyStore,
    private readonly packs: PackOpeningService
  ) {}

  async getBalance(twitchUserId: string): Promise<{ displayName: string; balance: number }> {
    const viewer = await this.requireViewer(twitchUserId);
    return {
      displayName: viewer.displayName,
      balance: await this.store.getCurrencyBalance(viewer.id)
    };
  }

  async getInventory(twitchUserId: string): Promise<{
    displayName: string;
    cards: readonly InventorySummaryItem[];
  }> {
    const viewer = await this.requireViewer(twitchUserId);
    return {
      displayName: viewer.displayName,
      cards: await this.store.getInventorySummary(viewer.id)
    };
  }

  async openPacks(input: OpenViewerPacksInput): Promise<PurchasePacksResult> {
    const viewer = await this.requireViewer(input.twitchUserId);
    const streamId = await this.store.findActiveStreamInternalId(input.twitchStreamId);
    if (!streamId) throw new Error(`Active stream not found: ${input.twitchStreamId}`);

    return this.packs.purchaseAndOpen({
      userId: viewer.id,
      streamId,
      batchSize: input.batchSize,
      now: input.now,
      random: input.random,
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {})
    });
  }

  private async requireViewer(twitchUserId: string): Promise<ViewerRecord> {
    const viewer = await this.store.findViewerByTwitchId(twitchUserId);
    if (!viewer) throw new ViewerNotFoundError(twitchUserId);
    return viewer;
  }
}
