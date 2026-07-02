import Phaser from "phaser";

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

function drawHumanoid(g: Phaser.GameObjects.Graphics, color: number, legOffset: number, wide: boolean) {
  const bodyColor = color;
  const legColor = darken(color, 60);
  const headColor = 0xe0b58c;

  const w = wide ? 34 : 28;
  const cx = w / 2;

  // legs
  g.fillStyle(legColor, 1);
  g.fillRect(cx - 7, 26 + legOffset, 5, 9);
  g.fillRect(cx + 2, 26 - legOffset, 5, 9);

  // torso
  g.fillStyle(bodyColor, 1);
  g.fillRoundedRect(cx - 9, 12, 18, 16, 4);
  if (wide) {
    g.fillRoundedRect(cx - 12, 10, 24, 12, 3);
  }

  // head
  g.fillStyle(headColor, 1);
  g.fillCircle(cx, 8, 7);

  // eyes (facing indicator, always drawn toward +x; flipped via sprite.flipX)
  g.fillStyle(0x222222, 1);
  g.fillCircle(cx + 3, 7, 1.4);
}

export function ensurePlayerTexture(scene: Phaser.Scene, colorHex: number, frame: 0 | 1): string {
  const key = `char_p_${colorHex.toString(16)}_${frame}`;
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  drawHumanoid(g, colorHex, frame === 0 ? 3 : -3, false);
  g.generateTexture(key, 28, 36);
  g.destroy();
  return key;
}

export function ensureEnemyTexture(scene: Phaser.Scene, colorHex: number, frame: 0 | 1, isBoss: boolean): string {
  const key = `char_e_${colorHex.toString(16)}_${isBoss ? "b" : "n"}_${frame}`;
  if (generatedKeys.has(key) || scene.textures.exists(key)) return key;
  generatedKeys.add(key);
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  drawHumanoid(g, colorHex, frame === 0 ? 3 : -3, isBoss);
  if (isBoss) {
    // small horns to read as "boss" at a glance
    g.fillStyle(darken(colorHex, 90), 1);
    g.fillTriangle(6, 4, 10, -4, 12, 6);
    g.fillTriangle(28, 4, 24, -4, 22, 6);
  }
  g.generateTexture(key, isBoss ? 34 : 28, isBoss ? 42 : 36);
  g.destroy();
  return key;
}
