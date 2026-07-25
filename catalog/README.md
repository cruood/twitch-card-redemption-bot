# Card Catalog Format

`cards.json` is the source of truth for active card definitions. Validate it without
connecting to PostgreSQL:

```bash
npm run catalog:validate
```

To validate a replacement file before moving it into the repository:

```bash
npm run catalog:validate -- /absolute/path/to/replacement-cards.json
```

The file must be a non-empty JSON array with at least one card for every rarity. Each
card has these fields:

```json
{
  "id": "epic-golden-moment",
  "name": "Golden Moment",
  "rarity": "epic",
  "tradeInRewardId": "timeout-10m"
}
```

- `id` is permanent and must be unique. Use lowercase letters, numbers, and hyphens.
  Renaming an ID creates a different card; keep old IDs stable to preserve inventory.
- `name` is the viewer-facing display name and can be changed later.
- `rarity` is one of `common`, `uncommon`, `rare`, `epic`, `legendary`, or `mythical`.
- `tradeInRewardId` is optional until reward policy is approved. When present, it uses
  lowercase letters, numbers, and hyphens and identifies the reward requested when that
  card is consumed.

Seeding is repeatable. Cards present in the file are inserted or updated and activated.
Cards omitted from the file are marked inactive, but existing inventory and audit history
are retained.
