/**
 * Signature class abilities — the single source of truth shared by client and
 * server, imported the same way as `classes.ts` and `boss.ts`. Each class in
 * `classes.ts` names one `abilityId`; this module defines what that ability does.
 *
 * `kind` decides where the ability runs:
 * - offensive kinds (`melee_aoe` / `dash` / `projectile`) run entirely on the
 *   client, reusing the existing client-detected melee pipeline (compute which
 *   enemies are hit, report each via the `enemy_hit` message). No new server
 *   damage path is needed.
 * - support kinds (`heal` / `shield`) touch server-authoritative player HP or
 *   damage immunity, so the client sends an `ability` message and the server
 *   applies the effect.
 *
 * Cooldowns are enforced on both sides: the client gates the keypress for
 * responsive feedback; the server re-checks the cooldown for support abilities.
 */
export type AbilityKind = "melee_aoe" | "dash" | "projectile" | "heal" | "shield";

export interface AbilityDef {
  id: string;
  name: string;
  kind: AbilityKind;
  cooldownMs: number;
  staminaCost: number;
  /** Weapon-damage multiplier for offensive kinds (dmg = player damage × this). */
  damageMult?: number;
  /** Effect radius for melee_aoe / heal. */
  radius?: number;
  /** Forward travel distance for `dash`. */
  reach?: number;
  /** Active window (ms) for `shield` / dash. */
  durationMs?: number;
  /** Flat HP restored to the caster and nearby allies for `heal`. */
  healAmount?: number;
  /** Number of bolts fired for `projectile`. */
  projectiles?: number;
  /** Total spread angle (degrees) the projectiles fan across. */
  spreadDeg?: number;
}

export const ABILITIES: Record<string, AbilityDef> = {
  whirlwind:   { id: "whirlwind",   name: "Whirlwind",   kind: "melee_aoe",  cooldownMs: 6000, staminaCost: 30, damageMult: 1.0, radius: 120 },
  dash_strike: { id: "dash_strike", name: "Dash Strike", kind: "dash",       cooldownMs: 5000, staminaCost: 30, damageMult: 1.5, reach: 220, radius: 56, durationMs: 200 },
  arcane_nova: { id: "arcane_nova", name: "Arcane Nova", kind: "melee_aoe",  cooldownMs: 8000, staminaCost: 40, damageMult: 2.2, radius: 170 },
  volley:      { id: "volley",      name: "Volley",      kind: "projectile", cooldownMs: 7000, staminaCost: 35, damageMult: 0.8, projectiles: 5, spreadDeg: 44 },
  heal_aura:   { id: "heal_aura",   name: "Heal Aura",   kind: "heal",       cooldownMs: 9000, staminaCost: 40, radius: 150, healAmount: 45 },
  guard:       { id: "guard",       name: "Guard",       kind: "shield",     cooldownMs: 8000, staminaCost: 35, durationMs: 2500 },
};

/** Ability lookup that returns undefined for unknown ids (classes may lack one). */
export function abilityDef(id: string | undefined): AbilityDef | undefined {
  return id ? ABILITIES[id] : undefined;
}
