# Co-op Boss Game — Next Steps

Written 2026-07-02. Follow-up to `soulslike-boss-game-plan.md`.

## Where we actually are

The original MVP plan (Phases 1–5) is **code-complete but not playtested**. What's built:

- **Phase 1 — core feel:** movement, dodge roll + i-frames, stamina, melee attack. ✅
- **Phase 2 — networking:** Colyseus 2-player room, synced positions, server-authoritative
  boss HP, ~20s reconnect grace. ✅
- **Phase 3 — data-driven boss:** generic `Boss` class runs a JSON-driven state machine
  (`idle → telegraph → attack → recover`, phase transitions at HP thresholds). Boss loaded
  from `data/bosses.json`. `DummyBoss.ts` removed. ✅
- **Phase 4 — real boss + juice:** "Ashen Sentinel" — 2 attacks (`slam`, `dash`), phase
  transition at 50% HP (color + enraged variants), hit-stop, screen shake, hit/dodge
  particles. ✅
- **Phase 5 — playtest:** not done yet.

Note: `README.md` still lists Phase 3/4 as pending — it's stale and should be updated.
The Phase 3/4 work is also **uncommitted** (see `git status`) — commit it before building on it.

## The one architectural problem to fix first

**The boss is not actually synced in co-op.** Each client runs its *own* local copy of the
boss state machine and feeds it *its own local player's* position
(`this.boss.update(localPlayerX, localPlayerY)` in `GameScene.update`). Only `bossHp` is
server-authoritative.

Consequences in a real 2-player fight:
- Players see **different telegraphs and different attacks** at different times.
- The boss chases a **different target** on each screen.
- Damage/hit registration is per-client and inconsistent.

For a co-op class playtest this reads as "broken/unfair," which is exactly the failure the
plan warns about. This must be fixed before students play together.

---

## Proposed phase order

### Phase 6 — Server-authoritative boss (the co-op fix) ⭐ highest priority

Move the boss state machine from the client into the Colyseus room so all players see one
shared, consistent fight.

1. **Port the `Boss` state machine to the server.** The server already reads `bosses.json`
   for HP; extend it to load the full boss def and run the same `idle → telegraph → attack
   → recover` loop the client currently runs. Keep it framework-agnostic (plain
   TS + a fixed-timestep tick via `this.setSimulationInterval`), not Phaser-dependent.
   - Goal: **one `Boss` state machine, ideally shared between client and server.** Extract
     the pure logic (timing, phase selection, target choice) out of the Phaser-coupled
     `client/src/entities/Boss.ts` into a shared module both sides import. This protects the
     "new boss = new JSON" principle — otherwise the logic forks.
2. **Sync boss state over schema:** add `bossX`, `bossY`, `bossState`
   (`idle`/`telegraph`/`attack`/`recover`/`dead`), `bossPhase`, and `currentAttackId` to
   `BossRoomState`. Client renders the boss purely from synced state (position, color by
   state) instead of simulating it.
3. **Server-side target selection:** boss picks the nearest living player as its target each
   attack. This is where co-op tactics emerge (aggro management).
4. **Server-authoritative attack hits:** when the boss's attack goes active, the *server*
   checks range against player positions and applies damage to `PlayerState.hp`. Remove the
   client-side `boss.onAttack` damage path. Player melee → boss damage can stay
   client-reported for now (already works), but note it's spoofable — fine for a trusted
   classroom.
5. Keep single-player fallback working: when offline, the client still runs the boss locally
   (reuse the shared logic module).

**Verify:** open two browser tabs against the running server; confirm both see the boss in
the same position, telegraphing the same attack at the same time, targeting the same player.

### Phase 7 — Playtest-readiness (no more "refresh to retry")

1. **Respawn / retry:** on player death, allow respawn (after a short delay, or when the boss
   resets) instead of forcing a page refresh.
2. **Room reset flow:** when the boss dies or all players die, server resets `bossHp`, boss
   state, and player HP so the room can immediately re-fight. A shared "VICTORY / WIPE —
   restarting in 5…" banner.
3. **Basic lobby feel:** show connected player count; handle a player leaving mid-fight
   gracefully (boss retargets).
4. Consider raising `maxClients` above 2 if you want more than 2 students per boss — decide
   based on how it feels (the arena is 960×640).

**Verify:** die on purpose, confirm you rejoin the fight without refreshing; kill the boss,
confirm the room resets for another round.

### Phase 8 — Playtest with students (Phase 5 from the original plan)

Run it in class. Watch for: co-op coordination breakdowns, attacks that read as unfair vs.
just hard, network hiccups on school wifi, how many students one room comfortably holds.
Take notes; let findings drive Phase 9.

### Phase 9 — Multiple rooms / dungeon system ⭐ (the "more rooms" ask)

Right now there's a single hardcoded arena (`960×640`, one boss spawned at center). Turn that
into a **data-driven multi-room dungeon** so a run is a sequence of rooms, not one fight.

**9a — Room as data.** Create `data/dungeons.json`. A dungeon is an ordered (or branching)
list of rooms; each room declares:
```
{
  "id": "ashen-halls",
  "name": "The Ashen Halls",
  "rooms": [
    { "id": "r1", "type": "boss",   "boss": "dummy",    "next": "r2" },
    { "id": "r2", "type": "arena",  "spawns": ["grunt","grunt"], "next": "r3" },
    { "id": "r3", "type": "rest",   "next": "r4" },
    { "id": "r4", "type": "boss",   "boss": "sentinel", "next": null }
  ]
}
```
Room `type` drives behavior: `boss` (fight one boss), `arena` (clear waves of minor enemies),
`rest` (heal / regroup, no combat), later `treasure` (loot).

**9b — Room transitions.** When a room is cleared (boss/enemies dead), open an **exit** the
players walk into to advance. Server tracks `currentRoomId`, resets/loads the next room's
enemies, repositions players at the entrance. All clients transition together (it's a shared
run). A short "cleared!" beat + fade between rooms.

**9c — Room geometry.** Give rooms real layout instead of an empty box: walls/obstacles the
player and boss collide with, entrance/exit doorways, hazard tiles. Start simple — a tile
grid or a list of wall rectangles in the room JSON — so students can lay out a room in data.

**9d — Non-boss enemies.** `arena` rooms need lightweight enemies (`data/enemies.json`, reuse
the boss state-machine engine with cheaper stats). This makes the space between bosses
interesting and teaches aggro/positioning before the boss.

**9e — Run state & flow.** Track progress through the dungeon on the server: current room,
players alive, run start time. On a full wipe, the run ends (back to room 1 or a lobby). On
clearing the final room, a victory screen with clear time.

**Verify:** start a run with 2 players, clear room 1's boss, walk through the exit together,
confirm room 2 loads with fresh enemies and both clients are in sync; wipe and confirm the
run resets.

### Phase 10 — Content + authoring (data-driven expansion)

Only after the loop is proven fun. All of this rides on the JSON systems above:
1. **More bosses**, authored entirely in `bosses.json` — ideally done live with students to
   prove the "new boss = new JSON" workflow. Add a `?boss=<id>` / `?dungeon=<id>` URL param
   or a simple select menu.
2. **`items.json`** — stat modifiers + effect type + icon. Pickups drop in `treasure` rooms;
   minimal equip loop (attack up, max-HP up, faster roll, etc.).
3. **More dungeons** in `dungeons.json` — different room orders, themes, difficulty tiers.
4. Document all JSON schemas in one place so students can author without reading game code.

### Phase 11 — Broader feature backlog

Pick from these as the game grows — roughly ordered by bang-for-buck:

- **Player classes / loadouts** — a few starting stat sets (tank, fast/glass-cannon) chosen
  at join. Cheap, adds co-op role variety.
- **Character customization** — pick a color/name so students recognize their own square.
- **More attack options** — a heavy attack, a ranged/projectile attack, a parry. Each opens
  new boss-design space.
- **Boss variety mechanics** — projectiles, AoE ground telegraphs, summoned adds, multi-hit
  combos, arena hazards tied to phases.
- **Revive mechanic** — down-but-not-dead; a teammate stands on you to revive. Strong co-op
  tension, encourages sticking together.
- **Difficulty scaling by player count** — boss HP/damage scales with how many joined.
- **Persistent progression** — unlock bosses/items across runs (localStorage or a simple
  server-side save). Optional; adds a reason to come back.
- **Scoreboard / clear times** — leaderboard of fastest dungeon clears per class.
- **Spectator mode** — dead players watch teammates instead of staring at a wipe screen.
- **In-game boss/room editor** — a debug UI to tweak JSON live and reload. This is the
  ultimate payoff of the data-driven design for a classroom.

### Phase 12 — Polish pass

Sprites/animations to replace rectangles, sound effects (hit, dodge, boss telegraph, room
clear, death), a proper title/lobby/end screen, camera that frames the arena. This is the
"reads as polished" layer — worth it once the game is proven and content-rich.

---

## Note on scope

That's a long list on purpose — treat Phases 11–12 as a menu, not a checklist. The dependency
order that matters is: **fix co-op (6) → retry loop (7) → playtest (8) → rooms/dungeon (9)**.
Everything after that is optional expansion driven by what students actually enjoy.

---

## Quick wins worth doing regardless of order

- **Commit the Phase 3/4 work** — it's currently uncommitted.
- **Update `README.md`** status section (Phase 3/4 are done, not pending).
- The `dummy` boss entry in `bosses.json` is now unused (game loads `sentinel`). Keep it as a
  simple test boss or a template for students, but note it in a comment/doc.

## Suggested immediate next action

Fix co-op first (Phase 6) — it's the difference between "a demo" and "something a class can
actually play together." If a playtest is imminent and there's no time for the rework, do
Phase 7's retry loop first so at least the single-consistent-client experience is smooth,
and run a smaller playtest.
