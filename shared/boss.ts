/**
 * Pure, framework-agnostic boss state machine. Imported by both the Colyseus
 * server (authoritative simulation) and the Phaser client (single-player
 * fallback + type definitions). No Phaser or Colyseus dependency here so it
 * stays usable from both sides — this is the "one Boss state machine" the
 * data-driven boss design depends on.
 */

export interface BossProjectileDef {
  /** Travel speed in px/sec. */
  speed: number;
  /** Hit radius of each bolt (a player is struck within radius + player size). */
  radius: number;
  /** How many bolts to fire in a fan. Default 1. */
  count?: number;
  /** Total fan angle in degrees across `count` bolts. Default 0 (all straight). */
  spreadDeg?: number;
  /** Cosmetic tint for the client renderer, hex string. */
  color?: string;
}

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
  /** Fire the hitbox on the final tick of the active window instead of the first — used by leap attacks that only damage on impact. */
  impactAtEnd?: boolean;
  /** When the hitbox lands, request this many minions be spawned. The server drains BossLogic.spawnQueue and creates them. */
  summon?: { enemyId: string; count: number };
  /** Donut hitbox: targets closer than this to the center are safe. Standing inside the ring dodges the hit. */
  rangeMin?: number;
  /** The hitbox resolves at the target's position captured when the telegraph began (aimX/aimY), not at the boss. */
  groundTarget?: boolean;
  /** How close a chasing enemy gets before it will use this attack. Defaults to `range` — set it for groundTarget attacks whose `range` is a blast radius, not a reach. */
  castRange?: number;
  /** Teleport when the telegraph begins: "target" blinks just behind the target, "away" retreats to ~320px from it. */
  blink?: "target" | "away";
  /** Fire the hitbox this many times across the active window (default 1). */
  hits?: number;
  /** Spacing between multi-hits in ms. Defaults to activeMs / hits. */
  hitIntervalMs?: number;
  /** Fire dodgeable traveling bolts toward the nearest target instead of a radial hitbox. `range` becomes max travel distance. */
  projectile?: BossProjectileDef;
}

export interface BossPhaseDef {
  hpThreshold: number;
  attacks: string[];
  /** Overrides the boss's idle/recover tint while this phase is active. */
  color?: string;
}

/**
 * Parametric appearance recipe for the procedural sprite renderer. Used by
 * enemies/bosses that don't have hand-authored SVG art in data/boss-art.json.
 * Purely cosmetic — has no effect on combat.
 */
export interface VisualRecipe {
  bodyShape?: "slim" | "stocky" | "hulking" | "hunched" | "blob";
  /** Uniform scale multiplier applied on top of the bodyShape's base size. Default 1. */
  size?: number;
  palette?: {
    body?: string;
    trim?: string;
    skin?: string;
    eyes?: string;
  };
  weapon?: "none" | "claw" | "blade" | "club" | "spear" | "axe";
  accessory?: "none" | "horns" | "spikes" | "hood" | "mask" | "mane";
  markings?: "none" | "stripes" | "spots" | "scars";
}

export interface BossDef {
  id: string;
  name: string;
  hpMax: number;
  aggroRange: number;
  color: string;
  attacks: Record<string, BossAttackDef>;
  phases: BossPhaseDef[];
  /** Optional procedural appearance recipe (fallback for entries not covered by data/boss-art.json). */
  visual?: VisualRecipe;
  /** If set, the enemy walks toward its target (px/sec) while idle and out of attack range, instead of standing still until aggroed. */
  moveSpeed?: number;
  /** Coward: runs away from the nearest target (at moveSpeed) instead of chasing/attacking. */
  flees?: boolean;
  /** Gold awarded to the killing player on death. */
  goldReward?: number;
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

export interface BossSpawnRequest {
  enemyId: string;
  count: number;
  x: number;
  y: number;
}

/** A live traveling bolt simulated by BossLogic; the server mirrors these into synced state each tick. */
export interface ProjectileSim {
  id: number;
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  speed: number;
  radius: number;
  damage: number;
  traveled: number;
  maxDistance: number;
  color: string;
}

function distance(x1: number, y1: number, x2: number, y2: number) {
  return Math.hypot(x2 - x1, y2 - y1);
}

// Arena play space; blinks clamp to it and projectiles despawn just past it.
const ARENA_W = 960;
const ARENA_H = 640;
const BLINK_MARGIN = 48;
/** Approximate player body radius used for projectile contact checks. */
const PLAYER_HIT_RADIUS = 14;

export class BossLogic {
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  state: BossState = "idle";
  targetId: string | null = null;
  currentAttackId: string | null = null;
  /** Ground-target attacks lock onto the target's position at telegraph start; the client draws the danger zone here. */
  aimX = 0;
  aimY = 0;

  readonly def: BossDef;

  /** Minion spawn requests emitted by summon attacks during update(); the server drains this after each tick. */
  readonly spawnQueue: BossSpawnRequest[] = [];

  /** Live bolts fired by projectile attacks; simulated every update() until they hit, expire, or leave the arena. */
  readonly projectiles: ProjectileSim[] = [];

  private readonly spawnX: number;
  private readonly spawnY: number;
  private stateEndsAt = 0;
  private hitsFired = 0;
  private nextHitAt = 0;
  private projectileCounter = 0;
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
    this.hitsFired = 0;
    this.nextHitAt = 0;
    this.currentAttack = null;
    this.currentAttackId = null;
    this.targetId = null;
    this.spawnQueue.length = 0;
    this.projectiles.length = 0;
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

  /** Shortest reach among the current phase's attacks, i.e. how close a chasing enemy needs to get before it can strike. */
  private minAttackRange(): number {
    const ranges = this.phase.attacks.map((id) => {
      const atk = this.def.attacks[id];
      return atk ? atk.castRange ?? atk.range : 0;
    });
    return ranges.length ? Math.min(...ranges) : 0;
  }

  /** Teleport for a blink attack: "target" lands just behind the target, "away" retreats to a standoff distance. */
  private applyBlink(mode: "target" | "away", target: BossTarget) {
    let dx = this.x - target.x;
    let dy = this.y - target.y;
    let len = Math.hypot(dx, dy);
    if (len < 1) {
      dx = 1;
      dy = 0;
      len = 1;
    }
    if (mode === "target") {
      // Opposite side of the target from where the boss stood.
      this.x = target.x - (dx / len) * 64;
      this.y = target.y - (dy / len) * 64;
    } else {
      this.x = target.x + (dx / len) * 320;
      this.y = target.y + (dy / len) * 320;
    }
    this.x = Math.min(ARENA_W - BLINK_MARGIN, Math.max(BLINK_MARGIN, this.x));
    this.y = Math.min(ARENA_H - BLINK_MARGIN, Math.max(BLINK_MARGIN, this.y));
  }

  /**
   * Resolves one firing of the current attack's hitbox: radial (with optional donut
   * hole and ground-target center) or a fan of projectiles aimed at the nearest target.
   */
  private fireHitbox(attack: BossAttackDef, targets: BossTarget[], events: BossHitEvent[]) {
    if (attack.projectile) {
      const proj = attack.projectile;
      const target = this.nearestTarget(targets);
      let dirX = this.dashDirX;
      let dirY = this.dashDirY;
      if (target) {
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        const len = Math.hypot(dx, dy) || 1;
        dirX = dx / len;
        dirY = dy / len;
      } else if (dirX === 0 && dirY === 0) {
        dirX = 1;
      }
      const count = Math.max(1, proj.count ?? 1);
      const spreadRad = ((proj.spreadDeg ?? 0) * Math.PI) / 180;
      const baseAngle = Math.atan2(dirY, dirX);
      for (let i = 0; i < count; i++) {
        const offset = count === 1 ? 0 : -spreadRad / 2 + (spreadRad * i) / (count - 1);
        const angle = baseAngle + offset;
        this.projectiles.push({
          id: this.projectileCounter++,
          x: this.x,
          y: this.y,
          dirX: Math.cos(angle),
          dirY: Math.sin(angle),
          speed: proj.speed,
          radius: proj.radius,
          damage: attack.damage,
          traveled: 0,
          maxDistance: attack.range,
          color: proj.color ?? this.def.color,
        });
      }
    } else if (attack.range > 0) {
      const cx = attack.groundTarget ? this.aimX : this.x;
      const cy = attack.groundTarget ? this.aimY : this.y;
      for (const target of targets) {
        if (!target.alive) continue;
        const dist = distance(cx, cy, target.x, target.y);
        if (dist <= attack.range && dist >= (attack.rangeMin ?? 0)) {
          events.push({ targetId: target.id, damage: attack.damage });
        }
      }
    }
    if (attack.summon) {
      this.spawnQueue.push({ enemyId: attack.summon.enemyId, count: attack.summon.count, x: this.x, y: this.y });
    }
  }

  /** Advances every live bolt, applying contact damage and despawning spent ones. Runs every tick regardless of boss state. */
  private updateProjectiles(dtMs: number, targets: BossTarget[], events: BossHitEvent[]) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const step = p.speed * (dtMs / 1000);
      p.x += p.dirX * step;
      p.y += p.dirY * step;
      p.traveled += step;
      let spent = p.traveled >= p.maxDistance || p.x < -20 || p.x > ARENA_W + 20 || p.y < -20 || p.y > ARENA_H + 20;
      for (const target of targets) {
        if (spent) break;
        if (!target.alive) continue;
        if (distance(p.x, p.y, target.x, target.y) <= p.radius + PLAYER_HIT_RADIUS) {
          events.push({ targetId: target.id, damage: p.damage });
          spent = true;
        }
      }
      if (spent) this.projectiles.splice(i, 1);
    }
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

    // Bolts already in flight keep moving whatever the boss is doing.
    this.updateProjectiles(dtMs, targets, events);

    switch (this.state) {
      case "idle": {
        const target = this.nearestTarget(targets);
        if (!target) break;
        const dist = distance(this.x, this.y, target.x, target.y);
        if (this.def.flees) {
          // Cowards sprint away from the nearest player (with a panicky wobble) and never attack.
          if (dist <= this.def.aggroRange && this.def.moveSpeed) {
            const angle = Math.atan2(this.y - target.y, this.x - target.x) + Math.sin(now / 130) * 0.6;
            this.x += Math.cos(angle) * this.def.moveSpeed * (dtMs / 1000);
            this.y += Math.sin(angle) * this.def.moveSpeed * (dtMs / 1000);
          }
          break;
        }
        if (dist <= this.def.aggroRange && this.def.moveSpeed && dist > this.minAttackRange()) {
          const dx = target.x - this.x;
          const dy = target.y - this.y;
          const len = Math.hypot(dx, dy) || 1;
          this.x += (dx / len) * this.def.moveSpeed * (dtMs / 1000);
          this.y += (dy / len) * this.def.moveSpeed * (dtMs / 1000);
        } else if (dist <= this.def.aggroRange && now >= this.stateEndsAt) {
          const picked = this.pickAttack(rand);
          this.currentAttackId = picked.id;
          this.currentAttack = picked.def;
          this.targetId = target.id;
          if (this.currentAttack.blink) this.applyBlink(this.currentAttack.blink, target);
          // Ground-target attacks lock the danger zone where the target stood as the wind-up begins.
          this.aimX = target.x;
          this.aimY = target.y;
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
          this.hitsFired = 0;
          this.nextHitAt = now;
          this.setState("attack", this.currentAttack.activeMs, now);
        }
        break;
      }

      case "attack": {
        if (this.currentAttack?.dashSpeed) {
          this.x += this.dashDirX * this.currentAttack.dashSpeed * (dtMs / 1000);
          this.y += this.dashDirY * this.currentAttack.dashSpeed * (dtMs / 1000);
        }
        const atEnd = now >= this.stateEndsAt;
        if (this.currentAttack) {
          // Leap attacks (impactAtEnd) resolve once on landing; everything else fires
          // `hits` times across the active window (default once, on the first tick).
          const attack = this.currentAttack;
          const totalHits = attack.impactAtEnd ? 1 : Math.max(1, attack.hits ?? 1);
          const interval = attack.hitIntervalMs ?? attack.activeMs / totalHits;
          while (this.hitsFired < totalHits && (attack.impactAtEnd ? atEnd : now >= this.nextHitAt)) {
            this.fireHitbox(attack, targets, events);
            this.hitsFired += 1;
            this.nextHitAt += interval;
          }
        }
        if (atEnd && this.currentAttack) {
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
