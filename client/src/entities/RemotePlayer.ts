import Phaser from "phaser";

const LERP_FACTOR = 0.25;

export class RemotePlayer {
  sprite: Phaser.GameObjects.Rectangle;
  private targetX: number;
  private targetY: number;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.targetX = x;
    this.targetY = y;
    this.sprite = scene.add.rectangle(x, y, 28, 28, 0x4dff88);
  }

  setTarget(x: number, y: number, rolling: boolean, hp: number) {
    this.targetX = x;
    this.targetY = y;
    this.sprite.setFillStyle(hp <= 0 ? 0x555555 : rolling ? 0xffffff : 0x4dff88);
  }

  update() {
    this.sprite.x = Phaser.Math.Linear(this.sprite.x, this.targetX, LERP_FACTOR);
    this.sprite.y = Phaser.Math.Linear(this.sprite.y, this.targetY, LERP_FACTOR);
  }

  destroy() {
    this.sprite.destroy();
  }
}
