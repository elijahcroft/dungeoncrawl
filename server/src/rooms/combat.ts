import type { BossLogic } from "../../../shared/boss";
import type { EffectFireCtx, Element, Trigger } from "../../../shared/effects";
import type { DungeonRoomState, RunStats } from "./DungeonRoom";

export type { Element };

/**
 * The central damage pipeline. Every point of damage in the game — player
 * weapon swings, ability hits, enemy attacks, lobby PvP (and later: status
 * ticks, item-triggered effects) — flows through the two apply* functions
 * below. This is THE hook point for on-hit/on-kill/on-hurt style triggers:
 * anything that reacts to damage belongs here, not scattered in handlers.
 */

export type DamageTag = "melee" | "projectile" | "ability" | "status" | "thorns" | "explosion";

export interface DamageCtx {
  /** What dealt the damage. Drives which defenses/procs apply. */
  source: "player" | "enemy" | "status" | "effect";
  /** Session id of the player credited with the damage (procs, stats, kill rewards). */
  attackerSessionId?: string;
  tags: DamageTag[];
  element?: Element;
  isCrit?: boolean;
  /**
   * Whether this damage may fire on-hit/on-kill triggers. False for damage that
   * was itself spawned by a trigger (status ticks, explosions) so effects can't
   * recurse into themselves.
   */
  canTriggerEffects: boolean;
  /** World position the hit came from — stamps the victim's lastHitX/Y for client knockback FX. */
  hitFromX?: number;
  hitFromY?: number;
}

/**
 * The slice of DungeonRoom the pipeline needs. DungeonRoom passes `this`; the
 * interface keeps combat.ts free of a runtime import cycle.
 */
export interface CombatHost {
  state: DungeonRoomState;
  enemyLogics: Map<string, BossLogic>;
  /** Enemy→player damage multiplier fixed per room (player-count/mutator/endless scaling). */
  enemyDamageScale: number;
  /** Gold multiplier from the current room's mutator. */
  mutatorGoldScale: number;
  /** Per-player end timestamp for an active Guard window (damage immunity). */
  guardUntil: Map<string, number>;
  statsFor(sessionId: string): RunStats;
  /** Award XP (and queue level-ups) to a player by session id. */
  grantXpTo(sessionId: string, amount: number): void;
  /** Dispatch a player's triggered effects (see shared/effects.ts). */
  fireEffects(trigger: Trigger, sessionId: string, ctx: EffectFireCtx): void;
}

/** XP awarded for a kill when the enemy def carries no goldReward to derive it from. */
const XP_PER_KILL_FALLBACK = 10;

/**
 * Apply damage from a player (or a player-credited effect) to one enemy.
 * Handles the attacker's run-stats tally, lifesteal, and kill rewards
 * (gold + XP). Returns the damage actually applied (0 if the enemy was
 * already dead or missing).
 */
export function applyDamageToEnemy(host: CombatHost, enemyId: string, amount: number, ctx: DamageCtx): number {
  if (!(amount > 0)) return 0;
  const logic = host.enemyLogics.get(enemyId);
  if (!logic || !logic.isAlive) return 0;
  logic.takeDamage(amount);

  const attackerId = ctx.attackerSessionId;
  const attacker = attackerId ? host.state.players.get(attackerId) : undefined;
  if (attackerId && attacker) {
    const stats = host.statsFor(attackerId);
    stats.damageDealt += amount;
    if (amount > stats.biggestHit) stats.biggestHit = amount;
    // Lifesteal: convert a fraction of damage dealt into healing for the attacker.
    // Direct hits only — status ticks and effect-spawned damage don't leech.
    if (ctx.source === "player" && attacker.lifestealPct > 0 && attacker.hp > 0) {
      attacker.hp = Math.min(attacker.hpMax, attacker.hp + (amount * attacker.lifestealPct) / 100);
    }
    if (!logic.isAlive) {
      const reward = Math.round((logic.def.goldReward ?? 0) * host.mutatorGoldScale);
      attacker.gold += reward;
      stats.kills += 1;
      stats.goldEarned += reward;
      // XP mirrors gold — the killer earns it. Tougher foes (higher gold) are worth more.
      host.grantXpTo(attackerId, logic.def.goldReward ?? XP_PER_KILL_FALLBACK);
    }
    // Triggered effects fire on direct hits only (canTriggerEffects gates recursion:
    // an effect's own damage arrives with it false, so procs can't chain procs).
    if (ctx.canTriggerEffects && ctx.source === "player") {
      const fireCtx = { damage: amount, x: logic.x, y: logic.y, targetEnemyId: enemyId };
      host.fireEffects("onHit", attackerId, fireCtx);
      if (ctx.isCrit) host.fireEffects("onCrit", attackerId, fireCtx);
      if (!logic.isAlive) host.fireEffects("onKill", attackerId, fireCtx);
    }
  }
  return amount;
}

/**
 * Apply damage to one player. Enemy-sourced damage respects dodge-roll
 * i-frames, the Guard window, and the room's enemy damage scale; other sources
 * (PvP, later status/effects) land unmodified. Returns the damage actually
 * applied after scaling (0 if fully avoided).
 */
export function applyDamageToPlayer(host: CombatHost, sessionId: string, amount: number, ctx: DamageCtx): number {
  if (!(amount > 0)) return 0;
  const player = host.state.players.get(sessionId);
  if (!player || player.hp <= 0) return 0;

  if (ctx.source === "enemy") {
    if (player.rolling) return 0; // dodge-roll i-frames
    if (Date.now() < (host.guardUntil.get(sessionId) ?? 0)) return 0; // Guard window absorbs the hit
    amount *= host.enemyDamageScale;
  }

  player.hp = Math.max(0, player.hp - amount);
  if (player.hp <= 0) host.statsFor(sessionId).deaths += 1;
  if (ctx.hitFromX !== undefined && ctx.hitFromY !== undefined) {
    player.lastHitX = ctx.hitFromX;
    player.lastHitY = ctx.hitFromY;
    player.lastHitSeq += 1;
  }
  if (ctx.canTriggerEffects && ctx.source === "enemy") {
    const fireCtx = { damage: amount, x: player.x, y: player.y };
    host.fireEffects("onHurt", sessionId, fireCtx);
    if (player.hp > 0 && player.hp < player.hpMax * 0.3) host.fireEffects("onLowHp", sessionId, fireCtx);
  }
  return amount;
}
