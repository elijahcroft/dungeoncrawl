# Co-op Boss Game

Browser-based, networked co-op boss-fighting game (Phaser 3 + Colyseus). Built to run on
your laptop during class — students connect from their own laptops over local wifi.

## Structure

```
/client   Phaser 3 + TypeScript game client (Vite)
/server   Colyseus multiplayer server (Node.js + TypeScript)
/data     JSON content: bosses, items, dungeons (data-driven design, see project plan)
```

## Setup

From the repo root (this is an npm workspace — one install covers both client and server):

```
npm install
```

## Running it

Run both client and server together:

```
npm run dev
```

Or run them separately in two terminals:

```
npm run dev:client   # Vite dev server, http://localhost:5173
npm run dev:server   # Colyseus server, ws://localhost:2567
```

Open `http://localhost:5173` in your browser to play.

## Classroom admin mode

Students now join a shared lobby. They can choose name/color/class, but not the dungeon.
Open `http://localhost:5173/admin` (or `?admin=1`) to connect as the admin and launch the
whole lobby into a dungeon.

The default admin PIN is `teacher`. Override it when starting the server:

```
ADMIN_PIN=your-pin npm run dev:server
```

Admin controls include dungeon launch, return to lobby, restart, next room, open exit,
heal all, clear enemies, gather players at the entrance, and send a notice banner. The
admin page also has a visual dungeon builder with a drag/drop room stage, room reordering,
wall/entrance/exit/enemy/boss/item placement, reusable room templates saved in
`data/rooms.json`, and a raw JSON fallback that saves complete dungeons to
`data/dungeons.json`.

## Letting a second laptop join over wifi

1. Make sure both laptops are on the same wifi network.
2. On your laptop (running the server), find your local IP address:
   - macOS: `ipconfig getifaddr en0` (or check System Settings → Wi-Fi → Details)
   - Linux: `hostname -I`
   - Windows: `ipconfig` and look for "IPv4 Address"
3. On the other laptop's browser, go to `http://<your-local-ip>:5173`.

To actually play multiplayer, run `npm run dev` (or both `dev:client`/`dev:server`) so the
Colyseus server is up — the client falls back to single-player if it can't connect.

## Current status

- **Phases 1–8 (done):** Core combat feel, Colyseus networking, data-driven Boss/Item/Dungeon
  JSON systems, a fully juiced first boss (Ashen Sentinel), server-authoritative co-op combat
  (one shared boss/enemy state everyone sees identically), and playtest-readiness (respawn,
  room reset, reconnect grace).
- **Phase 9 (done):** Multi-room dungeon system — a run is a sequence of rooms (`arena` /
  `rest` / `boss` / `treasure`), each with its own layout (`walls`), an entrance, and an exit
  doorway players walk into together once the room is cleared. Room progression, enemy
  spawning, and item pickups are all server-authoritative and fully data-driven from
  `data/dungeons.json`.
- **Phase 10 (done):** Content authoring pass — a second boss (Hollow Warden), `items.json`
  with an auto-pickup equip loop, a second longer dungeon (The Sable Crypt), and
  `data/SCHEMA.md` documenting every JSON schema so new content needs zero code changes.
- **Phase 11 (partial, by design — it's a menu, not a checklist):** Player classes
  (Warrior/Guardian/Cleric, chosen on the join screen), character customization (name + color),
  and boss/enemy HP scaling by player count. The rest of the Phase 11 backlog (revive
  mechanic, spectator mode, persistent progression, etc.) is optional future work.
- **Classroom admin mode (done):** Students land in one shared lobby while an admin launches
  the active dungeon, edits dungeon JSON, and can operate the run live with reset/heal/advance
  controls.
- **Player sprites (done):** Procedurally-drawn 2-frame character sprites (head/body/legs,
  facing flip, walk animation) replace the original flat-color rectangles for players and
  enemies — see `client/src/gfx/sprites.ts`.

See `soulslike-boss-game-plan.md` and `NEXT-STEPS.md` for the full plan and history, and
`data/SCHEMA.md` for how to add bosses/enemies/dungeons/items.

## Controls

- `WASD` — move
- `SPACE` — dodge roll (grants brief invulnerability, costs stamina)
- `J` — attack with the equipped weapon (costs stamina)
- `K` — use your class ability
- `E` — use a healing charge (picked up from consumable items; carry up to 3)
- `M` — mute/unmute sound
- `R` — retry/rematch after an offline (single-player) duel ends
- `ESC` — toggle the controls overlay

On load you'll pick a name, color, and class before entering the shared lobby. The admin
launches everyone into a dungeon. Clear each room to open its exit (it glows green) and walk
through together to advance; wipe the party and the run resets to the dungeon's first room.
Enemies telegraph (turn yellow) before they attack (turn red) — dodge through the attack or
step out of range.

## How the networking works

- Movement is **client-authoritative**: each player simulates their own physics locally
  (for responsiveness) and broadcasts position/facing/rolling state to the server ~20x/sec.
  Other clients render that as a lerped, name-tagged "remote player" sprite.
- **Everything else is server-authoritative**: the Colyseus room (`DungeonRoom`) runs the
  same JSON-driven boss/enemy state machine (`shared/boss.ts`) for every enemy in the current
  room, decides when attacks land, tracks room/run progression, and resolves item pickups.
  Landing a melee hit sends an `enemy_hit` message naming the target; the server is the single
  source of truth for HP. This is what makes co-op consistent — every player sees the same
  telegraph, at the same time, targeting the same player.
- If the server isn't running, the client silently falls back to a single-player offline
  fallback fight (check the small status text at the top of the game canvas).

### A note on dependency versions

Colyseus's newest release line (`colyseus`/`@colyseus/schema` 0.17.x/4.x) is ahead of what
the `colyseus.js` client SDK currently supports (it tops out around 0.16). To keep client
and server wire-compatible, this project pins both sides to the older, more battle-tested
`colyseus`/`colyseus.js` 0.15.x + `@colyseus/schema` 2.x line rather than the bleeding edge.
Also worth knowing if you touch the schema classes: they rely on legacy TypeScript
decorators (`experimentalDecorators: true`), which requires `useDefineForClassFields: false`
in both tsconfigs — without it, TS's ES2022 class-field emit silently shadows the decorator-
installed property accessors that `@colyseus/schema` needs for change-tracking, and state
sync just quietly does nothing (no errors, values never update). Both tsconfigs already have
this set; don't remove it.
# dungeoncrawl
