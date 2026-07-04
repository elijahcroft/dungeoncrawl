import Phaser from "phaser";

export class Bar {
  private width: number;
  private bg: Phaser.GameObjects.Rectangle;
  private fg: Phaser.GameObjects.Rectangle;
  // Optional souls-style "chip" that lags behind the real value to visualize damage taken.
  private chip?: Phaser.GameObjects.Rectangle;
  private chipValue: number;
  private max: number;
  private value: number;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number,
    max: number,
    fillColor: number,
    withChip = false,
  ) {
    this.width = width;
    this.max = max;
    this.value = max;
    this.chipValue = max;

    this.bg = scene.add.rectangle(x, y, width, height, 0x000000, 0.5).setOrigin(0, 0.5).setScrollFactor(0);
    if (withChip) {
      this.chip = scene.add.rectangle(x, y, width, height, 0xffbb55, 0.85).setOrigin(0, 0.5).setScrollFactor(0);
      this.chip.setDepth(100.5);
    }
    this.fg = scene.add.rectangle(x, y, width, height, fillColor, 1).setOrigin(0, 0.5).setScrollFactor(0);
    this.bg.setDepth(100);
    this.fg.setDepth(101);
  }

  setVisible(visible: boolean) {
    this.bg.setVisible(visible);
    this.fg.setVisible(visible);
    this.chip?.setVisible(visible);
  }

  setFillColor(color: number) {
    this.fg.setFillStyle(color);
  }

  setMax(max: number) {
    this.max = max;
    this.setValue(this.value);
  }

  setValue(value: number) {
    this.value = Phaser.Math.Clamp(value, 0, this.max);
    const pct = this.max > 0 ? this.value / this.max : 0;
    this.fg.width = this.width * pct;
    // Heals snap the chip up immediately; damage lets it drain via update().
    if (this.value > this.chipValue) this.chipValue = this.value;
  }

  getValue() {
    return this.value;
  }

  /** Call each frame (only matters for chip bars) so the lag chip catches up to the real value. */
  update(delta: number) {
    if (!this.chip) return;
    if (this.chipValue > this.value) {
      this.chipValue = Math.max(this.value, this.chipValue - (this.max * 0.45 * delta) / 1000);
    }
    this.chip.width = this.width * (this.max > 0 ? this.chipValue / this.max : 0);
  }
}
