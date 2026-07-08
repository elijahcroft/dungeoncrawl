import * as fs from "fs";
import * as path from "path";
import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";
import { BossLogic, type BossDef, type BossTarget } from "../../../shared/boss";
import { classDef } from "../../../shared/classes";
import { abilityDef } from "../../../shared/abilities";
import { powerUpDef, powerUpModifier, rollPowerUps, xpToNext, CRIT_MULTIPLIER, type PowerUpStat } from "../../../shared/powerups";
import { weaponDef } from "../../../shared/weapons";
import type { EffectAction, EffectDef, EffectFireCtx, ModifierDef, Trigger } from "../../../shared/effects";
import { applyDamageToEnemy, applyDamageToPlayer, type DamageTag } from "./combat";

// Resolved from the server package's cwd rather than __dirname so this works
// whether running from source (tsx, src/rooms/) or the build output.
const dataDir = path.join(process.cwd(), "../data");
const dungeonsPath = path.join(dataDir, "dungeons.json");
const roomsPath = path.join(dataDir, "rooms.json");
const leaderboardPath = path.join(dataDir, "leaderboard.json");
const bossDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "bosses.json"), "utf-8")) as Record<string, BossDef>;
const enemyDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "enemies.json"), "utf-8")) as Record<string, BossDef>;
const itemDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "items.json"), "utf-8")) as Record<
  string,
  {
    id: string;
    name: string;
    color: string;
    stat?: "hpMax" | "speedPct" | "damage";
    amount?: number;
    /** When set, picking this up swaps the player's carried weapon instead of granting a stat. */
    weaponId?: string;
    /** When set, picking this up grants a consumable charge instead of an instant stat. */
    itemType?: "consumable";
    effect?: "heal";
    /** Shop price in gold. Only needed for items offered in a rest-room shop. */
    price?: number;
    /** Visual tier: common | rare | epic. Drives name colour in shop/pickups. */
    rarity?: string;
  }
>;

/** Every item with a price is fair game for a shop reroll. */
const SHOPPABLE_ITEM_IDS = Object.values(itemDefs)
  .filter((def) => typeof def.price === "number")
  .map((def) => def.id);

/** Reverse lookup weaponId → its floor-item id, used to drop a swapped-out weapon. */
const WEAPON_ITEM_BY_WEAPON_ID: Record<string, string> = {};
for (const def of Object.values(itemDefs)) {
  if (def.weaponId) WEAPON_ITEM_BY_WEAPON_ID[def.weaponId] = def.id;
}

const MAX_POTION_CHARGES = 3;
/** Number of power-up cards offered on each level-up. */
const LEVEL_UP_CHOICES = 3;

interface RoomWalls {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DungeonRoomDef {
  id: string;
  type: "arena" | "rest" | "boss" | "treasure";
  name: string;
  spawns?: string[];
  enemySpawns?: { enemyId: string; x: number; y: number }[];
  boss?: string;
  bossSpawn?: { x: number; y: number };
  item?: string;
  /** Item ids offered for sale in this room's shop (rest rooms). */
  shop?: string[];
  /** Extra floor pickups placed at fixed positions (used for weapon drops). */
  itemSpawns?: { itemId: string; x: number; y: number }[];
  entrance: { x: number; y: number };
  exit: { x: number; y: number; w: number; h: number } | null;
  walls: RoomWalls[];
  /** World-space placement of this room within the dungeon (client-only rendering). */
  offset?: { x: number; y: number };
  /**
   * Ids of the rooms this one connects to. Omit for the default linear chain
   * (room i leads to room i+1). An explicit list forks the path: all its doors
   * open on clear and the first one a player walks through commits the party.
   * An empty list marks a leaf — clearing it ends the run.
   */
  exits?: string[];
}

export interface DungeonDef {
  id: string;
  name: string;
  rooms: DungeonRoomDef[];
  /**
   * When true the dungeon never ends on a clear: clearing the last room loops
   * back to the first and each descent ratchets up enemy scaling (endlessFloor).
   * The run ends only on a party wipe.
   */
  endless?: boolean;
}

export interface RoomTemplateDef {
  id: string;
  name: string;
  room: DungeonRoomDef;
}

interface RoomLayoutSnapshot {
  entrance: { x: number; y: number };
  exit: { x: number; y: number; w: number; h: number } | null;
  walls: RoomWalls[];
}

const ROOM_TYPES = new Set(["arena", "rest", "boss", "treasure"]);
const ADMIN_PIN = process.env.ADMIN_PIN ?? "teacher";
const LOBBY_LAYOUT: RoomLayoutSnapshot = {
  entrance: { x: 480, y: 460 },
  exit: null,
  walls: [
    { x: 150, y: 150, w: 660, h: 20 },
    { x: 150, y: 470, w: 660, h: 20 },
  ],
};

let dungeonDefs = readDungeonDefs();
let roomTemplates = readRoomTemplates();

/** One recorded dungeon clear, kept for the lobby leaderboard (fastest times per dungeon). */
interface LeaderEntry {
  clearMs: number;
  party: string[];
  playerCount: number;
  at: number;
}
const LEADERBOARD_MAX = 5;
// Persisted across server restarts; shared by all rooms in this process.
const leaderboard: Record<string, LeaderEntry[]> = readLeaderboard();

function readLeaderboard(): Record<string, LeaderEntry[]> {
  try {
    if (!fs.existsSync(leaderboardPath)) return {};
    return JSON.parse(fs.readFileSync(leaderboardPath, "utf-8")) as Record<string, LeaderEntry[]>;
  } catch {
    return {};
  }
}

function writeLeaderboard() {
  try {
    fs.writeFileSync(leaderboardPath, `${JSON.stringify(leaderboard, null, 2)}\n`);
  } catch (err) {
    console.error("[DungeonRoom] leaderboard write failed:", err);
  }
}

function readDungeonDefs(): Record<string, DungeonDef> {
  return JSON.parse(fs.readFileSync(dungeonsPath, "utf-8")) as Record<string, DungeonDef>;
}

function writeDungeonDefs() {
  fs.writeFileSync(dungeonsPath, `${JSON.stringify(dungeonDefs, null, 2)}\n`);
}

function readRoomTemplates(): Record<string, RoomTemplateDef> {
  if (!fs.existsSync(roomsPath)) return {};
  return JSON.parse(fs.readFileSync(roomsPath, "utf-8")) as Record<string, RoomTemplateDef>;
}

function writeRoomTemplates() {
  fs.writeFileSync(roomsPath, `${JSON.stringify(roomTemplates, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireNumber(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a finite number`);
  }
  return value;
}

function optionalStringArray(source: Record<string, unknown>, key: string, label: string): string[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`${label}.${key} must be an array of strings`);
  }
  return value.map((entry) => entry.trim());
}

function optionalPoint(source: Record<string, unknown>, key: string, label: string): { x: number; y: number } | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label}.${key} must be an object`);
  return { x: requireNumber(value, "x", `${label}.${key}`), y: requireNumber(value, "y", `${label}.${key}`) };
}

function requirePoint(source: Record<string, unknown>, key: string, label: string): { x: number; y: number } {
  const value = optionalPoint(source, key, label);
  if (!value) throw new Error(`${label}.${key} is required`);
  return value;
}

function parseRect(value: unknown, label: string): { x: number; y: number; w: number; h: number } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    x: requireNumber(value, "x", label),
    y: requireNumber(value, "y", label),
    w: requireNumber(value, "w", label),
    h: requireNumber(value, "h", label),
  };
}

function parseItemSpawns(source: Record<string, unknown>, label: string): { itemId: string; x: number; y: number }[] | undefined {
  const value = source.itemSpawns;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label}.itemSpawns must be an array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`${label}.itemSpawns[${i}] must be an object`);
    return {
      itemId: requireString(entry, "itemId", `${label}.itemSpawns[${i}]`),
      x: requireNumber(entry, "x", `${label}.itemSpawns[${i}]`),
      y: requireNumber(entry, "y", `${label}.itemSpawns[${i}]`),
    };
  });
}

function parseEnemySpawns(source: Record<string, unknown>, label: string): { enemyId: string; x: number; y: number }[] | undefined {
  const value = source.enemySpawns;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label}.enemySpawns must be an array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`${label}.enemySpawns[${i}] must be an object`);
    return {
      enemyId: requireString(entry, "enemyId", `${label}.enemySpawns[${i}]`),
      x: requireNumber(entry, "x", `${label}.enemySpawns[${i}]`),
      y: requireNumber(entry, "y", `${label}.enemySpawns[${i}]`),
    };
  });
}

function validateRoomDef(input: unknown, label: string): DungeonRoomDef {
  if (!isRecord(input)) throw new Error(`${label} must be an object`);
  const type = requireString(input, "type", label);
  if (!ROOM_TYPES.has(type)) throw new Error(`${label}.type must be arena, rest, boss, or treasure`);
  const exitValue = input.exit;
  const wallsValue = input.walls;
  if (exitValue !== null && exitValue !== undefined && !isRecord(exitValue)) throw new Error(`${label}.exit must be an object or null`);
  if (!Array.isArray(wallsValue)) throw new Error(`${label}.walls must be an array`);

  return {
    id: requireString(input, "id", label),
    type: type as DungeonRoomDef["type"],
    name: requireString(input, "name", label),
    spawns: optionalStringArray(input, "spawns", label),
    enemySpawns: parseEnemySpawns(input, label),
    boss: typeof input.boss === "string" ? input.boss.trim() : undefined,
    bossSpawn: optionalPoint(input, "bossSpawn", label),
    item: typeof input.item === "string" ? input.item.trim() : undefined,
    shop: optionalStringArray(input, "shop", label),
    itemSpawns: parseItemSpawns(input, label),
    entrance: requirePoint(input, "entrance", label),
    exit: exitValue === null || exitValue === undefined ? null : parseRect(exitValue, `${label}.exit`),
    walls: wallsValue.map((wall, wallIndex) => parseRect(wall, `${label}.walls[${wallIndex}]`)),
    offset: optionalPoint(input, "offset", label),
    exits: optionalStringArray(input, "exits", label),
  };
}

export function validateDungeonDef(input: unknown): DungeonDef {
  if (!isRecord(input)) throw new Error("dungeon must be an object");
  const id = requireString(input, "id", "dungeon");
  const name = requireString(input, "name", "dungeon");
  if (!Array.isArray(input.rooms) || input.rooms.length === 0) {
    throw new Error("dungeon.rooms must be a non-empty array");
  }

  const rooms = input.rooms.map((entry, index) => validateRoomDef(entry, `dungeon.rooms[${index}]`));

  return { id, name, rooms, endless: input.endless === true };
}

export function validateRoomTemplateDef(input: unknown): RoomTemplateDef {
  if (!isRecord(input)) throw new Error("room template must be an object");
  const id = requireString(input, "id", "roomTemplate");
  const name = requireString(input, "name", "roomTemplate");
  return { id, name, room: validateRoomDef(input.room, "roomTemplate.room") };
}

export function isAdminPin(pin: unknown): boolean {
  return typeof pin === "string" && pin === ADMIN_PIN;
}

export function getDungeonDefs(): Record<string, DungeonDef> {
  return dungeonDefs;
}

export function getRoomTemplates(): Record<string, RoomTemplateDef> {
  return roomTemplates;
}

export function upsertDungeonDef(input: unknown): DungeonDef {
  const dungeon = validateDungeonDef(input);
  dungeonDefs = { ...dungeonDefs, [dungeon.id]: dungeon };
  writeDungeonDefs();
  return dungeon;
}

export function upsertRoomTemplateDef(input: unknown): RoomTemplateDef {
  const template = validateRoomTemplateDef(input);
  roomTemplates = { ...roomTemplates, [template.id]: template };
  writeRoomTemplates();
  return template;
}

const ROOM_W = 960;
const ROOM_H = 640;
const CORRIDOR_FALLBACK_GAP = 220; // mirrors the client when a room lacks an authored offset
const RECONNECT_GRACE_SECONDS = 20;
const SIMULATION_INTERVAL_MS = 50;
const PLAYER_HP_MAX = 100;
const RESPAWN_DELAY_MS = 3000;
const ROOM_RESET_DELAY_MS = 5000;
const ITEM_PICKUP_RADIUS = 36;
/** How many stat-accessory items a player can hold at once; a further pickup swaps the oldest. */
const ACCESSORY_SLOTS = 2;
/** A living ally within this range of a downed player fills their revive meter. */
const REVIVE_RADIUS = 44;
/** Time an ally must stand by a downed player to revive them. */
const REVIVE_TIME_MS = 2500;
/** Fraction of max HP a revived player comes back with. */
const REVIVE_HP_FRAC = 0.5;
/** Gold cost to reroll a shop's unsold offerings. */
const SHOP_REROLL_COST = 15;
/** One offering per stall is discounted to this fraction of its base price. */
const SHOP_SALE_FRACTION = 0.7;
const ENEMY_SPREAD_X = [560, 720, 640];
const ENEMY_SPREAD_Y = [280, 280, 420];
/** Ceiling on how many boss-summoned minions may be alive at once, so a summon attack can't snowball the arena. */
const MINION_CAP = 6;
/** Player count above which difficulty stops scaling, so a very full room stays winnable. */
const MAX_SCALING_PLAYERS = 8;
/** Enemy max-HP bonus per extra player beyond the first. */
const HP_SCALE_PER_PLAYER = 0.35;
/** Enemy damage bonus per extra player beyond the first (milder than HP). */
const DAMAGE_SCALE_PER_PLAYER = 0.15;
/** Endless mode: enemy max-HP bonus per floor descended, so foes get spongier the deeper you go. */
const ENDLESS_HP_SCALE_PER_FLOOR = 0.15;
/** Endless mode: enemy damage bonus per floor descended (milder than HP). */
const ENDLESS_DAMAGE_SCALE_PER_FLOOR = 0.08;
/** Emotes players can fire; the client sends an index into this list. */
const EMOTES = ["😂", "❤️", "😱", "🐔"];
/** Minimum gap between one player's emotes, so a held key can't flood the room. */
const EMOTE_COOLDOWN_MS = 600;
/** Chance an arena room spawns a fleeing Gold Gremlin alongside its enemies. */
const GREMLIN_CHANCE = 0.2;
const GREMLIN_ID = "gold_gremlin";
/** Chance an arena room rolls a wacky mutator when it loads. */
const ROOM_MUTATOR_CHANCE = 0.35;
const ROOM_MUTATORS = [
  { label: "💰 GREED — enemies drop DOUBLE GOLD!", goldScale: 2, hpScale: 1, damageScale: 1 },
  { label: "🍬 GLASS BONES — enemies are brittle but bite HARD!", goldScale: 1, hpScale: 0.5, damageScale: 1.6 },
  { label: "🗿 TITANS — beefy enemies, double gold!", goldScale: 2, hpScale: 1.8, damageScale: 1 },
];

// ── Endless mode: procedural floor generation ──────────────────────────────
/** Fixed entrance/exit for every generated floor (matches the authored single-room template). */
const ENDLESS_ENTRANCE = { x: 80, y: 320 };
const ENDLESS_EXIT = { x: 900, y: 240, w: 60, h: 160 };
/**
 * Enemy roster grouped into difficulty tiers (by base HP / threat). Higher tiers
 * unlock as the party's level + floor climbs. The Gold Gremlin is excluded here —
 * it still rolls in separately as a wildcard.
 */
const ENDLESS_ENEMY_TIERS: string[][] = [
  ["husk", "slimeling", "imp"],
  ["frost_sprite", "archer", "stalker", "grunt", "cinder_whelp"],
  ["ash_cultist", "brute", "rime_brute"],
  ["flamebound_knight"],
];
/** A breather/shop floor appears on every Nth descent so the party can heal and spend gold. */
const ENDLESS_REST_EVERY = 4;
/** Curated wall layouts a generated arena floor picks from (all keep entrance/exit reachable). */
const ENDLESS_LAYOUTS: RoomWalls[][] = [
  [],
  [{ x: 340, y: 110, w: 40, h: 170 }, { x: 340, y: 360, w: 40, h: 170 }, { x: 620, y: 210, w: 40, h: 220 }],
  [
    { x: 340, y: 140, w: 40, h: 140 },
    { x: 340, y: 360, w: 40, h: 140 },
    { x: 660, y: 140, w: 40, h: 140 },
    { x: 660, y: 360, w: 40, h: 140 },
  ],
  [{ x: 450, y: 260, w: 60, h: 120 }],
  [{ x: 260, y: 110, w: 40, h: 170 }, { x: 620, y: 360, w: 40, h: 170 }],
];
/** Flavour names for generated arena floors. */
const ENDLESS_ROOM_NAMES = [
  "Shifting Hollow",
  "Sunless Pit",
  "Collapsed Vault",
  "Forgotten Crossing",
  "Echoing Cavern",
  "Ashen Gallery",
];

/** Pick up to `n` distinct random entries from a list (order shuffled). */
function pickSome<T>(items: T[], n: number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Pick a random enemy id for an endless floor. Draws from tiers up to `maxTier`,
 * with a bias toward the higher unlocked tiers so deeper/stronger parties meet
 * proportionally tougher foes.
 */
function pickEndlessEnemy(maxTier: number): string {
  const tier = Math.min(maxTier, Math.floor(Math.random() * (maxTier + 1)) + (Math.random() < 0.35 ? 1 : 0));
  const pool = ENDLESS_ENEMY_TIERS[tier];
  return pool[Math.floor(Math.random() * pool.length)];
}

export class PlayerState extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") teleportId = 0;
  @type("number") facingX = 0;
  @type("number") facingY = 1;
  @type("boolean") rolling = false;
  @type("number") hp = PLAYER_HP_MAX;
  @type("number") hpMax = PLAYER_HP_MAX;
  @type("string") name = "Player";
  @type("string") color = "0x4da6ff";
  @type("string") trimColor = "0xe2e8f2";
  @type("boolean") cape = true;
  @type("string") className = "warrior";
  @type("number") bonusDamage = 0;
  @type("number") bonusSpeedPct = 0;
  @type("string") weaponId = "sword";
  @type("number") lastHitX = 0;
  @type("number") lastHitY = 0;
  @type("number") lastHitSeq = 0;
  @type("number") gold = 0;
  @type("number") potionCharges = 0;
  /** Equipped stat accessories (item ids); "" means an empty slot. Capped at ACCESSORY_SLOTS. */
  @type("string") accessory0 = "";
  @type("string") accessory1 = "";
  /** Roguelite progression: current level, XP toward the next level, and its threshold. */
  @type("number") level = 1;
  @type("number") xp = 0;
  @type("number") xpToNext = xpToNext(1);
  /** Level-up choices awaiting a pick (>0 means the client should show the picker). */
  @type("number") pendingLevelUps = 0;
  /** Comma-separated ids of power-ups chosen this run; folded into recomputeStats. */
  @type("string") powerUpIds = "";
  /** 0..1 revive meter, filled while a living ally stands over this downed player. */
  @type("number") reviveProgress = 0;
  /** True while the Guardian's Guard ability window is active (damage immunity + ally shield visual). */
  @type("boolean") guarding = false;
  /** Roguelite power-up stats folded in by recomputeStats (mirrors bonusDamage). */
  @type("number") bonusAttackSpeedPct = 0;
  @type("number") critChancePct = 0;
  @type("number") lifestealPct = 0;
  @type("number") cdrPct = 0;
  @type("number") regenPerSec = 0;
}

export class EnemyState extends Schema {
  @type("string") id = "";
  @type("string") defId = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") hp = 0;
  @type("number") hpMax = 0;
  @type("string") state = "idle";
  @type("string") currentAttackId = "";
  @type("boolean") isBoss = false;
  @type("number") phaseIndex = 0;
  @type("number") aimX = 0;
  @type("number") aimY = 0;
}

export class ProjectileState extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") radius = 8;
  @type("string") color = "0xffffff";
}

export class ItemPickupState extends Schema {
  @type("string") id = "";
  @type("string") itemId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("boolean") taken = false;
}

export class ShopOfferingState extends Schema {
  @type("string") id = "";
  @type("string") itemId = "";
  @type("string") name = "";
  @type("number") price = 0;
  /** Undiscounted price; price < basePrice marks the stall's sale slot. */
  @type("number") basePrice = 0;
  @type("boolean") sold = false;
  @type("string") rarity = "common";
}

export class DungeonRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: EnemyState }) enemies = new MapSchema<EnemyState>();
  @type({ map: ItemPickupState }) items = new MapSchema<ItemPickupState>();
  @type({ map: ProjectileState }) projectiles = new MapSchema<ProjectileState>();
  @type({ map: ShopOfferingState }) shop = new MapSchema<ShopOfferingState>();
  @type("string") dungeonId = "";
  @type("string") dungeonName = "";
  @type("string") roomId = "";
  @type("string") roomName = "";
  @type("string") roomType = "";
  @type("number") roomIndex = 0;
  @type("number") roomCount = 0;
  @type("string") roomLayoutJson = "";
  @type("number") roomRevision = 0;
  @type("boolean") exitOpen = false;
  @type("string") runPhase = "lobby"; // lobby | playing | wiped | victory
  @type("number") resetAt = 0;
  @type("number") clearTimeMs = 0;
  @type("number") adminCount = 0;
  @type("string") adminNotice = "";
  @type("number") adminNoticeId = 0;
  /** JSON of fastest clears per dungeon, shown on the lobby leaderboard. */
  @type("string") leaderboardJson = "";
}

interface MoveMessage {
  x: number;
  y: number;
  facingX: number;
  facingY: number;
  rolling: boolean;
}

/** Per-player tally accumulated across one run, snapshotted into the end-of-run scoreboard. */
export interface RunStats {
  damageDealt: number;
  kills: number;
  revives: number;
  deaths: number;
  goldEarned: number;
  biggestHit: number;
}

interface JoinOptions {
  role?: "player" | "admin" | "spectator";
  adminPin?: string;
  name?: string;
  color?: string;
  trimColor?: string;
  cape?: boolean;
  className?: string;
}

export class DungeonRoom extends Room<DungeonRoomState> {
  maxClients = 64;

  private dungeonDef: DungeonDef | null = null;
  /** Non-private: read by the combat pipeline (see combat.ts CombatHost). */
  enemyLogics = new Map<string, BossLogic>();
  private minionCounter = 0;
  /** Endless mode: floors descended so far (0 on the first room). Drives per-floor enemy scaling. */
  private endlessFloor = 0;
  /** Endless mode: the freshly generated room def for the current floor (null outside endless). */
  private endlessRoom: DungeonRoomDef | null = null;
  private respawnAt = new Map<string, number>();
  private runStartedAt = 0;
  private disconnecting = new Set<string>();
  private admins = new Set<string>();
  private spectators = new Set<string>();
  /** Enemy damage multiplier fixed when the current room loads (see activateRoom). Read by combat.ts. */
  enemyDamageScale = 1;
  /** Room-mutator multipliers, rolled per arena room in activateRoom. Gold scale is read by combat.ts. */
  mutatorGoldScale = 1;
  private mutatorHpScale = 1;
  private lastEmoteAt = new Map<string, number>();
  /** Per-player next-ready timestamp for the signature ability (server-side cooldown gate). */
  private abilityReadyAt = new Map<string, number>();
  /** Per-player end timestamp for an active Guard window (damage immunity). Read by combat.ts. */
  guardUntil = new Map<string, number>();
  /** Per-player run tally for the end-of-run scoreboard; reset at each run start. */
  private runStats = new Map<string, RunStats>();
  /** Power-up ids currently offered to a player (the open level-up hand); one at a time. */
  private levelUpOffer = new Map<string, string[]>();
  /** Per-player triggered effects, rebuilt by recomputeStats from the player's modifiers. */
  private playerEffects = new Map<string, EffectDef[]>();
  /** Per-player active temporary stat buffs (from tempBuff effects), expired in tick(). */
  private tempBuffs = new Map<string, { stat: PowerUpStat; amount: number; expiresAt: number }[]>();
  /** Per-player internal cooldowns for triggered effects (keyed by effect index). */
  private effectCooldowns = new Map<string, Map<string, number>>();
  /** Accumulator driving the once-per-second onTickSec trigger. */
  private tickSecAccum = 0;

  onAuth(_client: Client, options: JoinOptions) {
    const privileged = options.role === "admin" || options.role === "spectator";
    return !privileged || isAdminPin(options.adminPin);
  }

  onCreate(_options: JoinOptions) {
    this.setMetadata({ dungeonId: "lobby" });
    this.setState(new DungeonRoomState());
    this.loadLobby("Waiting for admin to launch a dungeon.");

    this.onMessage("move", (client, message: MoveMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !message) return;
      // Reject malformed payloads — one bad message must not poison synced state.
      if (![message.x, message.y, message.facingX, message.facingY].every(Number.isFinite)) return;
      player.x = message.x;
      player.y = message.y;
      player.facingX = message.facingX;
      player.facingY = message.facingY;
      const rolling = message.rolling === true;
      if (rolling && !player.rolling) this.fireEffects("onDash", client.sessionId, { x: player.x, y: player.y });
      player.rolling = rolling;
    });

    // The client reports WHICH enemy its swing/bolt/ability caught (it owns the
    // hit geometry); the server computes the damage from the attacker's synced
    // weapon/stats — a client can't name an arbitrary damage number anymore.
    this.onMessage("enemy_hit", (client, message: { enemyId?: string; kind?: string; abilityId?: string; crit?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.hp <= 0 || !message || typeof message.enemyId !== "string") return;
      const hit = this.computePlayerHit(player, message);
      if (!hit) return;
      applyDamageToEnemy(this, message.enemyId, hit.damage, {
        source: "player",
        attackerSessionId: client.sessionId,
        tags: hit.tags,
        isCrit: hit.crit,
        canTriggerEffects: true,
      });
    });

    this.onMessage("emote", (client, message: { emote?: number }) => {
      if (!this.state.players.has(client.sessionId)) return;
      const index = typeof message?.emote === "number" ? Math.floor(message.emote) : -1;
      if (index < 0 || index >= EMOTES.length) return;
      const now = Date.now();
      if (now - (this.lastEmoteAt.get(client.sessionId) ?? 0) < EMOTE_COOLDOWN_MS) return;
      this.lastEmoteAt.set(client.sessionId, now);
      this.broadcast("emote", { sessionId: client.sessionId, emote: EMOTES[index] });
    });

    // Every ability use is reported here so on-ability-use effects fire and the
    // cooldown is enforced server-side. Support abilities (heal/shield) also apply
    // their server-authoritative payload; offensive abilities deal their damage
    // through the normal `enemy_hit` path instead.
    this.onMessage("ability", (client, message: { abilityId?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.hp <= 0) return;
      const ability = abilityDef(typeof message?.abilityId === "string" ? message.abilityId : undefined);
      if (!ability) return;
      // Only the caster's own class ability is honoured — no borrowing another class's.
      if (classDef(player.className).abilityId !== ability.id) return;
      const now = Date.now();
      if (now < (this.abilityReadyAt.get(client.sessionId) ?? 0)) return;
      this.abilityReadyAt.set(client.sessionId, now + ability.cooldownMs * (1 - player.cdrPct / 100));
      this.fireEffects("onAbilityUse", client.sessionId, { x: player.x, y: player.y });
      if (ability.kind !== "heal" && ability.kind !== "shield") return;

      if (ability.kind === "heal") {
        const radius = ability.radius ?? 150;
        const amount = ability.healAmount ?? 0;
        this.state.players.forEach((other) => {
          if (other.hp <= 0) return; // heal aura doesn't revive the downed
          if (Math.hypot(other.x - player.x, other.y - player.y) > radius) return;
          other.hp = Math.min(other.hpMax, other.hp + amount);
        });
      } else {
        this.guardUntil.set(client.sessionId, now + (ability.durationMs ?? 0));
        player.guarding = true;
      }
    });

    this.onMessage("use_potion", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.hp <= 0 || player.potionCharges <= 0) return;
      const def = Object.values(itemDefs).find((item) => item.itemType === "consumable" && item.effect === "heal");
      if (!def) return;
      player.potionCharges -= 1;
      player.hp = Math.min(player.hpMax, player.hp + (def.amount ?? 0));
    });

    this.onMessage("buy", (client, message: { id?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const offer = message && typeof message.id === "string" ? this.state.shop.get(message.id) : undefined;
      if (!player || player.hp <= 0 || !offer || offer.sold) return;
      if (player.gold < offer.price) return;
      const def = itemDefs[offer.itemId];
      if (!def) return;
      player.gold -= offer.price;
      offer.sold = true;
      this.applyItemToPlayer(client.sessionId, player, def);
    });

    // Pick one power-up from the open level-up hand. Validated against the exact
    // ids we offered this player, so a client can't grant itself an arbitrary buff.
    this.onMessage("choose_powerup", (client, message: { id?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const offer = this.levelUpOffer.get(client.sessionId);
      const id = message && typeof message.id === "string" ? message.id : "";
      if (!player || !offer || !offer.includes(id)) return;
      const def = powerUpDef(id);
      if (!def) return;
      this.levelUpOffer.delete(client.sessionId);
      player.powerUpIds = player.powerUpIds ? `${player.powerUpIds},${id}` : id;
      const beforeHpMax = player.hpMax;
      this.recomputeStats(client.sessionId, player);
      // Gaining max HP heals you for the amount gained, so the pick feels rewarding.
      if (player.hp > 0 && player.hpMax > beforeHpMax) {
        player.hp = Math.min(player.hpMax, player.hp + (player.hpMax - beforeHpMax));
      }
      player.pendingLevelUps = Math.max(0, player.pendingLevelUps - 1);
      // Chain straight into the next queued level-up, if any.
      if (player.pendingLevelUps > 0) this.offerLevelUp(client, player);
    });

    this.onMessage("reroll_shop", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.hp <= 0 || this.state.shop.size === 0) return;
      if (player.gold < SHOP_REROLL_COST || SHOPPABLE_ITEM_IDS.length === 0) return;
      player.gold -= SHOP_REROLL_COST;
      // Reroll only unsold slots; already-bought items stay gone.
      this.state.shop.forEach((offer) => {
        if (offer.sold) return;
        const itemId = SHOPPABLE_ITEM_IDS[Math.floor(Math.random() * SHOPPABLE_ITEM_IDS.length)];
        this.fillOffering(offer, itemId);
      });
      this.markSaleOffering();
    });

    // Deliberate weapon pickup: swap the carried weapon and leave the old one on the
    // floor in the drop's slot so it can be grabbed again (or by an ally).
    this.onMessage("pickup_weapon", (client, message: { id?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const item = message && typeof message.id === "string" ? this.state.items.get(message.id) : undefined;
      if (!player || player.hp <= 0 || !item || item.taken) return;
      const def = itemDefs[item.itemId];
      if (!def?.weaponId) return;
      if (Math.hypot(player.x - item.x, player.y - item.y) > ITEM_PICKUP_RADIUS) return;
      const droppedItemId = WEAPON_ITEM_BY_WEAPON_ID[player.weaponId];
      player.weaponId = def.weaponId;
      if (droppedItemId) {
        item.itemId = droppedItemId; // the drop now holds the weapon we swapped out
      } else {
        item.taken = true; // starter weapon has no floor item; nothing to leave behind
      }
    });

    // PvP is only live while everyone is idling in the lobby, not mid-dungeon.
    // Same contract as enemy_hit: the client reports the hit, the server rolls the damage.
    this.onMessage("player_hit", (client, message: { targetId?: string; crit?: boolean }) => {
      if (this.state.runPhase !== "lobby") return;
      if (!message || typeof message.targetId !== "string") return;
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker || attacker.hp <= 0) return;
      const hit = this.computePlayerHit(attacker, message);
      if (!hit) return;
      applyDamageToPlayer(this, message.targetId, hit.damage, {
        source: "player",
        attackerSessionId: client.sessionId,
        tags: hit.tags,
        isCrit: hit.crit,
        canTriggerEffects: false,
        hitFromX: attacker.x,
        hitFromY: attacker.y,
      });
    });

    this.onMessage("admin_launch", (client, message: { dungeonId?: string }) => {
      if (!this.requireAdmin(client)) return;
      const dungeonId = typeof message?.dungeonId === "string" ? message.dungeonId : "";
      this.launchDungeon(dungeonId);
    });

    this.onMessage("admin_return_lobby", (client) => {
      if (!this.requireAdmin(client)) return;
      this.loadLobby("Admin returned everyone to the lobby.");
    });

    this.onMessage("admin_restart", (client) => {
      if (!this.requireAdmin(client)) return;
      if (!this.dungeonDef) return;
      this.announce(`Restarting ${this.dungeonDef.name}.`);
      this.runStartedAt = Date.now();
      this.state.runPhase = "playing";
      this.state.clearTimeMs = 0;
      this.activateRoom(0, true);
    });

    this.onMessage("admin_next_room", (client) => {
      if (!this.requireAdmin(client)) return;
      if (!this.dungeonDef || this.state.runPhase !== "playing") return;
      // Endless mode has no end: wrap past the last room back to the first.
      const nextIndex = this.exitIndices(this.state.roomIndex)[0] ?? (this.isEndless() ? 0 : undefined);
      if (nextIndex === undefined) {
        this.triggerVictory("Admin ended the dungeon.");
      } else {
        if (this.isEndless()) this.endlessFloor += 1;
        this.announce("Admin moved everyone to the next room.");
        // Admin override: pull everyone into the next room (not a walked transition).
        this.activateRoom(nextIndex);
        this.positionPlayersAt(this.worldEntrance(nextIndex));
      }
    });

    this.onMessage("admin_open_exit", (client) => {
      if (!this.requireAdmin(client)) return;
      if (this.state.runPhase !== "playing") return;
      this.state.exitOpen = true;
      this.announce("Exit opened by admin.");
    });

    this.onMessage("admin_heal_all", (client) => {
      if (!this.requireAdmin(client)) return;
      this.healAllPlayers();
      this.announce("Everyone healed.");
    });

    this.onMessage("admin_clear_enemies", (client) => {
      if (!this.requireAdmin(client)) return;
      this.enemyLogics.forEach((logic) => {
        logic.hp = 0;
      });
      this.syncEnemyStates();
      this.state.exitOpen = true;
      this.announce("Enemies cleared by admin.");
    });

    this.onMessage("admin_gather", (client) => {
      if (!this.requireAdmin(client)) return;
      this.gatherPlayers();
      this.announce("Everyone gathered.");
    });

    // Grant a specific power-up to a player by name (admin utility; also the
    // deterministic hook the headless verify harness uses to test effects).
    this.onMessage("admin_grant_powerup", (client, message: { name?: string; id?: string }) => {
      if (!this.requireAdmin(client)) return;
      const def = powerUpDef(typeof message?.id === "string" ? message.id : "");
      if (!def || typeof message?.name !== "string") return;
      this.state.players.forEach((player, sessionId) => {
        if (player.name !== message.name) return;
        player.powerUpIds = player.powerUpIds ? `${player.powerUpIds},${def.id}` : def.id;
        this.recomputeStats(sessionId, player);
      });
    });

    this.onMessage("admin_notice", (client, message: { text?: string }) => {
      if (!this.requireAdmin(client)) return;
      const text = typeof message?.text === "string" ? message.text.trim().slice(0, 80) : "";
      if (text) this.announce(text);
    });

    // A tick exception must not take the whole server (and everyone's session) down.
    this.setSimulationInterval((deltaMs) => {
      try {
        this.tick(deltaMs);
      } catch (err) {
        console.error("[DungeonRoom] tick error:", err);
      }
    }, SIMULATION_INTERVAL_MS);
  }

  private currentRoomDef(): DungeonRoomDef | null {
    return this.roomDefAt(this.state.roomIndex) ?? null;
  }

  /**
   * The room def at `index`. In endless mode every floor is a single procedurally
   * generated room (regenerated in activateRoom), so the authored `rooms` array is
   * bypassed in favour of `endlessRoom`.
   */
  private roomDefAt(index: number): DungeonRoomDef | undefined {
    if (this.isEndless()) return this.endlessRoom ?? undefined;
    return this.dungeonDef?.rooms[index];
  }

  private isEndless(): boolean {
    return this.dungeonDef?.endless === true;
  }

  /**
   * The rooms `index` leads to, as indices. Defaults to the linear next room
   * (i+1) when `exits` is omitted; an explicit `exits` list (by room id) forks
   * the path, and an empty list marks a leaf (clearing it ends the run).
   */
  private exitIndices(index: number): number[] {
    // Endless floors are single rooms: clearing one always wraps to a freshly
    // generated floor, so the current room is always a leaf.
    if (this.isEndless()) return [];
    const rooms = this.dungeonDef?.rooms ?? [];
    const room = rooms[index];
    if (!room) return [];
    if (room.exits) {
      return room.exits.map((id) => rooms.findIndex((r) => r.id === id)).filter((j) => j >= 0 && j !== index);
    }
    return index + 1 < rooms.length ? [index + 1] : [];
  }

  /** World-space placement of a room within the dungeon (authored `offset`, or a horizontal fallback). */
  private roomOffset(index: number): { x: number; y: number } {
    const room = this.roomDefAt(index);
    return room?.offset ?? { x: index * (ROOM_W + CORRIDOR_FALLBACK_GAP), y: 0 };
  }

  /** Where players appear/respawn inside a room, in world space. */
  private worldEntrance(index: number): { x: number; y: number } {
    const room = this.roomDefAt(index);
    const off = this.roomOffset(index);
    const local = room?.entrance ?? { x: 80, y: 320 };
    return { x: off.x + local.x, y: off.y + local.y };
  }

  /** True when (x, y) lies inside the given room's rect. */
  private insideRoom(index: number, x: number, y: number): boolean {
    const off = this.roomOffset(index);
    return x >= off.x && x <= off.x + ROOM_W && y >= off.y && y <= off.y + ROOM_H;
  }

  /** True when a living, connected player stands in the current room's exit rect (endless descent trigger). */
  private anyPlayerInExit(): boolean {
    const exit = this.currentRoomDef()?.exit;
    if (!exit) return false;
    const off = this.roomOffset(this.state.roomIndex);
    const x0 = off.x + exit.x;
    const y0 = off.y + exit.y;
    return [...this.state.players.entries()].some(
      ([sessionId, p]) =>
        p.hp > 0 &&
        !this.disconnecting.has(sessionId) &&
        p.x >= x0 &&
        p.x <= x0 + exit.w &&
        p.y >= y0 &&
        p.y <= y0 + exit.h,
    );
  }

  private requireAdmin(client: Client): boolean {
    if (this.admins.has(client.sessionId)) return true;
    client.send("admin_error", { message: "Admin access required." });
    return false;
  }

  private announce(message: string) {
    this.state.adminNotice = message;
    this.state.adminNoticeId += 1;
  }

  private teleportPlayer(player: PlayerState, x: number, y: number) {
    player.x = x;
    player.y = y;
    player.teleportId += 1;
  }

  private positionPlayersAt(entrance: { x: number; y: number }) {
    let i = 0;
    this.state.players.forEach((player) => {
      const column = i % 4;
      const row = Math.floor(i / 4);
      this.teleportPlayer(player, entrance.x + column * 28 - 42, entrance.y + row * 30);
      player.hp = player.hpMax;
      i += 1;
    });
  }

  private healAllPlayers() {
    this.state.players.forEach((player) => {
      player.hp = player.hpMax;
    });
    this.respawnAt.clear();
  }

  private gatherPlayers() {
    this.positionPlayersAt(this.dungeonDef ? this.worldEntrance(this.state.roomIndex) : LOBBY_LAYOUT.entrance);
  }

  private launchDungeon(dungeonId: string) {
    const dungeonDef = dungeonDefs[dungeonId];
    if (!dungeonDef) {
      this.announce(`Unknown dungeon: ${dungeonId}`);
      return;
    }
    this.dungeonDef = dungeonDef;
    this.setMetadata({ dungeonId: dungeonDef.id });
    this.state.dungeonId = dungeonDef.id;
    this.state.dungeonName = dungeonDef.name;
    // Endless floors have no fixed count — the HUD shows the floor number instead of "room X/Y".
    this.state.roomCount = dungeonDef.endless ? 0 : dungeonDef.rooms.length;
    this.state.runPhase = "playing";
    this.state.clearTimeMs = 0;
    this.state.resetAt = 0;
    this.runStartedAt = Date.now();
    this.announce(`Launching ${dungeonDef.name}.`);
    this.activateRoom(0, true);
  }

  private loadLobby(message?: string) {
    this.dungeonDef = null;
    this.setMetadata({ dungeonId: "lobby" });
    this.state.dungeonId = "";
    this.state.dungeonName = "Lobby";
    this.state.roomId = "lobby";
    this.state.roomName = "Waiting Room";
    this.state.roomType = "lobby";
    this.state.roomIndex = 0;
    this.state.roomCount = 0;
    this.state.roomLayoutJson = JSON.stringify(LOBBY_LAYOUT);
    this.state.roomRevision += 1;
    this.state.exitOpen = false;
    this.state.runPhase = "lobby";
    this.state.resetAt = 0;
    this.state.clearTimeMs = 0;
    this.state.enemies.clear();
    this.state.items.clear();
    this.state.projectiles.clear();
    this.state.shop.clear();
    this.enemyLogics.clear();
    this.minionCounter = 0;
    this.respawnAt.clear();
    this.levelUpOffer.clear();
    this.positionPlayersAt(LOBBY_LAYOUT.entrance);
    this.syncLeaderboard();
    if (message) this.announce(message);
  }

  /** Player count used to scale difficulty, clamped so a very full room stays winnable. */
  private scalingPlayerCount(): number {
    return Math.min(MAX_SCALING_PLAYERS, Math.max(1, this.state.players.size));
  }

  /** Endless mode enemy HP multiplier for the current floor (1 outside endless dungeons). */
  private endlessHpScale(): number {
    return this.isEndless() ? 1 + ENDLESS_HP_SCALE_PER_FLOOR * this.endlessFloor : 1;
  }

  /** Average current (in-run) level across the live party; 1 when empty. Drives endless generation. */
  private partyAvgLevel(): number {
    const players = [...this.state.players.values()];
    if (players.length === 0) return 1;
    return players.reduce((sum, p) => sum + p.level, 0) / players.length;
  }

  /**
   * Build a fresh floor for endless mode. Rest floors (every Nth) offer a shop and
   * a breather; arena floors get a random wall layout plus a random enemy roster
   * whose size and difficulty tier scale with the party's level and the floor depth.
   */
  private generateEndlessRoom(floor: number): DungeonRoomDef {
    const base = {
      id: `endless_${floor}`,
      entrance: { ...ENDLESS_ENTRANCE },
      exit: { ...ENDLESS_EXIT },
      offset: { x: 0, y: 0 },
    };

    if (floor > 0 && floor % ENDLESS_REST_EVERY === 0) {
      return { ...base, type: "rest", name: "Waystation", shop: pickSome(SHOPPABLE_ITEM_IDS, 4), walls: [] };
    }

    const walls = ENDLESS_LAYOUTS[Math.floor(Math.random() * ENDLESS_LAYOUTS.length)].map((w) => ({ ...w }));
    // Power drives both how many foes spawn and how tough they can be.
    const power = this.partyAvgLevel() + floor;
    const maxTier = Math.max(0, Math.min(ENDLESS_ENEMY_TIERS.length - 1, Math.floor(power / 3)));
    const count = Math.max(3, Math.min(8, 3 + Math.floor(power / 3)));
    const enemySpawns = this.endlessSpawnPositions(walls, count).map((pos) => ({
      enemyId: pickEndlessEnemy(maxTier),
      x: pos.x,
      y: pos.y,
    }));

    return {
      ...base,
      type: "arena",
      name: ENDLESS_ROOM_NAMES[Math.floor(Math.random() * ENDLESS_ROOM_NAMES.length)],
      enemySpawns,
      walls,
    };
  }

  /** Pick up to `count` open floor positions that don't overlap a wall, on a loose grid. */
  private endlessSpawnPositions(walls: RoomWalls[], count: number): { x: number; y: number }[] {
    const candidates: { x: number; y: number }[] = [];
    for (const x of [320, 480, 560, 720, 830]) {
      for (const y of [180, 320, 460]) candidates.push({ x, y });
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const clear = candidates.filter(
      (p) => !walls.some((w) => p.x >= w.x - 24 && p.x <= w.x + w.w + 24 && p.y >= w.y - 24 && p.y <= w.y + w.h + 24),
    );
    return clear.slice(0, count);
  }

  private scaledHpMax(baseHpMax: number): number {
    // Difficulty scales gently with player count so a full party doesn't trivialize fights,
    // and (in endless mode) with the floor descended so foes get spongier the deeper you go.
    return Math.round(
      baseHpMax * (1 + HP_SCALE_PER_PLAYER * (this.scalingPlayerCount() - 1)) * this.mutatorHpScale * this.endlessHpScale(),
    );
  }

  /**
   * Makes `index` the live room: clears the previous room's contents and spawns
   * this room's enemies/items in world space. Players are NOT teleported — they
   * walk in through the corridor — unless `resetPlayers` (launch/restart/wipe),
   * which resets stats and drops everyone at the room's entrance.
   */
  private activateRoom(index: number, resetPlayers = false) {
    if (!this.dungeonDef) return;
    // A fresh run resets the endless depth before any floor-scaled math or labels below.
    if (resetPlayers) this.endlessFloor = 0;
    // Endless mode: every floor is a fresh procedurally generated room at index 0.
    if (this.isEndless()) {
      this.endlessRoom = this.generateEndlessRoom(this.endlessFloor);
      index = 0;
      // The client renders endless as a single server-driven room, so broadcast its layout.
      this.state.roomLayoutJson = JSON.stringify({
        entrance: this.endlessRoom.entrance,
        exit: this.endlessRoom.exit,
        walls: this.endlessRoom.walls,
      });
    }
    const roomDef = this.roomDefAt(index)!;
    const off = this.roomOffset(index);
    this.state.roomIndex = index;
    this.state.roomId = roomDef.id;
    // Endless rooms carry the current floor in their name so the HUD/banner reads "…· Floor N".
    this.state.roomName = this.isEndless() ? `${roomDef.name} · Floor ${this.endlessFloor + 1}` : roomDef.name;
    this.state.roomType = roomDef.type;
    this.state.roomRevision += 1;
    this.state.runPhase = "playing";
    this.state.resetAt = 0;
    this.state.enemies.clear();
    this.state.items.clear();
    this.state.projectiles.clear();
    this.state.shop.clear();
    this.enemyLogics.clear();
    this.minionCounter = 0;
    this.respawnAt.clear();
    // Roll a wacky mutator for arena rooms before any scaling math uses it.
    this.mutatorGoldScale = 1;
    this.mutatorHpScale = 1;
    let mutatorDamageScale = 1;
    if (roomDef.type === "arena" && Math.random() < ROOM_MUTATOR_CHANCE) {
      const mutator = ROOM_MUTATORS[Math.floor(Math.random() * ROOM_MUTATORS.length)];
      this.mutatorGoldScale = mutator.goldScale;
      this.mutatorHpScale = mutator.hpScale;
      mutatorDamageScale = mutator.damageScale;
      this.announce(mutator.label);
    }
    // Fix the enemy damage multiplier for this room at load time so mid-fight joins/leaves don't shift it.
    // In endless mode it also climbs with the floor descended.
    const endlessDamageScale = this.isEndless() ? 1 + ENDLESS_DAMAGE_SCALE_PER_FLOOR * this.endlessFloor : 1;
    this.enemyDamageScale =
      (1 + DAMAGE_SCALE_PER_PLAYER * (this.scalingPlayerCount() - 1)) * mutatorDamageScale * endlessDamageScale;

    if (roomDef.type === "boss" && roomDef.boss && bossDefs[roomDef.boss]) {
      const def = bossDefs[roomDef.boss];
      const spawn = roomDef.bossSpawn ?? { x: 640, y: 320 };
      const logic = new BossLogic(def, off.x + spawn.x, off.y + spawn.y);
      logic.hp = this.scaledHpMax(def.hpMax);
      logic.hpMax = logic.hp;
      const id = "boss";
      this.enemyLogics.set(id, logic);
      const enemyState = new EnemyState();
      enemyState.id = id;
      enemyState.defId = def.id;
      enemyState.name = def.name;
      enemyState.isBoss = true;
      this.state.enemies.set(id, enemyState);
    } else if (roomDef.type === "arena" && (roomDef.enemySpawns || roomDef.spawns)) {
      const enemyPlacements =
        roomDef.enemySpawns ??
        roomDef.spawns?.map((defId, i) => ({
          enemyId: defId,
          x: ENEMY_SPREAD_X[i % ENEMY_SPREAD_X.length],
          y: ENEMY_SPREAD_Y[i % ENEMY_SPREAD_Y.length] + (i >= 3 ? 60 : 0),
        })) ??
        [];
      enemyPlacements.forEach((spawn, i) => {
        const defId = spawn.enemyId;
        const def = enemyDefs[defId];
        if (!def) return;
        const logic = new BossLogic(def, off.x + spawn.x, off.y + spawn.y);
        logic.hp = this.scaledHpMax(def.hpMax);
        logic.hpMax = logic.hp;
        const id = `${defId}_${i}`;
        this.enemyLogics.set(id, logic);
        const enemyState = new EnemyState();
        enemyState.id = id;
        enemyState.defId = def.id;
        enemyState.name = def.name;
        enemyState.isBoss = false;
        this.state.enemies.set(id, enemyState);
      });
      // Wildcard: a Gold Gremlin sometimes scurries in. It flees instead of
      // fighting and pays out big when caught — and the door stays shut until
      // it's dealt with, so the party has to corner it.
      if (enemyDefs[GREMLIN_ID] && Math.random() < GREMLIN_CHANCE) {
        const def = enemyDefs[GREMLIN_ID];
        const gx = off.x + 480 + (Math.random() * 240 - 120);
        const gy = off.y + 320 + (Math.random() * 160 - 80);
        const logic = new BossLogic(def, gx, gy);
        const id = "gremlin";
        this.enemyLogics.set(id, logic);
        const enemyState = new EnemyState();
        enemyState.id = id;
        enemyState.defId = def.id;
        enemyState.name = def.name;
        enemyState.isBoss = false;
        enemyState.x = gx;
        enemyState.y = gy;
        enemyState.hp = logic.hp;
        enemyState.hpMax = logic.hpMax;
        this.state.enemies.set(id, enemyState);
        this.announce("💰 A Gold Gremlin scurries in — catch it!");
      }
    } else if (roomDef.type === "treasure" && roomDef.item) {
      const item = new ItemPickupState();
      item.id = "pickup_0";
      item.itemId = roomDef.item;
      item.x = off.x + 480;
      item.y = off.y + 320;
      this.state.items.set(item.id, item);
    }

    // Shop offerings (rest rooms). Shared stock: once someone buys an offering it's gone.
    roomDef.shop?.forEach((itemId, i) => {
      if (!itemDefs[itemId]) return;
      const offer = new ShopOfferingState();
      offer.id = `shop_${i}`;
      this.fillOffering(offer, itemId);
      this.state.shop.set(offer.id, offer);
    });
    if (this.state.shop.size > 0) this.markSaleOffering();

    // Fixed-position floor pickups (weapons, extra loot) — usable in any room type.
    roomDef.itemSpawns?.forEach((spawn, i) => {
      const item = new ItemPickupState();
      item.id = `spawn_${i}`;
      item.itemId = spawn.itemId;
      item.x = off.x + spawn.x;
      item.y = off.y + spawn.y;
      this.state.items.set(item.id, item);
    });

    // A room with nothing to fight is cleared on arrival, so its door opens at once.
    this.state.exitOpen = this.enemyLogics.size === 0;

    if (resetPlayers) {
      // A fresh run starts here (launch / restart / post-wipe restart) — clear the scoreboard tally
      // and any level-up hands, temp buffs, and effect cooldowns left over from the previous run.
      this.runStats.clear();
      this.levelUpOffer.clear();
      this.tempBuffs.clear();
      this.effectCooldowns.clear();
      let i = 0;
      const entrance = this.worldEntrance(index);
      this.state.players.forEach((player, sessionId) => {
        const def = classDef(player.className);
        player.hpMax = def.hpMax;
        player.bonusDamage = 0;
        player.bonusSpeedPct = def.speedPct;
        player.weaponId = def.starterWeaponId;
        player.gold = 0;
        player.potionCharges = 0;
        player.accessory0 = "";
        player.accessory1 = "";
        player.reviveProgress = 0;
        player.level = 1;
        player.xp = 0;
        player.xpToNext = xpToNext(1);
        player.pendingLevelUps = 0;
        player.powerUpIds = "";
        // Recompute clears every derived stat (crit/lifesteal/etc.) and rebuilds
        // the (now empty) triggered-effect list for the fresh run.
        this.recomputeStats(sessionId, player);
        player.hp = player.hpMax;
        this.teleportPlayer(player, entrance.x, entrance.y + (i % 5) * 24 - 48);
        i += 1;
      });
    }

    this.syncEnemyStates();
  }

  /** Keep enemies from wandering out of their room through the doorways. */
  private clampEnemiesToRoom() {
    const off = this.roomOffset(this.state.roomIndex);
    const margin = 40;
    this.enemyLogics.forEach((logic) => {
      logic.x = Math.min(off.x + ROOM_W - margin, Math.max(off.x + margin, logic.x));
      logic.y = Math.min(off.y + ROOM_H - margin, Math.max(off.y + margin, logic.y));
    });
  }

  private syncEnemyStates() {
    const liveProjectiles = new Set<string>();
    this.enemyLogics.forEach((logic, id) => {
      const enemyState = this.state.enemies.get(id);
      if (!enemyState) return;
      enemyState.x = logic.x;
      enemyState.y = logic.y;
      enemyState.hp = logic.hp;
      enemyState.hpMax = logic.hpMax;
      enemyState.state = logic.state;
      enemyState.currentAttackId = logic.currentAttackId ?? "";
      enemyState.aimX = logic.aimX;
      enemyState.aimY = logic.aimY;
      if (enemyState.isBoss) {
        const def = logic.def;
        const sortedPhases = [...def.phases].sort((a, b) => a.hpThreshold - b.hpThreshold);
        enemyState.phaseIndex = sortedPhases.findIndex((phase) => phase === logic.phase);
      }
      // Mirror this enemy's in-flight bolts into synced state.
      for (const proj of logic.projectiles) {
        const key = `${id}:${proj.id}`;
        liveProjectiles.add(key);
        let projState = this.state.projectiles.get(key);
        if (!projState) {
          projState = new ProjectileState();
          projState.id = key;
          projState.radius = proj.radius;
          projState.color = proj.color;
          this.state.projectiles.set(key, projState);
        }
        projState.x = proj.x;
        projState.y = proj.y;
      }
    });
    this.state.projectiles.forEach((_proj, key) => {
      if (!liveProjectiles.has(key)) this.state.projectiles.delete(key);
    });
  }

  /** Spawns boss-summoned minions in a ring around (x, y), respecting the arena bounds and the live-minion cap. */
  private spawnMinions(enemyId: string, count: number, x: number, y: number) {
    const def = enemyDefs[enemyId];
    if (!def) return;
    let living = 0;
    this.enemyLogics.forEach((logic, id) => {
      if (id.startsWith("minion_") && logic.isAlive) living += 1;
    });
    const allowed = Math.max(0, Math.min(count, MINION_CAP - living));
    const off = this.roomOffset(this.state.roomIndex);
    for (let i = 0; i < allowed; i++) {
      const angle = (Math.PI * 2 * i) / Math.max(1, allowed) + Math.random() * 0.6;
      const radius = 46 + Math.random() * 26;
      const mx = Math.min(off.x + ROOM_W - 48, Math.max(off.x + 48, x + Math.cos(angle) * radius));
      const my = Math.min(off.y + ROOM_H - 48, Math.max(off.y + 48, y + Math.sin(angle) * radius));
      const logic = new BossLogic(def, mx, my);
      logic.hp = this.scaledHpMax(def.hpMax);
      logic.hpMax = logic.hp;
      const id = `minion_${this.minionCounter++}`;
      this.enemyLogics.set(id, logic);
      const enemyState = new EnemyState();
      enemyState.id = id;
      enemyState.defId = def.id;
      enemyState.name = def.name;
      enemyState.isBoss = false;
      // Seed position/HP immediately so the client's onAdd handler renders it at the spawn point, not at (0,0).
      enemyState.x = mx;
      enemyState.y = my;
      enemyState.hp = logic.hp;
      enemyState.hpMax = logic.hpMax;
      this.state.enemies.set(id, enemyState);
    }
  }

  /** Point a shop offering at an item, copying its display fields. */
  private fillOffering(offer: ShopOfferingState, itemId: string) {
    const def = itemDefs[itemId];
    offer.itemId = itemId;
    offer.name = def.name;
    offer.price = def.price ?? 0;
    offer.basePrice = offer.price;
    offer.rarity = def.rarity ?? "common";
    offer.sold = false;
  }

  /** Discount one random unsold offering to the sale price; clears any previous sale first. */
  private markSaleOffering() {
    const unsold: ShopOfferingState[] = [];
    this.state.shop.forEach((offer) => {
      offer.price = offer.basePrice;
      if (!offer.sold) unsold.push(offer);
    });
    if (unsold.length === 0) return;
    const pick = unsold[Math.floor(Math.random() * unsold.length)];
    pick.price = Math.max(1, Math.round(pick.basePrice * SHOP_SALE_FRACTION));
  }

  /** Grant an item's effect to a player. Shared by floor pickups and shop purchases. */
  private applyItemToPlayer(sessionId: string, player: PlayerState, def: (typeof itemDefs)[string]) {
    if (def.itemType === "consumable") {
      player.potionCharges = Math.min(MAX_POTION_CHARGES, player.potionCharges + 1);
    } else if (def.weaponId) {
      player.weaponId = def.weaponId;
    } else if (def.stat) {
      // Stat item = accessory. Fill an empty slot, or swap out the oldest (FIFO).
      if (player.accessory0 === "") player.accessory0 = def.id;
      else if (player.accessory1 === "") player.accessory1 = def.id;
      else {
        player.accessory0 = player.accessory1;
        player.accessory1 = def.id;
      }
      this.recomputeStats(sessionId, player);
    }
  }

  /**
   * Server-side damage roll for one reported player hit. The client owns hit
   * geometry (which enemy a swing/bolt/ability caught) but never the number:
   * damage derives from the attacker's synced weapon and stats. The client
   * pre-rolls crits for consistent damage-text display; the roll is only
   * honoured when the player actually has crit chance, so forging the flag
   * caps out at the standard crit multiplier.
   */
  private computePlayerHit(
    player: PlayerState,
    message: { kind?: string; abilityId?: string; crit?: boolean },
  ): { damage: number; crit: boolean; tags: DamageTag[] } | null {
    const cls = classDef(player.className);
    const weapon = weaponDef(player.weaponId);
    const base = Math.round((weapon.damage + player.bonusDamage) * cls.damageMult);
    if (message.kind === "ability") {
      const ability = abilityDef(typeof message.abilityId === "string" ? message.abilityId : undefined);
      // Only the caster's own class ability, and only the offensive kinds, deal damage this way.
      if (!ability || cls.abilityId !== ability.id) return null;
      if (ability.kind !== "melee_aoe" && ability.kind !== "dash" && ability.kind !== "projectile") return null;
      return { damage: Math.round(base * (ability.damageMult ?? 1)), crit: false, tags: ["ability"] };
    }
    const crit = message.crit === true && player.critChancePct > 0;
    return {
      damage: crit ? base * CRIT_MULTIPLIER : base,
      crit,
      tags: [weapon.hitShape === "projectile" ? "projectile" : "melee"],
    };
  }

  /**
   * Everything currently buffing this player, reduced to the one unified
   * ModifierDef shape: equipped accessories, chosen power-ups, and active
   * temporary buffs. (Passive items and meta-upgrades join this list later.)
   */
  private collectModifiers(sessionId: string, player: PlayerState): ModifierDef[] {
    const mods: ModifierDef[] = [];
    for (const id of [player.accessory0, player.accessory1]) {
      if (!id) continue;
      const d = itemDefs[id];
      if (d?.stat) mods.push({ stats: { [d.stat]: d.amount ?? 0 } });
    }
    // Roguelite power-ups stack on top; the same buff can be picked twice to compound.
    for (const id of player.powerUpIds ? player.powerUpIds.split(",") : []) {
      const p = powerUpDef(id);
      if (p) mods.push(powerUpModifier(p));
    }
    for (const buff of this.tempBuffs.get(sessionId) ?? []) {
      mods.push({ stats: { [buff.stat]: buff.amount } });
    }
    return mods;
  }

  /** Recompute stats from the class base plus all modifiers, and rebuild the player's triggered-effect list. */
  private recomputeStats(sessionId: string, player: PlayerState) {
    const cls = classDef(player.className);
    const totals: Record<PowerUpStat, number> = {
      damage: 0, hpMax: 0, speedPct: 0, attackSpeedPct: 0, critPct: 0, lifestealPct: 0, cdrPct: 0, regenPerSec: 0,
    };
    const effects: EffectDef[] = [];
    for (const mod of this.collectModifiers(sessionId, player)) {
      if (mod.stats) {
        for (const [stat, amount] of Object.entries(mod.stats)) totals[stat as PowerUpStat] += amount ?? 0;
      }
      if (mod.effects) effects.push(...mod.effects);
    }
    this.playerEffects.set(sessionId, effects);
    player.hpMax = cls.hpMax + totals.hpMax;
    player.bonusDamage = totals.damage;
    player.bonusSpeedPct = cls.speedPct + totals.speedPct;
    player.bonusAttackSpeedPct = totals.attackSpeedPct;
    player.critChancePct = totals.critPct;
    player.lifestealPct = totals.lifestealPct;
    // Cooldown reduction is capped so abilities can never reach zero cooldown.
    player.cdrPct = Math.min(totals.cdrPct, 60);
    player.regenPerSec = totals.regenPerSec;
    if (player.hp > player.hpMax) player.hp = player.hpMax;
  }

  /**
   * Dispatch one trigger firing for a player: every matching effect rolls its
   * chance and internal cooldown, then executes. Called by the damage pipeline
   * (combat.ts) and the ability/dash/tick hooks.
   */
  fireEffects(trigger: Trigger, sessionId: string, ctx: EffectFireCtx) {
    const effects = this.playerEffects.get(sessionId);
    if (!effects || effects.length === 0) return;
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const now = Date.now();
    effects.forEach((eff, index) => {
      if (eff.trigger !== trigger) return;
      if (eff.cooldownMs) {
        let cds = this.effectCooldowns.get(sessionId);
        if (!cds) {
          cds = new Map();
          this.effectCooldowns.set(sessionId, cds);
        }
        const key = `${index}:${eff.trigger}`;
        if (now < (cds.get(key) ?? 0)) return;
        cds.set(key, now + eff.cooldownMs);
      }
      if (eff.chancePct !== undefined && Math.random() * 100 >= eff.chancePct) return;
      this.executeEffect(sessionId, player, eff.action, ctx, now);
    });
  }

  /** Carry out one triggered effect's action. Effect-spawned damage never re-triggers effects. */
  private executeEffect(sessionId: string, player: PlayerState, action: EffectAction, ctx: EffectFireCtx, now: number) {
    switch (action.kind) {
      case "aoeDamage": {
        const cx = action.center === "self" ? player.x : ctx.x ?? player.x;
        const cy = action.center === "self" ? player.y : ctx.y ?? player.y;
        const amount = Math.round((action.flat ?? 0) + ((ctx.damage ?? 0) * (action.pctOfHit ?? 0)) / 100);
        if (amount <= 0) return;
        this.broadcast("fx", { type: "explosion", x: cx, y: cy, radius: action.radius, element: action.element });
        this.enemyLogics.forEach((logic, id) => {
          if (!logic.isAlive) return;
          if (Math.hypot(logic.x - cx, logic.y - cy) > action.radius) return;
          applyDamageToEnemy(this, id, amount, {
            source: "effect", attackerSessionId: sessionId, tags: ["explosion"], element: action.element, canTriggerEffects: false,
          });
        });
        break;
      }
      case "chainDamage": {
        const amount = Math.round(((ctx.damage ?? 0) * action.pctOfHit) / 100);
        if (amount <= 0) return;
        let fromX = ctx.x ?? player.x;
        let fromY = ctx.y ?? player.y;
        const struck = new Set(ctx.targetEnemyId ? [ctx.targetEnemyId] : []);
        for (let jump = 0; jump < action.jumps; jump++) {
          let nextId = "";
          let nextDist = action.range;
          this.enemyLogics.forEach((logic, id) => {
            if (!logic.isAlive || struck.has(id)) return;
            const dist = Math.hypot(logic.x - fromX, logic.y - fromY);
            if (dist <= nextDist) {
              nextDist = dist;
              nextId = id;
            }
          });
          if (!nextId) break;
          const next = this.enemyLogics.get(nextId)!;
          this.broadcast("fx", { type: "chain", x: fromX, y: fromY, x2: next.x, y2: next.y, element: action.element });
          applyDamageToEnemy(this, nextId, amount, {
            source: "effect", attackerSessionId: sessionId, tags: ["explosion"], element: action.element, canTriggerEffects: false,
          });
          struck.add(nextId);
          fromX = next.x;
          fromY = next.y;
        }
        break;
      }
      case "applyStatus":
        // Wired up with the status system (see shared/effects.ts); no-op until then.
        break;
      case "heal": {
        if (player.hp <= 0) return;
        const amount =
          (action.flat ?? 0) + ((ctx.damage ?? 0) * (action.pctOfDamage ?? 0)) / 100 + (player.hpMax * (action.pctMax ?? 0)) / 100;
        if (amount <= 0) return;
        player.hp = Math.min(player.hpMax, player.hp + amount);
        this.broadcast("fx", { type: "heal", x: player.x, y: player.y });
        break;
      }
      case "tempBuff": {
        const buffs = this.tempBuffs.get(sessionId) ?? [];
        buffs.push({ stat: action.stat, amount: action.amount, expiresAt: now + action.durationMs });
        this.tempBuffs.set(sessionId, buffs);
        this.recomputeStats(sessionId, player);
        break;
      }
      case "grantGold":
        player.gold += action.amount;
        this.statsFor(sessionId).goldEarned += action.amount;
        break;
      case "grantShield":
        this.guardUntil.set(sessionId, Math.max(this.guardUntil.get(sessionId) ?? 0, now + action.durationMs));
        player.guarding = true;
        break;
    }
  }

  /** Expire lapsed temporary buffs, recomputing stats for any player whose buff set changed. */
  private expireTempBuffs(now: number) {
    this.tempBuffs.forEach((buffs, sessionId) => {
      const live = buffs.filter((b) => b.expiresAt > now);
      if (live.length === buffs.length) return;
      if (live.length === 0) this.tempBuffs.delete(sessionId);
      else this.tempBuffs.set(sessionId, live);
      const player = this.state.players.get(sessionId);
      if (player) this.recomputeStats(sessionId, player);
    });
  }

  /**
   * Award XP to the killer and roll level-ups when a threshold is crossed. Each
   * level queues one power-up pick; the first is offered immediately, the rest
   * chain as the player confirms each choice.
   */
  grantXpTo(sessionId: string, amount: number) {
    const player = this.state.players.get(sessionId);
    const client = this.clients.find((c) => c.sessionId === sessionId);
    if (!player || !client) return;
    this.grantXp(client, player, amount);
  }

  private grantXp(client: Client, player: PlayerState, amount: number) {
    if (amount <= 0) return;
    player.xp += amount;
    while (player.xp >= player.xpToNext) {
      player.xp -= player.xpToNext;
      player.level += 1;
      player.xpToNext = xpToNext(player.level);
      player.pendingLevelUps += 1;
    }
    // Offer the first pending choice if none is currently open for this player.
    if (player.pendingLevelUps > 0 && !this.levelUpOffer.has(client.sessionId)) {
      this.offerLevelUp(client, player);
    }
  }

  /** Roll a fresh power-up hand and send it to just this player's client. */
  private offerLevelUp(client: Client, player: PlayerState) {
    const choices = rollPowerUps(LEVEL_UP_CHOICES);
    this.levelUpOffer.set(client.sessionId, choices.map((c) => c.id));
    client.send("level_up", { level: player.level, choices });
  }

  /** Downed players (from PvE or lobby PvP) respawn at `spawn` after a short delay. */
  private respawnDownedPlayers(now: number, spawn: { x: number; y: number }) {
    this.state.players.forEach((player, sessionId) => {
      if (player.hp > 0) {
        this.respawnAt.delete(sessionId);
        return;
      }
      const scheduledAt = this.respawnAt.get(sessionId);
      if (scheduledAt === undefined) {
        this.respawnAt.set(sessionId, now + RESPAWN_DELAY_MS);
      } else if (now >= scheduledAt) {
        player.hp = player.hpMax;
        this.teleportPlayer(player, spawn.x, spawn.y);
        this.respawnAt.delete(sessionId);
      }
    });
  }

  /** Fill each downed player's revive meter while a living ally stands over them. */
  private updateRevives(deltaMs: number) {
    this.state.players.forEach((downed, id) => {
      if (downed.hp > 0) {
        downed.reviveProgress = 0;
        return;
      }
      let reviverId = "";
      this.state.players.forEach((other, otherId) => {
        if (otherId === id || other.hp <= 0) return;
        if (!reviverId && Math.hypot(other.x - downed.x, other.y - downed.y) <= REVIVE_RADIUS) reviverId = otherId;
      });
      if (reviverId) {
        downed.reviveProgress = Math.min(1, downed.reviveProgress + deltaMs / REVIVE_TIME_MS);
        if (downed.reviveProgress >= 1) {
          downed.hp = Math.round(downed.hpMax * REVIVE_HP_FRAC);
          downed.reviveProgress = 0;
          this.statsFor(reviverId).revives += 1;
        }
      } else {
        downed.reviveProgress = Math.max(0, downed.reviveProgress - deltaMs / REVIVE_TIME_MS);
      }
    });
  }

  /** Expire lapsed Guard windows and keep each player's synced `guarding` flag current. */
  private updateGuards(now: number) {
    this.state.players.forEach((player, id) => {
      const active = now < (this.guardUntil.get(id) ?? 0);
      if (!active && this.guardUntil.has(id)) this.guardUntil.delete(id);
      if (player.guarding !== active) player.guarding = active;
    });
  }

  private tick(deltaMs: number) {
    const now = Date.now();
    this.updateGuards(now);
    this.expireTempBuffs(now);
    // Once-per-second trigger for periodic effects (Echo Quiver-style items).
    this.tickSecAccum += deltaMs;
    const fireTickSec = this.tickSecAccum >= 1000;
    if (fireTickSec) {
      this.tickSecAccum -= 1000;
      this.state.players.forEach((player, sessionId) => {
        if (player.hp > 0) this.fireEffects("onTickSec", sessionId, { x: player.x, y: player.y });
      });
    }

    if (this.state.runPhase !== "playing") {
      if (this.state.runPhase === "lobby") {
        this.respawnDownedPlayers(now, LOBBY_LAYOUT.entrance);
        return;
      }
      if (!this.dungeonDef) return;
      if (this.state.resetAt > 0 && now >= this.state.resetAt) {
        this.state.clearTimeMs = 0;
        if (this.state.runPhase === "victory") {
          this.loadLobby("Dungeon cleared. Waiting for admin.");
        } else {
          this.state.runPhase = "playing";
          this.activateRoom(0, true);
        }
      }
      return;
    }

    const roomDef = this.currentRoomDef();
    if (!roomDef || !this.dungeonDef) return;

    // In a live dungeon, downed players stay down and are revived by a nearby
    // ally instead of auto-respawning. A full party-down still triggers a wipe.
    this.updateRevives(deltaMs);

    // Item pickups (proximity auto-pickup).
    this.state.items.forEach((item) => {
      if (item.taken) return;
      this.state.players.forEach((player, sessionId) => {
        if (item.taken || player.hp <= 0) return;
        const dist = Math.hypot(player.x - item.x, player.y - item.y);
        if (dist > ITEM_PICKUP_RADIUS) return;
        const def = itemDefs[item.itemId];
        if (!def) return;
        // Weapons are picked up deliberately via the J prompt (they swap the carried
        // weapon), so they are never auto-grabbed by walking over them.
        if (def.weaponId) return;
        item.taken = true;
        this.applyItemToPlayer(sessionId, player, def);
      });
    });

    // Passive health regen from power-ups (Regrowth / Troll Blood), ticked by dt.
    this.state.players.forEach((player) => {
      if (player.regenPerSec > 0 && player.hp > 0 && player.hp < player.hpMax) {
        player.hp = Math.min(player.hpMax, player.hp + (player.regenPerSec * deltaMs) / 1000);
      }
    });

    // Enemy simulation.
    const targets: BossTarget[] = [];
    this.state.players.forEach((player, sessionId) => {
      targets.push({ id: sessionId, x: player.x, y: player.y, alive: player.hp > 0 });
    });

    let anyAlive = false;
    const spawnRequests: { enemyId: string; count: number; x: number; y: number }[] = [];
    this.enemyLogics.forEach((logic) => {
      const events = logic.update(now, deltaMs, targets);
      for (const event of events) {
        // i-frames, Guard, and enemyDamageScale are applied inside the pipeline.
        applyDamageToPlayer(this, event.targetId, event.damage, {
          source: "enemy",
          tags: [],
          canTriggerEffects: true,
          hitFromX: logic.x,
          hitFromY: logic.y,
        });
      }
      // Drain summon requests here; adding to enemyLogics inside this forEach would mutate what we're iterating.
      if (logic.spawnQueue.length > 0) {
        spawnRequests.push(...logic.spawnQueue);
        logic.spawnQueue.length = 0;
      }
      if (logic.isAlive) anyAlive = true;
    });
    for (const req of spawnRequests) this.spawnMinions(req.enemyId, req.count, req.x, req.y);
    this.clampEnemiesToRoom();
    this.syncEnemyStates();

    const combatRoom = roomDef.type === "arena" || roomDef.type === "boss";
    if (combatRoom && this.enemyLogics.size > 0 && !anyAlive && !this.state.exitOpen) {
      this.state.exitOpen = true;
      this.state.players.forEach((player, sessionId) => {
        if (player.hp > 0) this.fireEffects("onRoomClear", sessionId, { x: player.x, y: player.y });
      });
    }

    // Progression: once the room is cleared its door opens (client-side collision).
    // The last room clears into victory; otherwise the next room wakes up the
    // moment a living player physically walks into it — no teleport.
    if (this.state.exitOpen) {
      // Endless mode never ends on a clear: once the floor is open, a living player
      // stepping into the exit descends the whole party to a freshly generated floor
      // (healed at the new entrance). Player-driven so shop/rest floors aren't skipped.
      if (this.isEndless()) {
        if (this.anyPlayerInExit()) {
          this.endlessFloor += 1;
          this.activateRoom(0);
          this.positionPlayersAt(this.worldEntrance(0));
          this.announce(`⬇️ Descending to Floor ${this.endlessFloor + 1} — enemies grow stronger!`);
        }
        return;
      }
      const nextIndices = this.exitIndices(this.state.roomIndex);
      if (nextIndices.length === 0) {
        this.triggerVictory();
        return;
      }
      // Forked rooms open every door; the first one a living player walks
      // through commits the whole party to that branch.
      for (const nextIndex of nextIndices) {
        const entered = [...this.state.players.entries()].some(
          ([sessionId, player]) => player.hp > 0 && !this.disconnecting.has(sessionId) && this.insideRoom(nextIndex, player.x, player.y),
        );
        if (entered) {
          this.activateRoom(nextIndex);
          return;
        }
      }
      return;
    }

    const hasPlayers = this.state.players.size > 0;
    const allDown = [...this.state.players.values()].every((player) => player.hp <= 0);
    if (hasPlayers && allDown) {
      this.state.runPhase = "wiped";
      this.state.resetAt = now + ROOM_RESET_DELAY_MS;
      this.broadcastRunResults(false);
    }
  }

  /** Get (creating if needed) the run tally for a player. Non-private: used by combat.ts. */
  statsFor(sessionId: string): RunStats {
    let s = this.runStats.get(sessionId);
    if (!s) {
      s = { damageDealt: 0, kills: 0, revives: 0, deaths: 0, goldEarned: 0, biggestHit: 0 };
      this.runStats.set(sessionId, s);
    }
    return s;
  }

  /** Broadcast the end-of-run scoreboard (per-player stats + superlatives) to all clients. */
  private broadcastRunResults(won: boolean) {
    const rows: (RunStats & { sessionId: string; name: string; className: string; color: string })[] = [];
    this.state.players.forEach((player, sessionId) => {
      const s = this.statsFor(sessionId);
      rows.push({ sessionId, name: player.name, className: player.className, color: player.color, ...s });
    });
    if (rows.length === 0) return;

    const top = (key: keyof RunStats): string | null => {
      let best: (typeof rows)[number] | null = null;
      for (const r of rows) {
        if (r[key] > 0 && (!best || r[key] > best[key])) best = r;
      }
      return best ? best.sessionId : null;
    };

    this.broadcast("run_results", {
      won,
      clearTimeMs: won ? this.state.clearTimeMs : 0,
      dungeonName: this.state.dungeonName,
      players: rows,
      superlatives: {
        mvp: top("damageDealt"),
        mostRevives: top("revives"),
        biggestHit: top("biggestHit"),
        mostGold: top("goldEarned"),
      },
    });
  }

  /** Record this run's clear time on the persistent leaderboard (fastest-first, capped per dungeon). */
  private recordClear() {
    if (!this.dungeonDef || this.state.clearTimeMs <= 0) return;
    const party: string[] = [];
    this.state.players.forEach((p) => party.push(p.name));
    if (party.length === 0) return;
    const list = leaderboard[this.dungeonDef.id] ?? [];
    list.push({ clearMs: this.state.clearTimeMs, party, playerCount: party.length, at: Date.now() });
    list.sort((a, b) => a.clearMs - b.clearMs);
    leaderboard[this.dungeonDef.id] = list.slice(0, LEADERBOARD_MAX);
    writeLeaderboard();
    this.syncLeaderboard();
  }

  /** Publish the leaderboard to clients as a compact per-dungeon summary for the lobby board. */
  private syncLeaderboard() {
    const summary = Object.entries(leaderboard)
      .filter(([, entries]) => entries.length > 0)
      .map(([id, entries]) => ({
        id,
        name: dungeonDefs[id]?.name ?? id,
        entries: entries.slice(0, LEADERBOARD_MAX).map((e) => ({ clearMs: e.clearMs, party: e.party, playerCount: e.playerCount })),
      }));
    this.state.leaderboardJson = JSON.stringify(summary);
  }

  private triggerVictory(message = "Dungeon cleared.") {
    this.state.runPhase = "victory";
    this.state.clearTimeMs = Date.now() - this.runStartedAt;
    this.state.resetAt = Date.now() + ROOM_RESET_DELAY_MS * 2;
    this.recordClear();
    this.broadcastRunResults(true);
    this.announce(message);
  }

  onJoin(client: Client, options: JoinOptions) {
    if (options.role === "admin") {
      if (!isAdminPin(options.adminPin)) {
        client.send("admin_status", { ok: false, message: "Invalid admin PIN." });
        this.clock.setTimeout(() => client.leave(1008, "Invalid admin PIN."), 50);
        return;
      }
      this.admins.add(client.sessionId);
      this.state.adminCount = this.admins.size;
      client.send("admin_status", { ok: true, message: "Admin connected." });
      return;
    }

    // Spectators (admins watching the room) connect but never spawn a body.
    if (options.role === "spectator") {
      if (!isAdminPin(options.adminPin)) {
        this.clock.setTimeout(() => client.leave(1008, "Invalid admin PIN."), 50);
        return;
      }
      this.spectators.add(client.sessionId);
      return;
    }

    const player = new PlayerState();
    const def = classDef(options.className);
    player.className = def.id;
    player.hpMax = def.hpMax;
    player.hp = def.hpMax;
    player.bonusSpeedPct = def.speedPct;
    player.weaponId = def.starterWeaponId;
    player.name = (options.name ?? "Player").slice(0, 16);
    player.color = options.color ?? "0x4da6ff";
    player.trimColor = options.trimColor ?? "0xe2e8f2";
    player.cape = options.cape ?? true;
    const entrance = this.dungeonDef ? this.worldEntrance(this.state.roomIndex) : LOBBY_LAYOUT.entrance;
    const offset = this.state.players.size % 5;
    this.teleportPlayer(player, entrance.x, entrance.y + offset * 24 - 48);
    this.state.players.set(client.sessionId, player);
  }

  async onLeave(client: Client, consented?: boolean) {
    if (this.admins.delete(client.sessionId)) {
      this.state.adminCount = this.admins.size;
      return;
    }

    if (this.spectators.delete(client.sessionId)) return;

    if (consented) {
      this.forgetPlayer(client.sessionId);
      return;
    }
    this.disconnecting.add(client.sessionId);
    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    } catch {
      this.forgetPlayer(client.sessionId);
    } finally {
      this.disconnecting.delete(client.sessionId);
    }
  }

  /** Drop every per-player runtime record when a player leaves for good. */
  private forgetPlayer(sessionId: string) {
    this.state.players.delete(sessionId);
    this.respawnAt.delete(sessionId);
    this.lastEmoteAt.delete(sessionId);
    this.abilityReadyAt.delete(sessionId);
    this.guardUntil.delete(sessionId);
    this.levelUpOffer.delete(sessionId);
    this.playerEffects.delete(sessionId);
    this.tempBuffs.delete(sessionId);
    this.effectCooldowns.delete(sessionId);
  }
}
