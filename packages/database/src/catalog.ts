import { RARITIES, type Rarity } from "@cardbot/rarity";

export interface CatalogCard {
  id: string;
  name: string;
  rarity: Rarity;
  tradeInRewardId?: string;
}

export function parseCatalog(value: unknown): CatalogCard[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Card catalog must be a non-empty array");
  }
  const ids = new Set<string>();
  const cards = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`Card ${index} must be an object`);
    }
    const card = entry as Record<string, unknown>;
    if (typeof card.id !== "string" || !/^[a-z0-9-]+$/.test(card.id)) {
      throw new TypeError(`Card ${index} has an invalid id`);
    }
    if (ids.has(card.id)) throw new TypeError(`Duplicate card id: ${card.id}`);
    ids.add(card.id);
    if (typeof card.name !== "string" || card.name.trim().length === 0) {
      throw new TypeError(`Card ${card.id} has an invalid name`);
    }
    if (typeof card.rarity !== "string" || !(RARITIES as readonly string[]).includes(card.rarity)) {
      throw new TypeError(`Card ${card.id} has an invalid rarity`);
    }
    if (card.tradeInRewardId !== undefined && typeof card.tradeInRewardId !== "string") {
      throw new TypeError(`Card ${card.id} has an invalid tradeInRewardId`);
    }
    return {
      id: card.id,
      name: card.name.trim(),
      rarity: card.rarity as Rarity,
      ...(typeof card.tradeInRewardId === "string"
        ? { tradeInRewardId: card.tradeInRewardId }
        : {})
    };
  });

  for (const rarity of RARITIES) {
    if (!cards.some((card) => card.rarity === rarity)) {
      throw new TypeError(`Card catalog must include at least one ${rarity} card`);
    }
  }
  return cards;
}
