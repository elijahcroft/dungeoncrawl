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
}

export const CLASSES: Record<string, ClassDef> = {
  guardian: { id: "guardian", name: "Guardian", blurb: "Tank — soaks hits, guards allies", hpMax: 140, speedPct: -15, staminaMax: 70,  damageMult: 0.9,  starterWeaponId: "mace",     abilityId: "guard" },
  warrior:  { id: "warrior",  name: "Warrior",  blurb: "Bruiser — balanced, spins for AoE", hpMax: 100, speedPct: 0,   staminaMax: 100, damageMult: 1.0,  starterWeaponId: "sword",    abilityId: "whirlwind" },
  rogue:    { id: "rogue",    name: "Rogue",    blurb: "Assassin — fast, dashes through foes", hpMax: 80,  speedPct: 15,  staminaMax: 130, damageMult: 1.15, starterWeaponId: "dagger",   abilityId: "dash_strike" },
  ranger:   { id: "ranger",   name: "Ranger",   blurb: "Ranged — kites with a volley", hpMax: 85,  speedPct: 5,   staminaMax: 100, damageMult: 1.0,  starterWeaponId: "crossbow", abilityId: "volley" },
  cleric:   { id: "cleric",   name: "Cleric",   blurb: "Support — heals self and allies", hpMax: 105, speedPct: 0,   staminaMax: 100, damageMult: 0.9,  starterWeaponId: "mace",     abilityId: "heal_aura" },
  mage:     { id: "mage",     name: "Mage",     blurb: "Caster — fragile, huge arcane burst", hpMax: 75,  speedPct: 0,   staminaMax: 90,  damageMult: 1.2,  starterWeaponId: "rapier",   abilityId: "arcane_nova" },
};

export const DEFAULT_CLASS_ID = "warrior";

/** Class lookup that always returns a valid def (falls back to the default class). */
export function classDef(id: string | undefined): ClassDef {
  return CLASSES[id ?? DEFAULT_CLASS_ID] ?? CLASSES[DEFAULT_CLASS_ID];
}
