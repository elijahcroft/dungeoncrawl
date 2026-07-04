import Phaser from "phaser";

export class Bar {
  private width: number;
  private bg: Phaser.GameObjects.Rectangle;
  private fg: Phaser.GameObjects.Rectangle;
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
  ) {
    this.width = width;
    this.max = max;
    this.value = max;

    this.bg = scene.add.rectangle(x, y, width, height, 0x000000, 0.5).setOrigin(0, 0.5).setScrollFactor(0);
    this.fg = scene.add.rectangle(x, y, width, height, fillColor, 1).setOrigin(0, 0.5).setScrollFactor(0);
    this.bg.setDepth(100);
    this.fg.setDepth(101);
  }

  setVisible(visible: boolean) {
    this.bg.setVisible(visible);
    this.fg.setVisible(visible);
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
  }

  getValue() {
    return this.value;
  }
}
