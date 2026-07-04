import Phaser from "phaser";

const PIP_R = 5;
const PIP_GAP = 15;
const CLEARED_COLOR = 0x4dff88; // rooms already behind you
const CURRENT_COLOR = 0xffd24a; // the room you're fighting through now
const REMAINING_COLOR = 0x3a3a44; // rooms still ahead, dimmed

/**
 * Compact dungeon-progress readout below the main HUD panel: a "ROOM 2/5"
 * caption over a row of pips (cleared / current / remaining), plus the current
 * room's name. Self-contained — owns all its Phaser objects and rebuilds the
 * pip row only when the room count changes.
 */
export class RoomProgress {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private label: Phaser.GameObjects.Text;
  private nameText: Phaser.GameObjects.Text;
  private pips: Phaser.GameObjects.Arc[] = [];
  private pipTotal = -1;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    // Sits just under the top-left status panel (panelY 12 + panelH 122).
    const x = 24;
    const y = 146;

    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(99);

    this.label = scene.add
      .text(x, y, "", { fontSize: "11px", color: "#e8d8b0", fontStyle: "bold" })
      .setOrigin(0, 0.5);
    this.container.add(this.label);

    this.nameText = scene.add
      .text(x, y + 30, "", { fontSize: "10px", color: "#aeb8c8" })
      .setOrigin(0, 0.5);
    this.container.add(this.nameText);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
  }

  private buildPips(total: number, x: number, y: number) {
    for (const p of this.pips) p.destroy();
    this.pips = [];
    for (let i = 0; i < total; i++) {
      const pip = this.scene.add
        .circle(x + i * PIP_GAP, y, PIP_R, REMAINING_COLOR)
        .setScrollFactor(0);
      this.pips.push(pip);
      this.container.add(pip);
    }
    this.pipTotal = total;
  }

  /** @param current 1-based room number, @param total room count. */
  update(current: number, total: number, name?: string) {
    const pipX = 26;
    const pipY = 146 + 15;

    this.label.setText(total > 0 ? `ROOM ${current}/${total}` : "");
    this.nameText.setText(name ? name.toUpperCase() : "");

    if (total !== this.pipTotal) this.buildPips(total, pipX, pipY);

    for (let i = 0; i < this.pips.length; i++) {
      const roomNum = i + 1;
      const color =
        roomNum < current ? CLEARED_COLOR : roomNum === current ? CURRENT_COLOR : REMAINING_COLOR;
      this.pips[i].setFillStyle(color);
    }
  }
}
