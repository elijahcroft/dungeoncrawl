import Phaser from "phaser";
import { ensurePlayerTexture } from "../gfx/sprites";

const LERP_FACTOR = 0.25;
const WALK_FRAME_INTERVAL_MS = 140;

export class RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  private label: Phaser.GameObjects.Text;
  private color: number;
  private targetX: number;
  private targetY: number;
  private walkFrame: 0 | 1 = 0;
  private nextWalkFrameAt = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, color: number, name: string) {
    this.targetX = x;
    this.targetY = y;
    this.color = color;
    const textureKey = ensurePlayerTexture(scene, color, 0);
    this.sprite = scene.add.sprite(x, y, textureKey);
    this.label = scene.add
      .text(x, y - 24, name, { fontSize: "11px", color: "#cccccc" })
      .setOrigin(0.5, 1);
  }

  setTarget(x: number, y: number, rolling: boolean, hp: number, facingX: number) {
    this.targetX = x;
    this.targetY = y;
    if (Math.abs(facingX) > 0.1) this.sprite.setFlipX(facingX < 0);
    if (hp <= 0) {
      this.sprite.setAlpha(0.35);
      this.sprite.clearTint();
    } else {
      this.sprite.setAlpha(1);
      if (rolling) this.sprite.setTint(0xffffff);
      else this.sprite.clearTint();
    }
  }

  update() {
    const now = Date.now();
    const moved = Math.hypot(this.targetX - this.sprite.x, this.targetY - this.sprite.y) > 1;
    if (moved && now >= this.nextWalkFrameAt) {
      this.walkFrame = this.walkFrame === 0 ? 1 : 0;
      this.nextWalkFrameAt = now + WALK_FRAME_INTERVAL_MS;
      this.sprite.setTexture(ensurePlayerTexture(this.sprite.scene, this.color, this.walkFrame));
    } else if (!moved) {
      this.sprite.setTexture(ensurePlayerTexture(this.sprite.scene, this.color, 0));
    }
    this.sprite.x = Phaser.Math.Linear(this.sprite.x, this.targetX, LERP_FACTOR);
    this.sprite.y = Phaser.Math.Linear(this.sprite.y, this.targetY, LERP_FACTOR);
    this.label.setPosition(this.sprite.x, this.sprite.y - 24);
  }

  destroy() {
    this.sprite.destroy();
    this.label.destroy();
  }
}
