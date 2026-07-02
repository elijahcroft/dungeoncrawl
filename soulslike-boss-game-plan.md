# Co-op Souls-like Boss Game — Project Plan

## Vision
A browser-based, networked co-op boss-fighting game for students to jump into during downtime. Each student joins from their own laptop, fights bosses together, and the whole thing is built so you (Elijah) can keep adding bosses, items, and dungeons over time without touching core code.

Think *Hollow Knight*-style 2D combat feel — tight hitboxes, readable telegraphs, dodge-roll — rather than literal 3D. That's what makes "polished" achievable on a solo dev + class-hours budget.

## Tech Stack
- **Phaser 3 + TypeScript** — the game engine/client
- **Colyseus (Node.js)** — authoritative multiplayer server, room management, state sync
- **Vite** — dev server / bundler for the client
- Hosted locally on your laptop during class; students connect via your local IP over school wifi

## Core Architecture Principle: Data-Driven Content
Everything a student "adds content" to should be JSON, not code:

```
/data
  bosses.json
  items.json
  dungeons.json
```

- **bosses.json** — HP, phases, attack patterns (each attack = telegraph duration, hitbox shape/size, damage, cooldown, animation key)
- **items.json** — stat modifiers, effect type, icon reference
- **dungeons.json** — room/tile layout, spawn points, which boss + loot table lives there

One generic `Boss` class reads a boss's JSON and drives a state machine:
`idle → telegraph → attack → recover → (phase transition at HP thresholds) → repeat`

New boss = new JSON file, not new code. This is the single most important architectural decision — protect it.

## Build Phases

**Phase 1 — Core Feel (solo, no networking)**
Player movement, dodge roll with i-frames, stamina bar, one placeholder "dummy" boss to hit. This phase determines whether the game feels good at all — don't skip ahead until this is fun in isolation.

**Phase 2 — Networking**
Colyseus room setup, 2+ players synced in a shared space, shared boss HP bar, basic reconnect handling.

**Phase 3 — Data-Driven Systems**
Build the JSON schemas + generic Boss/Item/Dungeon loader classes described above.

**Phase 4 — First Real Boss + Juice**
A fully designed boss with 2-3 attack patterns and a phase transition. Add hit-stop, screen shake, particles, sound. This "juice" layer is most of what reads as "polished" — prioritize it over adding more bosses early.

**Phase 5 — Playtest & Iterate**
Run it with actual students. Watch where the co-op coordination breaks down or where a boss reads as unfair vs. hard.

## MVP Scope (what to build first)
- 2-player networked co-op
- One arena, one boss, 2 attack patterns + 1 phase transition
- Dodge roll, basic melee attack, shared boss HP bar
- No items/loot yet — that's Phase 3+, after the loop is proven fun

---

# Prompt for Claude Code

Copy everything below into Claude Code to scaffold the MVP.

```
I'm building a browser-based, networked co-op boss-fighting game (souls-like combat feel — think Hollow Knight, not 3D) for my students to play together during class downtime. Each student connects from their own laptop over local wifi.

STACK:
- Phaser 3 + TypeScript for the client
- Vite for dev server/bundling
- Colyseus (Node.js) for the multiplayer server

ARCHITECTURE REQUIREMENT (important, don't skip):
All boss/item/dungeon content must be data-driven from JSON files, not hardcoded, so I can add new content later without touching game code:
- /data/bosses.json — boss HP, phases, and attack patterns (each attack has telegraph duration, hitbox shape/size, damage, cooldown, animation key)
- /data/items.json — stat modifiers, effect type, icon reference
- /data/dungeons.json — room/tile layout, spawn points, boss + loot references

Build a generic Boss class that reads a boss definition from bosses.json and runs a state machine: idle -> telegraph -> attack -> recover -> (phase transition at HP thresholds) -> repeat. Adding a new boss should mean writing a new JSON entry, not new code.

BUILD THIS MVP, IN THIS ORDER:
1. Project scaffold: Vite + Phaser 3 + TypeScript client, and a separate Colyseus Node.js server, in a monorepo structure. Include a README with exact commands to run both (client dev server + Colyseus server) and how a second laptop joins over local wifi (i.e. how to find/enter my local IP).
2. Single-player core combat feel first: player movement, a dodge roll with i-frames, a stamina bar, and a placeholder "dummy" boss with a basic melee attack pattern I can hit and get hit by. Get this feeling responsive before anything else.
3. Add Colyseus networking: a room that supports 2 players, synced player positions/state, and a shared boss HP bar visible to both players.
4. Implement the data-driven Boss/Item/Dungeon loader system described above, and migrate the placeholder boss to be defined via bosses.json instead of hardcoded.
5. Build one real boss with 2 attack patterns and one phase transition at 50% HP, using the JSON system. Add basic "juice": hit-stop on landing a hit, light screen shake, and simple particle effects on hits/dodges.

Please work through this phase by phase, and after each phase, tell me how to test it before moving to the next. Ask me clarifying questions if anything about the movement feel, boss difficulty, or visual style is ambiguous before you make assumptions.
```

## Notes for you
- Keep the first playtest boss deliberately easy — it's a coordination/feel test with students, not a difficulty test.
- Once Phase 4 lands, adding a second boss is a great "next session" task to do live with students who are curious about the code.
