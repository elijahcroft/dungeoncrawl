# Economy, Secondary Items & Shop — Improvement Plan

Written 2026-07-03. Builds on `NEXT-STEPS.md` (Phase 11 backlog) and the item system
already in place (`data/items.json`, `client/src/entities/weapons.ts`).

## Where we are today

- Items are **instant-apply pickups**: walk over a ring/boots/blade and its stat bonus
  applies immediately and permanently for the run. Weapons work the same way — walking
  over one swaps your currently-held weapon.
- There is **no currency, no inventory, no consumables, and no shop**. Nothing is a
  choice — everything you touch, you get.

That's fine for an MVP but it's the single biggest thing missing before this reads as a
"real" dungeon crawler: there's no economy, no risk/reward, no build decisions.

---

## 1. Currency ("Ash" / "Souls" / pick a name)

- Enemies and bosses drop currency on death (small amount per grunt, larger per boss).
- Add `gold` (or thematic name) to `PlayerState` schema, server-authoritative like HP.
- Currency persists for the run only (resets on new run) — keep scope small at first.
- **Why first:** every other idea below (shop, consumables, rerolls) depends on having
  something to spend.

## 2. Secondary item slot (consumables)

Give each player 1–2 consumable slots separate from their weapon:

- **Potion** — heal to full / heal a flat amount, limited charges per run.
- **Stamina draught** — instant stamina refill, useful mid-boss-fight.
- **Throwable** (bomb/oil flask) — a one-off ranged AoE, reuses the `projectile`
  hitShape plumbing already built for the crossbow.
- Bind to a dedicated key (e.g. `Q`/`E`) separate from the attack button.
- Data-driven in `data/items.json` the same way weapons are — add an `itemType:
  "consumable"` field with `effect`, `charges`, `cooldownMs`.

**Why:** this is the most requested kind of item in the genre and slots cleanly into
the existing data-driven item pattern — no new architecture, just a new `itemType`.

## 3. Shop (spend currency between rooms)

- Use the existing `rest` room type (`data/dungeons.json`/`rooms.json` already have
  this room type with `itemSpawns`) as the shop location — no new room type needed.
- Rest room shows a small set of purchasable items (weapons, stat rings, consumables)
  instead of free pickups; price scales with item power.
- Server validates purchase (enough gold, item still in stock) and applies it the same
  way pickups apply today — reuse that code path.
- Optional: reroll button (spend gold to reroll the shop's offered items) for replay
  value.

**Why:** turns "loot on the floor" into a decision ("do I buy the heal or the damage
ring?"), and gives currency a sink.

## 4. Inventory / loadout screen (small UI addition)

- A simple panel (not a full inventory grid) showing: equipped weapon, equipped stat
  items, consumable charges, current gold. Toggle with `Tab` or always-visible in a
  corner (fits the existing `Bar.ts`/`BossBar.ts` UI style).
- Needed as soon as there's more than one "slot" a player can hold — otherwise players
  can't tell what they currently have equipped.

## 5. Item rarity / tiers

- Add a `rarity` field to `items.json` entries (common/rare/epic) with a color-coded
  border or name color in pickup text and shop listing.
- Rarity drives shop price and drop weighting from enemies/chests — cheap way to make
  loot feel more exciting without new mechanics.

## 6. Risk/reward room type: `treasure`

- Already mentioned as a stub in `NEXT-STEPS.md` Phase 9. A room with a guarded chest
  (a few tougher enemies) that drops a guaranteed rare item + gold — worth adding once
  currency exists, since it's a natural gold source.

## 7. Equipment slots beyond weapon (stretch)

- Right now stat items (`iron_ring`, `swift_boots`, `heavy_blade`) apply instantly and
  stack forever. Consider capping to e.g. 2 accessory slots so players choose which
  bonuses to keep, and picking up a 3rd forces a swap decision (drop or replace).
  This is a bigger change (needs UI to pick which to drop) — do after the shop ships
  and only if instant-stacking-forever starts feeling too easy.

---

## Suggested build order

1. **Currency** — server-side gold field + drops on enemy/boss death. Small, unlocks
   everything else.
2. **Secondary consumable slot** — potion + one throwable, new `itemType` in
   `items.json`, dedicated input key.
3. **Shop in rest rooms** — spend gold on weapons/rings/consumables using the existing
   rest-room + pickup-apply plumbing.
4. **Inventory/loadout HUD** — small panel so players can see gold + what they're
   holding.
5. **Rarity tiers + treasure rooms** — polish/content pass once the economy loop works.
6. **Equipment slot caps** — only if unlimited stacking turns out to trivialize runs.

Steps 1–3 are the "give the game an economy" core; 4–6 are refinement once that loop is
proven fun in a playtest.
