import { createTwitchBotRuntime } from "./index.js";
import { startHealthServer } from "./health-server.js";

const runtime = createTwitchBotRuntime({ enableTwitch: false });
const worker = runtime.startEconomyWorker();

if (!worker) {
  await runtime.close();
  throw new Error("DATABASE_URL and REDIS_URL are required to start the economy worker");
}

worker.on("failed", (job, error) => {
  console.error("Economy job failed", { jobId: job?.id, jobName: job?.name, error });
});
worker.on("error", (error) => {
  console.error("Economy worker error", error);
});

console.log("Economy worker started");
await worker.waitUntilReady();
const health = await startHealthServer("economy-worker", runtime.config.healthPort);
if (health) console.log(`Health server listening on port ${health.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    health?.markStopping();
    void Promise.all([runtime.close(), health?.close()]).then(() => process.exit(0), (error: unknown) => {
      console.error("Economy worker shutdown failed", error);
      process.exit(1);
    });
  });
}
