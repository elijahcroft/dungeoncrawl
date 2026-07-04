import Phaser from "phaser";

/**
 * Dramatic bottom-of-screen boss health bar (souls-style): centered name,
 * a wide framed HP bar with a "lag" chip that trails the real value, and
 * phase pips. Hidden until a boss is present, revealed with a quick fade.
 */
export class BossBar {
  private container: Phaser.GameObjects.Container;
  private nameText: Phaser.GameObjects.Text;
  private fg: Phaser.GameObjects.Rectangle;
  private chip: Phaser.GameObjects.Rectangle;
  private pips: Phaser.GameObjects.Rectangle[] = [];
  private readonly barWidth = 520;
  private targetFrac = 1;
  private chipFrac = 1;
  private shown = false;

  constructor(scene: Phaser.Scene) {
    const cx = 480;
    const y = 596;
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(120).setAlpha(0);

    const frame = scene.add
      .rectangle(cx, y, this.barWidth + 8, 26, 0x000000, 0.7)
      .setStrokeStyle(2, 0x6b5a3a);
    const bg = scene.add.rectangle(cx, y, this.barWidth, 18, 0x2a0a0a, 1);
    // Chip drains slowly behind the real bar to visualize burst damage.
    this.chip = scene.add.rectangle(cx - this.barWidth / 2, y, this.barWidth, 18, 0xffbb55, 0.8).setOrigin(0, 0.5);
    this.fg = scene.add.rectangle(cx - this.barWidth / 2, y, this.barWidth, 18, 0xb01e1e, 1).setOrigin(0, 0.5);
    this.nameText = scene.add
      .text(cx, y - 20, "", { fontSize: "15px", color: "#e8d8b0", fontStyle: "bold" })
      .setOrigin(0.5, 1);

    this.container.add([frame, bg, this.chip, this.fg, this.nameText]);
    // Phase pips sit just above the bar, filled left-to-right as phases pass.
    for (let i = 0; i < 4; i++) {
      const pip = scene.add.rectangle(cx - 40 + i * 26, y - 2, 8, 8, 0x553322, 1).setOrigin(0.5).setVisible(false);
      this.pips.push(pip);
      this.container.add(pip);
    }
  }

  show(scene: Phaser.Scene) {
    if (this.shown) return;
    this.shown = true;
    scene.tweens.add({ targets: this.container, alpha: 1, duration: 400 });
  }

  hide(scene: Phaser.Scene) {
    if (!this.shown) return;
    this.shown = false;
    scene.tweens.add({ targets: this.container, alpha: 0, duration: 600 });
  }

  setBoss(name: string, phaseCount: number, phaseIndex: number) {
    this.nameText.setText(name.toUpperCase());
    this.pips.forEach((pip, i) => {
      pip.setVisible(i < phaseCount);
      pip.setFillStyle(i <= phaseIndex ? 0xffcc55 : 0x553322);
    });
  }

  setFraction(frac: number) {
    this.targetFrac = Phaser.Math.Clamp(frac, 0, 1);
    this.fg.width = this.barWidth * this.targetFrac;
  }

  /** Call each frame so the trailing chip catches up to the real HP. */
  update() {
    if (this.chipFrac > this.targetFrac) {
      this.chipFrac = Math.max(this.targetFrac, this.chipFrac - 0.006);
    } else {
      this.chipFrac = this.targetFrac;
    }
    this.chip.width = this.barWidth * this.chipFrac;
  }
}
