import Phaser from "phaser";

export interface DamageTextOpts {
  color?: string;
  fontSize?: string;
  rise?: number;
  duration?: number;
}

/** Short-lived floating combat number that drifts up and fades, then destroys itself. */
export function showDamageText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  amount: number,
  opts: DamageTextOpts = {},
) {
  const { color = "#ffe08a", fontSize = "16px", rise = 28, duration = 600 } = opts;
  const text = scene.add
    .text(x, y, String(Math.round(amount)), {
      fontSize,
      color,
      fontStyle: "bold",
      stroke: "#08080b",
      strokeThickness: 3,
    })
    .setOrigin(0.5)
    .setDepth(60);
  scene.tweens.add({
    targets: text,
    y: y - rise,
    alpha: 0,
    duration,
    ease: "Cubic.easeOut",
    onComplete: () => text.destroy(),
  });
  return text;
}
