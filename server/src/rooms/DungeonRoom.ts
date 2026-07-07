import * as fs from "fs";
import * as path from "path";
import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";
import { BossLogic, type BossDef, type BossTarget } from "../../../shared/boss";
import { classDef } from "../../../shared/classes";

// Resolved from the server package's cwd rather than __dirname so this works
// whether running from source (tsx, src/rooms/) or the build output.
const dataDir = path.join(process.cwd(), "../data");
const dungeonsPath = path.join(dataDir, "dungeons.json");
const roomsPath = path.join(dataDir, "rooms.json");
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

const MAX_POTION_CHARGES = 3;

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

  return { id, name, rooms };
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
  /** 0..1 revive meter, filled while a living ally stands over this downed player. */
  @type("number") reviveProgress = 0;
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
}

interface MoveMessage {
  x: number;
  y: number;
  facingX: number;
  facingY: number;
  rolling: boolean;
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
  private enemyLogics = new Map<string, BossLogic>();
  private minionCounter = 0;
  private respawnAt = new Map<string, number>();
  private runStartedAt = 0;
  private disconnecting = new Set<string>();
  private admins = new Set<string>();
  private spectators = new Set<string>();
  /** Enemy damage multiplier fixed when the current room loads (see activateRoom). */
  private enemyDamageScale = 1;
  /** Room-mutator multipliers, rolled per arena room in activateRoom. */
  private mutatorGoldScale = 1;
  private mutatorHpScale = 1;
  private lastEmoteAt = new Map<string, number>();

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
      player.rolling = message.rolling === true;
    });

    this.onMessage("enemy_hit", (client, message: { enemyId: string; damage: number }) => {
      if (!message || typeof message.damage !== "number" || message.damage <= 0) return;
      const logic = this.enemyLogics.get(message.enemyId);
      if (!logic || !logic.isAlive) return;
      logic.takeDamage(message.damage);
      if (!logic.isAlive) {
        const attacker = this.state.players.get(client.sessionId);
        if (attacker) attacker.gold += Math.round((logic.def.goldReward ?? 0) * this.mutatorGoldScale);
      }
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
      this.applyItemToPlayer(player, def);
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

    // PvP is only live while everyone is idling in the lobby, not mid-dungeon.
    this.onMessage("player_hit", (client, message: { targetId: string; damage: number }) => {
      if (this.state.runPhase !== "lobby") return;
      if (!message || typeof message.targetId !== "string" || typeof message.damage !== "number" || message.damage <= 0) return;
      const attacker = this.state.players.get(client.sessionId);
      const target = this.state.players.get(message.targetId);
      if (!attacker || !target || target.hp <= 0) return;
      target.hp = Math.max(0, target.hp - message.damage);
      target.lastHitX = attacker.x;
      target.lastHitY = attacker.y;
      target.lastHitSeq += 1;
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
      const nextIndex = this.exitIndices(this.state.roomIndex)[0];
      if (nextIndex === undefined) {
        this.triggerVictory("Admin ended the dungeon.");
      } else {
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
    return this.dungeonDef?.rooms[this.state.roomIndex] ?? null;
  }

  /**
   * The rooms `index` leads to, as indices. Defaults to the linear next room
   * (i+1) when `exits` is omitted; an explicit `exits` list (by room id) forks
   * the path, and an empty list marks a leaf (clearing it ends the run).
   */
  private exitIndices(index: number): number[] {
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
    const room = this.dungeonDef?.rooms[index];
    return room?.offset ?? { x: index * (ROOM_W + CORRIDOR_FALLBACK_GAP), y: 0 };
  }

  /** Where players appear/respawn inside a room, in world space. */
  private worldEntrance(index: number): { x: number; y: number } {
    const room = this.dungeonDef?.rooms[index];
    const off = this.roomOffset(index);
    const local = room?.entrance ?? { x: 80, y: 320 };
    return { x: off.x + local.x, y: off.y + local.y };
  }

  /** True when (x, y) lies inside the given room's rect. */
  private insideRoom(index: number, x: number, y: number): boolean {
    const off = this.roomOffset(index);
    return x >= off.x && x <= off.x + ROOM_W && y >= off.y && y <= off.y + ROOM_H;
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
    this.state.roomCount = dungeonDef.rooms.length;
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
    this.positionPlayersAt(LOBBY_LAYOUT.entrance);
    if (message) this.announce(message);
  }

  /** Player count used to scale difficulty, clamped so a very full room stays winnable. */
  private scalingPlayerCount(): number {
    return Math.min(MAX_SCALING_PLAYERS, Math.max(1, this.state.players.size));
  }

  private scaledHpMax(baseHpMax: number): number {
    // Difficulty scales gently with player count so a full party doesn't trivialize fights.
    return Math.round(baseHpMax * (1 + HP_SCALE_PER_PLAYER * (this.scalingPlayerCount() - 1)) * this.mutatorHpScale);
  }

  /**
   * Makes `index` the live room: clears the previous room's contents and spawns
   * this room's enemies/items in world space. Players are NOT teleported — they
   * walk in through the corridor — unless `resetPlayers` (launch/restart/wipe),
   * which resets stats and drops everyone at the room's entrance.
   */
  private activateRoom(index: number, resetPlayers = false) {
    if (!this.dungeonDef) return;
    const roomDef = this.dungeonDef.rooms[index];
    const off = this.roomOffset(index);
    this.state.roomIndex = index;
    this.state.roomId = roomDef.id;
    this.state.roomName = roomDef.name;
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
    this.enemyDamageScale = (1 + DAMAGE_SCALE_PER_PLAYER * (this.scalingPlayerCount() - 1)) * mutatorDamageScale;

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
      let i = 0;
      const entrance = this.worldEntrance(index);
      this.state.players.forEach((player) => {
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
  private applyItemToPlayer(player: PlayerState, def: (typeof itemDefs)[string]) {
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
      this.recomputeStats(player);
    }
  }

  /** Recompute HP/damage/speed from the class base plus currently equipped accessories. */
  private recomputeStats(player: PlayerState) {
    const cls = classDef(player.className);
    let hpMax = cls.hpMax;
    let bonusDamage = 0;
    let bonusSpeedPct = cls.speedPct;
    for (const id of [player.accessory0, player.accessory1]) {
      if (!id) continue;
      const d = itemDefs[id];
      if (!d) continue;
      if (d.stat === "hpMax") hpMax += d.amount ?? 0;
      else if (d.stat === "damage") bonusDamage += d.amount ?? 0;
      else if (d.stat === "speedPct") bonusSpeedPct += d.amount ?? 0;
    }
    player.hpMax = hpMax;
    player.bonusDamage = bonusDamage;
    player.bonusSpeedPct = bonusSpeedPct;
    if (player.hp > hpMax) player.hp = hpMax;
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
      let ally = false;
      this.state.players.forEach((other, otherId) => {
        if (otherId === id || other.hp <= 0) return;
        if (Math.hypot(other.x - downed.x, other.y - downed.y) <= REVIVE_RADIUS) ally = true;
      });
      if (ally) {
        downed.reviveProgress = Math.min(1, downed.reviveProgress + deltaMs / REVIVE_TIME_MS);
        if (downed.reviveProgress >= 1) {
          downed.hp = Math.round(downed.hpMax * REVIVE_HP_FRAC);
          downed.reviveProgress = 0;
        }
      } else {
        downed.reviveProgress = Math.max(0, downed.reviveProgress - deltaMs / REVIVE_TIME_MS);
      }
    });
  }

  private tick(deltaMs: number) {
    const now = Date.now();

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
      this.state.players.forEach((player) => {
        if (item.taken || player.hp <= 0) return;
        const dist = Math.hypot(player.x - item.x, player.y - item.y);
        if (dist > ITEM_PICKUP_RADIUS) return;
        const def = itemDefs[item.itemId];
        if (!def) return;
        item.taken = true;
        this.applyItemToPlayer(player, def);
      });
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
        const player = this.state.players.get(event.targetId);
        if (!player || player.rolling || player.hp <= 0) continue;
        player.hp = Math.max(0, player.hp - event.damage * this.enemyDamageScale);
        player.lastHitX = logic.x;
        player.lastHitY = logic.y;
        player.lastHitSeq += 1;
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
    if (combatRoom && this.enemyLogics.size > 0 && !anyAlive) {
      this.state.exitOpen = true;
    }

    // Progression: once the room is cleared its door opens (client-side collision).
    // The last room clears into victory; otherwise the next room wakes up the
    // moment a living player physically walks into it — no teleport.
    if (this.state.exitOpen) {
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
    }
  }

  private triggerVictory(message = "Dungeon cleared.") {
    this.state.runPhase = "victory";
    this.state.clearTimeMs = Date.now() - this.runStartedAt;
    this.state.resetAt = Date.now() + ROOM_RESET_DELAY_MS * 2;
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
      this.state.players.delete(client.sessionId);
      this.respawnAt.delete(client.sessionId);
      this.lastEmoteAt.delete(client.sessionId);
      return;
    }
    this.disconnecting.add(client.sessionId);
    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    } catch {
      this.state.players.delete(client.sessionId);
      this.respawnAt.delete(client.sessionId);
      this.lastEmoteAt.delete(client.sessionId);
    } finally {
      this.disconnecting.delete(client.sessionId);
    }
  }
}
