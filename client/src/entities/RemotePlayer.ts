import Phaser from "phaser";
import {
  ensurePlayerTexture,
  ensureShadowTexture,
  WALK_POSES,
  IDLE_POSES,
  type PlayerPoseName,
} from "../gfx/sprites";
import { WEAPONS, STARTER_WEAPON_ID, type WeaponDef } from "./weapons";

const LERP_FACTOR = 0.25;
const WALK_FRAME_INTERVAL_MS = 110;
const IDLE_FRAME_INTERVAL_MS = 620;

export class RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  private shadow: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private color: number;
  private trimColor: number;
  private cape: boolean;
  private weapon: WeaponDef = WEAPONS[STARTER_WEAPON_ID];
  private targetX: number;
  private targetY: number;
  private rolling = false;
  hp = 1;
  private animIndex = 0;
  private nextAnimAt = 0;
  private currentPose: PlayerPoseName = "idle0";

  constructor(scene: Phaser.Scene, x: number, y: number, color: number, name: string, trimColor: number, cape: boolean) {
    this.targetX = x;
    this.targetY = y;
    this.color = color;
    this.trimColor = trimColor;
    this.cape = cape;
    this.shadow = scene.add.image(x, y + 26, ensureShadowTexture(scene, 30)).setDepth(-0.5);
    const textureKey = ensurePlayerTexture(scene, color, "idle0", this.weapon.sprite, this.weapon.color, trimColor, cape);
    this.sprite = scene.add.sprite(x, y, textureKey);
    this.label = scene.add
      .text(x, y - 24, name, { fontSize: "11px", color: "#cccccc" })
      .setOrigin(0.5, 1);
  }

  setTarget(x: number, y: number, rolling: boolean, hp: number, facingX: number, weaponId: string) {
    this.targetX = x;
    this.targetY = y;
    this.rolling = rolling;
    this.hp = hp;
    if (weaponId !== this.weapon.id && WEAPONS[weaponId]) {
      this.weapon = WEAPONS[weaponId];
    }
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
    const moving = Math.hypot(this.targetX - this.sprite.x, this.targetY - this.sprite.y) > 1.5;
    this.updateAnimation(now, moving);
    this.sprite.x = Phaser.Math.Linear(this.sprite.x, this.targetX, LERP_FACTOR);
    this.sprite.y = Phaser.Math.Linear(this.sprite.y, this.targetY, LERP_FACTOR);
    this.shadow.setPosition(this.sprite.x, this.sprite.y + 26);
    this.label.setPosition(this.sprite.x, this.sprite.y - 24);
  }

  private updateAnimation(now: number, moving: boolean) {
    if (this.rolling) {
      this.setPose("roll");
      return;
    }
    const frames = moving ? WALK_POSES : IDLE_POSES;
    const interval = moving ? WALK_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS;
    if (now >= this.nextAnimAt || !frames.includes(this.currentPose)) {
      this.animIndex = (this.animIndex + 1) % frames.length;
      this.nextAnimAt = now + interval;
    }
    this.setPose(frames[this.animIndex % frames.length]);
  }

  private setPose(pose: PlayerPoseName) {
    if (pose === this.currentPose) return;
    this.currentPose = pose;
    this.sprite.setTexture(
      ensurePlayerTexture(this.sprite.scene, this.color, pose, this.weapon.sprite, this.weapon.color, this.trimColor, this.cape),
    );
  }

  destroy() {
    this.sprite.destroy();
    this.shadow.destroy();
    this.label.destroy();
  }
}
