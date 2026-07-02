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

- **Phase 1 (done):** Single-player core combat feel — movement, dodge roll with i-frames,
  stamina bar, placeholder "dummy" boss with a telegraphed melee attack.
- **Phase 2 (done):** Colyseus networking — 2-player room, synced positions/state, a
  shared/authoritative boss HP bar, and basic reconnect handling (page refresh within ~20s
  rejoins your same player instead of spawning a duplicate).
- **Phase 3:** Data-driven Boss/Item/Dungeon JSON loader system.
- **Phase 4:** First real boss with multiple attacks + a phase transition, plus "juice"
  (hit-stop, screen shake, particles).

See `soulslike-boss-game-plan.md` for the full plan.

## Controls

- `WASD` — move
- `SPACE` — dodge roll (grants brief invulnerability, costs stamina)
- `J` — melee attack (costs stamina)

Fight the red dummy boss in the arena. It telegraphs (turns yellow) before it attacks
(turns red) — dodge through the attack or step out of range. Getting hit briefly turns you
red and gives you a moment of invulnerability so you can't be juggled by back-to-back hits.

## How the networking works (Phase 2)

- Movement is **client-authoritative**: each player simulates their own physics locally
  (for responsiveness) and broadcasts position/facing/rolling state to the server ~20x/sec.
  Other clients render that as a lerped "remote player" rectangle (green).
- The **dummy boss's HP is server-authoritative**: landing a hit sends a `boss_hit` message
  to the server, which is the single source of truth for HP. Each client still runs its own
  local copy of the boss's telegraph/attack timing for visuals — a deliberate simplification
  for the MVP, not true server-side boss AI (that's a natural upgrade once the data-driven
  Boss system lands in Phase 3/4, since the server could then run the same JSON-driven state
  machine authoritatively).
- If the server isn't running, the client silently falls back to the Phase 1 single-player
  mode (check the small status text at the top of the game canvas).

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
