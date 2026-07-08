import Phaser from "phaser";
import type { PowerUpDef, PowerUpRarity } from "../../../shared/powerups";
import { sfx } from "../audio/sfx";

/** Server `level_up` payload: which level was reached and the hand to choose from. */
export interface LevelUpOffer {
  level: number;
  choices: PowerUpDef[];
}

const RARITY: Record<PowerUpRarity, { text: string; stroke: number; glow: number; label: string }> = {
  common:    { text: "#cfd6e0", stroke: 0x8b95a4, glow: 0x6b7688, label: "COMMON" },
  rare:      { text: "#5cb3ff", stroke: 0x3f8fe0, glow: 0x2f6fc0, label: "RARE" },
  epic:      { text: "#d08bff", stroke: 0xb060e0, glow: 0x8a3ac0, label: "EPIC" },
  legendary: { text: "#ffcf5c", stroke: 0xffb020, glow: 0xff9500, label: "LEGENDARY" },
};

const CARD_W = 184;
const CARD_H = 250;
const CARD_GAP = 26;
const CENTER_X = 480;
const CARDS_Y = 348;

/**
 * Roguelite level-up picker — a Brotato/Isaac-style card draft shown when the
 * server sends `level_up`. Three rarity-coloured power-up cards animate in; the
 * player picks one with the mouse or number keys 1–3, which fires `onChoose`
 * (the scene relays it to the server). Purely an overlay: like the other panels
 * it draws over the running scene and never pauses the networked sim.
 */
export class LevelUpPanel {
  private scene: Phaser.Scene;
  private container?: Phaser.GameObjects.Container;
  private onChoose?: (id: string) => void;
  private choices: PowerUpDef[] = [];
  private cards: { root: Phaser.GameObjects.Container; frame: Phaser.GameObjects.Rectangle; def: PowerUpDef }[] = [];
  private keyHandlers: { key: string; fn: () => void }[] = [];
  private locked = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  get isOpen(): boolean {
    return !!this.container;
  }

  show(offer: LevelUpOffer, onChoose: (id: string) => void) {
    // If a pick is already open (chained level-ups), replace it with the new hand.
    this.hide();
    this.onChoose = onChoose;
    this.choices = offer.choices;
    this.locked = false;
    const scene = this.scene;

    const container = scene.add.container(0, 0).setScrollFactor(0).setDepth(320);
    this.container = container;

    // Dim backdrop + a soft radial bloom behind the title.
    container.add(scene.add.rectangle(480, 320, 960, 640, 0x05050c, 0.78).setScrollFactor(0));
    const bloom = scene.add.circle(480, 150, 320, 0xffd24a, 0.05).setScrollFactor(0);
    container.add(bloom);
    scene.tweens.add({ targets: bloom, scale: 1.12, alpha: 0.09, duration: 1400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });

    const title = scene.add
      .text(480, 96, "LEVEL UP", { fontSize: "44px", color: "#ffe27a", fontStyle: "bold", stroke: "#3a2a00", strokeThickness: 6 })
      .setOrigin(0.5)
      .setScrollFactor(0);
    container.add(title);
    scene.tweens.add({ targets: title, scale: { from: 0.6, to: 1 }, duration: 420, ease: "Back.easeOut" });

    container.add(
      scene.add
        .text(480, 138, `You reached level ${offer.level} — choose a power-up`, { fontSize: "15px", color: "#c8cfda" })
        .setOrigin(0.5)
        .setScrollFactor(0),
    );

    const totalW = this.choices.length * CARD_W + (this.choices.length - 1) * CARD_GAP;
    const startX = CENTER_X - totalW / 2 + CARD_W / 2;
    this.cards = [];
    this.choices.forEach((def, i) => {
      const cx = startX + i * (CARD_W + CARD_GAP);
      const card = this.buildCard(def, i);
      card.root.setPosition(cx, CARDS_Y);
      container.add(card.root);
      this.cards.push(card);
      // Staggered pop-in from below.
      card.root.setAlpha(0).setY(CARDS_Y + 40).setScale(0.9);
      scene.tweens.add({
        targets: card.root,
        alpha: 1,
        y: CARDS_Y,
        scale: 1,
        delay: 120 + i * 90,
        duration: 360,
        ease: "Back.easeOut",
      });
    });

    // Number keys 1..N mirror clicking the matching card.
    (["ONE", "TWO", "THREE", "FOUR"] as const).slice(0, this.choices.length).forEach((key, i) => {
      const fn = () => this.pick(i);
      scene.input.keyboard?.on(`keydown-${key}`, fn);
      this.keyHandlers.push({ key: `keydown-${key}`, fn });
    });

    sfx.pickup();
    scene.cameras.main.flash(220, 90, 80, 20);
  }

  private buildCard(def: PowerUpDef, index: number) {
    const scene = this.scene;
    const r = RARITY[def.rarity];
    const root = scene.add.container(0, 0);

    const frame = scene.add
      .rectangle(0, 0, CARD_W, CARD_H, 0x0d0d16, 0.98)
      .setStrokeStyle(3, r.stroke)
      .setScrollFactor(0);
    const rarityGlow = scene.add.rectangle(0, 0, CARD_W + 8, CARD_H + 8, r.glow, 0.16).setScrollFactor(0);
    const icon = scene.add.text(0, -66, def.icon, { fontSize: "60px" }).setOrigin(0.5).setScrollFactor(0);
    const rarityLabel = scene.add
      .text(0, -6, r.label, { fontSize: "10px", color: r.text, fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const name = scene.add
      .text(0, 18, def.name, { fontSize: "19px", color: "#ffffff", fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const desc = scene.add
      .text(0, 48, def.desc, { fontSize: "14px", color: "#aeb8c8", align: "center", wordWrap: { width: CARD_W - 24 } })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const hint = scene.add
      .text(0, CARD_H / 2 - 18, `[${index + 1}]  CLICK`, { fontSize: "11px", color: "#7f8896", fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0);

    root.add([rarityGlow, frame, icon, rarityLabel, name, desc, hint]);

    frame
      .setInteractive({ useHandCursor: true })
      .on("pointerover", () => {
        if (this.locked) return;
        frame.setStrokeStyle(4, 0xffffff);
        rarityGlow.setFillStyle(r.glow, 0.35);
        scene.tweens.add({ targets: root, scale: 1.06, duration: 120, ease: "Quad.easeOut" });
      })
      .on("pointerout", () => {
        if (this.locked) return;
        frame.setStrokeStyle(3, r.stroke);
        rarityGlow.setFillStyle(r.glow, 0.16);
        scene.tweens.add({ targets: root, scale: 1, duration: 120, ease: "Quad.easeOut" });
      })
      .on("pointerdown", () => this.pick(index));

    return { root, frame, def };
  }

  private pick(index: number) {
    if (this.locked || !this.container) return;
    const chosen = this.cards[index];
    if (!chosen) return;
    this.locked = true;

    // Flash the chosen card and fade the rest, then close.
    this.cards.forEach((c, i) => {
      if (i === index) return;
      this.scene.tweens.add({ targets: c.root, alpha: 0.15, scale: 0.92, duration: 220, ease: "Quad.easeOut" });
    });
    chosen.frame.setStrokeStyle(4, 0xffffff);
    this.scene.tweens.add({
      targets: chosen.root,
      scale: 1.16,
      duration: 180,
      yoyo: true,
      ease: "Quad.easeOut",
      onComplete: () => {
        const id = chosen.def.id;
        this.hide();
        this.onChoose?.(id);
      },
    });
    sfx.heal();
    this.scene.cameras.main.flash(180, 120, 110, 40);
  }

  hide() {
    for (const h of this.keyHandlers) this.scene.input.keyboard?.off(h.key, h.fn);
    this.keyHandlers = [];
    this.container?.destroy(true);
    this.container = undefined;
    this.cards = [];
    this.locked = false;
  }
}
