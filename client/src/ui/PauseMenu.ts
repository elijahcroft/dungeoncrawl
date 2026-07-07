import Phaser from "phaser";

/**
 * ESC-toggled controls overlay. Purely informational — it draws a dimmer + panel
 * on top of the running game and never pauses the networked simulation, so other
 * players and the server keep going while it's open.
 */
const CONTROLS: [string, string][] = [
  ["WASD", "Move"],
  ["SPACE", "Dodge roll (i-frames)"],
  ["J", "Attack"],
  ["E", "Use potion"],
  ["T/Y/U/G", "Emotes 😂 ❤️ 😱 🐔"],
  ["ESC", "Toggle this menu"],
];

export class PauseMenu {
  private container: Phaser.GameObjects.Container;
  private visible = false;

  constructor(scene: Phaser.Scene) {
    const panelW = 340;
    const panelH = 250;
    const panelX = 480 - panelW / 2;
    const panelY = 320 - panelH / 2;

    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(300).setVisible(false);

    const dimmer = scene.add
      .rectangle(480, 320, 960, 640, 0x05050a, 0.6)
      .setOrigin(0.5)
      .setScrollFactor(0);
    this.container.add(dimmer);

    const frame = scene.add
      .rectangle(panelX, panelY, panelW, panelH, 0x0a0a0f, 0.92)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0x6b5a3a);
    this.container.add(frame);

    const title = scene.add
      .text(480, panelY + 20, "CONTROLS", { fontSize: "20px", color: "#f3e4bd", fontStyle: "bold" })
      .setOrigin(0.5, 0);
    this.container.add(title);

    const rowY = panelY + 62;
    const rowGap = 28;
    const keyX = panelX + 28;
    const descX = panelX + 150;
    CONTROLS.forEach(([key, desc], i) => {
      const y = rowY + i * rowGap;
      this.container.add(
        scene.add.text(keyX, y, key, { fontSize: "14px", color: "#8fc4e8", fontStyle: "bold" }).setOrigin(0, 0.5),
      );
      this.container.add(
        scene.add.text(descX, y, desc, { fontSize: "14px", color: "#d8d1bd" }).setOrigin(0, 0.5),
      );
    });

    this.container.add(
      scene.add
        .text(480, panelY + panelH - 22, "Press ESC to resume", { fontSize: "12px", color: "#aeb8c8" })
        .setOrigin(0.5, 0.5),
    );
  }

  show() {
    this.visible = true;
    this.container.setVisible(true);
  }

  hide() {
    this.visible = false;
    this.container.setVisible(false);
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
}
