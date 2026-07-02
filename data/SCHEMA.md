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
        "dashSpeed": 520        // optional — boss charges toward the target during "attack"
      }
    },
    "phases": [
      { "hpThreshold": 100, "attacks": ["slam", "dash"], "color": "0x8855cc" },
      { "hpThreshold": 50,  "attacks": ["slam_enraged"], "color": "0xcc3355" }
    ]
  }
}
```
Phases are sorted by `hpThreshold` and the first one whose threshold is `>=` current HP% is active — so list them highest to lowest.

## enemies.json

Same shape as one boss entry (`hpMax`, `aggroRange`, `color`, `attacks`, `phases`) — these are cheaper, non-boss enemies spawned in `arena` rooms. They reuse the exact same state-machine engine as bosses.

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

## items.json

```
{
  "<itemId>": {
    "id": "<itemId>",
    "name": "Display Name",
    "color": "0xaaaaaa",              // pickup icon color
    "stat": "hpMax" | "speedPct" | "damage",
    "amount": 25
  }
}
```
Items are placed by `dungeons.json` (`treasure` rooms) and auto-picked-up on walkover. Effects stack and persist for the rest of the run.

## Adding content

- **New boss** — add an entry to `bosses.json`, then reference its id from a `"type": "boss"` room in `dungeons.json`.
- **New enemy** — add an entry to `enemies.json`, reference its id from an `arena` room's `"spawns"` list.
- **New dungeon** — add an entry to `dungeons.json` and select it from the join screen (`client/index.html` dungeon `<select>`).
- **New item** — add an entry to `items.json`, reference its id from a `treasure` room's `"item"` field.

No code changes required for any of the above.
