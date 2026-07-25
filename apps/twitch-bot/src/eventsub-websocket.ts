import WebSocket, { type RawData } from "ws";
import { TwitchEventSubRouter } from "./eventsub-router.js";
import { TwitchHelixEventSubClient, type EventSubRegistrationConfig } from "./helix-eventsub.js";

const DEFAULT_EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

interface EventSubEnvelope {
  metadata: {
    messageId: string;
    messageType: string;
    messageTimestamp: string;
    subscriptionType?: string;
  };
  payload: Record<string, unknown>;
}

export interface EventSubLogger {
  info(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export class TwitchEventSubWebSocketClient {
  private activeSocket: WebSocket | undefined;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  private validationTimer: ReturnType<typeof setInterval> | undefined;
  private keepaliveTimeoutMs = 35_000;
  private readonly seenMessageIds = new Set<string>();
  private readonly inFlightMessageIds = new Set<string>();

  constructor(
    private readonly helix: TwitchHelixEventSubClient,
    private readonly router: TwitchEventSubRouter,
    private readonly registration: EventSubRegistrationConfig,
    private readonly logger: EventSubLogger = console
  ) {}

  async start(): Promise<void> {
    if (this.activeSocket) return;
    this.stopped = false;
    try {
      await this.helix.validateCredentials(this.registration);
      this.validationTimer = setInterval(() => {
        void this.helix.validateCredentials(this.registration).catch((error: unknown) => {
          this.logger.error("Twitch token revalidation failed; ending EventSub session", error);
          this.stop();
        });
      }, 60 * 60_000);
      await this.connect(DEFAULT_EVENTSUB_URL, "fresh");
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.validationTimer) clearInterval(this.validationTimer);
    this.activeSocket?.close(1000, "client shutdown");
    this.activeSocket = undefined;
  }

  private connect(
    url: string,
    mode: "fresh" | "twitch-reconnect",
    previousSocket?: WebSocket
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let welcomed = false;
      const welcomeDeadline = setTimeout(() => {
        if (welcomed) return;
        socket.terminate();
        reject(new Error("Twitch EventSub welcome timed out"));
      }, 15_000);

      socket.on("message", (raw) => {
        void this.handleRawMessage(raw, socket, mode, previousSocket)
          .then((wasWelcome) => {
            if (!wasWelcome || welcomed) return;
            welcomed = true;
            clearTimeout(welcomeDeadline);
            resolve();
          })
          .catch((error: unknown) => this.logger.error("EventSub message handling failed", error));
      });
      socket.on("error", (error) => {
        this.logger.error("EventSub WebSocket error", error);
        if (!welcomed) {
          clearTimeout(welcomeDeadline);
          reject(error);
        }
      });
      socket.on("close", (code, reason) => {
        clearTimeout(welcomeDeadline);
        if (!welcomed) reject(new Error(`EventSub closed before welcome (${code}): ${reason}`));
        if (!this.stopped && this.activeSocket === socket) this.scheduleFreshReconnect();
      });
    });
  }

  private async handleRawMessage(
    raw: RawData,
    socket: WebSocket,
    mode: "fresh" | "twitch-reconnect",
    previousSocket: WebSocket | undefined
  ): Promise<boolean> {
    const envelope = parseEventSubEnvelope(raw.toString());
    const messageId = envelope.metadata.messageId;
    if (this.seenMessageIds.has(messageId) || this.inFlightMessageIds.has(messageId)) return false;
    this.inFlightMessageIds.add(messageId);
    if (this.activeSocket === socket) this.resetKeepaliveWatchdog(socket);

    try {
      switch (envelope.metadata.messageType) {
        case "session_welcome": {
          const session = readObject(envelope.payload.session, "EventSub session");
          const sessionId = readString(session, "id");
          const keepaliveSeconds = readOptionalNumber(session, "keepalive_timeout_seconds");
          if (keepaliveSeconds) this.keepaliveTimeoutMs = (keepaliveSeconds + 5) * 1_000;
          this.activeSocket = socket;
          this.reconnectAttempt = 0;
          this.resetKeepaliveWatchdog(socket);
          if (mode === "fresh") {
            await this.helix.registerWebSocketSubscriptions(sessionId, this.registration);
          }
          if (previousSocket && previousSocket !== socket) previousSocket.close(1000, "reconnected");
          this.logger.info("Twitch EventSub session ready", { sessionId, mode });
          this.rememberMessage(messageId);
          return true;
        }
        case "notification": {
          const subscriptionType = envelope.metadata.subscriptionType;
          if (!subscriptionType) throw new TypeError("EventSub notification is missing subscription_type");
          await this.router.route(
            subscriptionType,
            envelope.payload.event,
            envelope.metadata.messageTimestamp,
            messageId
          );
          this.rememberMessage(messageId);
          return false;
        }
        case "session_keepalive":
          this.rememberMessage(messageId);
          return false;
        case "session_reconnect": {
          const session = readObject(envelope.payload.session, "EventSub reconnect session");
          const reconnectUrl = readString(session, "reconnect_url");
          void this.connect(reconnectUrl, "twitch-reconnect", socket).catch((error: unknown) => {
            this.logger.error("Twitch-directed EventSub reconnect failed", error);
            this.scheduleFreshReconnect();
          });
          this.rememberMessage(messageId);
          return false;
        }
        case "revocation":
          this.logger.error("Twitch EventSub subscription revoked", envelope.payload.subscription);
          this.rememberMessage(messageId);
          return false;
        default:
          throw new Error(`Unknown EventSub message type: ${envelope.metadata.messageType}`);
      }
    } finally {
      this.inFlightMessageIds.delete(messageId);
    }
  }

  private rememberMessage(messageId: string): void {
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 5_000) {
      const oldest = this.seenMessageIds.values().next().value as string | undefined;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }

  private resetKeepaliveWatchdog(socket: WebSocket): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      if (!this.stopped && this.activeSocket === socket) {
        this.logger.error("Twitch EventSub keepalive timed out");
        socket.terminate();
      }
    }, this.keepaliveTimeoutMs);
  }

  private scheduleFreshReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(DEFAULT_EVENTSUB_URL, "fresh").catch((error: unknown) => {
        this.logger.error("Fresh EventSub reconnect failed", error);
        this.scheduleFreshReconnect();
      });
    }, delay);
  }
}

export function parseEventSubEnvelope(json: string): EventSubEnvelope {
  const root = readObject(JSON.parse(json) as unknown, "EventSub envelope");
  const metadata = readObject(root.metadata, "EventSub metadata");
  return {
    metadata: {
      messageId: readString(metadata, "message_id"),
      messageType: readString(metadata, "message_type"),
      messageTimestamp: readString(metadata, "message_timestamp"),
      ...(typeof metadata.subscription_type === "string"
        ? { subscriptionType: metadata.subscription_type }
        : {})
    },
    payload: readObject(root.payload, "EventSub payload")
  };
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
    throw new TypeError(`EventSub ${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalNumber(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
