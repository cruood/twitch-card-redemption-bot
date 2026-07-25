import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { type TwitchTokenPair, type TwitchTokenSnapshot, type TwitchTokenStore } from "./twitch-tokens.js";

const TOKEN_KEYS = {
  bot: {
    accessToken: "TWITCH_BOT_ACCESS_TOKEN",
    refreshToken: "TWITCH_BOT_REFRESH_TOKEN"
  },
  broadcaster: {
    accessToken: "TWITCH_BROADCASTER_ACCESS_TOKEN",
    refreshToken: "TWITCH_BROADCASTER_REFRESH_TOKEN"
  }
} as const;

export class EnvFileTwitchTokenStore implements TwitchTokenStore {
  private readonly path: string;

  constructor(path = ".env") {
    this.path = resolve(path);
  }

  async load(): Promise<TwitchTokenSnapshot | null> {
    const values = parseEnv(await readFile(this.path, "utf8"));
    const pairs = {
      bot: readPair(values, TOKEN_KEYS.bot),
      broadcaster: readPair(values, TOKEN_KEYS.broadcaster)
    };
    if (!pairs.bot && !pairs.broadcaster) return null;
    if (!pairs.bot || !pairs.broadcaster) {
      throw new Error("Twitch token store must contain complete bot and broadcaster credentials");
    }
    return { bot: pairs.bot, broadcaster: pairs.broadcaster };
  }

  async persist(tokens: TwitchTokenSnapshot): Promise<void> {
    const current = await readFile(this.path, "utf8");
    let updated = current;
    updated = updatePair(updated, TOKEN_KEYS.bot, tokens.bot);
    updated = updatePair(updated, TOKEN_KEYS.broadcaster, tokens.broadcaster);

    const temporaryPath = resolve(dirname(this.path), `.${randomUUID()}.tokens.tmp`);
    try {
      await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function readPair(
  values: Record<string, string | undefined>,
  keys: { accessToken: string; refreshToken: string }
): TwitchTokenPair | null {
  const accessToken = values[keys.accessToken];
  const refreshToken = values[keys.refreshToken];
  if (!accessToken && !refreshToken) return null;
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

function updatePair(
  source: string,
  keys: { accessToken: string; refreshToken: string },
  pair: TwitchTokenPair
): string {
  return updateValue(
    updateValue(source, keys.accessToken, pair.accessToken),
    keys.refreshToken,
    pair.refreshToken
  );
}

function updateValue(source: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (index >= 0) lines[index] = entry;
  else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, entry);
  return lines.join("\n");
}
