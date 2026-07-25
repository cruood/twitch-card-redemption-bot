import { type TwitchEconomyCoordinator, type TwitchStreamOnlineEvent } from "./economy-coordinator.js";
import {
  requestWithTwitchToken,
  type TwitchAccessTokenProvider
} from "./twitch-tokens.js";

export interface TwitchStreamStatusGateway {
  getCurrentStream(): Promise<TwitchStreamOnlineEvent | null>;
}

export interface StreamReconcilerLogger {
  info(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export class TwitchHelixStreamStatusClient implements TwitchStreamStatusGateway {
  constructor(
    private readonly clientId: string,
    private readonly broadcasterUserId: string,
    private readonly tokens: TwitchAccessTokenProvider,
    private readonly request: typeof fetch = fetch
  ) {}

  async getCurrentStream(): Promise<TwitchStreamOnlineEvent | null> {
    const url = new URL("https://api.twitch.tv/helix/streams");
    url.searchParams.set("user_id", this.broadcasterUserId);
    const response = await requestWithTwitchToken(this.tokens, "broadcaster", (accessToken) =>
      this.request(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      })
    );
    if (!response.ok) {
      throw new Error(`Twitch stream status failed (${response.status}): ${await response.text()}`);
    }
    const body = readObject(await response.json(), "Twitch stream response");
    if (!Array.isArray(body.data)) throw new TypeError("Twitch stream response data must be an array");
    const first = body.data[0];
    if (first === undefined) return null;
    const stream = readObject(first, "Twitch stream");
    return {
      id: readString(stream, "id"),
      startedAt: parseTimestamp(readString(stream, "started_at"))
    };
  }
}

export class TwitchStreamReconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(
    private readonly status: TwitchStreamStatusGateway,
    private readonly coordinator: TwitchEconomyCoordinator,
    private readonly intervalMs = 2 * 60_000,
    private readonly clock: () => Date = () => new Date(),
    private readonly logger: StreamReconcilerLogger = console
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("Stream reconciliation interval must be positive");
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.poll();
    this.timer = setInterval(() => void this.pollSafely(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async pollSafely(): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      this.logger.error("Twitch stream reconciliation failed", error);
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const checkedAt = this.clock();
    try {
      const current = await this.status.getCurrentStream();
      const observedAt = this.clock();
      await this.coordinator.reconcileCurrentStream(current, checkedAt, observedAt);
      this.logger.info("Twitch stream state reconciled", {
        twitchStreamId: current?.id ?? null,
        observedAt: observedAt.toISOString()
      });
    } finally {
      this.polling = false;
    }
  }
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Twitch stream ${key} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid Twitch stream timestamp: ${value}`);
  return date;
}
