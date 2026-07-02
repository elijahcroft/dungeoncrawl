import Phaser from "phaser";
import { ensurePlayerTexture } from "../gfx/sprites";

const MOVE_SPEED = 220;
const ROLL_SPEED = 520;
const ROLL_DURATION_MS = 220;
const ROLL_COOLDOWN_MS = 500;
const ROLL_STAMINA_COST = 25;

const ATTACK_STAMINA_COST = 15;
const ATTACK_COOLDOWN_MS = 400;
const ATTACK_ACTIVE_MS = 150;
const ATTACK_RANGE = 60;
const ATTACK_DAMAGE = 20;

const STAMINA_MAX = 100;
const STAMINA_REGEN_PER_SEC = 35;
const STAMINA_REGEN_DELAY_MS = 500;

const HP_MAX = 100;
const HIT_IFRAME_MS = 500;
const WALK_FRAME_INTERVAL_MS = 140;

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

  private color: number;
  private moveSpeed: number;
  private attackDamage: number;

  private isRolling = false;
  private rollEndsAt = 0;
  private rollCooldownUntil = 0;
  private lastStaminaUseAt = 0;

  private attackCooldownUntil = 0;
  private attackActiveUntil = 0;
  private attackHitboxUsed = false;

  private invulnerableUntil = 0;
  private tintedUntil = 0;
  private walkFrame: 0 | 1 = 0;
  private nextWalkFrameAt = 0;

  private keys: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    roll: Phaser.Input.Keyboard.Key;
    attack: Phaser.Input.Keyboard.Key;
  };

  onAttack?: (originX: number, originY: number, dirX: number, dirY: number) => void;
  onRoll?: () => void;

  constructor(scene: Phaser.Scene, x: number, y: number, options: PlayerOptions = {}) {
    this.scene = scene;
    this.color = options.color ?? 0x4da6ff;
    this.hpMax = options.hpMax ?? HP_MAX;
    this.hp = this.hpMax;
    this.moveSpeed = MOVE_SPEED * (1 + (options.speedPct ?? 0) / 100);
    this.attackDamage = ATTACK_DAMAGE + (options.bonusDamage ?? 0);

    const textureKey = ensurePlayerTexture(scene, this.color, 0);
    const sprite = scene.add.sprite(x, y, textureKey) as Phaser.GameObjects.Sprite & {
      body: Phaser.Physics.Arcade.Body;
    };
    scene.physics.add.existing(sprite);
    sprite.body.setSize(20, 22);
    sprite.body.setOffset(4, 12);
    sprite.body.setCollideWorldBounds(true);
    this.sprite = sprite;

    const kb = scene.input.keyboard!;
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      roll: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      attack: kb.addKey(Phaser.Input.Keyboard.KeyCodes.J),
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

  static get attackRange() {
    return ATTACK_RANGE;
  }

  get damage() {
    return this.attackDamage;
  }

  /** Reconciles live stat bonuses (class + picked-up items) from the server. */
  applyBonuses(hpMax: number, bonusDamage: number, bonusSpeedPct: number) {
    this.hpMax = hpMax;
    this.moveSpeed = MOVE_SPEED * (1 + bonusSpeedPct / 100);
    this.attackDamage = ATTACK_DAMAGE + bonusDamage;
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
    this.hp = Math.max(0, this.hp - amount);
    this.invulnerableUntil = this.scene.time.now + HIT_IFRAME_MS;
    this.flashTint(0xff4d4d, 120);
  }

  /** Reconcile local HP with the server's authoritative value (multiplayer mode). */
  syncHp(hp: number, hpMax?: number) {
    const nextHp = Math.max(0, hp);
    const wasAlive = this.hp > 0;
    const tookDamage = nextHp < this.hp;
    this.hp = nextHp;
    if (hpMax !== undefined) this.hpMax = hpMax;

    if (nextHp <= 0) {
      this.sprite.setAlpha(0.35);
      return;
    }
    this.sprite.setAlpha(1);
    if (!wasAlive) return;
    if (tookDamage) this.flashTint(0xff4d4d, 120);
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
      }
      // maintain roll velocity, ignore new input during roll
      this.updateAttackWindow(now);
      this.updateFacingVisual();
      return;
    }

    // Movement input
    const dir = new Phaser.Math.Vector2(0, 0);
    if (this.keys.left.isDown) dir.x -= 1;
    if (this.keys.right.isDown) dir.x += 1;
    if (this.keys.up.isDown) dir.y -= 1;
    if (this.keys.down.isDown) dir.y += 1;

    if (dir.lengthSq() > 0) {
      dir.normalize();
      this.facing.copy(dir);
    }
    body.setVelocity(dir.x * this.moveSpeed, dir.y * this.moveSpeed);
    this.updateWalkAnimation(now, dir.lengthSq() > 0);
    this.updateFacingVisual();

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
      const rollDir = dir.lengthSq() > 0 ? dir : this.facing;
      body.setVelocity(rollDir.x * ROLL_SPEED, rollDir.y * ROLL_SPEED);
      this.flashTint(0xffffff, ROLL_DURATION_MS);
    }

    // Attack input
    if (
      Phaser.Input.Keyboard.JustDown(this.keys.attack) &&
      now >= this.attackCooldownUntil &&
      this.stamina >= ATTACK_STAMINA_COST
    ) {
      this.spendStamina(ATTACK_STAMINA_COST);
      this.attackCooldownUntil = now + ATTACK_COOLDOWN_MS;
      this.attackActiveUntil = now + ATTACK_ACTIVE_MS;
      this.attackHitboxUsed = false;
    }

    this.updateAttackWindow(now);
  }

  private updateFacingVisual() {
    if (Math.abs(this.facing.x) > 0.1) {
      this.sprite.setFlipX(this.facing.x < 0);
    }
  }

  private updateWalkAnimation(now: number, moving: boolean) {
    if (!moving) {
      this.walkFrame = 0;
      this.sprite.setTexture(ensurePlayerTexture(this.scene, this.color, 0));
      return;
    }
    if (now >= this.nextWalkFrameAt) {
      this.walkFrame = this.walkFrame === 0 ? 1 : 0;
      this.nextWalkFrameAt = now + WALK_FRAME_INTERVAL_MS;
      this.sprite.setTexture(ensurePlayerTexture(this.scene, this.color, this.walkFrame));
    }
  }

  private updateAttackWindow(now: number) {
    if (now < this.attackActiveUntil && !this.attackHitboxUsed) {
      this.attackHitboxUsed = true;
      const originX = this.sprite.x + this.facing.x * ATTACK_RANGE * 0.5;
      const originY = this.sprite.y + this.facing.y * ATTACK_RANGE * 0.5;
      this.onAttack?.(originX, originY, this.facing.x, this.facing.y);
    }
  }
}
