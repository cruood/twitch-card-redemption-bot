import {
  type StreamAccrualResult,
  StreamEconomyService,
  type ViewerOptInResult
} from "@cardbot/economy";
import { type EconomyQueuePort } from "@cardbot/queue";

export interface TwitchStreamOnlineEvent {
  id: string;
  startedAt: Date;
}

export interface TwitchStreamOfflineEvent {
  id: string;
  observedAt: Date;
}

export interface TwitchViewerEvent {
  twitchUserId: string;
  displayName: string;
  twitchStreamId?: string;
  observedAt: Date;
  eventMessageId?: string;
}

export class TwitchEconomyCoordinator {
  private activeTwitchStreamId: string | null = null;
  private scheduledTwitchStreamId: string | null = null;

  constructor(
    private readonly economy: StreamEconomyService,
    private readonly queue: EconomyQueuePort
  ) {}

  async initialize(): Promise<void> {
    this.activeTwitchStreamId = await this.economy.getActiveTwitchStreamId();
  }

  getActiveStreamId(): Promise<string | null> {
    return this.resolveActiveStreamId(undefined);
  }

  async streamOnline(event: TwitchStreamOnlineEvent): Promise<void> {
    assertValidDate(event.startedAt, "Stream start time");
    if (this.activeTwitchStreamId && this.activeTwitchStreamId !== event.id) {
      const previous = await this.economy.getActiveStreamState();
      if (previous) await this.closeStream(previous.twitchStreamId, previous.lastLiveAt);
    }
    await this.economy.startStream({ twitchStreamId: event.id, startedAt: event.startedAt });
    this.activeTwitchStreamId = event.id;
    await this.queue.scheduleStreamAccrual(event.id);
    this.scheduledTwitchStreamId = event.id;
  }

  async streamOffline(event: TwitchStreamOfflineEvent): Promise<void> {
    assertValidDate(event.observedAt, "Stream offline observation time");
    await this.closeStream(event.id, event.observedAt);
  }

  async reconcileCurrentStream(
    current: TwitchStreamOnlineEvent | null,
    checkedAt: Date,
    observedAt: Date = checkedAt
  ): Promise<void> {
    assertValidDate(checkedAt, "Stream status check time");
    assertValidDate(observedAt, "Stream status observation time");
    const stored = await this.economy.getActiveStreamState();
    this.activeTwitchStreamId = stored?.twitchStreamId ?? null;

    // A newer EventSub event won the race with this status request.
    if (stored && stored.lastLiveAt > checkedAt) return;

    if (!current) {
      if (stored) await this.closeStream(stored.twitchStreamId, stored.lastLiveAt);
      return;
    }
    assertValidDate(current.startedAt, "Current stream start time");

    if (stored && stored.twitchStreamId !== current.id) {
      await this.closeStream(stored.twitchStreamId, stored.lastLiveAt);
    }
    if (!stored || stored.twitchStreamId !== current.id) {
      await this.economy.startStream({
        twitchStreamId: current.id,
        startedAt: current.startedAt
      });
    }
    await this.economy.markStreamObservedLive(current.id, observedAt);
    this.activeTwitchStreamId = current.id;
    if (this.scheduledTwitchStreamId !== current.id) {
      await this.queue.scheduleStreamAccrual(current.id);
      this.scheduledTwitchStreamId = current.id;
    }
  }

  async optInCommand(event: TwitchViewerEvent): Promise<ViewerOptInResult> {
    assertValidDate(event.observedAt, "Opt-in time");
    const twitchStreamId = await this.requireActiveStreamId(event.twitchStreamId);
    return this.economy.optIn({
      twitchUserId: event.twitchUserId,
      displayName: event.displayName,
      twitchStreamId,
      optedInAt: event.observedAt
    });
  }

  async chatMessage(event: TwitchViewerEvent): Promise<boolean> {
    const twitchStreamId = await this.resolveActiveStreamId(event.twitchStreamId);
    if (!twitchStreamId) return false;
    return this.economy.recordOptedInMessage(
      event.twitchUserId,
      twitchStreamId,
      event.eventMessageId
    );
  }

  async rewardRedemption(event: TwitchViewerEvent): Promise<boolean> {
    const twitchStreamId = await this.resolveActiveStreamId(event.twitchStreamId);
    if (!twitchStreamId) return false;
    return this.economy.recordOptedInRewardRedemption(
      event.twitchUserId,
      twitchStreamId,
      event.eventMessageId
    );
  }

  private async resolveActiveStreamId(provided: string | undefined): Promise<string | null> {
    if (provided) return provided;
    if (this.activeTwitchStreamId) return this.activeTwitchStreamId;
    this.activeTwitchStreamId = await this.economy.getActiveTwitchStreamId();
    return this.activeTwitchStreamId;
  }

  private async requireActiveStreamId(provided: string | undefined): Promise<string> {
    const twitchStreamId = await this.resolveActiveStreamId(provided);
    if (!twitchStreamId) throw new Error("No active Twitch stream is available");
    return twitchStreamId;
  }

  private async closeStream(twitchStreamId: string, endedAt: Date): Promise<void> {
    await this.economy.markStreamEnded(twitchStreamId, endedAt);
    if (this.activeTwitchStreamId === twitchStreamId) this.activeTwitchStreamId = null;
    await this.queue.stopAccrualAndFinalize(twitchStreamId, endedAt);
    if (this.scheduledTwitchStreamId === twitchStreamId) this.scheduledTwitchStreamId = null;
  }
}

export type EconomyWorkerResult = StreamAccrualResult;

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid date`);
}
