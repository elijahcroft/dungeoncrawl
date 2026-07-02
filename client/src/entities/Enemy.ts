import Phaser from "phaser";
import { BossLogic, type BossDef, type BossHitEvent, type BossTarget } from "../../../shared/boss";
import { ensureEnemyTexture } from "../gfx/sprites";

export type { BossDef, BossAttackDef, BossPhaseDef } from "../../../shared/boss";

export interface EnemyOptions {
  id: string;
  isBoss: boolean;
}

/** Renders one enemy (grunt or boss) from either a local simulation (offline fallback) or synced server state. */
export class Enemy {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Sprite;
  id: string;
  isBoss: boolean;
  hpMax: number;
  hp: number;

  private def: BossDef;
  private logic: BossLogic | null;
  private baseColor: number;
  private hpBarBg: Phaser.GameObjects.Rectangle;
  private hpBarFg: Phaser.GameObjects.Rectangle;

  constructor(scene: Phaser.Scene, x: number, y: number, def: BossDef, options: EnemyOptions, standalone = false) {
    this.scene = scene;
    this.def = def;
    this.id = options.id;
    this.isBoss = options.isBoss;
    this.hpMax = def.hpMax;
    this.hp = def.hpMax;
    this.baseColor = Number(def.color);
    this.logic = standalone ? new BossLogic(def, x, y) : null;
    const textureKey = ensureEnemyTexture(scene, this.baseColor, 0, options.isBoss);
    this.sprite = scene.add.sprite(x, y, textureKey);

    const barWidth = options.isBoss ? 44 : 28;
    const barY = y - (options.isBoss ? 30 : 24);
    this.hpBarBg = scene.add.rectangle(x, barY, barWidth, 4, 0x000000, 0.6);
    this.hpBarFg = scene.add.rectangle(x - barWidth / 2, barY, barWidth, 4, 0xff5555, 1).setOrigin(0, 0.5);
  }

  get isAlive() {
    return this.hp > 0;
  }

  /** Offline single-player fallback: advance the local state machine and return any hit events. */
  update(now: number, deltaMs: number, target: BossTarget): BossHitEvent[] {
    if (!this.logic || !this.logic.isAlive) return [];
    const events = this.logic.update(now, deltaMs, [target]);
    this.hp = this.logic.hp;
    this.render(this.logic.x, this.logic.y, this.logic.state, this.logic.phase.color ?? this.def.color);
    return events;
  }

  takeDamage(amount: number) {
    if (!this.logic) return;
    this.logic.takeDamage(amount);
    this.hp = this.logic.hp;
    this.flashHit();
  }

  /** Multiplayer: render purely from server-synced state, no local simulation. */
  applyServerState(x: number, y: number, hp: number, hpMax: number, state: string, phaseColor: string) {
    this.hp = hp;
    this.hpMax = hpMax;
    this.render(x, y, state, phaseColor);
  }

  private render(x: number, y: number, state: string, phaseColor: string) {
    if (x < this.sprite.x) this.sprite.setFlipX(true);
    else if (x > this.sprite.x) this.sprite.setFlipX(false);
    this.sprite.setPosition(x, y);

    const tint = this.colorForState(state, phaseColor);
    if (tint === null) this.sprite.clearTint();
    else this.sprite.setTint(tint);

    const alive = this.hp > 0;
    this.sprite.setVisible(alive);
    this.hpBarBg.setVisible(alive);
    this.hpBarFg.setVisible(alive);
    if (alive) {
      const barWidth = this.isBoss ? 44 : 28;
      const barY = y - (this.isBoss ? 30 : 24);
      this.hpBarBg.setPosition(x, barY);
      this.hpBarFg.setPosition(x - barWidth / 2, barY);
      this.hpBarFg.width = barWidth * Phaser.Math.Clamp(this.hp / Math.max(1, this.hpMax), 0, 1);
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
  }
}
