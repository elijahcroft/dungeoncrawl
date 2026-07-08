import type { PowerUpStat } from "./powerups";

/**
 * The declarative effect/modifier system — the single source of truth shared
 * by client and server, imported the same way as `powerups.ts` and `boss.ts`.
 *
 * A ModifierDef is the one shape every buff-granting thing reduces to:
 * power-ups, accessories, passive items, and (later) elite affixes and
 * meta-upgrades. `stats` folds into the server's recomputeStats; `effects`
 * are trigger→action rules dispatched by the server's damage pipeline
 * (combat.ts). Content stays data: a new item is a ModifierDef, not code.
 *
 * Effects never recurse — damage spawned by an effect is applied with
 * `canTriggerEffects: false`, so an explosion can't proc another explosion.
 */

export type Element = "physical" | "fire" | "poison" | "ice" | "shock";

export type Trigger =
  | "onHit"        // any direct player hit lands on an enemy
  | "onCrit"       // the landed hit was a critical strike
  | "onKill"       // the hit killed the enemy
  | "onHurt"       // the player took damage from an enemy
  | "onLowHp"      // the player dropped below 30% HP (fires per damaging hit; use cooldownMs)
  | "onRoomClear"  // the current room's last enemy died
  | "onAbilityUse" // the player used their signature ability
  | "onDash"       // the player dodge-rolled
  | "onTickSec";   // once per second while alive

export type EffectAction =
  /** Burst of damage in a radius, centered on the struck enemy or the player. */
  | { kind: "aoeDamage"; center: "target" | "self"; radius: number; pctOfHit?: number; flat?: number; element?: Element }
  /** Damage arcs to up to `jumps` other enemies, each within `range` of the last. */
  | { kind: "chainDamage"; jumps: number; pctOfHit: number; range: number; element?: Element }
  /** Apply a status effect (see status.ts) to the struck enemy, nearby enemies, or the player. */
  | { kind: "applyStatus"; status: string; stacks: number; target: "hitEnemy" | "nearbyEnemies" | "self"; radius?: number }
  /** Heal the player. */
  | { kind: "heal"; flat?: number; pctOfDamage?: number; pctMax?: number }
  /** Time-limited stat boost, folded into recomputeStats until it expires. */
  | { kind: "tempBuff"; stat: PowerUpStat; amount: number; durationMs: number }
  /** Flat gold payout. */
  | { kind: "grantGold"; amount: number }
  /** Brief damage-immunity window (reuses the Guard mechanic). */
  | { kind: "grantShield"; durationMs: number };

export interface EffectDef {
  trigger: Trigger;
  /** Roll chance per trigger firing; omit for always. */
  chancePct?: number;
  /** Internal cooldown so a fast trigger (onHit) can't machine-gun the action. */
  cooldownMs?: number;
  action: EffectAction;
}

/** The unified modifier shape: flat stat lines, multipliers, and/or triggered effects. */
export interface ModifierDef {
  stats?: Partial<Record<PowerUpStat, number>>;
  /** Multipliers applied after all flat stats (glass-cannon curses etc.). */
  mults?: { damageMult?: number; hpMult?: number; speedMult?: number };
  effects?: EffectDef[];
}

/** Context handed to the dispatcher when a trigger fires. */
export interface EffectFireCtx {
  /** Damage of the hit that caused the trigger (drives pctOfHit/pctOfDamage). */
  damage?: number;
  /** World position of the trigger (usually the struck enemy). */
  x?: number;
  y?: number;
  /** The enemy the triggering hit landed on (excluded from chain jumps). */
  targetEnemyId?: string;
}
