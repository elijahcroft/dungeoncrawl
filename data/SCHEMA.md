# Data schemas

Everything here is plain JSON — add content by editing these files, no code changes needed.

## bosses.json

```
{
  "<bossId>": {
    "id": "<bossId>",
    "name": "Display Name",
    "hpMax": 220,
    "aggroRange": 260,          // px — boss starts telegraphing once a player is this close
    "color": "0x8855cc",        // base tint, hex string
    "attacks": {
      "<attackId>": {
        "telegraphMs": 650,     // wind-up before the hit lands
        "activeMs": 180,        // hitbox is live during this window
        "recoverMs": 550,       // vulnerable/cooldown after the hit
        "cooldownMs": 1200,     // minimum time before this attack can repeat
        "damage": 16,
        "range": 100,           // px, hitbox radius from boss position
        "animationKey": "slam", // cosmetic tag, not required to be unique
        "dashSpeed": 520,       // optional — boss charges toward the target during "attack"
        "impactAtEnd": true,    // optional — hitbox lands on the LAST active tick (use with animationKey "jump" leaps)
        "summon": { "enemyId": "slimeling", "count": 3 }, // optional — spawn minions (ids from enemies.json) when the hit lands
        "rangeMin": 64,         // optional — donut hitbox: safe closer than this (players dodge by hugging the boss)
        "groundTarget": true,   // optional — blast lands where the target STOOD at telegraph start, not at the boss
        "castRange": 300,       // optional — how close a chasing enemy gets before using this attack (defaults to range;
                                //            set it when groundTarget makes "range" a blast radius rather than a reach)
        "blink": "away",        // optional — teleport at telegraph start: "target" pops behind the target, "away" retreats
        "hits": 3,              // optional — fire the hitbox this many times across the active window (default 1)
        "hitIntervalMs": 350,   // optional — spacing between multi-hits (defaults to activeMs / hits)
        "projectile": {         // optional — fire dodgeable bolts instead of a radial hit; "range" = max travel distance
          "speed": 320,         //   px/sec
          "radius": 10,         //   bolt hit radius
          "count": 3,           //   bolts per volley (default 1)
          "spreadDeg": 26,      //   total fan angle across the volley (default 0)
          "color": "0xff7733"   //   cosmetic bolt tint
        }
      }
    },
    "phases": [
      { "hpThreshold": 100, "attacks": ["slam", "dash"], "color": "0x8855cc" },
      { "hpThreshold": 50,  "attacks": ["slam_enraged"], "color": "0xcc3355" }
    ],
    "visual": { "bodyShape": "hulking", "weapon": "club", "accessory": "spikes" }
  }
}
```
Phases are sorted by `hpThreshold` and the first one whose threshold is `>=` current HP% is active — so list them highest to lowest.

`animationKey` is mostly a free cosmetic tag, but the client gives two values special FX: `"jump"` renders the boss sprite as a real airborne leap (arc + squash/stretch, grounded shadow you dodge, crash shockwave on landing — pair it with `impactAtEnd: true`), and `"summon"` plays a goo-burst pulse (pair it with a `summon` block). See `slime_king` in `bosses.json` for a worked example.

The newer mechanic fields also drive their own telegraphs and FX automatically: `projectile` attacks show a charge-up pulse then launch glowing bolts (roll through them — i-frames eat bolts), `groundTarget` attacks draw the filling danger circle at the marked spot, `rangeMin` donuts draw a red ring with a green safe-zone boundary, `blink` pops the sprite with a teleport flash, and `hits > 1` pulses the danger zone for the whole active window with a shockwave per hit. Worked examples: `ember_lich` (projectiles + ground-target + blink + donut), `gravelord` (multi-hit stomp + donut quake + summon), `broodmother` (projectile spit + leap + summon), and the `archer` / `imp` / `husk` entries in `enemies.json`.

`visual` is optional and purely cosmetic — see **Character visuals** below. If a boss id has a matching entry in `boss-art.json`, that hand-authored art is used instead and `visual` is ignored for that boss.

## enemies.json

Same shape as one boss entry (`hpMax`, `aggroRange`, `color`, `attacks`, `phases`, `visual`) — these are cheaper, non-boss enemies spawned in `arena` rooms. They reuse the exact same state-machine engine as bosses.

## Character visuals

There are two ways to give an enemy or boss an appearance. Pick based on how much it matters that this one look distinct.

### 1. `visual` recipe (grunts, trash mobs, quick variety)

Add a `visual` object to any entry in `bosses.json` or `enemies.json`. It's rendered procedurally (no art files) by `client/src/gfx/sprites.ts`, so it's just parameters — safe for a mob you want visual variety on without hand-drawing anything.

```
"visual": {
  "bodyShape": "slim" | "stocky" | "hulking" | "hunched" | "blob",  // default "stocky"; "blob" = gelatinous goo (slimes), no weapon/legs
  "size": 1.0,               // uniform scale multiplier, default 1
  "palette": {
    "body": "0x669944",      // main color — falls back to the entry's top-level "color"
    "trim": "0x2e4a20",       // weapon/accessory/markings color — falls back to a darkened body color
    "skin": "0xe0b58c",       // head color
    "eyes": "0xffee88"
  },
  "weapon": "none" | "claw" | "blade" | "club" | "spear" | "axe",
  "accessory": "none" | "horns" | "spikes" | "hood" | "mask" | "mane",
  "markings": "none" | "stripes" | "spots" | "scars"
}
```
Everything is optional — omit `visual` entirely and you get the old flat-color default body. Mix and match freely; there's no wrong combination, this is meant to be cheap to iterate on. Purely cosmetic, never affects combat.

### 2. Hand-authored SVG art (bosses you want to look unique)

For a boss worth the extra effort, add an entry to **`boss-art.json`** keyed by the boss's `id`, containing a raw SVG markup string. This overrides `visual` for that boss.

Contract every boss SVG must follow so it rasterizes consistently:
- Root `<svg>` must declare `viewBox='0 0 96 120' width='96' height='120'` — that's the fixed canvas every boss renders into (see `BOSS_ART_WIDTH`/`BOSS_ART_HEIGHT` in `client/src/gfx/sprites.ts`).
- Character faces **right**, feet near the bottom of the canvas (~y=108-112), roughly centered horizontally around x=48. The client flips the sprite automatically when the boss moves left.
- Stick to basic shapes only: `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, `<path>` (straight/curve commands, no external refs), `<line>`, with `fill`/`stroke`/`opacity` attributes. No `<text>`, no gradients, no filters, no `<image>`/external references — Phaser's SVG loader rasterizes this at load time and fancier features aren't guaranteed to render the same across browsers.
- Use single-quoted attribute values (`fill='#448866'`) so the SVG can sit inside the JSON string without escaping.
- The combat state machine tints the whole sprite (yellow on telegraph, red on attack, phase-color swaps) on top of your art via `setTint` — design the base art to still read at a glance once a flat color multiply is applied over it.

If a boss id has no `boss-art.json` entry, it silently falls back to the `visual` recipe system (or the flat-color default if that's absent too) — so adding art is purely additive, nothing breaks by skipping it.

## dungeons.json

```
{
  "<dungeonId>": {
    "id": "<dungeonId>",
    "name": "Display Name",
    "rooms": [
      {
        "id": "r1",
        "type": "arena" | "rest" | "boss" | "treasure",
        "name": "Room label shown in the HUD",
        "spawns": ["grunt", "grunt"],       // arena only — enemy ids from enemies.json
        "enemySpawns": [
          { "enemyId": "grunt", "x": 560, "y": 280 }
        ],                                  // arena only, optional exact placements
        "boss": "sentinel",                 // boss only — boss id from bosses.json
        "bossSpawn": { "x": 640, "y": 320 },// boss only, optional (defaults to 640,320)
        "item": "iron_ring",                // treasure only — item id from items.json
        "entrance": { "x": 80, "y": 320 },  // where players appear on entering this room
        "exit": { "x": 900, "y": 240, "w": 60, "h": 160 }, // walk-in zone to advance; null = last room
        "walls": [{ "x": 460, "y": 260, "w": 40, "h": 120 }] // obstacle rectangles (client-side collision)
      }
    ]
  }
}
```
Rooms play in array order. `rest` and `treasure` rooms open their exit immediately (no combat gate); `arena` and `boss` rooms open the exit once every enemy in the room is dead. The last room should have `"exit": null` — reaching that room's clear condition ends the run in victory.

`spawns` is the old compact arena format; enemies are placed by the server's default spread.
`enemySpawns` is the visual-builder format and stores exact enemy positions. If both are
present, `enemySpawns` controls placement and `spawns` is kept as a readable summary.

## rooms.json

Reusable room templates for the admin builder live here:

```
{
  "<templateId>": {
    "id": "<templateId>",
    "name": "Template Name",
    "room": {
      "id": "room-id",
      "type": "arena",
      "name": "Room Name",
      "enemySpawns": [{ "enemyId": "grunt", "x": 560, "y": 280 }],
      "entrance": { "x": 80, "y": 320 },
      "exit": { "x": 900, "y": 240, "w": 60, "h": 160 },
      "walls": []
    }
  }
}
```

Templates are not played directly. The admin page inserts a copy of a template room into the
currently edited dungeon, where it can be changed without altering the saved template.

## items.json

Two item kinds share this file — a **stat** item and a **weapon** item:
```
{
  "<itemId>": {                       // stat item: grants a persistent bonus
    "id": "<itemId>",
    "name": "Display Name",
    "color": "0xaaaaaa",              // pickup icon color
    "stat": "hpMax" | "speedPct" | "damage",
    "amount": 25
  },
  "w_<weaponId>": {                    // weapon item: swaps the carried weapon on pickup
    "id": "w_<weaponId>",
    "name": "Display Name",
    "color": "0xaaaaaa",
    "weaponId": "sword"              // must match a key in client/src/entities/weapons.ts WEAPONS
  }
}
```
Items are placed by `dungeons.json` (`treasure` rooms' `item` field, or any room's `itemSpawns` list) and auto-picked-up on walkover. Stat effects stack and persist for the rest of the run; a weapon item replaces whatever weapon the player is carrying.

Weapons themselves (damage, hitbox shape, reach, cooldown, combos) are defined in code, not data — see the `WEAPONS` table in `client/src/entities/weapons.ts`. Available weapon ids: `dagger`, `sword`, `spear`, `axe`, `mace`, `rapier`, `greatsword`, `warhammer`, `katana`, `crossbow`.

## Adding content

- **New boss** — add an entry to `bosses.json`, then reference its id from a `"type": "boss"` room in `dungeons.json`.
- **New enemy** — add an entry to `enemies.json`, reference its id from an `arena` room's `"spawns"` list.
- **New dungeon** — add an entry to `dungeons.json`, or use the admin page's Dungeon JSON editor. The admin page lists saved dungeons and launches the whole lobby into the selected dungeon.
- **New item** — add an entry to `items.json`, reference its id from a `treasure` room's `"item"` field.
- **New/better look for an enemy or boss** — add a `visual` recipe (fast) or, for a boss, an SVG entry in `boss-art.json` (more distinct) — see **Character visuals** above.

No code changes required for any of the above.
