import Phaser from "phaser";
import {
  ensurePlayerTexture,
  ensureShadowTexture,
  ensureAimedWeaponTexture,
  AIMED_WEAPON_W,
  AIMED_WEAPON_H,
  AIMED_WEAPON_GRIP_X,
  AIMED_WEAPON_GRIP_Y,
  WALK_POSES,
  IDLE_POSES,
  type PlayerPoseName,
  type WeaponSprite,
} from "../gfx/sprites";
import { WEAPONS, STARTER_WEAPON_ID, type WeaponDef } from "./weapons";

const MOVE_SPEED = 220;
// Velocity is eased toward the input target instead of snapping, so the hero has
// weight. Rates are exponential-smoothing constants (per second): a higher rate
// closes the gap faster. Decel is snappier than accel so stops still feel crisp.
const ACCEL_RATE = 17;
const DECEL_RATE = 24;
const ROLL_SPEED = 560;
// Roll coasts out to this fraction of its launch speed for an ease-out dive.
const ROLL_END_SPEED_MULT = 0.45;
const ROLL_DURATION_MS = 220;
const ROLL_COOLDOWN_MS = 500;
const ROLL_STAMINA_COST = 25;

const ATTACK_STAMINA_COST = 15;
// Movement is throttled to this fraction of normal speed while a swing is committed.
const ATTACK_MOVE_MULT = 0.45;
// While an attack is charging/active, held movement input nudges the aim by at most
// this many degrees per second — fine radial control instead of snapping to facing.
const AIM_TURN_RATE_RAD = Phaser.Math.DegToRad(200);

const STAMINA_MAX = 100;
const STAMINA_REGEN_PER_SEC = 35;
const STAMINA_REGEN_DELAY_MS = 500;

const HP_MAX = 100;
const HIT_IFRAME_MS = 500;
const WALK_FRAME_INTERVAL_MS = 110;
const IDLE_FRAME_INTERVAL_MS = 620;

export interface PlayerOptions {
  color?: number;
  hpMax?: number;
  speedPct?: number;
  bonusDamage?: number;
}

export class Player {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Sprite & { body: Phaser.Physics.Arcade.Body };
  hp: number;
  hpMax: number;
  stamina = STAMINA_MAX;
  staminaMax = STAMINA_MAX;

  facing = new Phaser.Math.Vector2(0, 1);
  private aimAngle = Math.atan2(1, 0);
  private aimDir = new Phaser.Math.Vector2(0, 1);

  private color: number;
  private moveSpeed: number;
  private bonusDamage: number;
  private currentWeapon: WeaponDef = WEAPONS[STARTER_WEAPON_ID];

  private isRolling = false;
  private rollEndsAt = 0;
  private rollCooldownUntil = 0;
  private rollDir = new Phaser.Math.Vector2(0, 1);
  private lastStaminaUseAt = 0;

  private attackCooldownUntil = 0;
  private attackHitsRemaining = 0;
  private nextHitAt = 0;
  private hitIntervalMs = 0;
  private attackLungeUntil = 0;
  private attackLungeSpeed = 0;
  private attackLungeDir = new Phaser.Math.Vector2(0, 1);
  private attackActiveUntil = 0;
  private hurtKnockUntil = 0;
  private hurtKnockVec = new Phaser.Math.Vector2(0, 0);

  private invulnerableUntil = 0;
  private tintedUntil = 0;
  private animIndex = 0;
  private nextAnimAt = 0;
  private currentPose: PlayerPoseName = "idle0";
  private shadow: Phaser.GameObjects.Image;
  // Ranged weapons (crossbow, future bows/guns) render as a separate sprite held
  // in front of the hero, pivoted to the aim direction, instead of being baked
  // into the pose textures. Undefined while a melee weapon is equipped.
  private weaponOverlay?: Phaser.GameObjects.Sprite;

  private keys: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    roll: Phaser.Input.Keyboard.Key;
    attack: Phaser.Input.Keyboard.Key;
    useItem: Phaser.Input.Keyboard.Key;
  };

  onAttack?: (originX: number, originY: number, dirX: number, dirY: number) => void;
  onSwing?: () => void;
  onRoll?: () => void;
  onHurt?: (amount: number) => void;
  onUseItem?: () => void;

  constructor(scene: Phaser.Scene, x: number, y: number, options: PlayerOptions = {}) {
    this.scene = scene;
    this.color = options.color ?? 0x4da6ff;
    this.hpMax = options.hpMax ?? HP_MAX;
    this.hp = this.hpMax;
    this.moveSpeed = MOVE_SPEED * (1 + (options.speedPct ?? 0) / 100);
    this.bonusDamage = options.bonusDamage ?? 0;

    this.shadow = scene.add.image(x, y + 26, ensureShadowTexture(scene, 30)).setDepth(-0.5);

    const textureKey = ensurePlayerTexture(scene, this.color, "idle0", this.bakedWeaponSprite(), this.currentWeapon.color);
    const sprite = scene.add.sprite(x, y, textureKey) as Phaser.GameObjects.Sprite & {
      body: Phaser.Physics.Arcade.Body;
    };
    scene.physics.add.existing(sprite);
    sprite.body.setSize(24, 28);
    sprite.body.setOffset(14, 26);
    sprite.body.setCollideWorldBounds(true);
    this.sprite = sprite;
    this.refreshWeaponOverlay();

    const kb = scene.input.keyboard!;
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      roll: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      attack: kb.addKey(Phaser.Input.Keyboard.KeyCodes.J),
      useItem: kb.addKey(Phaser.Input.Keyboard.KeyCodes.E),
    };
  }

  get isInvulnerable() {
    return this.scene.time.now < this.invulnerableUntil;
  }

  get isAlive() {
    return this.hp > 0;
  }

  get rolling() {
    return this.isRolling;
  }

  get rollDurationMs() {
    return ROLL_DURATION_MS;
  }

  get weapon(): WeaponDef {
    return this.currentWeapon;
  }

  get damage() {
    return this.currentWeapon.damage + this.bonusDamage;
  }

  /**
   * Attack-cooldown recharge, 0 (just swung) → 1 (ready), for the MC-style HUD bar.
   * Reads 1 before the first swing / whenever off cooldown.
   */
  get attackCooldownFraction() {
    const cd = this.currentWeapon.cooldownMs;
    if (cd <= 0) return 1;
    const elapsed = this.scene.time.now - (this.attackCooldownUntil - cd);
    return Phaser.Math.Clamp(elapsed / cd, 0, 1);
  }

  /** Swaps the carried weapon (the player holds exactly one) and re-renders the sprite. */
  setWeapon(weaponId: string) {
    const next = WEAPONS[weaponId];
    if (!next) return;
    this.currentWeapon = next;
    this.sprite.setTexture(
      ensurePlayerTexture(this.scene, this.color, this.currentPose, this.bakedWeaponSprite(), next.color),
    );
    this.refreshWeaponOverlay();
  }

  /** Ranged weapons are drawn as an aim-tracking overlay, not swung as an arc/thrust/slam. */
  private get isRanged() {
    return this.currentWeapon.hitShape === "projectile";
  }

  /** Which weapon art to bake into the player texture — none for ranged (the overlay draws it). */
  private bakedWeaponSprite(): WeaponSprite {
    return this.isRanged ? "none" : this.currentWeapon.sprite;
  }

  /** Creates/updates/removes the aim-tracking overlay sprite to match the current weapon. */
  private refreshWeaponOverlay() {
    if (this.isRanged) {
      const key = ensureAimedWeaponTexture(this.scene, this.currentWeapon.sprite, this.currentWeapon.color);
      if (!this.weaponOverlay) {
        this.weaponOverlay = this.scene.add
          .sprite(this.sprite.x, this.sprite.y, key)
          .setOrigin(AIMED_WEAPON_GRIP_X / AIMED_WEAPON_W, AIMED_WEAPON_GRIP_Y / AIMED_WEAPON_H)
          .setDepth(1);
      } else {
        this.weaponOverlay.setTexture(key);
      }
    } else if (this.weaponOverlay) {
      this.weaponOverlay.destroy();
      this.weaponOverlay = undefined;
    }
  }

  /** Anchors the ranged-weapon overlay at the hand, held slightly in front and pivoted to the aim. */
  private updateWeaponOverlay() {
    const w = this.weaponOverlay;
    if (!w) return;
    const forward = 5; // px the grip sits ahead of the body along the aim
    const handY = 6; // grip height relative to the sprite center
    w.setPosition(this.sprite.x + this.aimDir.x * forward, this.sprite.y + handY + this.aimDir.y * forward);
    w.setRotation(this.aimAngle);
    w.setFlipY(this.aimDir.x < 0); // keep the stock down when aiming left
    w.setVisible(this.sprite.visible);
    w.setAlpha(this.sprite.alpha);
  }

  /** Reconciles live stat bonuses (class + picked-up items) from the server. */
  applyBonuses(hpMax: number, bonusDamage: number, bonusSpeedPct: number) {
    this.hpMax = hpMax;
    this.moveSpeed = MOVE_SPEED * (1 + bonusSpeedPct / 100);
    this.bonusDamage = bonusDamage;
  }

  /** Brief directional shove applied when the player is hit (visible through the input-driven velocity). */
  knockback(dirX: number, dirY: number, speed = 460, durationMs = 220) {
    const len = Math.hypot(dirX, dirY) || 1;
    this.hurtKnockVec.set((dirX / len) * speed, (dirY / len) * speed);
    this.hurtKnockUntil = this.scene.time.now + durationMs;
  }

  private spendStamina(amount: number) {
    this.stamina = Math.max(0, this.stamina - amount);
    this.lastStaminaUseAt = this.scene.time.now;
  }

  private flashTint(color: number, durationMs: number) {
    this.sprite.setTint(color);
    this.tintedUntil = this.scene.time.now + durationMs;
    this.scene.time.delayedCall(durationMs, () => {
      if (this.scene.time.now >= this.tintedUntil) this.sprite.clearTint();
    });
  }

  takeDamage(amount: number) {
    if (this.isInvulnerable || !this.isAlive) return;
    const dealt = Math.min(amount, this.hp);
    this.hp = Math.max(0, this.hp - amount);
    this.invulnerableUntil = this.scene.time.now + HIT_IFRAME_MS;
    this.flashTint(0xff4d4d, 120);
    this.popScale(1.18, 0.84); // recoil squash on hit
    this.onHurt?.(dealt);
  }

  /** Reconcile local HP with the server's authoritative value (multiplayer mode). */
  syncHp(hp: number, hpMax?: number) {
    const nextHp = Math.max(0, hp);
    const wasAlive = this.hp > 0;
    const tookDamage = nextHp < this.hp;
    const dealt = this.hp - nextHp;
    this.hp = nextHp;
    if (hpMax !== undefined) this.hpMax = hpMax;

    if (nextHp <= 0) {
      this.sprite.setAlpha(0.35);
      return;
    }
    this.sprite.setAlpha(1);
    if (!wasAlive) return;
    if (tookDamage) {
      this.flashTint(0xff4d4d, 120);
      this.popScale(1.18, 0.84); // recoil squash on hit
      this.onHurt?.(dealt);
    }
  }

  update(_time: number, delta: number) {
    const now = this.scene.time.now;
    const body = this.sprite.body;

    // Stamina regen after a short delay of no use
    if (now - this.lastStaminaUseAt > STAMINA_REGEN_DELAY_MS && this.stamina < this.staminaMax) {
      this.stamina = Math.min(this.staminaMax, this.stamina + (STAMINA_REGEN_PER_SEC * delta) / 1000);
    }

    if (this.isRolling) {
      if (now >= this.rollEndsAt) {
        this.isRolling = false;
        this.popScale(0.86, 1.16); // landing squash as the dive resolves
      } else {
        // Ease the roll speed out across its duration so it lands soft, not abrupt.
        const p = (this.rollEndsAt - now) / ROLL_DURATION_MS; // 1 → 0
        const speed = ROLL_SPEED * (ROLL_END_SPEED_MULT + (1 - ROLL_END_SPEED_MULT) * p);
        body.setVelocity(this.rollDir.x * speed, this.rollDir.y * speed);
      }
      this.updateAttackWindow(now);
      this.updateWalkAnimation(now, false);
      this.updateFacingVisual();
      this.updateSquash();
      this.updateWeaponOverlay();
      return;
    }

    // Movement input
    const dir = new Phaser.Math.Vector2(0, 0);
    if (this.keys.left.isDown) dir.x -= 1;
    if (this.keys.right.isDown) dir.x += 1;
    if (this.keys.up.isDown) dir.y -= 1;
    if (this.keys.down.isDown) dir.y += 1;

    const moving = dir.lengthSq() > 0;
    if (moving) {
      dir.normalize();
      this.facing.copy(dir);
    }
    // While a shot is charging/active, held input dials the aim in smoothly (radial
    // fine-aim) rather than snapping it to one of the 8 WASD directions. Otherwise
    // the aim simply tracks the facing, so a held ranged weapon points where you go.
    if (this.attackHitsRemaining > 0) {
      if (moving) {
        const targetAngle = Math.atan2(dir.y, dir.x);
        const maxStep = (AIM_TURN_RATE_RAD * delta) / 1000;
        this.aimAngle = Phaser.Math.Angle.RotateTo(this.aimAngle, targetAngle, maxStep);
        this.aimDir.set(Math.cos(this.aimAngle), Math.sin(this.aimAngle));
      }
    } else {
      this.aimAngle = Math.atan2(this.facing.y, this.facing.x);
      this.aimDir.copy(this.facing);
    }
    // Committing to a swing slows the player until the swing window ends (attack commitment).
    const speed = now < this.attackActiveUntil ? this.moveSpeed * ATTACK_MOVE_MULT : this.moveSpeed;
    // Ease velocity toward the input target so the hero accelerates and coasts to a
    // stop instead of snapping — frame-rate-independent via exponential smoothing.
    const rate = moving ? ACCEL_RATE : DECEL_RATE;
    const t = 1 - Math.exp((-rate * delta) / 1000);
    body.setVelocity(
      Phaser.Math.Linear(body.velocity.x, dir.x * speed, t),
      Phaser.Math.Linear(body.velocity.y, dir.y * speed, t),
    );
    // A lunging stab drives the player forward through the swing, ignoring steer input.
    if (now < this.attackLungeUntil) {
      body.setVelocity(this.attackLungeDir.x * this.attackLungeSpeed, this.attackLungeDir.y * this.attackLungeSpeed);
    }
    // Being hit shoves the player back briefly, overriding steer input.
    if (now < this.hurtKnockUntil) {
      body.setVelocity(this.hurtKnockVec.x, this.hurtKnockVec.y);
    }
    this.updateWalkAnimation(now, moving);
    this.updateFacingVisual();
    this.updateSquash();

    // Roll input
    if (
      Phaser.Input.Keyboard.JustDown(this.keys.roll) &&
      now >= this.rollCooldownUntil &&
      this.stamina >= ROLL_STAMINA_COST
    ) {
      this.spendStamina(ROLL_STAMINA_COST);
      this.onRoll?.();
      this.isRolling = true;
      this.rollEndsAt = now + ROLL_DURATION_MS;
      this.rollCooldownUntil = now + ROLL_DURATION_MS + ROLL_COOLDOWN_MS;
      this.invulnerableUntil = this.rollEndsAt;
      const rollDir = moving ? dir : this.facing;
      this.rollDir.copy(rollDir);
      body.setVelocity(rollDir.x * ROLL_SPEED, rollDir.y * ROLL_SPEED);
      this.flashTint(0xffffff, ROLL_DURATION_MS);
      this.popScale(1.2, 0.82); // stretch into the dive
    }

    // Attack input
    if (
      Phaser.Input.Keyboard.JustDown(this.keys.attack) &&
      now >= this.attackCooldownUntil &&
      this.stamina >= ATTACK_STAMINA_COST
    ) {
      const w = this.currentWeapon;
      this.spendStamina(ATTACK_STAMINA_COST);
      this.aimAngle = Math.atan2(this.facing.y, this.facing.x);
      this.aimDir.copy(this.facing);
      this.attackCooldownUntil = now + w.cooldownMs;
      this.attackActiveUntil = now + w.swingMs;
      this.onSwing?.();
      // Schedule this swing's hits (combos land multiple times across the swing window).
      const hits = w.hits ?? 1;
      this.attackHitsRemaining = hits;
      this.hitIntervalMs = w.swingMs / hits;
      this.nextHitAt = now + (w.windupMs ?? 0); // crossbows draw briefly before the bolt releases
      this.popScale(1.12, 0.92); // swing punch
      if (w.lunge && !this.isRolling) {
        const durMs = Math.min(w.swingMs, 180);
        this.attackLungeUntil = now + durMs;
        this.attackLungeDir.copy(this.facing);
        this.attackLungeSpeed = (w.lunge / durMs) * 1000;
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.useItem)) {
      this.onUseItem?.();
    }

    this.updateAttackWindow(now);
    this.updateWeaponOverlay();
  }

  private setPose(pose: PlayerPoseName) {
    if (pose === this.currentPose) return;
    this.currentPose = pose;
    this.sprite.setTexture(
      ensurePlayerTexture(this.scene, this.color, pose, this.bakedWeaponSprite(), this.currentWeapon.color),
    );
  }

  private updateFacingVisual() {
    if (Math.abs(this.facing.x) > 0.1) {
      this.sprite.setFlipX(this.facing.x < 0);
    }
    this.shadow.setPosition(this.sprite.x, this.sprite.y + 26);
  }

  /** Snaps the sprite to a squash/stretch, from which updateSquash() eases it back to 1. */
  private popScale(scaleX: number, scaleY: number) {
    this.sprite.setScale(scaleX, scaleY);
  }

  /** Eases any active squash/stretch back to neutral each frame for a springy settle. */
  private updateSquash() {
    const sx = Phaser.Math.Linear(this.sprite.scaleX, 1, 0.2);
    const sy = Phaser.Math.Linear(this.sprite.scaleY, 1, 0.2);
    this.sprite.setScale(Math.abs(sx - 1) < 0.01 ? 1 : sx, Math.abs(sy - 1) < 0.01 ? 1 : sy);
  }

  /** Chooses the animation pose from the player's current action (roll > attack > walk > idle). */
  private updateWalkAnimation(now: number, moving: boolean) {
    if (this.isRolling) {
      this.setPose("roll");
      return;
    }
    if (now < this.attackActiveUntil) {
      this.setPose("attack");
      return;
    }
    const frames = moving ? WALK_POSES : IDLE_POSES;
    const interval = moving ? WALK_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS;
    // Advance on the timer, or immediately when coming from a non-cycling pose (attack/roll/other set).
    if (now >= this.nextAnimAt || !frames.includes(this.currentPose)) {
      this.animIndex = (this.animIndex + 1) % frames.length;
      this.nextAnimAt = now + interval;
    }
    this.setPose(frames[this.animIndex % frames.length]);
  }

  private updateAttackWindow(now: number) {
    // Fire at most one hit per frame; combos space their hits by hitIntervalMs.
    if (this.attackHitsRemaining > 0 && now >= this.nextHitAt) {
      this.attackHitsRemaining--;
      this.nextHitAt = now + this.hitIntervalMs;
      // The hitbox is measured from the player's center out along the aim direction.
      this.onAttack?.(this.sprite.x, this.sprite.y, this.aimDir.x, this.aimDir.y);
      if (this.currentWeapon.hitShape === "projectile" && this.currentWeapon.recoil && !this.isRolling) {
        const durMs = 90;
        this.attackLungeUntil = now + durMs;
        this.attackLungeDir.set(-this.aimDir.x, -this.aimDir.y);
        this.attackLungeSpeed = (this.currentWeapon.recoil / durMs) * 1000;
        this.popScale(0.9, 1.12);
      }
    }
  }
}
