import Phaser from "phaser";

const HP_MAX = 150;
const AGGRO_RANGE = 220;
const ATTACK_RANGE = 100;
const TELEGRAPH_MS = 700;
const ATTACK_ACTIVE_MS = 200;
const RECOVER_MS = 600;
const ATTACK_COOLDOWN_MS = 1400;
const ATTACK_DAMAGE = 15;

type BossState = "idle" | "telegraph" | "attack" | "recover" | "dead";

export class DummyBoss {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Rectangle & { body: Phaser.Physics.Arcade.Body };
  hp = HP_MAX;
  hpMax = HP_MAX;

  private state: BossState = "idle";
  private stateEndsAt = 0;
  private attackHitboxUsed = false;

  onAttack?: (originX: number, originY: number, radius: number) => void;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.scene = scene;
    const rect = scene.add.rectangle(x, y, 64, 64, 0xaa3333) as Phaser.GameObjects.Rectangle & {
      body: Phaser.Physics.Arcade.Body;
    };
    scene.physics.add.existing(rect);
    rect.body.setImmovable(true);
    rect.body.setCollideWorldBounds(true);
    this.sprite = rect;
  }

  get isAlive() {
    return this.state !== "dead";
  }

  takeDamage(amount: number) {
    if (!this.isAlive) return;
    this.hp = Math.max(0, this.hp - amount);
    this.sprite.setFillStyle(0xffffff);
    this.scene.time.delayedCall(80, () => {
      if (this.isAlive) this.sprite.setFillStyle(this.colorForState());
    });
    if (this.hp <= 0) {
      this.state = "dead";
      this.sprite.setFillStyle(0x333333);
    }
  }

  /** Reconcile local HP with the server's authoritative value (multiplayer mode). */
  syncHp(hp: number) {
    if (!this.isAlive) return;
    this.hp = Math.max(0, hp);
    if (this.hp <= 0) {
      this.state = "dead";
      this.sprite.setFillStyle(0x333333);
    }
  }

  private colorForState() {
    switch (this.state) {
      case "telegraph":
        return 0xffcc33;
      case "attack":
        return 0xff3333;
      default:
        return 0xaa3333;
    }
  }

  private setState(state: BossState, durationMs: number) {
    this.state = state;
    this.stateEndsAt = this.scene.time.now + durationMs;
    this.sprite.setFillStyle(this.colorForState());
  }

  update(playerX: number, playerY: number) {
    if (!this.isAlive) return;
    const now = this.scene.time.now;
    const dist = Phaser.Math.Distance.Between(this.sprite.x, this.sprite.y, playerX, playerY);

    switch (this.state) {
      case "idle":
        if (dist <= AGGRO_RANGE && now >= this.stateEndsAt) {
          this.setState("telegraph", TELEGRAPH_MS);
        }
        break;

      case "telegraph":
        if (now >= this.stateEndsAt) {
          this.attackHitboxUsed = false;
          this.setState("attack", ATTACK_ACTIVE_MS);
        }
        break;

      case "attack":
        if (!this.attackHitboxUsed && dist <= ATTACK_RANGE) {
          this.attackHitboxUsed = true;
          this.onAttack?.(this.sprite.x, this.sprite.y, ATTACK_RANGE);
        }
        if (now >= this.stateEndsAt) {
          this.setState("recover", RECOVER_MS);
        }
        break;

      case "recover":
        if (now >= this.stateEndsAt) {
          this.state = "idle";
          this.stateEndsAt = now + ATTACK_COOLDOWN_MS;
          this.sprite.setFillStyle(this.colorForState());
        }
        break;
    }
  }

  static get attackDamage() {
    return ATTACK_DAMAGE;
  }
}
