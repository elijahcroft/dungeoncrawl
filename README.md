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

Note: as of this scaffold, the client doesn't yet connect to the Colyseus server for
multiplayer — that's Phase 2 of the build plan (see `soulslike-boss-game-plan.md`). Right
now `npm run dev:client` alone gets you the single-player combat prototype.

## Current status

- **Phase 1 (done):** Single-player core combat feel — movement, dodge roll with i-frames,
  stamina bar, placeholder "dummy" boss with a telegraphed melee attack.
- **Phase 2:** Colyseus networking (2-player room, synced state, shared boss HP).
- **Phase 3:** Data-driven Boss/Item/Dungeon JSON loader system.
- **Phase 4:** First real boss with multiple attacks + a phase transition, plus "juice"
  (hit-stop, screen shake, particles).

See `soulslike-boss-game-plan.md` for the full plan.

## Phase 1 controls (current prototype)

- `WASD` — move
- `SPACE` — dodge roll (grants brief invulnerability, costs stamina)
- `J` — melee attack (costs stamina)

Fight the red dummy boss in the arena. It telegraphs (turns yellow) before it attacks
(turns red) — dodge through the attack or step out of range. Getting hit briefly turns you
red and gives you a moment of invulnerability so you can't be juggled by back-to-back hits.
