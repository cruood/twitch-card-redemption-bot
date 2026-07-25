export type TwitchTokenAudience = "bot" | "broadcaster";

export interface TwitchTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TwitchTokenSnapshot {
  bot: TwitchTokenPair;
  broadcaster: TwitchTokenPair;
}

export interface TwitchTokenStore {
  load?(): Promise<TwitchTokenSnapshot | null>;
  persist(tokens: TwitchTokenSnapshot): Promise<void>;
  withRefreshLock?<T>(work: (store: TwitchTokenStore) => Promise<T>): Promise<T>;
}

export interface TwitchAccessTokenProvider {
  getAccessToken(audience: TwitchTokenAudience): Promise<string>;
  refreshAccessToken?(audience: TwitchTokenAudience, rejectedAccessToken: string): Promise<string>;
}

export class StaticTwitchAccessTokenProvider implements TwitchAccessTokenProvider {
  constructor(
    private readonly botToken: string,
    private readonly broadcasterToken: string
  ) {}

  async getAccessToken(audience: TwitchTokenAudience): Promise<string> {
    const token = audience === "bot" ? this.botToken : this.broadcasterToken;
    if (!token) throw new Error(`Missing Twitch ${audience} access token`);
    return token;
  }
}

export class RefreshingTwitchAccessTokenProvider implements TwitchAccessTokenProvider {
  private readonly tokens: TwitchTokenSnapshot;
  private readonly hasBootstrapTokens: boolean;
  private readonly refreshes = new Map<string, Promise<string>>();
  private rotationQueue = Promise.resolve();
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    initialTokens: TwitchTokenSnapshot | undefined,
    private readonly store: TwitchTokenStore,
    private readonly request: typeof fetch = fetch
  ) {
    this.hasBootstrapTokens = initialTokens !== undefined;
    this.tokens = initialTokens ? cloneSnapshot(initialTokens) : emptySnapshot();
    if (!initialTokens && !store.load) {
      throw new Error("Twitch token provider requires bootstrap tokens or a readable token store");
    }
  }

  async getAccessToken(audience: TwitchTokenAudience): Promise<string> {
    await this.ensureInitialized();
    return this.tokens[audience].accessToken;
  }

  async refreshAccessToken(
    audience: TwitchTokenAudience,
    rejectedAccessToken: string
  ): Promise<string> {
    await this.ensureInitialized();
    const current = this.tokens[audience];
    if (current.accessToken !== rejectedAccessToken) return Promise.resolve(current.accessToken);

    const existing = this.refreshes.get(rejectedAccessToken);
    if (existing) return existing;

    const refresh = this.rotationQueue.then(() => this.rotate(audience, rejectedAccessToken));
    this.rotationQueue = refresh.then(() => undefined, () => undefined);
    this.refreshes.set(rejectedAccessToken, refresh);
    void refresh.finally(() => this.refreshes.delete(rejectedAccessToken)).catch(() => undefined);
    return refresh;
  }

  private async rotate(
    audience: TwitchTokenAudience,
    rejectedAccessToken: string
  ): Promise<string> {
    return this.withStoreLock(async (store) => {
      const persisted = await store.load?.();
      if (persisted) replaceSnapshot(this.tokens, persisted);

      const current = this.tokens[audience];
      if (current.accessToken !== rejectedAccessToken) return current.accessToken;

      const response = await this.request("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken
        })
      });
      if (!response.ok) {
        throw new Error(`Twitch ${audience} token refresh failed (${response.status}): ${await response.text()}`);
      }
      const replacement = readRefreshResponse(await response.json());
      const audiences = (["bot", "broadcaster"] as const).filter((candidate) => {
        const pair = this.tokens[candidate];
        return pair.accessToken === current.accessToken && pair.refreshToken === current.refreshToken;
      });
      for (const candidate of audiences) this.tokens[candidate] = replacement;
      await store.persist(cloneSnapshot(this.tokens));
      return replacement.accessToken;
    });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.store.load) return Promise.resolve();
    this.initialization ??= this.withStoreLock(async (store) => {
      const persisted = await store.load?.();
      if (persisted) replaceSnapshot(this.tokens, persisted);
      else if (this.hasBootstrapTokens) await store.persist(cloneSnapshot(this.tokens));
      else {
        throw new Error(
          "PostgreSQL Twitch token store is empty; supply access and refresh tokens for the first deployment"
        );
      }
    });
    return this.initialization;
  }

  private withStoreLock<T>(work: (store: TwitchTokenStore) => Promise<T>): Promise<T> {
    return this.store.withRefreshLock ? this.store.withRefreshLock(work) : work(this.store);
  }
}

export async function requestWithTwitchToken(
  tokens: TwitchAccessTokenProvider,
  audience: TwitchTokenAudience,
  request: (accessToken: string) => Promise<Response>
): Promise<Response> {
  const accessToken = await tokens.getAccessToken(audience);
  const response = await request(accessToken);
  if (response.status !== 401 || !tokens.refreshAccessToken) return response;

  const replacement = await tokens.refreshAccessToken(audience, accessToken);
  return request(replacement);
}

function readRefreshResponse(value: unknown): TwitchTokenPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Twitch token refresh response must be an object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new TypeError("Twitch token refresh response is missing access_token");
  }
  if (typeof body.refresh_token !== "string" || body.refresh_token.length === 0) {
    throw new TypeError("Twitch token refresh response is missing refresh_token");
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

function cloneSnapshot(tokens: TwitchTokenSnapshot): TwitchTokenSnapshot {
  return {
    bot: { ...tokens.bot },
    broadcaster: { ...tokens.broadcaster }
  };
}

function replaceSnapshot(target: TwitchTokenSnapshot, source: TwitchTokenSnapshot): void {
  target.bot = { ...source.bot };
  target.broadcaster = { ...source.broadcaster };
}

function emptySnapshot(): TwitchTokenSnapshot {
  return {
    bot: { accessToken: "", refreshToken: "" },
    broadcaster: { accessToken: "", refreshToken: "" }
  };
}
