import Phaser from "phaser";
import type { VisualRecipe } from "../../../shared/boss";
import type { PlayerAccessory } from "../../../shared/classes";

/**
 * Procedurally-drawn placeholder sprites (no external art assets in this repo).
 * Each character gets a 2-frame walk cycle so movement reads better than a
 * static rectangle. Textures are cached per (kind, color, frame) so repeated
 * calls for the same color are cheap.
 */

const generatedKeys = new Set<string>();

function darken(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) - amount);
  const g = Math.max(0, ((color >> 8) & 0xff) - amount);
  const b = Math.max(0, (color & 0xff) - amount);
  return (r << 16) | (g << 8) | b;
}

function lighten(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + amount);
  const g = Math.min(255, ((color >> 8) & 0xff) + amount);
  const b = Math.min(255, (color & 0xff) + amount);
  return (r << 16) | (g << 8) | b;
}

// The WeaponSprite union lives with the shared weapon table now; re-exported so
// existing `from "../gfx/sprites"` type imports keep working.
import type { WeaponSprite } from "../../../shared/weapons";
export type { WeaponSprite };

/** Player sprite canvas. Bigger than the enemy grunts so the hero reads as the focal point. */
export const PLAYER_W = 52;
export const PLAYER_H = 64;

const HANDLE_COLOR = 0x6b4a2b;

/** Draws a weapon gripped in the hand at (hx, hy), pointing up (-y). Faces +x; the sprite's flipX mirrors it. */
function drawHeldWeapon(g: Phaser.GameObjects.Graphics, sprite: WeaponSprite, hx: number, hy: number, metal: number) {
  switch (sprite) {
    case "none":
      break; // ranged weapons draw as a separate aim-tracking overlay, not baked in
    case "dagger":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1.5, hy - 2, 3, 7);
      g.fillStyle(darken(metal, 40), 1);
      g.fillRect(hx - 4, hy - 3, 8, 2);
      g.fillStyle(metal, 1);
      g.fillRect(hx - 2, hy - 16, 4, 14);
      g.fillTriangle(hx - 2, hy - 16, hx + 2, hy - 16, hx, hy - 22);
      break;
    case "sword":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1.5, hy - 2, 3, 8);
      g.fillStyle(darken(metal, 40), 1);
      g.fillRect(hx - 6, hy - 3, 12, 3);
      g.fillStyle(metal, 1);
      g.fillRect(hx - 2.5, hy - 30, 5, 28);
      g.fillTriangle(hx - 2.5, hy - 30, hx + 2.5, hy - 30, hx, hy - 35);
      g.fillStyle(lighten(metal, 45), 1);
      g.fillRect(hx - 0.5, hy - 29, 1.5, 26);
      break;
    case "spear":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1.5, hy - 30, 3, 38);
      g.fillStyle(metal, 1);
      g.fillTriangle(hx - 4, hy - 30, hx + 4, hy - 30, hx, hy - 40);
      g.fillStyle(darken(metal, 30), 1);
      g.fillRect(hx - 2, hy - 30, 4, 4);
      break;
    case "axe":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1.5, hy - 28, 3, 34);
      g.fillStyle(metal, 1);
      g.fillTriangle(hx + 1, hy - 28, hx + 13, hy - 24, hx + 1, hy - 14);
      g.fillRect(hx - 2, hy - 28, 4, 6);
      g.fillStyle(lighten(metal, 30), 1);
      g.fillTriangle(hx + 1, hy - 26, hx + 9, hy - 23, hx + 1, hy - 17);
      break;
    case "mace":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1.5, hy - 22, 3, 28);
      g.fillStyle(metal, 1);
      g.fillCircle(hx, hy - 25, 6);
      g.fillStyle(darken(metal, 25), 1);
      g.fillTriangle(hx - 9, hy - 25, hx - 3, hy - 27, hx - 3, hy - 23);
      g.fillTriangle(hx + 9, hy - 25, hx + 3, hy - 27, hx + 3, hy - 23);
      g.fillTriangle(hx, hy - 34, hx - 3, hy - 27, hx + 3, hy - 27);
      break;
    case "rapier":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1, hy - 2, 2, 7);
      g.fillStyle(darken(metal, 40), 1);
      g.fillEllipse(hx, hy - 3, 8, 5); // swept cup guard
      g.fillStyle(metal, 1);
      g.fillRect(hx - 1, hy - 40, 2, 37); // long thin blade
      g.fillTriangle(hx - 1, hy - 40, hx + 1, hy - 40, hx, hy - 44);
      break;
    case "greatsword":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 2, hy - 3, 4, 11);
      g.fillStyle(darken(metal, 40), 1);
      g.fillRect(hx - 9, hy - 4, 18, 3); // wide crossguard
      g.fillStyle(metal, 1);
      g.fillRect(hx - 4, hy - 44, 8, 40); // broad blade
      g.fillTriangle(hx - 4, hy - 44, hx + 4, hy - 44, hx, hy - 52);
      g.fillStyle(lighten(metal, 45), 1);
      g.fillRect(hx - 0.5, hy - 43, 1.5, 38); // fuller
      break;
    case "warhammer":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 2, hy - 30, 4, 38);
      g.fillStyle(metal, 1);
      g.fillRect(hx - 9, hy - 38, 18, 12); // blocky head
      g.fillStyle(lighten(metal, 25), 1);
      g.fillRect(hx - 9, hy - 38, 18, 3);
      g.fillStyle(darken(metal, 30), 1);
      g.fillRect(hx - 9, hy - 29, 18, 3);
      break;
    case "katana":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 1.5, hy - 2, 3, 9);
      g.fillStyle(darken(metal, 40), 1);
      g.fillRect(hx - 4, hy - 3, 8, 2); // tsuba
      g.fillStyle(metal, 1);
      g.fillRect(hx - 1.5, hy - 30, 4, 28); // single-edged blade
      g.fillTriangle(hx - 1.5, hy - 30, hx + 2.5, hy - 30, hx + 3, hy - 36); // angled tip
      g.fillStyle(lighten(metal, 40), 1);
      g.fillRect(hx + 1, hy - 29, 1, 26); // edge highlight
      break;
    case "crossbow":
      g.fillStyle(HANDLE_COLOR, 1);
      g.fillRect(hx - 2, hy - 4, 4, 26); // stock
      g.fillStyle(darken(HANDLE_COLOR, 22), 1);
      g.fillRect(hx - 4, hy + 12, 8, 5); // shoulder rest
      g.fillStyle(metal, 1);
      g.fillRect(hx - 2, hy - 28, 4, 27); // bolt rail
      g.fillStyle(lighten(metal, 48), 1);
      g.fillTriangle(hx - 2, hy - 28, hx + 2, hy - 28, hx, hy - 36); // loaded bolt
      g.fillStyle(darken(metal, 35), 1);
      g.fillRoundedRect(hx - 15, hy - 20, 30, 5, 2); // cross limb
      g.lineStyle(1.4, 0xf4e4b0, 1);
      g.beginPath();
      g.moveTo(hx - 15, hy - 20);
      g.lineTo(hx, hy - 13);
      g.lineTo(hx + 15, hy - 20);
      g.strokePath(); // taut string
      break;
  }
}

/** Named animation poses for the player sprite. Each maps to one cached texture. */
export type PlayerPoseName =
  | "idle0"
  | "idle1"
  | "walk0"
  | "walk1"
  | "walk2"
  | "walk3"
  | "attack"
  | "roll";

interface Pose {
  legL: number; // left-leg vertical stride offset
  legR: number; // right-leg vertical stride offset
  bob: number; // whole-body vertical bob
  lean: number; // forward (+x) torso/head lean
  armSwing: number; // weapon-arm vertical swing
  weaponAngle: number; // weapon rotation about the hand (rad; 0 = upright)
  crouch: number; // shortens legs / lowers body (roll tuck)
}

const POSES: Record<PlayerPoseName, Pose> = {
  idle0: { legL: 0, legR: 0, bob: 0, lean: 0, armSwing: 0, weaponAngle: 0.04, crouch: 0 },
  idle1: { legL: 0, legR: 0, bob: -1, lean: 0, armSwing: -0.6, weaponAngle: 0.08, crouch: 0 },
  walk0: { legL: 4, legR: -4, bob: 0, lean: 1.5, armSwing: -2, weaponAngle: 0.18, crouch: 0 },
  walk1: { legL: 0, legR: 0, bob: -2, lean: 1.5, armSwing: 0, weaponAngle: 0.02, crouch: 0 },
  walk2: { legL: -4, legR: 4, bob: 0, lean: 1.5, armSwing: 2, weaponAngle: -0.14, crouch: 0 },
  walk3: { legL: 0, legR: 0, bob: -2, lean: 1.5, armSwing: 0, weaponAngle: 0.02, crouch: 0 },
  attack: { legL: 3, legR: -2, bob: 0, lean: 5, armSwing: -1, weaponAngle: -1.15, crouch: 0 },
  roll: { legL: 0, legR: 0, bob: 4, lean: 7, armSwing: 1, weaponAngle: 0.7, crouch: 6 },
};

/** The four-frame walk loop, in order. */
export const WALK_POSES: PlayerPoseName[] = ["walk0", "walk1", "walk2", "walk3"];
export const IDLE_POSES: PlayerPoseName[] = ["idle0", "idle1"];

/** Draws a class's head silhouette on top of the helmet — the main at-a-glance class read. */
function drawClassAccessory(
  g: Phaser.GameObjects.Graphics,
  accessory: PlayerAccessory,
  hx: number,
  headY: number,
  headR: number,
  bodyColor: number,
  trimColor: number,
  outlineColor: number,
) {
  switch (accessory) {
    case "none":
      break;
    case "hood":
      g.fillStyle(darken(bodyColor, 30), 1);
      g.fillRoundedRect(hx - headR - 2, headY - headR - 4, headR * 2 + 4, headR + 8, 6);
      g.lineStyle(1.2, outlineColor, 1);
      g.strokeRoundedRect(hx - headR - 2, headY - headR - 4, headR * 2 + 4, headR + 8, 6);
      break;
    case "mask":
      g.fillStyle(darken(bodyColor, 45), 1);
      g.fillRect(hx - headR + 1, headY - 1, headR * 2 - 2, 5);
      break;
    case "spikes":
      g.fillStyle(trimColor, 1);
      for (let i = -1; i <= 1; i++) {
        g.fillTriangle(hx + i * 5 - 2, headY - headR + 1, hx + i * 5 + 2, headY - headR + 1, hx + i * 5, headY - headR - 7);
      }
      break;
    case "hat":
      g.fillStyle(bodyColor, 1);
      g.fillTriangle(hx - headR - 1, headY - headR - 1, hx + headR + 1, headY - headR - 1, hx, headY - headR - 20);
      g.fillStyle(trimColor, 1);
      g.fillRect(hx - headR - 2, headY - headR - 2, headR * 2 + 4, 3);
      break;
    case "halo":
      g.lineStyle(2, trimColor, 0.9);
      g.strokeEllipse(hx, headY - headR - 7, headR * 1.6, 4);
      break;
  }
}

function drawPlayer(
  g: Phaser.GameObjects.Graphics,
  color: number,
  pose: Pose,
  weaponSprite: WeaponSprite,
  weaponColor: number,
  trimColor: number,
  cape: boolean,
  accessory: PlayerAccessory,
  legStyle: "boots" | "robe",
  bulk: number,
) {
  const bodyColor = color;
  const legColor = darken(color, 60);
  const skinColor = 0xe0b58c;
  // A near-black outline drawn on the silhouette makes the hero pop off the dark
  // dungeon floor — the single biggest readability win for a small on-screen sprite.
  const outlineColor = darken(color, 110);

  const cx = PLAYER_W / 2; // 26
  const by = pose.bob;
  const lean = pose.lean;
  const headY = 22 + by;
  const headR = 8;
  const torsoTop = 29 + by;
  const torsoW = 22 * bulk;
  const torsoH = 21;
  const torsoBottom = torsoTop + torsoH;
  const legLen = 11 - pose.crouch;

  // cape (behind everything), sways opposite the lean — not every hero wears one
  if (cape) {
    g.fillStyle(darken(bodyColor, 72), 1);
    g.fillTriangle(cx - 7 - lean * 0.4, torsoTop + 1, cx + 7 - lean * 0.4, torsoTop + 1, cx - lean * 1.4, torsoBottom + 9 + pose.crouch);
  }

  if (legStyle === "robe") {
    // A single tapered skirt instead of two legs/boots — casters and support read as robed.
    const hemSway = (pose.legL - pose.legR) * 0.2;
    const skirtTop = torsoBottom - 2;
    const skirtBottom = skirtTop + legLen + 5;
    g.lineStyle(1, outlineColor, 1);
    g.fillStyle(bodyColor, 1);
    g.beginPath();
    g.moveTo(cx - torsoW / 2 + 2 + lean * 0.4, skirtTop);
    g.lineTo(cx + torsoW / 2 - 2 + lean * 0.4, skirtTop);
    g.lineTo(cx + torsoW / 2 + 3 + hemSway + lean * 0.4, skirtBottom);
    g.lineTo(cx - torsoW / 2 - 3 + hemSway + lean * 0.4, skirtBottom);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.fillStyle(trimColor, 1);
    g.fillRect(cx - torsoW / 2 - 3 + hemSway + lean * 0.4, skirtBottom - 3, torsoW + 6, 3); // hem trim
  } else {
    // legs + boots (outlined to match the torso/head silhouette)
    const legTopL = torsoBottom - 2 + pose.legL;
    const legTopR = torsoBottom - 2 + pose.legR;
    g.lineStyle(1, outlineColor, 1);
    g.fillStyle(legColor, 1);
    g.fillRect(cx - 8, legTopL, 6, legLen);
    g.strokeRect(cx - 8, legTopL, 6, legLen);
    g.fillRect(cx + 2, legTopR, 6, legLen);
    g.strokeRect(cx + 2, legTopR, 6, legLen);
    g.fillStyle(darken(legColor, 35), 1);
    g.fillRect(cx - 9, legTopL + legLen - 3, 8, 3);
    g.strokeRect(cx - 9, legTopL + legLen - 3, 8, 3);
    g.fillRect(cx + 2, legTopR + legLen - 3, 8, 3);
    g.strokeRect(cx + 2, legTopR + legLen - 3, 8, 3);
  }

  // back arm (behind torso)
  g.fillStyle(darken(bodyColor, 45), 1);
  g.fillRoundedRect(cx - torsoW / 2 - 3 + lean * 0.3, torsoTop + 3, 5, 14, 2);

  // weapon — translate to the hand, rotate, then draw upright art at the origin
  const handX = cx + torsoW / 2 + 1 + lean;
  const handY = torsoTop + 13 + pose.armSwing;
  g.save();
  g.translateCanvas(handX, handY);
  g.rotateCanvas(pose.weaponAngle);
  drawHeldWeapon(g, weaponSprite, 0, 0, weaponColor);
  g.restore();

  // torso (leans forward with the pose)
  const tx = cx - torsoW / 2 + lean * 0.4;
  g.fillStyle(bodyColor, 1);
  g.fillRoundedRect(tx, torsoTop, torsoW, torsoH, 5);
  g.lineStyle(1.5, outlineColor, 1);
  g.strokeRoundedRect(tx, torsoTop, torsoW, torsoH, 5); // silhouette outline
  g.fillStyle(lighten(bodyColor, 25), 1);
  g.fillRoundedRect(tx + 2, torsoTop + 2, torsoW - 4, 6, 3); // top highlight
  g.fillStyle(lighten(bodyColor, 55), 0.5);
  g.fillRect(tx + torsoW - 3, torsoTop + 3, 1.5, torsoH - 8); // +x rim light
  // chest emblem (diamond) — metal trim color for a two-tone armored look
  const ex = cx + lean * 0.4;
  g.fillStyle(trimColor, 1);
  g.fillTriangle(ex, torsoTop + 8, ex - 3, torsoTop + 12, ex + 3, torsoTop + 12);
  g.fillTriangle(ex - 3, torsoTop + 12, ex + 3, torsoTop + 12, ex, torsoTop + 16);
  // belt + trim buckle
  g.fillStyle(darken(bodyColor, 50), 1);
  g.fillRect(tx, torsoBottom - 5, torsoW, 4);
  g.fillStyle(trimColor, 1);
  g.fillRect(ex - 2, torsoBottom - 5, 4, 4);
  // pauldrons (body-toned dome with a trim stud)
  g.fillStyle(darken(bodyColor, 18), 1);
  g.fillCircle(tx + 3, torsoTop + 3, 4);
  g.fillCircle(tx + torsoW - 3, torsoTop + 3, 4);
  g.fillStyle(trimColor, 1);
  g.fillCircle(tx + 3, torsoTop + 3, 1.5);
  g.fillCircle(tx + torsoW - 3, torsoTop + 3, 1.5);

  // front arm + hand (overlaps the grip)
  g.fillStyle(bodyColor, 1);
  g.fillRoundedRect(cx + torsoW / 2 - 4 + lean, torsoTop + 4 + pose.armSwing * 0.5, 5, 12, 2);
  g.fillStyle(skinColor, 1);
  g.fillCircle(handX, handY, 2.8);

  // head + helmet
  const hx = cx + lean;
  g.fillStyle(skinColor, 1);
  g.fillCircle(hx, headY, headR);
  g.lineStyle(1.5, outlineColor, 1);
  g.strokeCircle(hx, headY, headR); // head outline
  g.fillStyle(darken(bodyColor, 20), 1);
  g.fillRoundedRect(hx - headR, headY - headR - 2, headR * 2, headR, 4); // helmet cap
  g.lineStyle(1.5, outlineColor, 1);
  g.strokeRoundedRect(hx - headR, headY - headR - 2, headR * 2, headR, 4); // helmet outline
  g.fillStyle(trimColor, 1);
  g.fillRect(hx - 1, headY - headR - 6, 2, 5); // crest
  g.fillStyle(0x111417, 1);
  g.fillRect(hx - headR + 2, headY - 1, headR * 2 - 4, 3); // visor slit
  // eye glint (facing indicator, drawn toward +x; flipped via sprite.flipX)
  g.fillStyle(0xffe9b0, 1);
  g.fillCircle(hx + headR * 0.45, headY + 0.4, 1.5);

  drawClassAccessory(g, accessory, hx, headY, headR, bodyColor, trimColor, outlineColor);
}

/**
 * Canvas for a weapon rendered as a free-rotating overlay that tracks the aim
 * direction (ranged weapons). The art is drawn pointing +x with the grip at
 * (AIMED_WEAPON_GRIP_X, AIMED_WEAPON_GRIP_Y). Set the sprite origin to the grip
 * and rotate by the aim angle so the weapon pivots in the hand. GRIP_Y sits at
 * the vertical center so a flipY (for aiming left) keeps the grip anchored.
 */
export const AIMED_WEAPON_W = 76;
export const AIMED_WEAPON_H = 44;
export const AIMED_WEAPON_GRIP_X = 24;
export const AIMED_WEAPON_GRIP_Y = AIMED_WEAPON_H / 2;

/** The held-weapon art on its own canvas, pointing +x, for aim-tracking overlays. Cached and reused. */
export function ensureAimedWeaponTexture(scene: Phaser.Scene, sprite: WeaponSprite, color: number): string {
  const key = `aimw_${sprite}_${color.toString(16)}`;
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  // drawHeldWeapon draws pointing up (-y); rotate +90° so the blade points +x.
  g.translateCanvas(AIMED_WEAPON_GRIP_X, AIMED_WEAPON_GRIP_Y);
  g.rotateCanvas(Math.PI / 2);
  drawHeldWeapon(g, sprite, 0, 0, color);
  g.generateTexture(key, AIMED_WEAPON_W, AIMED_WEAPON_H);
  g.destroy();
  return key;
}

/** A weapon lying on the floor as a pickup: the held-weapon art on a small canvas with a drop shadow. */
export function ensureWeaponPickupTexture(scene: Phaser.Scene, sprite: WeaponSprite, color: number): string {
  const key = `wpick_${sprite}_${color.toString(16)}`;
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const w = 44;
  const h = 52;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x000000, 0.25);
  g.fillEllipse(w / 2, h - 5, 24, 8);
  drawHeldWeapon(g, sprite, w / 2, h - 10, color);
  g.generateTexture(key, w, h);
  g.destroy();
  return key;
}

export function ensurePlayerTexture(
  scene: Phaser.Scene,
  colorHex: number,
  poseName: PlayerPoseName = "idle0",
  weaponSprite: WeaponSprite = "sword",
  weaponColor = 0xcfd6e0,
  trimColor = 0xe2e8f2,
  cape = true,
  accessory: PlayerAccessory = "none",
  legStyle: "boots" | "robe" = "boots",
  bulk = 1,
): string {
  const key = `char_p_${colorHex.toString(16)}_${poseName}_${weaponSprite}_${weaponColor.toString(16)}_${trimColor.toString(16)}_${cape ? 1 : 0}_${accessory}_${legStyle}_${bulk}`;
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  drawPlayer(g, colorHex, POSES[poseName], weaponSprite, weaponColor, trimColor, cape, accessory, legStyle, bulk);
  g.generateTexture(key, PLAYER_W, PLAYER_H);
  g.destroy();
  return key;
}

/** A 64px seamless stone-flagstone floor tile for the dungeon background. Cached and reused. */
export function ensureFloorTexture(scene: Phaser.Scene): string {
  const key = "floor_stone";
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const size = 64;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x1d1d24, 1);
  g.fillRect(0, 0, size, size);
  // Speckle for stone grain.
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(Math.random() * size);
    const y = Math.floor(Math.random() * size);
    g.fillStyle(Math.random() > 0.5 ? 0x25252e : 0x17171d, 0.5);
    g.fillRect(x, y, 2, 2);
  }
  // Grout lines dividing four flagstones, with a faint top-edge highlight per stone.
  g.fillStyle(0x131319, 1);
  g.fillRect(0, 0, size, 2);
  g.fillRect(0, 0, 2, size);
  g.fillRect(0, size / 2 - 1, size, 2);
  g.fillRect(size / 2 - 1, 0, 2, size);
  g.fillStyle(0x2b2b35, 0.7);
  g.fillRect(3, 3, size / 2 - 6, 1);
  g.fillRect(size / 2 + 2, 3, size / 2 - 6, 1);
  g.fillRect(3, size / 2 + 2, size / 2 - 6, 1);
  g.fillRect(size / 2 + 2, size / 2 + 2, size / 2 - 6, 1);
  g.generateTexture(key, size, size);
  g.destroy();
  return key;
}

/** A soft elliptical ground shadow texture, sized for players/enemies. Cached and reused. */
export function ensureShadowTexture(scene: Phaser.Scene, width = 30): string {
  const key = `shadow_${width}`;
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const h = Math.max(6, Math.round(width * 0.34));
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x000000, 0.28);
  g.fillEllipse(width / 2, h / 2, width, h);
  g.generateTexture(key, width, h);
  g.destroy();
  return key;
}

const BODY_SHAPES: Record<
  NonNullable<VisualRecipe["bodyShape"]>,
  { w: number; h: number; torsoW: number; torsoH: number; headR: number; hunch: number }
> = {
  slim: { w: 26, h: 38, torsoW: 13, torsoH: 18, headR: 6, hunch: 0 },
  stocky: { w: 28, h: 36, torsoW: 18, torsoH: 16, headR: 7, hunch: 0 },
  hulking: { w: 36, h: 44, torsoW: 25, torsoH: 20, headR: 9, hunch: 0 },
  hunched: { w: 30, h: 36, torsoW: 19, torsoH: 15, headR: 7, hunch: 5 },
  blob: { w: 30, h: 28, torsoW: 22, torsoH: 16, headR: 8, hunch: 0 },
};

/**
 * A gelatinous blob (slimes/goo) instead of the humanoid body. The walk `legOffset`
 * (+3 / -3) drives a squash-and-stretch hop, so a moving blob bounces. Faces +x
 * (eyes on the right); the sprite's flipX mirrors it.
 */
function drawBlob(g: Phaser.GameObjects.Graphics, recipe: VisualRecipe, fallbackColor: number, legOffset: number) {
  const shape = BODY_SHAPES.blob;
  const bodyColor = toColor(recipe.palette?.body, fallbackColor);
  const trimColor = toColor(recipe.palette?.trim, darken(bodyColor, 55));
  const eyeColor = toColor(recipe.palette?.eyes, 0x0d2b0d);

  const cx = shape.w / 2;
  const ground = shape.h - 4;
  const bodyW = shape.torsoW + legOffset; // squash wide on the frame it lands
  const bodyH = shape.torsoH - legOffset; // ...and short — tall/narrow on the airborne frame
  const cy = ground - bodyH / 2;

  g.fillStyle(0x000000, 0.18);
  g.fillEllipse(cx, ground + 2, bodyW + 2, 6); // contact shadow
  g.fillStyle(bodyColor, 1);
  g.fillEllipse(cx, cy, bodyW, bodyH);
  g.fillStyle(lighten(bodyColor, 45), 0.8);
  g.fillEllipse(cx - 2, cy - bodyH * 0.22, bodyW * 0.5, bodyH * 0.28); // top gloss
  g.fillStyle(trimColor, 0.5);
  g.fillCircle(cx - 4, cy + 2, 1.6); // suspended bubble
  g.fillStyle(eyeColor, 1);
  g.fillCircle(cx + 3, cy, 2);
  g.fillCircle(cx + 8, cy, 2);
  g.fillStyle(0xffffff, 0.9);
  g.fillCircle(cx + 3.7, cy - 0.6, 0.7);
  g.fillCircle(cx + 8.7, cy - 0.6, 0.7);
}

function toColor(hex: string | number | undefined, fallback: number): number {
  if (hex === undefined) return fallback;
  return Number(hex);
}

function drawWeapon(
  g: Phaser.GameObjects.Graphics,
  weapon: NonNullable<VisualRecipe["weapon"]>,
  cx: number,
  handY: number,
  color: number,
) {
  if (weapon === "none") return;
  g.fillStyle(color, 1);
  switch (weapon) {
    case "claw":
      g.fillTriangle(cx + 10, handY, cx + 20, handY - 6, cx + 18, handY + 2);
      g.fillTriangle(cx + 10, handY + 4, cx + 20, handY + 2, cx + 17, handY + 9);
      break;
    case "blade":
      g.fillRect(cx + 9, handY - 16, 4, 22);
      g.fillTriangle(cx + 9, handY - 16, cx + 13, handY - 16, cx + 11, handY - 22);
      break;
    case "club":
      g.fillRect(cx + 9, handY - 4, 4, 16);
      g.fillCircle(cx + 11, handY - 6, 6);
      break;
    case "spear":
      g.fillRect(cx + 10, handY - 20, 3, 30);
      g.fillTriangle(cx + 8, handY - 20, cx + 15, handY - 20, cx + 11, handY - 28);
      break;
    case "axe":
      g.fillRect(cx + 10, handY - 10, 4, 24);
      g.fillTriangle(cx + 6, handY - 14, cx + 14, handY - 18, cx + 14, handY - 4);
      break;
  }
}

function drawAccessory(
  g: Phaser.GameObjects.Graphics,
  accessory: NonNullable<VisualRecipe["accessory"]>,
  cx: number,
  headY: number,
  headR: number,
  color: number,
) {
  if (accessory === "none") return;
  g.fillStyle(color, 1);
  switch (accessory) {
    case "horns":
      g.fillTriangle(cx - headR + 1, headY - 2, cx - headR - 3, headY - 10, cx - headR + 5, headY - 4);
      g.fillTriangle(cx + headR - 1, headY - 2, cx + headR + 3, headY - 10, cx + headR - 5, headY - 4);
      break;
    case "spikes":
      for (let i = -1; i <= 1; i++) {
        g.fillTriangle(cx + i * 5 - 2, headY - headR + 2, cx + i * 5 + 2, headY - headR + 2, cx + i * 5, headY - headR - 6);
      }
      break;
    case "hood":
      g.fillStyle(color, 1);
      g.fillRoundedRect(cx - headR - 2, headY - headR - 3, headR * 2 + 4, headR + 6, 5);
      break;
    case "mask":
      g.fillStyle(color, 1);
      g.fillRect(cx - headR + 1, headY - 2, headR * 2 - 2, 5);
      break;
    case "mane":
      for (let i = -2; i <= 2; i++) {
        g.fillTriangle(cx + i * 4, headY, cx + i * 4 - 2, headY + 8, cx + i * 4 + 2, headY + 8);
      }
      break;
  }
}

function drawMarkings(
  g: Phaser.GameObjects.Graphics,
  markings: NonNullable<VisualRecipe["markings"]>,
  cx: number,
  torsoTop: number,
  torsoW: number,
  torsoH: number,
  color: number,
) {
  if (markings === "none") return;
  g.fillStyle(color, 1);
  switch (markings) {
    case "stripes":
      for (let i = 0; i < 3; i++) {
        g.fillRect(cx - torsoW / 2 + 2 + i * 5, torsoTop + 2, 2, torsoH - 4);
      }
      break;
    case "spots":
      for (let i = 0; i < 3; i++) {
        g.fillCircle(cx - torsoW / 2 + 4 + i * 6, torsoTop + 5 + (i % 2) * 5, 1.6);
      }
      break;
    case "scars":
      g.lineStyle(1.4, color, 1);
      g.lineBetween(cx - 4, torsoTop + 2, cx, torsoTop + 8);
      g.lineBetween(cx + 2, torsoTop + 3, cx + 5, torsoTop + 9);
      break;
  }
}

function drawCreature(g: Phaser.GameObjects.Graphics, recipe: VisualRecipe, fallbackColor: number, legOffset: number) {
  if (recipe.bodyShape === "blob") {
    drawBlob(g, recipe, fallbackColor, legOffset);
    return;
  }
  const shape = BODY_SHAPES[recipe.bodyShape ?? "stocky"];
  const bodyColor = toColor(recipe.palette?.body, fallbackColor);
  const trimColor = toColor(recipe.palette?.trim, darken(bodyColor, 60));
  const skinColor = toColor(recipe.palette?.skin, 0xe0b58c);
  const eyeColor = toColor(recipe.palette?.eyes, 0x222222);
  const legColor = darken(bodyColor, 60);

  const cx = shape.w / 2;
  const torsoTop = 12 + shape.hunch;
  const headY = torsoTop - 4 + (shape.hunch ? shape.hunch * 0.6 : 0);
  const headX = cx + (shape.hunch ? 3 : 0);

  // legs
  g.fillStyle(legColor, 1);
  g.fillRect(cx - shape.torsoW / 2 + 2, torsoTop + shape.torsoH + legOffset, 5, 9);
  g.fillRect(cx + shape.torsoW / 2 - 7, torsoTop + shape.torsoH - legOffset, 5, 9);

  // torso
  g.fillStyle(bodyColor, 1);
  g.fillRoundedRect(cx - shape.torsoW / 2, torsoTop, shape.torsoW, shape.torsoH, 4);

  drawMarkings(g, recipe.markings ?? "none", cx, torsoTop, shape.torsoW, shape.torsoH, trimColor);
  drawWeapon(g, recipe.weapon ?? "none", cx, torsoTop + shape.torsoH / 2, trimColor);

  // head
  g.fillStyle(skinColor, 1);
  g.fillCircle(headX, headY, shape.headR);

  drawAccessory(g, recipe.accessory ?? "none", headX, headY, shape.headR, trimColor);

  // eyes (facing indicator, always drawn toward +x; flipped via sprite.flipX)
  if (recipe.accessory !== "mask") {
    g.fillStyle(eyeColor, 1);
    g.fillCircle(headX + shape.headR * 0.4, headY - 1, 1.4);
  }
}

function recipeCacheKey(recipe: VisualRecipe, fallbackColor: number, isBoss: boolean, frame: number): string {
  return `char_e_${isBoss ? "b" : "n"}_${frame}_${fallbackColor.toString(16)}_${JSON.stringify(recipe)}`;
}

/** Renders a grunt/boss from a data-driven VisualRecipe (see shared/boss.ts). Falls back to a flat-colored default body if no recipe is given. */
export function ensureEnemyTexture(
  scene: Phaser.Scene,
  recipe: VisualRecipe | undefined,
  fallbackColor: number,
  frame: 0 | 1,
  isBoss: boolean,
): string {
  const effectiveRecipe: VisualRecipe = recipe ?? {};
  const key = recipeCacheKey(effectiveRecipe, fallbackColor, isBoss, frame);
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);

  const shape = BODY_SHAPES[effectiveRecipe.bodyShape ?? "stocky"];
  const scale = effectiveRecipe.size ?? 1;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  drawCreature(g, effectiveRecipe, fallbackColor, frame === 0 ? 3 : -3);
  g.generateTexture(key, shape.w * scale, shape.h * scale);
  g.destroy();
  return key;
}

/** Fixed canvas size every hand-authored boss SVG (data/boss-art.json) must target — see data/SCHEMA.md. */
export const BOSS_ART_WIDTH = 96;
export const BOSS_ART_HEIGHT = 120;

export function bossArtKey(bossId: string): string {
  return `boss_art_${bossId}`;
}

/** Queues Phaser's SVG loader for every hand-authored boss in data/boss-art.json. Call from a scene's preload(). */
export function preloadBossArt(scene: Phaser.Scene, artData: Record<string, string>) {
  for (const [bossId, svg] of Object.entries(artData)) {
    // Phaser's SVG loader base64-decodes data URIs (atob), so the payload must be
    // base64 — a URL-encoded (charset=utf-8) URI throws InvalidCharacterError and
    // aborts the whole preload. unescape(encodeURIComponent(...)) keeps btoa UTF-8-safe.
    const dataUri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    scene.load.svg(bossArtKey(bossId), dataUri, { width: BOSS_ART_WIDTH, height: BOSS_ART_HEIGHT });
  }
}
