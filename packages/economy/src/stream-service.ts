export interface StreamStartedInput {
  twitchStreamId: string;
  startedAt: Date;
}

export interface ViewerOptInInput {
  twitchUserId: string;
  displayName: string;
  twitchStreamId: string;
  optedInAt: Date;
}

export interface ViewerOptInResult {
  userId: string;
  streamId: string;
  newlyOptedIn: boolean;
  attendanceStreak: number;
}

export interface StreamAccrualResult {
  participantCount: number;
  creditedParticipantCount: number;
  currencyAwarded: number;
}

export interface ActiveStreamState {
  twitchStreamId: string;
  startedAt: Date;
  lastLiveAt: Date;
}

export class StreamNotFoundError extends Error {
  constructor(twitchStreamId: string) {
    super(`Active stream not found: ${twitchStreamId}`);
    this.name = "StreamNotFoundError";
  }
}

export function calculateNextAttendanceStreak(
  currentStreak: number,
  attendedPreviousStream: boolean
): number {
  if (!Number.isInteger(currentStreak) || currentStreak < 0) {
    throw new RangeError("Attendance streak must be a non-negative integer");
  }
  return attendedPreviousStream ? currentStreak + 1 : 1;
}

export interface StreamEconomyStore {
  recordStreamStarted(input: StreamStartedInput): Promise<string>;
  recordStreamEnded(twitchStreamId: string, endedAt: Date): Promise<void>;
  recordStreamObservedLive(twitchStreamId: string, observedAt: Date): Promise<void>;
  optInViewer(input: ViewerOptInInput): Promise<ViewerOptInResult>;
  listOptedInUserIds(twitchStreamId: string): Promise<readonly string[]>;
  accrueOptedInUser(userId: string, twitchStreamId: string, now: Date): Promise<number>;
  incrementMessageCount(
    twitchUserId: string,
    twitchStreamId: string,
    eventMessageId?: string
  ): Promise<boolean>;
  incrementRewardRedemptionCount(
    twitchUserId: string,
    twitchStreamId: string,
    eventMessageId?: string
  ): Promise<boolean>;
  getActiveTwitchStreamId(): Promise<string | null>;
  getActiveStreamState(): Promise<ActiveStreamState | null>;
}

export class StreamEconomyService {
  constructor(private readonly store: StreamEconomyStore) {}

  startStream(input: StreamStartedInput): Promise<string> {
    return this.store.recordStreamStarted(input);
  }

  optIn(input: ViewerOptInInput): Promise<ViewerOptInResult> {
    return this.store.optInViewer(input);
  }

  markStreamEnded(twitchStreamId: string, endedAt: Date): Promise<void> {
    return this.store.recordStreamEnded(twitchStreamId, endedAt);
  }

  markStreamObservedLive(twitchStreamId: string, observedAt: Date): Promise<void> {
    return this.store.recordStreamObservedLive(twitchStreamId, observedAt);
  }

  getActiveTwitchStreamId(): Promise<string | null> {
    return this.store.getActiveTwitchStreamId();
  }

  getActiveStreamState(): Promise<ActiveStreamState | null> {
    return this.store.getActiveStreamState();
  }

  recordOptedInMessage(
    twitchUserId: string,
    twitchStreamId: string,
    eventMessageId?: string
  ): Promise<boolean> {
    return this.store.incrementMessageCount(twitchUserId, twitchStreamId, eventMessageId);
  }

  recordOptedInRewardRedemption(
    twitchUserId: string,
    twitchStreamId: string,
    eventMessageId?: string
  ): Promise<boolean> {
    return this.store.incrementRewardRedemptionCount(
      twitchUserId,
      twitchStreamId,
      eventMessageId
    );
  }

  async accrueStream(twitchStreamId: string, now: Date): Promise<StreamAccrualResult> {
    const userIds = await this.store.listOptedInUserIds(twitchStreamId);
    let creditedParticipantCount = 0;
    let currencyAwarded = 0;

    // Sequential writes keep database pressure predictable until BullMQ owns this fan-out.
    for (const userId of userIds) {
      const amount = await this.store.accrueOptedInUser(userId, twitchStreamId, now);
      if (amount > 0) creditedParticipantCount += 1;
      currencyAwarded += amount;
    }

    return {
      participantCount: userIds.length,
      creditedParticipantCount,
      currencyAwarded
    };
  }

  async endStream(twitchStreamId: string, endedAt: Date): Promise<StreamAccrualResult> {
    await this.store.recordStreamEnded(twitchStreamId, endedAt);
    return this.accrueStream(twitchStreamId, endedAt);
  }
}
