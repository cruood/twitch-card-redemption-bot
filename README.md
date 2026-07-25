# Twitch Card Redemption Bot

A standalone TypeScript monorepo for a custom Twitch channel economy where opted-in viewers earn currency, open virtual trading-card packs, and eventually trade high-rarity cards for chat/status/moderation effects.

The first milestone deliberately focuses on the economy, inventory, and rarity simulation. Moderation execution is represented as interfaces and stubs until pack odds, cooldown budgets, target protection, and audit flows are verified.

## Product Rules

- Viewers must opt in each stream before earning currency.
- Opted-in viewers earn `100` currency every `10` minutes by default.
- Pack openings are limited to batches of `1`, `5`, or `10`.
- Card rarities are represented as stars:
  - Common: 1 star
  - Uncommon: 2 stars
  - Rare: 3 stars
  - Epic: 4 stars
  - Legendary: 5 stars
  - Mythical: 6 stars
- Legendary and Mythical pulls are governed by global cooldown budgets that boosts cannot bypass.
- Rare+ boost factors can include opted-in stream time, message count, channel reward redemptions, and bot-tracked attendance streak.
- Only the broadcaster is protected by default. Moderators, VIPs, subscribers, and regular viewers are valid targets unless manually protected.
- Moderation trade-ins assume the bot has Lead Moderator-level permissions, but execution remains stubbed for now.

## Monorepo Layout

```text
apps/
  twitch-bot/       Twitch EventSub + Helix worker entrypoint
  discord-bot/      discord.js v14 companion entrypoint
packages/
  economy/          Opt-in and passive currency accrual
  rarity/           Rarity tables, boost math, budgets, simulation
  inventory/        Pack opening and inventory helpers
  shared-config/    Shared runtime config parsing
  database/         PostgreSQL transactions, repositories, and migrations
  queue/            BullMQ schedulers, workers, retries, and Redis config
```

## Setup

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run db:migrate
npm run db:seed-catalog
npm test
npm run test:integration
npm run build
npm run doctor
npm run worker:economy
npm run twitch:eventsub
```

PostgreSQL and Redis must be running before the migration, worker, or EventSub process
starts. The seed command is repeatable: it updates cards from `catalog/cards.json` and
marks cards omitted from that file inactive without deleting inventory history.

Run the deterministic rarity simulation (defaults to 100 runs of 120 daily streams):

```bash
npm run simulate:rarity -- --streams 120 --pulls-per-stream 400 --runs 100 --seed 42
```

The simulation reports both pulls per stream and streams per pull. Rare and Epic are
calibrated against a representative 400-pull stream; Legendary and Mythical are also
limited by persistent token budgets replenishing once per 7 and 10.5 days respectively.

Pack purchases use one PostgreSQL transaction. The transaction locks the user row and
global rarity budget, checks the ledger balance, derives the stream boost signals, then
records the debit, opening, awarded cards, consumed rarity tokens, participation signals,
budget state, and individual rarity rolls together. Any error rolls the complete purchase
back. EventSub message IDs make command purchases and participation counters durable
against Twitch redelivery.

Every future currency-ledger writer must take the same user row lock before changing a
balance. This is the serialization rule that prevents accrual and pack purchases from
spending against stale balances concurrently.

Stream participation is persisted per Twitch stream. Duplicate opt-in commands are
idempotent, attendance streaks advance only when the immediately previous stream was
attended, and passive accrual advances a ledger checkpoint in the same transaction as
its currency credit. Chat-message and channel-reward counters only increment after the
viewer has opted into that stream.

Each active stream gets one BullMQ job scheduler that checks accrual every ten minutes.
On `stream.offline`, the end timestamp is persisted first so in-flight accrual is clamped;
then the scheduler is removed and a uniquely identified finalization job performs final
accrual. Jobs retry five times with exponential backoff, while domain checkpoints make
retries idempotent.

The EventSub process also checks Helix stream status every two minutes. Positive checks
persist a last-confirmed-live heartbeat. If an offline notification is missed, recovery
closes the stale stream at that heartbeat instead of awarding currency for unverified
downtime. Starting the bot during an already-live stream creates or recovers its scheduler.
Processed EventSub counter IDs are retained for seven days and pruned at stream start.

## Twitch Commands

- `!cards`: opt into the current stream. This command is configurable with
  `TWITCH_OPT_IN_COMMAND`.
- `!balance`: show the caller's currency balance.
- `!inventory`: show a compact rarity summary of the caller's cards.
- `!open 1`, `!open 5`, or `!open 10`: atomically buy and open the requested pack batch.

Responses are sent through the Helix chat API as replies to the originating message.
Economy commands resolve users by Twitch user ID rather than mutable display name.

## Twitch EventSub Setup

The WebSocket transport registers `stream.online`, `stream.offline`,
`channel.chat.message`, and `channel.channel_points_custom_reward_redemption.add` after
Twitch sends `session_welcome`. Configure the IDs and access tokens in `.env.example`.

- Bot user token: `user:read:chat` and `user:write:chat`.
- Broadcaster token: `channel:bot` and `channel:read:redemptions`.
- When the broadcaster and bot are the same account, the same token may be used for both
  variables if it includes all required scopes.

Run `npm run twitch:eventsub` for the WebSocket/subscription process and
`npm run worker:economy` for BullMQ processing. Tokens are validated at startup and every
hour. Configure both refresh-token variables and `TWITCH_CLIENT_SECRET` to enable one-time
`401` retry with Twitch token rotation. Local development defaults to
`TWITCH_TOKEN_STORE=env`, which atomically rewrites `TWITCH_TOKEN_STORE_PATH` (default
`.env`) with owner-only permissions. Production uses `TWITCH_TOKEN_STORE=postgres`; the
first startup seeds the token table from environment credentials, then future restarts
load the latest rotated credentials directly from PostgreSQL. Bootstrap token variables
can be removed from the service after that first deployment succeeds.

PostgreSQL token refresh uses a cross-process advisory lock and an atomic two-row upsert.
This prevents overlapping deployments or maintenance commands from consuming the same
one-use refresh token twice. When both audiences share one Twitch authorization, one
refresh updates both audience records. `npm run twitch:rotate-tokens` performs an explicit
rotation without printing credentials.

## Production Operation

Run these as separate supervised processes:

- One `npm run twitch:eventsub` process. EventSub WebSocket ownership remains a singleton.
- One or more `npm run worker:economy` processes. BullMQ owns worker concurrency and retry.

Before every release, run:

```bash
npm ci
npm run db:migrate
npm run db:seed-catalog
npm test
npm run test:integration
npm run doctor
```

The migration runner takes a PostgreSQL advisory lock and verifies SHA-256 checksums for
applied SQL files. Never edit an applied migration; add a new numbered file. `doctor`
checks secret-file permissions, schema and migration checksums, catalog coverage, Redis,
Twitch token identity/scopes, and Helix reachability without printing credentials.

Both production entry points expose `/healthz` and `/readyz` on `PORT`, report `503` while
stopping, close network resources on `SIGTERM`, and are suitable for a supervisor with an
always-restart policy. Production PostgreSQL and Redis need authentication, monitoring,
and backups appropriate to the selected hosting provider.

## Railway Deployment

The root `railway.toml` supports direct CLI deployment of both services. Set
`RAILWAY_START_SCRIPT=start:twitch-eventsub` on EventSub and
`RAILWAY_START_SCRIPT=start:economy-worker` on the worker before running `railway up`.
Both services run the repeatable migration/catalog preparation command before deployment.

The repository also includes service-specific config files for dashboard or GitHub use:

- `railway/eventsub.toml`: singleton Twitch service, migrations plus catalog seeding,
  zero deployment overlap, health check, and graceful drain.
- `railway/worker.toml`: scalable BullMQ worker, migrations, health check, and graceful
  drain.

Create one Railway project with PostgreSQL and Redis services, then create two application
services from this same repository. Set each service's config file path in Railway to
`/railway/eventsub.toml` or `/railway/worker.toml`. The EventSub service must remain at one
replica; the worker can be scaled independently. Neither service needs a public domain
because Twitch EventSub WebSocket and BullMQ use outbound connections, but Railway still
uses the private health server during deployment.

Use Railway reference variables for the private database services:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

`railway/variables.example` lists the EventSub variables. Set `PORT=3000`,
`NODE_ENV=production`, and `TWITCH_TOKEN_STORE=postgres`. The worker only needs
`NODE_ENV`, `PORT`, `DATABASE_URL`, and `REDIS_URL`; it deliberately does not initialize
Twitch clients or require Twitch secrets.

For the initial EventSub deployment, provide all Twitch access and refresh token variables.
After `/healthz` passes and the logs show PostgreSQL token persistence initialized, remove
the four access/refresh token bootstrap variables from Railway and redeploy. Keep
`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BROADCASTER_ID`, and
`TWITCH_BOT_USER_ID`. Enable Railway backups for PostgreSQL and Redis before launch.

Deploy EventSub first so its pre-deploy step seeds the card catalog, then deploy the worker.
The migration runner's PostgreSQL advisory lock makes later simultaneous service deploys
safe. A GitHub-connected Railway service needs this directory in a Git repository;
alternatively, deploy each service with the Railway CLI.

## Milestone Plan

1. Scaffold the monorepo and package boundaries. (Complete)
2. Verify economy accrual, opt-in reset behavior, pack batch limits, and rarity simulation. (Complete)
3. Add PostgreSQL schema migrations and atomic pack-purchase persistence. (Complete)
4. Wire Twitch EventSub WebSocket/Helix transport for stream lifecycle, chat participation signals, and channel reward redemptions. (Complete and live-verified)
5. Add Twitch balance, inventory, and pack-opening commands with durable EventSub idempotency. (Complete)
6. Verify PostgreSQL, Redis, EventSub, and Helix chat together against a test Twitch channel. (Complete)
7. Add Discord companion commands after selecting a Twitch-to-Discord account-linking flow.
8. Wire Helix actions behind moderation interfaces with dry-run mode, audit logs, broadcaster protection rules, and approved reward pricing.
9. Enable low-risk trade-ins first, then gated vote-based moderation redeems after simulation and operator review.

## Trade-In Reward Direction

The highest-impact rewards should map to the highest rarity and cost tiers:

- Timeouts: 1 min, 5 min, 10 min, 30 min, 45 min, 1 hour.
- VIP grant: self or target for 1 day, half week, or 1 week.
- VIP revoke: target for 1 day, half week, or 1 week.
- Vote to add moderator and vote to remove moderator: equally expensive and just below permanent ban vote.
- Permanent ban vote: third-to-last reward in the full list and most expensive overall; no moderator approval, broadcaster-only veto/review remit if one is later added.

## Current Status

The economy beta path is implemented and covered by 51 unit/contract tests plus two
real-service integration tests: per-stream opt-in, passive accrual, attendance and
engagement signals, controlled rarity budgets, atomic and concurrency-safe pack purchases,
card inventory, Twitch chat commands, EventSub redelivery protection, automatic OAuth
rotation, stale-stream recovery, and BullMQ reconciliation. Moderation interfaces remain
dry-run only and perform no Twitch moderation actions.

A live test channel has verified stream online/offline events, Helix chat replies,
per-stream opt-in, an atomic pack purchase, inventory lookup, ten-minute passive accrual,
final stream accrual, and BullMQ scheduler removal. The persisted opening audit included
its source event, participation snapshot, boost, raw rarity roll, and budget state.

The production host and rotated OAuth strategy are now selected and implemented for
Railway. Remaining launch inputs are replacing the starter catalog in `catalog/cards.json`,
creating/linking the Railway project, and deciding whether the production broadcaster and
bot use separate Twitch accounts. Discord work requires an account-linking decision.
Moderation work requires approved reward costs, vote thresholds and durations, and veto
behavior before any dangerous Helix action is enabled.
