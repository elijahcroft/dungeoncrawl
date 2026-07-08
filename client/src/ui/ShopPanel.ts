import Phaser from "phaser";
import itemsData from "../../../data/items.json";
import { WEAPONS } from "../entities/weapons";
import { sfx } from "../audio/sfx";

export interface ShopOffering {
  id: string;
  itemId: string;
  name: string;
  price: number;
  /** Undiscounted price; price < basePrice marks the stall's sale slot. */
  basePrice: number;
  sold: boolean;
  rarity: string;
}

interface ItemDef {
  stat?: string;
  amount?: number;
  weaponId?: string;
  itemType?: string;
  effect?: string;
}
const itemDefs = itemsData as Record<string, ItemDef>;

/** Rarity palette shared in spirit with the level-up cards (see LevelUpPanel). */
const RARITY: Record<string, { text: string; stroke: number; glow: number; label: string }> = {
  common: { text: "#cfd6e0", stroke: 0x8b95a4, glow: 0x6b7688, label: "COMMON" },
  rare:   { text: "#4aa3ff", stroke: 0x3f8fe0, glow: 0x2f6fc0, label: "RARE" },
  epic:   { text: "#c77dff", stroke: 0xb060e0, glow: 0x8a3ac0, label: "EPIC" },
};
const DEFAULT_RARITY = RARITY.common;

const CARD_W = 152;
const CARD_H = 210;
const CARD_GAP = 16;
const CENTER_X = 480;
const CARDS_Y = 300;
const REROLL_COST = 15;

/** An emoji icon for an offering, mirroring the icon slot on level-up cards. */
function iconForItem(itemId: string): string {
  const def = itemDefs[itemId];
  if (!def) return "❓";
  if (def.weaponId) return "🗡️";
  if (def.itemType === "consumable" && def.effect === "heal") return "🧪";
  if (def.stat === "hpMax") return "❤️";
  if (def.stat === "damage") return "⚔️";
  if (def.stat === "speedPct") return "👢";
  return "💎";
}

/** One-line effect summary for an offering, looked up from the item data. */
function describeItem(itemId: string): string {
  const def = itemDefs[itemId];
  if (!def) return "";
  if (def.itemType === "consumable" && def.effect === "heal") return `Potion · heals ${def.amount ?? 0} HP`;
  if (def.weaponId) {
    const w = WEAPONS[def.weaponId];
    return w ? `Weapon · ${w.damage} dmg · swaps yours` : "Weapon · swaps yours";
  }
  if (def.stat === "hpMax") return `+${def.amount ?? 0} Max HP`;
  if (def.stat === "damage") return `+${def.amount ?? 0} Damage`;
  if (def.stat === "speedPct") return `+${def.amount ?? 0}% Speed`;
  return "";
}

interface ShopCard {
  root: Phaser.GameObjects.Container;
  glow: Phaser.GameObjects.Rectangle;
  frame: Phaser.GameObjects.Rectangle;
  icon: Phaser.GameObjects.Text;
  rarityLabel: Phaser.GameObjects.Text;
  name: Phaser.GameObjects.Text;
  desc: Phaser.GameObjects.Text;
  price: Phaser.GameObjects.Text;
  hint: Phaser.GameObjects.Text;
  flash: Phaser.GameObjects.Rectangle;
}

/**
 * Rest-room shop rendered as a row of rarity-coloured draft cards, matching the
 * look of the level-up picker (LevelUpPanel). Unlike that modal draft this panel
 * is live and non-modal: it shows the shared server stock while you stand in the
 * stall, so cards carry per-slot price/SOLD/SALE state, grey out when you can't
 * afford them, and flash when any player buys them. Click a card (or press its
 * number) to buy; click the reroll footer (or press R) to reroll unsold slots.
 * GameScene sets `onBuy`/`onReroll` and feeds state via `update`.
 */
export class ShopPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private title: Phaser.GameObjects.Text;
  private goldText: Phaser.GameObjects.Text;
  private rerollRow: Phaser.GameObjects.Text;
  private cards: ShopCard[] = [];
  /** offering id -> "itemId:sold", to detect purchases for the row flash. */
  private lastStock = new Map<string, string>();
  private gold = 0;

  onBuy?: (index: number) => void;
  onReroll?: () => void;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(100).setVisible(false);

    // Soft backdrop behind the card cluster only — non-modal so the room stays visible.
    this.container.add(
      scene.add.rectangle(CENTER_X, CARDS_Y - 4, 900, CARD_H + 150, 0x05050c, 0.55).setScrollFactor(0),
    );

    this.title = scene.add
      .text(CENTER_X, CARDS_Y - CARD_H / 2 - 46, "SHOP", {
        fontSize: "30px",
        color: "#ffd24a",
        fontStyle: "bold",
        stroke: "#3a2a00",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setScrollFactor(0);
    this.container.add(this.title);

    this.goldText = scene.add
      .text(CENTER_X, CARDS_Y - CARD_H / 2 - 20, "", { fontSize: "14px", color: "#ffd24a" })
      .setOrigin(0.5)
      .setScrollFactor(0);
    this.container.add(this.goldText);

    this.rerollRow = scene.add
      .text(CENTER_X, CARDS_Y + CARD_H / 2 + 22, "", { fontSize: "13px", color: "#9aa2ae", fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true })
      .on("pointerover", () => this.rerollRow.setColor(this.gold >= REROLL_COST ? "#ffe27a" : "#6a4a4a"))
      .on("pointerout", () => this.rerollRow.setColor(this.gold >= REROLL_COST ? "#9aa2ae" : "#6a4a4a"))
      .on("pointerdown", () => this.onReroll?.());
    this.container.add(this.rerollRow);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
    if (!visible) this.lastStock.clear();
  }

  private rebuild(count: number) {
    for (const c of this.cards) c.root.destroy(true);
    this.cards = [];
    const totalW = count * CARD_W + (count - 1) * CARD_GAP;
    const startX = CENTER_X - totalW / 2 + CARD_W / 2;
    for (let i = 0; i < count; i++) {
      const card = this.buildCard(i);
      card.root.setPosition(startX + i * (CARD_W + CARD_GAP), CARDS_Y);
      this.container.add(card.root);
      this.cards.push(card);
    }
  }

  private buildCard(index: number): ShopCard {
    const scene = this.scene;
    const root = scene.add.container(0, 0).setScrollFactor(0);

    const glow = scene.add.rectangle(0, 0, CARD_W + 8, CARD_H + 8, DEFAULT_RARITY.glow, 0.16).setScrollFactor(0);
    const frame = scene.add
      .rectangle(0, 0, CARD_W, CARD_H, 0x0d0d16, 0.98)
      .setStrokeStyle(3, DEFAULT_RARITY.stroke)
      .setScrollFactor(0);
    const icon = scene.add.text(0, -60, "", { fontSize: "48px" }).setOrigin(0.5).setScrollFactor(0);
    const rarityLabel = scene.add
      .text(0, -8, "", { fontSize: "10px", color: DEFAULT_RARITY.text, fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const name = scene.add
      .text(0, 14, "", { fontSize: "16px", color: "#ffffff", fontStyle: "bold", align: "center", wordWrap: { width: CARD_W - 18 } })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const desc = scene.add
      .text(0, 44, "", { fontSize: "12px", color: "#aeb8c8", align: "center", wordWrap: { width: CARD_W - 20 } })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const price = scene.add
      .text(0, CARD_H / 2 - 32, "", { fontSize: "17px", color: "#ffd24a", fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const hint = scene.add
      .text(0, CARD_H / 2 - 13, `[${index + 1}]  BUY`, { fontSize: "10px", color: "#7f8896", fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const flash = scene.add.rectangle(0, 0, CARD_W, CARD_H, 0xffd24a, 0).setScrollFactor(0);

    root.add([glow, frame, icon, rarityLabel, name, desc, price, hint, flash]);

    frame
      .setInteractive({ useHandCursor: true })
      .on("pointerover", () => {
        const r = RARITY[this.cards[index]?.frame.getData("rarity") as string] ?? DEFAULT_RARITY;
        frame.setStrokeStyle(4, 0xffffff);
        glow.setFillStyle(r.glow, 0.35);
        scene.tweens.add({ targets: root, scale: 1.05, duration: 120, ease: "Quad.easeOut" });
      })
      .on("pointerout", () => {
        const r = RARITY[this.cards[index]?.frame.getData("rarity") as string] ?? DEFAULT_RARITY;
        frame.setStrokeStyle(3, r.stroke);
        glow.setFillStyle(r.glow, 0.16);
        scene.tweens.add({ targets: root, scale: 1, duration: 120, ease: "Quad.easeOut" });
      })
      .on("pointerdown", () => this.onBuy?.(index));

    return { root, glow, frame, icon, rarityLabel, name, desc, price, hint, flash };
  }

  /** Brief highlight pulse over a card when its offering is bought. */
  private flashCard(i: number) {
    const flash = this.cards[i]?.flash;
    if (!flash) return;
    flash.setFillStyle(0xffd24a, 0.4);
    this.scene.tweens.add({ targets: flash, fillAlpha: 0, duration: 450, ease: "Cubic.easeOut" });
    sfx.pickup();
  }

  /** @param gold local player's gold, used to grey out unaffordable cards. */
  update(offerings: ShopOffering[], gold: number) {
    this.gold = gold;
    if (offerings.length !== this.cards.length) this.rebuild(offerings.length);

    this.goldText.setText(`Your gold: ${gold}g`);

    offerings.forEach((o, i) => {
      const card = this.cards[i];
      if (!card) return;

      // Flash the card when this exact offering flips to sold (any buyer).
      const prev = this.lastStock.get(o.id);
      if (prev === `${o.itemId}:false` && o.sold) this.flashCard(i);
      this.lastStock.set(o.id, `${o.itemId}:${o.sold}`);

      const r = RARITY[o.rarity] ?? DEFAULT_RARITY;
      card.frame.setData("rarity", o.rarity);
      card.icon.setText(iconForItem(o.itemId));
      card.name.setText(o.name);
      card.desc.setText(describeItem(o.itemId)).setColor("#aeb8c8");

      const onSale = !o.sold && o.price < o.basePrice;

      if (o.sold) {
        card.root.setAlpha(0.5);
        card.frame.setStrokeStyle(3, 0x3a3a44);
        card.glow.setFillStyle(0x3a3a44, 0.1);
        card.rarityLabel.setText("SOLD").setColor("#5a5a66");
        card.price.setText("—").setColor("#5a5a66");
        card.hint.setText("SOLD").setColor("#5a5a66");
        return;
      }

      const affordable = gold >= o.price;
      card.root.setAlpha(affordable ? 1 : 0.55);
      card.frame.setStrokeStyle(3, r.stroke);
      card.glow.setFillStyle(r.glow, 0.16);
      card.rarityLabel.setText(onSale ? "ON SALE" : r.label).setColor(onSale ? "#7dffa8" : r.text);
      card.price
        .setText(onSale ? `${o.price}g  (was ${o.basePrice}g)` : `${o.price}g`)
        .setColor(affordable ? (onSale ? "#7dffa8" : "#ffd24a") : "#c05a5a");
      card.hint.setText(`[${i + 1}]  BUY`).setColor(affordable ? "#7f8896" : "#c05a5a");
    });

    this.rerollRow.setText(`[R]  Reroll unsold — ${REROLL_COST}g`);
    this.rerollRow.setColor(gold >= REROLL_COST ? "#9aa2ae" : "#6a4a4a");
  }
}
