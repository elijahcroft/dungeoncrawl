import Phaser from "phaser";

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

export class Player {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Rectangle & { body: Phaser.Physics.Arcade.Body };
  hp = HP_MAX;
  hpMax = HP_MAX;
  stamina = STAMINA_MAX;
  staminaMax = STAMINA_MAX;

  facing = new Phaser.Math.Vector2(0, 1);

  private isRolling = false;
  private rollEndsAt = 0;
  private rollCooldownUntil = 0;
  private lastStaminaUseAt = 0;

  private attackCooldownUntil = 0;
  private attackActiveUntil = 0;
  private attackHitboxUsed = false;

  private invulnerableUntil = 0;

  private keys: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    roll: Phaser.Input.Keyboard.Key;
    attack: Phaser.Input.Keyboard.Key;
  };

  onAttack?: (originX: number, originY: number, dirX: number, dirY: number) => void;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.scene = scene;

    const rect = scene.add.rectangle(x, y, 28, 28, 0x4da6ff) as Phaser.GameObjects.Rectangle & {
      body: Phaser.Physics.Arcade.Body;
    };
    scene.physics.add.existing(rect);
    rect.body.setCollideWorldBounds(true);
    this.sprite = rect;

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

  private spendStamina(amount: number) {
    this.stamina = Math.max(0, this.stamina - amount);
    this.lastStaminaUseAt = this.scene.time.now;
  }

  takeDamage(amount: number) {
    if (this.isInvulnerable || !this.isAlive) return;
    this.hp = Math.max(0, this.hp - amount);
    this.invulnerableUntil = this.scene.time.now + HIT_IFRAME_MS;
    this.sprite.setFillStyle(0xff4d4d);
    this.scene.time.delayedCall(120, () => {
      if (this.isAlive) this.sprite.setFillStyle(0x4da6ff);
    });
  }

  update(_time: number, _delta: number) {
    const now = this.scene.time.now;
    const body = this.sprite.body;

    // Stamina regen after a short delay of no use
    if (now - this.lastStaminaUseAt > STAMINA_REGEN_DELAY_MS && this.stamina < this.staminaMax) {
      this.stamina = Math.min(this.staminaMax, this.stamina + (STAMINA_REGEN_PER_SEC * _delta) / 1000);
    }

    if (this.isRolling) {
      if (now >= this.rollEndsAt) {
        this.isRolling = false;
      }
      // maintain roll velocity, ignore new input during roll
      this.updateAttackWindow(now);
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
    body.setVelocity(dir.x * MOVE_SPEED, dir.y * MOVE_SPEED);

    // Roll input
    if (
      Phaser.Input.Keyboard.JustDown(this.keys.roll) &&
      now >= this.rollCooldownUntil &&
      this.stamina >= ROLL_STAMINA_COST
    ) {
      this.spendStamina(ROLL_STAMINA_COST);
      this.isRolling = true;
      this.rollEndsAt = now + ROLL_DURATION_MS;
      this.rollCooldownUntil = now + ROLL_DURATION_MS + ROLL_COOLDOWN_MS;
      this.invulnerableUntil = this.rollEndsAt;
      const rollDir = dir.lengthSq() > 0 ? dir : this.facing;
      body.setVelocity(rollDir.x * ROLL_SPEED, rollDir.y * ROLL_SPEED);
      this.sprite.setFillStyle(0xffffff);
      this.scene.time.delayedCall(ROLL_DURATION_MS, () => {
        if (this.isAlive) this.sprite.setFillStyle(0x4da6ff);
      });
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

  private updateAttackWindow(now: number) {
    if (now < this.attackActiveUntil && !this.attackHitboxUsed) {
      this.attackHitboxUsed = true;
      const originX = this.sprite.x + this.facing.x * ATTACK_RANGE * 0.5;
      const originY = this.sprite.y + this.facing.y * ATTACK_RANGE * 0.5;
      this.onAttack?.(originX, originY, this.facing.x, this.facing.y);
    }
  }

  static get attackRange() {
    return ATTACK_RANGE;
  }

  static get attackDamage() {
    return ATTACK_DAMAGE;
  }
}
