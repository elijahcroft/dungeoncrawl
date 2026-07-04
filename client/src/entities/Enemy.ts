import Phaser from "phaser";
import { BossLogic, type BossAttackDef, type BossDef, type BossHitEvent, type BossTarget, type ProjectileSim } from "../../../shared/boss";
import { ensureEnemyTexture, ensureShadowTexture, bossArtKey } from "../gfx/sprites";

export type { BossDef, BossAttackDef, BossPhaseDef } from "../../../shared/boss";

export interface EnemyOptions {
  id: string;
  isBoss: boolean;
}

const LERP_FACTOR = 0.3;
const KNOCK_DECAY = 0.78;
/** Peak height (px) the boss sprite lifts at the apex of a "jump" attack arc. */
const JUMP_PEAK = 120;
/** A synced position jump bigger than this reads as a blink teleport: snap instead of lerping across the room. */
const BLINK_SNAP_DIST = 110;

/** Renders one enemy (grunt or boss) from either a local simulation (offline fallback) or synced server state. */
export class Enemy {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Sprite;
  id: string;
  isBoss: boolean;
  hpMax: number;
  hp: number;
  def: BossDef;

  /** Scene-level hooks so the GameScene can add FX/sound/screen-shake on boss events. */
  onBossAttack?: (x: number, y: number, range: number, attack: BossAttackDef) => void;
  onPhaseChange?: (x: number, y: number) => void;
  onBlink?: (fromX: number, fromY: number, toX: number, toY: number) => void;

  private logic: BossLogic | null;
  private baseColor: number;
  private hpBarBg: Phaser.GameObjects.Rectangle;
  private hpBarFg: Phaser.GameObjects.Rectangle;
  private decal: Phaser.GameObjects.Graphics;
  private shadow: Phaser.GameObjects.Image;

  // Grunt walk-cycle (bosses use single-texture SVG art, so they don't frame-swap).
  private usesArt: boolean;
  private walkFrame: 0 | 1 = 0;
  private nextWalkFrameAt = 0;

  // Interpolation + knockback so server-synced enemies move smoothly and react to hits.
  private targetX: number;
  private targetY: number;
  private knockX = 0;
  private knockY = 0;

  // Transition tracking for one-shot telegraph/attack/phase FX.
  private prevState = "idle";
  private prevHp: number;
  private prevPhaseIndex = 0;
  private telegraphStart = 0;
  private telegraphMs = 0;
  private telegraphRange = 0;
  private telegraphAttack: BossAttackDef | null = null;
  // Ground-target attacks resolve at this synced aim point, not at the enemy.
  private aimX = 0;
  private aimY = 0;

  // Active-window tracking so the "jump" attack can render a real airborne arc and land its crash FX on impact.
  private attackAnimKey = "";
  private attackStart = 0;
  private attackMs = 0;
  private attackDef: BossAttackDef | null = null;
  private jumpImpactFired = false;
  private lastLift = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, def: BossDef, options: EnemyOptions, standalone = false) {
    this.scene = scene;
    this.def = def;
    this.id = options.id;
    this.isBoss = options.isBoss;
    this.hpMax = def.hpMax;
    this.hp = def.hpMax;
    this.prevHp = def.hpMax;
    this.baseColor = Number(def.color);
    this.logic = standalone ? new BossLogic(def, x, y) : null;
    this.targetX = x;
    this.targetY = y;
    const artKey = options.isBoss ? bossArtKey(def.id) : null;
    this.usesArt = !!(artKey && scene.textures.exists(artKey));
    const textureKey = this.usesArt ? artKey! : ensureEnemyTexture(scene, def.visual, this.baseColor, 0, options.isBoss);
    this.decal = scene.add.graphics().setDepth(1);
    this.shadow = scene.add.image(x, y + (options.isBoss ? 48 : 16), ensureShadowTexture(scene, options.isBoss ? 60 : 26)).setDepth(0);
    this.sprite = scene.add.sprite(x, y, textureKey).setDepth(2);

    const barWidth = options.isBoss ? 44 : 28;
    const barY = y - (options.isBoss ? 30 : 24);
    this.hpBarBg = scene.add.rectangle(x, barY, barWidth, 4, 0x000000, 0.6).setDepth(3);
    this.hpBarFg = scene.add.rectangle(x - barWidth / 2, barY, barWidth, 4, 0xff5555, 1).setOrigin(0, 0.5).setDepth(3);
  }

  get isAlive() {
    return this.hp > 0;
  }

  get phaseIndex() {
    return this.prevPhaseIndex;
  }

  /** Offline single-player fallback: advance the local state machine and return any hit events. */
  update(now: number, deltaMs: number, target: BossTarget): BossHitEvent[] {
    if (!this.logic) return [];
    const events = this.logic.isAlive ? this.logic.update(now, deltaMs, [target]) : [];
    const phaseIndex = Math.max(0, this.def.phases.indexOf(this.logic.phase));
    this.sync(this.logic.x, this.logic.y, this.logic.hp, this.hpMax, this.logic.state, this.logic.phase.color ?? this.def.color, this.logic.currentAttackId ?? "", phaseIndex, this.logic.aimX, this.logic.aimY, true);
    return events;
  }

  /** Offline fallback: bolts simulated by the local state machine (multiplayer bolts come from synced state instead). */
  get localProjectiles(): ProjectileSim[] {
    return this.logic?.projectiles ?? [];
  }

  takeDamage(amount: number) {
    if (!this.logic) return;
    this.logic.takeDamage(amount);
    this.hp = this.logic.hp;
    this.flashHit();
  }

  /** Push the sprite away from a hit; the offset decays back to the interpolated position. */
  applyKnockback(dirX: number, dirY: number, strength: number) {
    const len = Math.hypot(dirX, dirY) || 1;
    this.knockX += (dirX / len) * strength;
    this.knockY += (dirY / len) * strength;
  }

  /** Multiplayer: render purely from server-synced state, no local simulation. */
  applyServerState(x: number, y: number, hp: number, hpMax: number, state: string, phaseColor: string, attackId: string, phaseIndex: number, aimX: number, aimY: number) {
    this.sync(x, y, hp, hpMax, state, phaseColor, attackId, phaseIndex, aimX, aimY, false);
  }

  private sync(x: number, y: number, hp: number, hpMax: number, state: string, phaseColor: string, attackId: string, phaseIndex: number, aimX: number, aimY: number, snap: boolean) {
    this.targetX = x;
    this.targetY = y;
    this.aimX = aimX;
    this.aimY = aimY;
    if (snap) {
      this.sprite.x = x;
      this.sprite.y = y;
    } else if (Math.hypot(x - this.sprite.x, y - this.sprite.y) > BLINK_SNAP_DIST) {
      // Blink teleport: don't smear the sprite across the room — pop it to the new spot.
      this.onBlink?.(this.sprite.x, this.sprite.y, x, y);
      this.sprite.x = x;
      this.sprite.y = y;
    }
    this.hpMax = hpMax;

    // Damage flash when HP drops (works in multiplayer, where there's no local takeDamage).
    if (hp < this.prevHp && hp > 0) this.flashHit();
    this.prevHp = hp;
    this.hp = hp;

    // Telegraph begins: remember timing so the decal can fill up over the wind-up.
    if (state === "telegraph" && this.prevState !== "telegraph") {
      const atk = this.def.attacks[attackId];
      this.telegraphStart = this.scene.time.now;
      this.telegraphMs = atk?.telegraphMs ?? 500;
      this.telegraphRange = atk?.range ?? 0;
      this.telegraphAttack = atk ?? null;
      this.attackAnimKey = atk?.animationKey ?? "";
      this.scene.game.events.emit("boss-telegraph");
    }
    // Active window begins: record timing for the airborne arc, then fire the on-launch FX —
    // except for "jump" attacks, whose crash FX fires on landing (see render()).
    if (state === "attack" && this.prevState !== "attack") {
      const atk = this.def.attacks[attackId];
      this.attackDef = atk ?? null;
      this.attackAnimKey = atk?.animationKey ?? "";
      this.attackStart = this.scene.time.now;
      this.attackMs = atk?.activeMs ?? 200;
      this.jumpImpactFired = false;
      if (atk && this.attackAnimKey !== "jump") {
        // Ground-target blasts detonate at the marked zone, not under the caster.
        const fxX = atk.groundTarget ? this.aimX : this.sprite.x;
        const fxY = atk.groundTarget ? this.aimY : this.sprite.y;
        this.onBossAttack?.(fxX, fxY, atk.range, atk);
      }
    }
    if (state !== "attack" && state !== "telegraph") {
      this.attackAnimKey = "";
      this.telegraphAttack = null;
    }
    this.prevState = state;

    if (phaseIndex !== this.prevPhaseIndex) {
      this.prevPhaseIndex = phaseIndex;
      this.onPhaseChange?.(this.sprite.x, this.sprite.y);
    }

    this.render(state, phaseColor);
  }

  private render(state: string, phaseColor: string) {
    // Distance still to cover (pre-interpolation) tells us whether to play the walk cycle.
    const moving = Math.hypot(this.targetX - this.sprite.x, this.targetY - this.sprite.y) > 1;
    // Interpolate toward the server position, then add the decaying knockback offset.
    this.sprite.x = Phaser.Math.Linear(this.sprite.x, this.targetX, LERP_FACTOR);
    this.sprite.y = Phaser.Math.Linear(this.sprite.y, this.targetY, LERP_FACTOR);
    this.knockX *= KNOCK_DECAY;
    this.knockY *= KNOCK_DECAY;
    if (Math.abs(this.knockX) < 0.3) this.knockX = 0;
    if (Math.abs(this.knockY) < 0.3) this.knockY = 0;

    const drawX = this.sprite.x + this.knockX;
    const drawY = this.sprite.y + this.knockY;
    if (this.targetX < this.sprite.x - 0.5) this.sprite.setFlipX(true);
    else if (this.targetX > this.sprite.x + 0.5) this.sprite.setFlipX(false);

    // Airborne arc + squash-and-stretch for "jump" attacks; the body lifts while the shadow stays planted.
    const { lift, scaleX, scaleY } = this.computeJump(state, drawX, drawY);
    this.sprite.setScale(scaleX, scaleY);
    const yAdjust = (1 - scaleY) * (this.sprite.height / 2); // keep the feet planted as it squashes/stretches
    this.sprite.setPosition(drawX, drawY - lift + yAdjust);

    const tint = this.colorForState(state, phaseColor);
    if (tint === null) this.sprite.clearTint();
    else this.sprite.setTint(tint);

    const alive = this.hp > 0;
    // Grunts (procedural, non-SVG) shuffle their legs while chasing.
    if (!this.usesArt && alive && moving) {
      const now = this.scene.time.now;
      if (now >= this.nextWalkFrameAt) {
        this.walkFrame = this.walkFrame === 0 ? 1 : 0;
        this.nextWalkFrameAt = now + 150;
        this.sprite.setTexture(ensureEnemyTexture(this.scene, this.def.visual, this.baseColor, this.walkFrame, this.isBoss));
      }
    }
    this.sprite.setVisible(alive);
    this.hpBarBg.setVisible(alive);
    this.hpBarFg.setVisible(alive);
    // Shadow stays on the ground and shrinks/fades with height — the classic "dodge the shadow" cue.
    const liftFrac = this.lastLift / JUMP_PEAK;
    this.shadow
      .setVisible(alive)
      .setPosition(drawX, drawY + (this.isBoss ? 48 : 16))
      .setScale(1 - 0.5 * liftFrac)
      .setAlpha(1 - 0.55 * liftFrac);
    this.drawDecal(drawX, drawY, state, alive);
    if (alive) {
      const barWidth = this.isBoss ? 44 : 28;
      const barY = drawY - this.lastLift - (this.isBoss ? 30 : 24);
      this.hpBarBg.setPosition(drawX, barY);
      this.hpBarFg.setPosition(drawX - barWidth / 2, barY);
      this.hpBarFg.width = barWidth * Phaser.Math.Clamp(this.hp / Math.max(1, this.hpMax), 0, 1);
    }
  }

  /**
   * Computes the jump arc height + squash/stretch for the current frame, and fires the crash
   * FX on landing. Returns all-neutral values for non-jump attacks. `lastLift` is stashed so
   * the shadow/HP-bar code below can react to the same height.
   */
  private computeJump(state: string, drawX: number, drawY: number): { lift: number; scaleX: number; scaleY: number } {
    let lift = 0;
    let scaleX = 1;
    let scaleY = 1;
    if (this.attackAnimKey === "jump") {
      const now = this.scene.time.now;
      if (state === "telegraph") {
        const p = Phaser.Math.Clamp((now - this.telegraphStart) / Math.max(1, this.telegraphMs), 0, 1);
        scaleY = 1 - 0.16 * p; // gather/crouch anticipation
        scaleX = 1 + 0.14 * p;
      } else if (state === "attack") {
        const p = Phaser.Math.Clamp((now - this.attackStart) / Math.max(1, this.attackMs), 0, 1);
        lift = Math.sin(p * Math.PI) * JUMP_PEAK; // up-and-over arc, back to ground at p=1
        if (p < 0.22) {
          const s = p / 0.22; // launch stretch
          scaleY = 1 + 0.3 * s;
          scaleX = 1 - 0.2 * s;
        } else if (p > 0.8) {
          const s = (p - 0.8) / 0.2; // impact squash
          scaleY = 1 - 0.36 * s;
          scaleX = 1 + 0.3 * s;
        }
        if (p >= 0.99 && !this.jumpImpactFired) {
          this.jumpImpactFired = true;
          if (this.attackDef) this.onBossAttack?.(drawX, drawY, this.attackDef.range, this.attackDef);
        }
      }
    }
    this.lastLift = lift;
    return { lift, scaleX, scaleY };
  }

  /** Ground AoE telegraph: a boundary ring plus a danger zone that fills over the wind-up, then a red strike flash. */
  private drawDecal(x: number, y: number, state: string, alive: boolean) {
    this.decal.clear();
    if (!alive || this.telegraphRange <= 0) return;
    // Leap attack: no marker during the wind-up (the boss hasn't committed a landing spot yet); once
    // airborne, the danger zone tracks the ground point under the boss and fills over the descent.
    if (this.attackAnimKey === "jump") {
      if (state === "attack") {
        const p = Phaser.Math.Clamp((this.scene.time.now - this.attackStart) / Math.max(1, this.attackMs), 0, 1);
        this.decal.lineStyle(2, 0xff5544, 0.55);
        this.decal.strokeCircle(x, y, this.telegraphRange);
        this.decal.fillStyle(0xff3322, 0.12 + 0.3 * p);
        this.decal.fillCircle(x, y, this.telegraphRange * (0.35 + 0.65 * p));
      }
      return;
    }
    const atk = this.telegraphAttack;
    // Projectile cast: no giant zone (the danger travels) — just a charge-up pulse under the caster.
    if (atk?.projectile) {
      if (state === "telegraph") {
        const p = Phaser.Math.Clamp((this.scene.time.now - this.telegraphStart) / Math.max(1, this.telegraphMs), 0, 1);
        this.decal.lineStyle(2, 0xffaa44, 0.25 + 0.55 * p);
        this.decal.strokeCircle(x, y, 34 - 14 * p);
        this.decal.fillStyle(0xffaa44, 0.12 + 0.28 * p);
        this.decal.fillCircle(x, y, 10 + 8 * p);
      }
      return;
    }
    // Ground-target attacks mark the locked aim point; everything else is centered on the enemy.
    const cx = atk?.groundTarget ? this.aimX : x;
    const cy = atk?.groundTarget ? this.aimY : y;
    const inner = atk?.rangeMin ?? 0;
    // A donut is drawn as one thick stroked ring between its inner and outer radii.
    const mid = (inner + this.telegraphRange) / 2;
    const band = this.telegraphRange - inner;
    if (state === "telegraph") {
      const progress = Phaser.Math.Clamp((this.scene.time.now - this.telegraphStart) / Math.max(1, this.telegraphMs), 0, 1);
      this.decal.lineStyle(2, 0xff5544, 0.5);
      this.decal.strokeCircle(cx, cy, this.telegraphRange);
      if (inner > 0) {
        this.decal.lineStyle(band, 0xff3322, 0.1 + 0.24 * progress);
        this.decal.strokeCircle(cx, cy, mid);
        this.decal.lineStyle(2, 0x66ff88, 0.7); // safe-zone boundary: get inside this circle
        this.decal.strokeCircle(cx, cy, inner);
      } else {
        this.decal.fillStyle(0xff3322, 0.14 + 0.22 * progress);
        this.decal.fillCircle(cx, cy, this.telegraphRange * progress);
      }
    } else if (state === "attack") {
      // Multi-hit attacks stay dangerous the whole window: pulse instead of a single flat flash.
      const alpha = (atk?.hits ?? 1) > 1 ? 0.2 + 0.18 * (0.5 + 0.5 * Math.sin(this.scene.time.now / 55)) : 0.36;
      if (inner > 0) {
        this.decal.lineStyle(band, 0xff2211, alpha);
        this.decal.strokeCircle(cx, cy, mid);
      } else {
        this.decal.fillStyle(0xff2211, alpha);
        this.decal.fillCircle(cx, cy, this.telegraphRange);
      }
      this.decal.lineStyle(3, 0xffffff, 0.6);
      this.decal.strokeCircle(cx, cy, this.telegraphRange);
    }
  }

  private flashHit() {
    this.sprite.setTint(0xffffff);
    this.scene.time.delayedCall(80, () => {
      if (this.hp > 0) this.sprite.clearTint();
    });
  }

  private colorForState(state: string, phaseColor: string): number | null {
    switch (state) {
      case "telegraph":
        return 0xffcc33;
      case "attack":
        return 0xff3333;
      case "dead":
        return 0x333333;
      default:
        return Number(phaseColor ?? this.def.color) === this.baseColor ? null : Number(phaseColor);
    }
  }

  destroy() {
    this.sprite.destroy();
    this.hpBarBg.destroy();
    this.hpBarFg.destroy();
    this.decal.destroy();
    this.shadow.destroy();
  }
}
