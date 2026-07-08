/**
 * Player classes — the single source of truth shared by client and server
 * (both import this the same way they import `boss.ts`). A class is a starting
 * stat block plus a thematic starter weapon and a signature ability; all real
 * combat variety still comes from weapons (see client `entities/weapons.ts`) and
 * abilities (see `abilities.ts`).
 *
 * `starterWeaponId` and `abilityId` are plain string ids so this module has no
 * dependency on the client-only weapon/ability art — the server just copies the
 * ids onto `PlayerState`.
 */
/** Head silhouette drawn on the player sprite — purely cosmetic, gives each class a distinct read at a glance. */
export type PlayerAccessory = "none" | "hood" | "mask" | "spikes" | "hat" | "halo";

export interface ClassDef {
  id: string;
  name: string;
  /** One-liner shown in the join <select>. */
  blurb: string;
  hpMax: number;
  /** Move-speed modifier as a percentage (e.g. -15 = 15% slower). */
  speedPct: number;
  /** Per-class stamina pool (assassins get more rolls/abilities, tanks fewer). */
  staminaMax: number;
  /** Multiplier applied to weapon damage (glass-cannon >1, tank <1). */
  damageMult: number;
  /** Weapon the class spawns holding — reuses a WEAPONS id. */
  starterWeaponId: string;
  /** Signature ability id (see `abilities.ts`). */
  abilityId: string;
  /** Cosmetic headwear silhouette (see `PlayerAccessory`). */
  accessory: PlayerAccessory;
  /** Legs drawn as boots (default) or a single robe/skirt shape (casters/support). */
  legStyle: "boots" | "robe";
  /** Torso-width multiplier — tanks read bulkier, assassins/casters read leaner. Default 1. */
  bulk: number;
}

export const CLASSES: Record<string, ClassDef> = {
  guardian: { id: "guardian", name: "Guardian", blurb: "Tank — soaks hits, guards allies", hpMax: 140, speedPct: -15, staminaMax: 70,  damageMult: 0.9,  starterWeaponId: "mace",     abilityId: "guard",       accessory: "spikes", legStyle: "boots", bulk: 1.3 },
  warrior:  { id: "warrior",  name: "Warrior",  blurb: "Bruiser — balanced, spins for AoE", hpMax: 100, speedPct: 0,   staminaMax: 100, damageMult: 1.0,  starterWeaponId: "sword",    abilityId: "whirlwind",   accessory: "none",   legStyle: "boots", bulk: 1.0 },
  rogue:    { id: "rogue",    name: "Rogue",    blurb: "Assassin — fast, dashes through foes", hpMax: 80,  speedPct: 15,  staminaMax: 130, damageMult: 1.15, starterWeaponId: "dagger",   abilityId: "dash_strike", accessory: "hood",   legStyle: "boots", bulk: 0.85 },
  ranger:   { id: "ranger",   name: "Ranger",   blurb: "Ranged — kites with a volley", hpMax: 85,  speedPct: 5,   staminaMax: 100, damageMult: 1.0,  starterWeaponId: "crossbow", abilityId: "volley",      accessory: "mask",   legStyle: "boots", bulk: 0.95 },
  cleric:   { id: "cleric",   name: "Cleric",   blurb: "Support — heals self and allies", hpMax: 105, speedPct: 0,   staminaMax: 100, damageMult: 0.9,  starterWeaponId: "mace",     abilityId: "heal_aura",   accessory: "halo",   legStyle: "robe",  bulk: 1.0 },
  mage:     { id: "mage",     name: "Mage",     blurb: "Caster — fragile, huge arcane burst", hpMax: 75,  speedPct: 0,   staminaMax: 90,  damageMult: 1.2,  starterWeaponId: "rapier",   abilityId: "arcane_nova", accessory: "hat",    legStyle: "robe",  bulk: 0.85 },
};

export const DEFAULT_CLASS_ID = "warrior";

/** Class lookup that always returns a valid def (falls back to the default class). */
export function classDef(id: string | undefined): ClassDef {
  return CLASSES[id ?? DEFAULT_CLASS_ID] ?? CLASSES[DEFAULT_CLASS_ID];
}
