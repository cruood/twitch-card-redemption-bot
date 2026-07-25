import { loadConfig } from "@cardbot/shared-config";

export function createDiscordBotRuntime() {
  const config = loadConfig(process.env);
  return {
    config,
    status: "discord companion bot scaffolded"
  };
}
