import Phaser from "phaser";
import { BossLogic, type BossDef, type BossHitEvent, type BossTarget } from "../../../shared/boss";

export type { BossDef, BossAttackDef, BossPhaseDef } from "../../../shared/boss";

export class Boss {
  scene: Phaser.Scene;
  sprite: Phaser.GameObjects.Rectangle;
  hpMax: number;

  private def: BossDef;
  private logic: BossLogic;

  constructor(scene: Phaser.Scene, x: number, y: number, def: BossDef) {
    this.scene = scene;
    this.def = def;
    this.hpMax = def.hpMax;
    this.logic = new BossLogic(def, x, y);
    this.sprite = scene.add.rectangle(x, y, 64, 64, Number(def.color));
  }

  get hp() {
    return this.logic.hp;
  }

  get isAlive() {
    return this.logic.isAlive;
  }

  /** Single-player fallback: advance the local state machine against one target and return any hits. */
  update(now: number, deltaMs: number, target: BossTarget): BossHitEvent[] {
    if (!this.logic.isAlive) return [];
    const events = this.logic.update(now, deltaMs, [target]);
    this.render();
    return events;
  }

  takeDamage(amount: number) {
    this.logic.takeDamage(amount);
    this.flashHit();
    this.render();
  }

  /** Reconcile local HP with the server's authoritative value (multiplayer mode). */
  syncHp(hp: number) {
    this.logic.hp = Math.max(0, hp);
    if (this.logic.hp <= 0) {
      this.logic.state = "dead";
    } else if (this.logic.state === "dead") {
      // Server reset the boss (victory/wipe reset) — revive locally too.
      this.logic.state = "idle";
    }
  }

  /** Multiplayer: render purely from server-synced boss state, no local simulation. */
  applyServerState(x: number, y: number, state: string, phaseColor: string) {
    this.sprite.setPosition(x, y);
    this.sprite.setFillStyle(this.colorForState(state, phaseColor));
  }

  private render() {
    this.sprite.setPosition(this.logic.x, this.logic.y);
    this.sprite.setFillStyle(this.colorForState(this.logic.state, this.logic.phase.color ?? this.def.color));
  }

  private flashHit() {
    this.sprite.setFillStyle(0xffffff);
    this.scene.time.delayedCall(80, () => {
      if (this.logic.isAlive) this.render();
    });
  }

  private colorForState(state: string, phaseColor: string) {
    switch (state) {
      case "telegraph":
        return 0xffcc33;
      case "attack":
        return 0xff3333;
      case "dead":
        return 0x333333;
      default:
        return Number(phaseColor ?? this.def.color);
    }
  }
}
