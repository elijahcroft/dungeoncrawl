import Phaser from "phaser";
import { Bar } from "./Bar";
import { RoomProgress } from "./RoomProgress";

/**
 * Top-left player status panel: name, HP/stamina/weapon-cooldown bars, gold,
 * and potion charges — grouped inside one framed panel instead of loose,
 * ad-hoc bars scattered over the top-left corner.
 */
export class Hud {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private hpBar: Bar;
  private staminaFlashUntil = 0;
  private staminaBar: Bar;
  private cooldownBar: Bar;
  private cooldownLabel: Phaser.GameObjects.Text;
  private abilityBar: Bar;
  private abilityLabel: Phaser.GameObjects.Text;
  private goldText: Phaser.GameObjects.Text;
  private potionText: Phaser.GameObjects.Text;
  private accessoryText: Phaser.GameObjects.Text;
  private roomProgress: RoomProgress;
  private xpBar: Bar;
  private levelText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, name: string) {
    this.scene = scene;
    const panelX = 12;
    const panelY = 12;
    const panelW = 232;
    const panelH = 162;
    const contentX = panelX + 12;
    const barX = panelX + 38;
    const barW = panelW - 38 - 12;

    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(99);

    const frame = scene.add
      .rectangle(panelX, panelY, panelW, panelH, 0x0a0a0f, 0.55)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0x6b5a3a);
    this.container.add(frame);

    const nameText = scene.add
      .text(contentX, panelY + 8, name.toUpperCase(), { fontSize: "13px", color: "#e8d8b0", fontStyle: "bold" })
      .setOrigin(0, 0);
    this.container.add(nameText);

    this.container.add(scene.add.text(contentX, panelY + 30, "HP", { fontSize: "9px", color: "#8fd6a8" }).setOrigin(0, 0.5));
    this.hpBar = new Bar(scene, barX, panelY + 30, barW, 14, 100, 0x4dff88, true);

    this.container.add(scene.add.text(contentX, panelY + 50, "SP", { fontSize: "9px", color: "#e8d27a" }).setOrigin(0, 0.5));
    this.staminaBar = new Bar(scene, barX, panelY + 50, barW, 10, 100, 0xffdd44);

    this.container.add(scene.add.text(contentX, panelY + 68, "WPN", { fontSize: "9px", color: "#8fc4e8" }).setOrigin(0, 0.5));
    this.cooldownBar = new Bar(scene, barX, panelY + 68, barW, 8, 1, 0x66ccff);
    // A caption row below the bar (not beside it) so the label never sits under
    // the bar's own rectangle — those live outside this container at a higher depth.
    this.cooldownLabel = scene.add
      .text(panelX + panelW - 4, panelY + 80, "", { fontSize: "9px", color: "#66ccff" })
      .setOrigin(1, 0.5);
    this.container.add(this.cooldownLabel);

    this.goldText = scene.add
      .text(contentX, panelY + 100, "Gold: 0", { fontSize: "12px", color: "#ffd24a" })
      .setOrigin(0, 0.5);
    this.container.add(this.goldText);

    this.potionText = scene.add
      .text(panelX + panelW - 4, panelY + 100, "", { fontSize: "12px", color: "#ff6b6b" })
      .setOrigin(1, 0.5);
    this.container.add(this.potionText);

    this.accessoryText = scene.add
      .text(contentX, panelY + 120, "Acc: —", { fontSize: "11px", color: "#aeb8c8" })
      .setOrigin(0, 0.5);
    this.container.add(this.accessoryText);

    this.container.add(scene.add.text(contentX, panelY + 142, "ABL", { fontSize: "9px", color: "#c9a6ff" }).setOrigin(0, 0.5));
    this.abilityBar = new Bar(scene, barX, panelY + 142, barW, 8, 1, 0xa877ff);
    this.abilityLabel = scene.add
      .text(panelX + panelW - 4, panelY + 142, "", { fontSize: "9px", color: "#c9a6ff" })
      .setOrigin(1, 0.5);
    this.container.add(this.abilityLabel);

    // Bar backgrounds/foregrounds are created outside the container (screen-space
    // rectangles at fixed depth) — pull them onto the same depth band as the panel.

    this.roomProgress = new RoomProgress(scene);

    // Roguelite XP: a thin bar pinned across the very top of the screen (Brotato/Isaac
    // style) with a level badge tucked into the left corner above the status panel.
    this.xpBar = new Bar(scene, 0, 4, 960, 6, 100, 0xb066ff);
    this.levelText = scene.add
      .text(0, 4, " LVL 1 ", {
        fontSize: "11px",
        color: "#e8d2ff",
        fontStyle: "bold",
        backgroundColor: "#2a1150dd",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(102)
      .setVisible(false);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
    this.hpBar.setVisible(visible);
    this.staminaBar.setVisible(visible);
    this.cooldownBar.setVisible(visible);
    this.abilityBar.setVisible(visible);
    this.roomProgress.setVisible(visible);
    this.xpBar.setVisible(visible);
    this.levelText.setVisible(visible);
  }

  /** Update the top XP bar and level badge from the server-synced progression fields. */
  setXp(level: number, xp: number, xpToNext: number) {
    this.levelText.setText(` LVL ${level} `).setVisible(true);
    this.xpBar.setMax(Math.max(1, xpToNext));
    this.xpBar.setValue(xp);
  }

  /** current is 1-based; pass total 0 to hide the readout (e.g. in the lobby). */
  setRoomProgress(current: number, total: number, name?: string) {
    this.roomProgress.update(current, total, name);
  }

  setHpMax(max: number) {
    this.hpBar.setMax(max);
  }

  setHp(hp: number) {
    this.hpBar.setValue(hp);
  }

  setStamina(stamina: number) {
    this.staminaBar.setValue(stamina);
  }

  setCooldown(frac: number, ready: boolean, weaponName: string) {
    this.cooldownBar.setValue(frac);
    this.cooldownBar.setFillColor(ready ? 0x66ff66 : 0x66ccff);
    this.cooldownLabel.setText(weaponName);
    this.cooldownLabel.setColor(ready ? "#66ff66" : "#66ccff");
  }

  /** Ability cooldown bar (0 just-used → 1 ready). Shows "READY" green when charged. */
  setAbility(name: string, frac: number) {
    const ready = frac >= 1;
    this.abilityBar.setValue(frac);
    this.abilityBar.setFillColor(ready ? 0x66ff66 : 0xa877ff);
    this.abilityLabel.setText(ready ? `${name} [K]` : name);
    this.abilityLabel.setColor(ready ? "#66ff66" : "#c9a6ff");
  }

  setGold(gold: number) {
    this.goldText.setText(`Gold: ${gold}`);
  }

  setPotions(charges: number) {
    this.potionText.setText(charges > 0 ? `Potions x${charges} [E]` : "");
  }

  /** Names of equipped stat accessories; empty list shows a dash. */
  setAccessories(names: string[]) {
    this.accessoryText.setText(names.length > 0 ? `Acc: ${names.join(", ")}` : "Acc: —");
  }

  /** Brief red flash on the stamina bar when an action is denied for lack of stamina. */
  flashStamina() {
    this.staminaFlashUntil = this.scene.time.now + 180;
    this.staminaBar.setFillColor(0xff5544);
  }

  /** Per-frame: drains the HP chip trail and clears an expired stamina flash. */
  update(delta: number) {
    this.hpBar.update(delta);
    if (this.staminaFlashUntil > 0 && this.scene.time.now >= this.staminaFlashUntil) {
      this.staminaFlashUntil = 0;
      this.staminaBar.setFillColor(0xffdd44);
    }
  }
}
