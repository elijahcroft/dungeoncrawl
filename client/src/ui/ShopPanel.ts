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

const ROW_H = 32;
const PANEL_W = 340;
const REROLL_COST = 15;

const RARITY_COLOR: Record<string, string> = {
  common: "#cfd6e0",
  rare: "#4aa3ff",
  epic: "#c77dff",
};

/** One-line effect summary for an offering, looked up from the item data. */
function describeItem(itemId: string): string {
  const def = itemDefs[itemId];
  if (!def) return "";
  if (def.itemType === "consumable" && def.effect === "heal") return `Potion charge · heals ${def.amount ?? 0} HP`;
  if (def.weaponId) {
    const w = WEAPONS[def.weaponId];
    return w ? `Weapon · ${w.damage} dmg · swaps yours` : "Weapon · swaps yours";
  }
  if (def.stat === "hpMax") return `Accessory · +${def.amount ?? 0} Max HP`;
  if (def.stat === "damage") return `Accessory · +${def.amount ?? 0} Damage`;
  if (def.stat === "speedPct") return `Accessory · +${def.amount ?? 0}% Speed`;
  return "";
}

/**
 * Bottom-centre shop stall shown only while standing in a rest room that has
 * offerings. Each offering is a two-line row: "[n] Name" coloured by rarity
 * with the price right-aligned, and a small effect description underneath.
 * One slot per stall is on SALE (price < basePrice) and highlighted. Rows grey
 * out when sold and dim when unaffordable; a row flashes when someone buys it.
 * Purchases and reroll are driven by keys in GameScene; this panel renders state.
 */
export class ShopPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private frame: Phaser.GameObjects.Rectangle;
  private title: Phaser.GameObjects.Text;
  private goldText: Phaser.GameObjects.Text;
  private rerollRow: Phaser.GameObjects.Text;
  private rows: { name: Phaser.GameObjects.Text; price: Phaser.GameObjects.Text; desc: Phaser.GameObjects.Text; flash: Phaser.GameObjects.Rectangle }[] = [];
  /** offering id -> "itemId:sold", to detect purchases for the row flash. */
  private lastStock = new Map<string, string>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(100).setVisible(false);

    const x = 480 - PANEL_W / 2;
    const y = 452;
    this.frame = scene.add
      .rectangle(x, y, PANEL_W, 40, 0x0a0a0f, 0.78)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0x6b5a3a);
    this.container.add(this.frame);

    this.title = scene.add
      .text(x + 14, y + 12, "SHOP", { fontSize: "12px", color: "#ffd24a", fontStyle: "bold" })
      .setOrigin(0, 0.5);
    this.container.add(this.title);

    this.goldText = scene.add
      .text(x + PANEL_W - 14, y + 12, "", { fontSize: "11px", color: "#ffd24a" })
      .setOrigin(1, 0.5);
    this.container.add(this.goldText);

    this.rerollRow = scene.add.text(x + 14, 0, "", { fontSize: "11px", color: "#9aa2ae" }).setOrigin(0, 0.5);
    this.container.add(this.rerollRow);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
    if (!visible) this.lastStock.clear();
  }

  private rebuild(count: number) {
    for (const r of this.rows) {
      r.name.destroy();
      r.price.destroy();
      r.desc.destroy();
      r.flash.destroy();
    }
    this.rows = [];
    const x = 480 - PANEL_W / 2;
    const y = 452;
    this.frame.height = 36 + count * ROW_H + 20;
    for (let i = 0; i < count; i++) {
      const rowY = y + 34 + i * ROW_H;
      const flash = this.scene.add
        .rectangle(x + 4, rowY - 4, PANEL_W - 8, ROW_H - 4, 0xffffff, 0)
        .setOrigin(0, 0);
      const name = this.scene.add
        .text(x + 14, rowY + 4, "", { fontSize: "12px", color: "#e8d8b0" })
        .setOrigin(0, 0.5);
      const price = this.scene.add
        .text(x + PANEL_W - 14, rowY + 4, "", { fontSize: "12px", color: "#e8d8b0" })
        .setOrigin(1, 0.5);
      const desc = this.scene.add
        .text(x + 26, rowY + 18, "", { fontSize: "9px", color: "#7f8896" })
        .setOrigin(0, 0.5);
      this.rows.push({ name, price, desc, flash });
      this.container.add([flash, name, price, desc]);
    }
    this.rerollRow.setY(y + 36 + count * ROW_H + 8);
  }

  /** Brief highlight pulse over a row when its offering is bought. */
  private flashRow(i: number) {
    const flash = this.rows[i]?.flash;
    if (!flash) return;
    flash.setFillStyle(0xffd24a, 0.35);
    this.scene.tweens.add({ targets: flash, fillAlpha: 0, duration: 450, ease: "Cubic.easeOut" });
    sfx.pickup();
  }

  /** @param gold local player's gold, used to grey out unaffordable rows. */
  update(offerings: ShopOffering[], gold: number) {
    if (offerings.length !== this.rows.length) this.rebuild(offerings.length);

    this.goldText.setText(`Your gold: ${gold}g`);

    offerings.forEach((o, i) => {
      const row = this.rows[i];
      if (!row) return;

      // Flash the row when this exact offering flips to sold (any buyer).
      const stockKey = `${o.itemId}:${o.sold}`;
      const prev = this.lastStock.get(o.id);
      if (prev === `${o.itemId}:false` && o.sold) this.flashRow(i);
      this.lastStock.set(o.id, stockKey);

      const onSale = !o.sold && o.price < o.basePrice;
      row.name.setText(`[${i + 1}] ${o.name}`);

      if (o.sold) {
        row.name.setColor("#5a5a66").setAlpha(1);
        row.price.setText("SOLD").setColor("#5a5a66");
        row.desc.setText("").setAlpha(1);
        return;
      }

      const affordable = gold >= o.price;
      row.name.setColor(RARITY_COLOR[o.rarity] ?? "#e8d8b0").setAlpha(affordable ? 1 : 0.5);
      row.price.setText(`${o.price}g`).setColor(affordable ? (onSale ? "#7dffa8" : "#ffd24a") : "#c05a5a");
      row.desc
        .setText(onSale ? `SALE · was ${o.basePrice}g · ${describeItem(o.itemId)}` : describeItem(o.itemId))
        .setColor(onSale ? "#c9a94a" : "#7f8896")
        .setAlpha(affordable ? 1 : 0.5);
    });

    this.rerollRow.setText(`[R] Reroll unsold — ${REROLL_COST}g`);
    this.rerollRow.setColor(gold >= REROLL_COST ? "#9aa2ae" : "#6a4a4a");
  }
}
