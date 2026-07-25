import { createTwitchBotRuntime } from "./index.js";
import { startHealthServer } from "./health-server.js";

const runtime = createTwitchBotRuntime();
let eventSub;
try {
  eventSub = await runtime.startEventSub();
} catch (error) {
  await runtime.close();
  throw error;
}

if (!eventSub) {
  await runtime.close();
  throw new Error(
    "EventSub requires database, Redis, Twitch client, broadcaster, bot, and OAuth token configuration"
  );
}

console.log("Twitch EventSub client started", { tokenStore: runtime.config.twitchTokenStore });
const health = await startHealthServer("twitch-eventsub", runtime.config.healthPort);
if (health) console.log(`Health server listening on port ${health.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    health?.markStopping();
    void Promise.all([runtime.close(), health?.close()]).then(() => process.exit(0), (error: unknown) => {
      console.error("EventSub shutdown failed", error);
      process.exit(1);
    });
  });
}
