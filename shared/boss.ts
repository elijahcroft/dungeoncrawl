/**
 * Pure, framework-agnostic boss state machine. Imported by both the Colyseus
 * server (authoritative simulation) and the Phaser client (single-player
 * fallback + type definitions). No Phaser or Colyseus dependency here so it
 * stays usable from both sides — this is the "one Boss state machine" the
 * data-driven boss design depends on.
 */

export interface BossAttackDef {
  telegraphMs: number;
  activeMs: number;
  recoverMs: number;
  cooldownMs: number;
  damage: number;
  range: number;
  animationKey?: string;
  /** If set, the boss charges toward its target's telegraph-time position at this speed (px/sec) during the attack. */
  dashSpeed?: number;
}

export interface BossPhaseDef {
  hpThreshold: number;
  attacks: string[];
  /** Overrides the boss's idle/recover tint while this phase is active. */
  color?: string;
}

export interface BossDef {
  id: string;
  name: string;
  hpMax: number;
  aggroRange: number;
  color: string;
  attacks: Record<string, BossAttackDef>;
  phases: BossPhaseDef[];
}

export type BossState = "idle" | "telegraph" | "attack" | "recover" | "dead";

export interface BossTarget {
  id: string;
  x: number;
  y: number;
  alive: boolean;
}

export interface BossHitEvent {
  targetId: string;
  damage: number;
}

function distance(x1: number, y1: number, x2: number, y2: number) {
  return Math.hypot(x2 - x1, y2 - y1);
}

export class BossLogic {
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  state: BossState = "idle";
  targetId: string | null = null;
  currentAttackId: string | null = null;

  readonly def: BossDef;

  private readonly spawnX: number;
  private readonly spawnY: number;
  private stateEndsAt = 0;
  private attackHitboxUsed = false;
  private currentAttack: BossAttackDef | null = null;
  private dashDirX = 0;
  private dashDirY = 0;

  constructor(def: BossDef, x: number, y: number) {
    this.def = def;
    this.hpMax = def.hpMax;
    this.hp = def.hpMax;
    this.x = x;
    this.y = y;
    this.spawnX = x;
    this.spawnY = y;
  }

  get isAlive() {
    return this.state !== "dead";
  }

  get phase(): BossPhaseDef {
    const hpPercent = (this.hp / this.hpMax) * 100;
    const sorted = [...this.def.phases].sort((a, b) => a.hpThreshold - b.hpThreshold);
    return sorted.find((phase) => hpPercent <= phase.hpThreshold) ?? sorted[sorted.length - 1];
  }

  takeDamage(amount: number) {
    if (!this.isAlive) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.state = "dead";
    }
  }

  reset() {
    this.hp = this.hpMax;
    this.state = "idle";
    this.stateEndsAt = 0;
    this.attackHitboxUsed = false;
    this.currentAttack = null;
    this.currentAttackId = null;
    this.targetId = null;
    this.x = this.spawnX;
    this.y = this.spawnY;
  }

  private setState(state: BossState, durationMs: number, now: number) {
    this.state = state;
    this.stateEndsAt = now + durationMs;
  }

  private nearestTarget(targets: BossTarget[]): BossTarget | null {
    let best: BossTarget | null = null;
    let bestDist = Infinity;
    for (const target of targets) {
      if (!target.alive) continue;
      const dist = distance(this.x, this.y, target.x, target.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = target;
      }
    }
    return best;
  }

  private pickAttack(rand: () => number): { id: string; def: BossAttackDef } {
    const attackIds = this.phase.attacks;
    const id = attackIds[Math.floor(rand() * attackIds.length)];
    return { id, def: this.def.attacks[id] };
  }

  /**
   * Advances the state machine by one tick. Boss always targets the nearest
   * living target for aggro/chasing; attack hitboxes damage every target
   * within range when they go active (so co-op players sharing melee range
   * both get hit by an AoE swing).
   */
  update(now: number, dtMs: number, targets: BossTarget[], rand: () => number = Math.random): BossHitEvent[] {
    if (!this.isAlive) return [];
    const events: BossHitEvent[] = [];

    switch (this.state) {
      case "idle": {
        const target = this.nearestTarget(targets);
        if (!target) break;
        const dist = distance(this.x, this.y, target.x, target.y);
        if (dist <= this.def.aggroRange && now >= this.stateEndsAt) {
          const picked = this.pickAttack(rand);
          this.currentAttackId = picked.id;
          this.currentAttack = picked.def;
          this.targetId = target.id;
          if (this.currentAttack.dashSpeed) {
            const dx = target.x - this.x;
            const dy = target.y - this.y;
            const len = Math.hypot(dx, dy) || 1;
            this.dashDirX = dx / len;
            this.dashDirY = dy / len;
          }
          this.setState("telegraph", this.currentAttack.telegraphMs, now);
        }
        break;
      }

      case "telegraph": {
        if (now >= this.stateEndsAt && this.currentAttack) {
          this.attackHitboxUsed = false;
          this.setState("attack", this.currentAttack.activeMs, now);
        }
        break;
      }

      case "attack": {
        if (this.currentAttack?.dashSpeed) {
          this.x += this.dashDirX * this.currentAttack.dashSpeed * (dtMs / 1000);
          this.y += this.dashDirY * this.currentAttack.dashSpeed * (dtMs / 1000);
        }
        if (this.currentAttack && !this.attackHitboxUsed) {
          for (const target of targets) {
            if (!target.alive) continue;
            const dist = distance(this.x, this.y, target.x, target.y);
            if (dist <= this.currentAttack.range) {
              events.push({ targetId: target.id, damage: this.currentAttack.damage });
            }
          }
          this.attackHitboxUsed = true;
        }
        if (now >= this.stateEndsAt && this.currentAttack) {
          this.setState("recover", this.currentAttack.recoverMs, now);
        }
        break;
      }

      case "recover": {
        if (now >= this.stateEndsAt && this.currentAttack) {
          const cooldownMs = this.currentAttack.cooldownMs;
          this.currentAttack = null;
          this.currentAttackId = null;
          this.state = "idle";
          this.stateEndsAt = now + cooldownMs;
        }
        break;
      }
    }

    return events;
  }
}
