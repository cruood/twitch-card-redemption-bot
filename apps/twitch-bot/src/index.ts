import {
  PackOpeningService,
  PostgresDatabase,
  ViewerEconomyService
} from "@cardbot/database";
import { StreamEconomyService } from "@cardbot/economy";
import { BullMqEconomyQueue, createEconomyWorker } from "@cardbot/queue";
import { loadConfig, type RuntimeConfig } from "@cardbot/shared-config";
import { TwitchEconomyCoordinator } from "./economy-coordinator.js";
import { TwitchEconomyCommandService } from "./chat-commands.js";
import { TwitchEventSubRouter } from "./eventsub-router.js";
import { TwitchEventSubWebSocketClient } from "./eventsub-websocket.js";
import {
  RefreshingTwitchAccessTokenProvider,
  StaticTwitchAccessTokenProvider,
  TwitchHelixEventSubClient,
  type TwitchAccessTokenProvider
} from "./helix-eventsub.js";
import { TwitchHelixChatClient } from "./helix-chat.js";
import { EnvFileTwitchTokenStore } from "./env-token-store.js";
import { PostgresTwitchTokenStore } from "./postgres-token-store.js";
import { TwitchHelixStreamStatusClient, TwitchStreamReconciler } from "./stream-reconciler.js";

export * from "./economy-coordinator.js";
export * from "./eventsub-router.js";
export * from "./eventsub-websocket.js";
export * from "./helix-eventsub.js";
export * from "./helix-chat.js";
export * from "./chat-commands.js";
export * from "./env-token-store.js";
export * from "./postgres-token-store.js";
export * from "./twitch-tokens.js";
export * from "./stream-reconciler.js";
export * from "./health-server.js";

export interface TwitchModerationTarget {
  userId: string;
  displayName: string;
}

export interface TwitchModerationGateway {
  timeout(target: TwitchModerationTarget, durationSeconds: number, reason: string): Promise<void>;
  ban(target: TwitchModerationTarget, reason: string): Promise<void>;
  addVip(target: TwitchModerationTarget, expiresAt: Date): Promise<void>;
  removeVip(target: TwitchModerationTarget, expiresAt: Date): Promise<void>;
  addModeratorVote(target: TwitchModerationTarget): Promise<void>;
  removeModeratorVote(target: TwitchModerationTarget): Promise<void>;
}

export class DryRunTwitchModerationGateway implements TwitchModerationGateway {
  async timeout(): Promise<void> {}
  async ban(): Promise<void> {}
  async addVip(): Promise<void> {}
  async removeVip(): Promise<void> {}
  async addModeratorVote(): Promise<void> {}
  async removeModeratorVote(): Promise<void> {}
}

export function createTwitchBotRuntime(options: { enableTwitch?: boolean } = {}) {
  const config = loadConfig(process.env);
  const database = config.databaseUrl
    ? new PostgresDatabase({ connectionString: config.databaseUrl })
    : undefined;
  const economy = database ? new StreamEconomyService(database) : undefined;
  const economyQueue = config.redisUrl ? new BullMqEconomyQueue(config.redisUrl) : undefined;
  const economyCoordinator = economy && economyQueue
    ? new TwitchEconomyCoordinator(economy, economyQueue)
    : undefined;
  const packOpening = database ? new PackOpeningService(database) : undefined;
  const viewerEconomy = database && packOpening
    ? new ViewerEconomyService(database, packOpening)
    : undefined;
  const tokenProvider = options.enableTwitch === false
    ? undefined
    : createTwitchTokenProvider(config, database);
  const chat = tokenProvider && config.twitchClientId && config.twitchBroadcasterId &&
    config.twitchBotUserId
    ? new TwitchHelixChatClient(
        config.twitchClientId,
        config.twitchBroadcasterId,
        config.twitchBotUserId,
        tokenProvider
      )
    : undefined;
  const commands = economyCoordinator && viewerEconomy && chat
    ? new TwitchEconomyCommandService(
        economyCoordinator,
        viewerEconomy,
        chat,
        config.twitchOptInCommand
      )
    : undefined;
  const eventSub = economyCoordinator && commands && tokenProvider && config.twitchClientId && config.twitchBroadcasterId &&
    config.twitchBotUserId
    ? new TwitchEventSubWebSocketClient(
        new TwitchHelixEventSubClient(
          config.twitchClientId,
          tokenProvider
        ),
        new TwitchEventSubRouter(economyCoordinator, config.twitchOptInCommand, commands),
        {
          broadcasterUserId: config.twitchBroadcasterId,
          botUserId: config.twitchBotUserId
        }
      )
    : undefined;
  const streamReconciler = economyCoordinator && tokenProvider && config.twitchClientId &&
    config.twitchBroadcasterId
    ? new TwitchStreamReconciler(
        new TwitchHelixStreamStatusClient(
          config.twitchClientId,
          config.twitchBroadcasterId,
          tokenProvider
        ),
        economyCoordinator
      )
    : undefined;
  let economyWorker: ReturnType<typeof createEconomyWorker> | undefined;

  return {
    config,
    database,
    economy,
    economyQueue,
    economyCoordinator,
    viewerEconomy,
    tokenProvider,
    commands,
    chat,
    eventSub,
    streamReconciler,
    packOpening,
    moderation: new DryRunTwitchModerationGateway(),
    startEconomyWorker: () => {
      if (!config.redisUrl || !economy) return undefined;
      economyWorker ??= createEconomyWorker(config.redisUrl, economy);
      return economyWorker;
    },
    startEventSub: async () => {
      if (!eventSub || !economyCoordinator || !streamReconciler) return undefined;
      await economyCoordinator.initialize();
      await eventSub.start();
      await streamReconciler.start();
      return eventSub;
    },
    close: async () => {
      streamReconciler?.stop();
      eventSub?.stop();
      await economyWorker?.close();
      await economyQueue?.close();
      await database?.close();
    }
  };
}

export function createTwitchTokenProvider(
  config: RuntimeConfig,
  database?: PostgresDatabase
): TwitchAccessTokenProvider | undefined {
  const initialTokens = readInitialTokenSnapshot(config);
  if (config.twitchTokenStore === "postgres") {
    if (!config.twitchClientId || !config.twitchClientSecret) {
      throw new Error("PostgreSQL Twitch token persistence requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET");
    }
    if (!database) throw new Error("TWITCH_TOKEN_STORE=postgres requires DATABASE_URL");
    return new RefreshingTwitchAccessTokenProvider(
      config.twitchClientId,
      config.twitchClientSecret,
      initialTokens,
      new PostgresTwitchTokenStore(database, database)
    );
  }

  if (!config.twitchBotAccessToken || !config.twitchBroadcasterAccessToken) return undefined;
  if (config.twitchClientId && config.twitchClientSecret && initialTokens) {
    return new RefreshingTwitchAccessTokenProvider(
      config.twitchClientId,
      config.twitchClientSecret,
      initialTokens,
      new EnvFileTwitchTokenStore(config.twitchTokenStorePath)
    );
  }
  return new StaticTwitchAccessTokenProvider(
    config.twitchBotAccessToken,
    config.twitchBroadcasterAccessToken
  );
}

function readInitialTokenSnapshot(config: RuntimeConfig) {
  if (
    !config.twitchBotAccessToken ||
    !config.twitchBroadcasterAccessToken ||
    !config.twitchBotRefreshToken ||
    !config.twitchBroadcasterRefreshToken
  ) {
    return undefined;
  }
  return {
    bot: {
      accessToken: config.twitchBotAccessToken,
      refreshToken: config.twitchBotRefreshToken
    },
    broadcaster: {
      accessToken: config.twitchBroadcasterAccessToken,
      refreshToken: config.twitchBroadcasterRefreshToken
    }
  };
}
