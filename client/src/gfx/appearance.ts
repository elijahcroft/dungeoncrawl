/**
 * Curated armor "kits" so a randomly-assigned hero always looks coherent — each
 * pairs a body color with a harmonious metal trim and a cape flag. One is rolled
 * per player at join (see main.ts) and synced so every client draws the same hero.
 */
export interface PlayerAppearance {
  /** Dominant armor color — torso, limbs, helmet. Parseable via Number(). */
  body: number;
  /** Metal accent for the chest emblem, belt buckle, pauldron studs, and helmet crest. */
  trim: number;
  /** Whether the hero wears a cape. */
  cape: boolean;
}

const ARMOR_KITS: PlayerAppearance[] = [
  { body: 0x4da6ff, trim: 0xe2e8f2, cape: true },  // steel-blue knight, silver trim
  { body: 0xd6533a, trim: 0xf0c14b, cape: true },  // crimson + gold
  { body: 0x3fa66a, trim: 0xd8dee6, cape: false }, // forest green + silver
  { body: 0x8a5cd6, trim: 0xe8c96a, cape: true },  // amethyst + gold
  { body: 0xc9702e, trim: 0x2b2b33, cape: false }, // bronze + darksteel
  { body: 0x2c8fb0, trim: 0xe6ecf2, cape: true },  // teal + silver
  { body: 0xb0324f, trim: 0xd9b45a, cape: false }, // wine + brass
  { body: 0x5b6472, trim: 0x9fb2c9, cape: true },  // slate steel plate
  { body: 0x6b8f2e, trim: 0xcdd6de, cape: false }, // olive + steel
  { body: 0xd98cae, trim: 0xf3ead0, cape: true },  // rose + ivory
  { body: 0x2f4a8c, trim: 0xc9a24b, cape: true },  // royal blue + gold
  { body: 0x3a3f4a, trim: 0xc0392b, cape: false }, // black plate + red trim
];

/** Picks a random curated armor kit for a newly-joined hero. */
export function rollAppearance(): PlayerAppearance {
  return ARMOR_KITS[Math.floor(Math.random() * ARMOR_KITS.length)];
}
