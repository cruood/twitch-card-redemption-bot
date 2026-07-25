import {
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
  type JobsOptions
} from "bullmq";
import { type StreamAccrualResult, StreamEconomyService } from "@cardbot/economy";

export const ECONOMY_QUEUE_NAME = "stream-economy";
export const ECONOMY_JOB_NAMES = {
  accrueStream: "accrue-stream",
  finalizeStream: "finalize-stream"
} as const;

export interface AccrueStreamJobData {
  twitchStreamId: string;
}

export interface FinalizeStreamJobData extends AccrueStreamJobData {
  endedAt: string;
}

export type EconomyJobData = AccrueStreamJobData | FinalizeStreamJobData;

export interface EconomyQueuePort {
  scheduleStreamAccrual(twitchStreamId: string): Promise<void>;
  stopAccrualAndFinalize(twitchStreamId: string, endedAt: Date): Promise<void>;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000
};

export class BullMqEconomyQueue implements EconomyQueuePort {
  private readonly queue: Queue<EconomyJobData>;

  constructor(redisUrl: string, queueName = ECONOMY_QUEUE_NAME) {
    this.queue = new Queue<EconomyJobData>(queueName, {
      connection: redisConnectionFromUrl(redisUrl)
    });
  }

  async scheduleStreamAccrual(twitchStreamId: string): Promise<void> {
    assertIdentifier(twitchStreamId, "Twitch stream ID");
    await this.queue.upsertJobScheduler(
      accrualSchedulerId(twitchStreamId),
      { every: 10 * 60_000 },
      {
        name: ECONOMY_JOB_NAMES.accrueStream,
        data: { twitchStreamId },
        opts: DEFAULT_JOB_OPTIONS
      }
    );
  }

  async stopAccrualAndFinalize(twitchStreamId: string, endedAt: Date): Promise<void> {
    assertIdentifier(twitchStreamId, "Twitch stream ID");
    assertValidDate(endedAt, "Stream end time");
    await this.queue.removeJobScheduler(accrualSchedulerId(twitchStreamId));
    await this.queue.add(
      ECONOMY_JOB_NAMES.finalizeStream,
      { twitchStreamId, endedAt: endedAt.toISOString() },
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: `finalize-stream-${twitchStreamId}`
      }
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

export function createEconomyWorker(
  redisUrl: string,
  economy: StreamEconomyService,
  options: { queueName?: string; concurrency?: number; clock?: () => Date } = {}
): Worker<EconomyJobData, StreamAccrualResult> {
  return new Worker<EconomyJobData, StreamAccrualResult>(
    options.queueName ?? ECONOMY_QUEUE_NAME,
    createEconomyJobProcessor(economy, options.clock),
    {
      connection: redisConnectionFromUrl(redisUrl),
      concurrency: options.concurrency ?? 4
    }
  );
}

export async function verifyRedisConnection(
  redisUrl: string,
  queueName = ECONOMY_QUEUE_NAME
): Promise<void> {
  const queue = new Queue(queueName, { connection: redisConnectionFromUrl(redisUrl) });
  try {
    await queue.waitUntilReady();
  } finally {
    await queue.close();
  }
}

export function createEconomyJobProcessor(
  economy: StreamEconomyService,
  clock: () => Date = () => new Date()
): (job: Pick<Job<EconomyJobData>, "name" | "data">) => Promise<StreamAccrualResult> {
  return async (job) => {
    const twitchStreamId = readStreamId(job.data);

    if (job.name === ECONOMY_JOB_NAMES.accrueStream) {
      return economy.accrueStream(twitchStreamId, clock());
    }
    if (job.name === ECONOMY_JOB_NAMES.finalizeStream) {
      const endedAtValue = (job.data as Partial<FinalizeStreamJobData>).endedAt;
      if (typeof endedAtValue !== "string") throw new TypeError("Finalization job requires endedAt");
      const endedAt = new Date(endedAtValue);
      assertValidDate(endedAt, "Finalization endedAt");
      return economy.endStream(twitchStreamId, endedAt);
    }

    throw new Error(`Unknown economy job: ${job.name}`);
  };
}

export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new TypeError("Redis URL must use redis:// or rediss://");
  }
  if (!parsed.hostname) throw new TypeError("Redis URL must include a hostname");

  const databasePath = parsed.pathname.replace(/^\//, "");
  const connection: ConnectionOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379
  };
  if (parsed.username) connection.username = decodeURIComponent(parsed.username);
  if (parsed.password) connection.password = decodeURIComponent(parsed.password);
  if (databasePath) {
    const database = Number(databasePath);
    if (!Number.isInteger(database) || database < 0) {
      throw new TypeError("Redis database must be a non-negative integer");
    }
    connection.db = database;
  }
  if (parsed.protocol === "rediss:") connection.tls = {};
  return connection;
}

function accrualSchedulerId(twitchStreamId: string): string {
  return `stream-accrual-${twitchStreamId}`;
}

function readStreamId(data: EconomyJobData): string {
  const twitchStreamId = (data as Partial<EconomyJobData>).twitchStreamId;
  if (typeof twitchStreamId !== "string") throw new TypeError("Economy job requires twitchStreamId");
  assertIdentifier(twitchStreamId, "Twitch stream ID");
  return twitchStreamId;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, underscores, or hyphens`);
  }
}

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid date`);
}
