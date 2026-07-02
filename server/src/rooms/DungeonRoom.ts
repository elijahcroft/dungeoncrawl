import * as fs from "fs";
import * as path from "path";
import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";
import { BossLogic, type BossDef, type BossTarget } from "../../../shared/boss";

// Resolved from the server package's cwd rather than __dirname so this works
// whether running from source (tsx, src/rooms/) or the build output.
const dataDir = path.join(process.cwd(), "../data");
const bossDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "bosses.json"), "utf-8")) as Record<string, BossDef>;
const enemyDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "enemies.json"), "utf-8")) as Record<string, BossDef>;
const itemDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "items.json"), "utf-8")) as Record<
  string,
  { id: string; name: string; color: string; stat: "hpMax" | "speedPct" | "damage"; amount: number }
>;

interface RoomWalls {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DungeonRoomDef {
  id: string;
  type: "arena" | "rest" | "boss" | "treasure";
  name: string;
  spawns?: string[];
  boss?: string;
  bossSpawn?: { x: number; y: number };
  item?: string;
  entrance: { x: number; y: number };
  exit: { x: number; y: number; w: number; h: number } | null;
  walls: RoomWalls[];
}

interface DungeonDef {
  id: string;
  name: string;
  rooms: DungeonRoomDef[];
}

const dungeonDefs = JSON.parse(fs.readFileSync(path.join(dataDir, "dungeons.json"), "utf-8")) as Record<
  string,
  DungeonDef
>;

const RECONNECT_GRACE_SECONDS = 20;
const SIMULATION_INTERVAL_MS = 50;
const PLAYER_HP_MAX = 100;
const RESPAWN_DELAY_MS = 3000;
const ROOM_RESET_DELAY_MS = 5000;
const ITEM_PICKUP_RADIUS = 36;
const ENEMY_SPREAD_X = [560, 720, 640];
const ENEMY_SPREAD_Y = [280, 280, 420];

export class PlayerState extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") facingX = 0;
  @type("number") facingY = 1;
  @type("boolean") rolling = false;
  @type("number") hp = PLAYER_HP_MAX;
  @type("number") hpMax = PLAYER_HP_MAX;
  @type("string") name = "Player";
  @type("string") color = "0x4da6ff";
  @type("string") className = "warrior";
  @type("number") bonusDamage = 0;
  @type("number") bonusSpeedPct = 0;
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
}

export class ItemPickupState extends Schema {
  @type("string") id = "";
  @type("string") itemId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("boolean") taken = false;
}

export class DungeonRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: EnemyState }) enemies = new MapSchema<EnemyState>();
  @type({ map: ItemPickupState }) items = new MapSchema<ItemPickupState>();
  @type("string") dungeonId = "";
  @type("string") dungeonName = "";
  @type("string") roomId = "";
  @type("string") roomName = "";
  @type("string") roomType = "";
  @type("number") roomIndex = 0;
  @type("number") roomCount = 0;
  @type("boolean") exitOpen = false;
  @type("string") runPhase = "playing"; // playing | wiped | victory
  @type("number") resetAt = 0;
  @type("number") clearTimeMs = 0;
}

interface MoveMessage {
  x: number;
  y: number;
  facingX: number;
  facingY: number;
  rolling: boolean;
}

interface JoinOptions {
  dungeonId?: string;
  name?: string;
  color?: string;
  className?: string;
}

const CLASS_STATS: Record<string, { hpMax: number; speedPct: number }> = {
  warrior: { hpMax: PLAYER_HP_MAX, speedPct: 0 },
  guardian: { hpMax: 130, speedPct: -15 },
};

export class DungeonRoom extends Room<DungeonRoomState> {
  maxClients = 4;

  private dungeonDef!: DungeonDef;
  private enemyLogics = new Map<string, BossLogic>();
  private respawnAt = new Map<string, number>();
  private runStartedAt = 0;

  onCreate(options: JoinOptions) {
    this.dungeonDef = dungeonDefs[options.dungeonId ?? "ashen-halls"] ?? dungeonDefs["ashen-halls"];
    this.setMetadata({ dungeonId: this.dungeonDef.id });
    this.setState(new DungeonRoomState());
    this.state.dungeonId = this.dungeonDef.id;
    this.state.dungeonName = this.dungeonDef.name;
    this.state.roomCount = this.dungeonDef.rooms.length;
    this.runStartedAt = Date.now();
    this.loadRoom(0);

    this.onMessage("move", (client, message: MoveMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.x = message.x;
      player.y = message.y;
      player.facingX = message.facingX;
      player.facingY = message.facingY;
      player.rolling = message.rolling;
    });

    this.onMessage("enemy_hit", (_client, message: { enemyId: string; damage: number }) => {
      if (!message || typeof message.damage !== "number" || message.damage <= 0) return;
      const logic = this.enemyLogics.get(message.enemyId);
      if (!logic || !logic.isAlive) return;
      logic.takeDamage(message.damage);
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), SIMULATION_INTERVAL_MS);
  }

  private currentRoomDef(): DungeonRoomDef {
    return this.dungeonDef.rooms[this.state.roomIndex];
  }

  private scaledHpMax(baseHpMax: number): number {
    // Difficulty scales gently with player count so a full party doesn't trivialize fights.
    const playerCount = Math.max(1, this.state.players.size);
    return Math.round(baseHpMax * (1 + 0.35 * (playerCount - 1)));
  }

  private loadRoom(index: number) {
    const roomDef = this.dungeonDef.rooms[index];
    this.state.roomIndex = index;
    this.state.roomId = roomDef.id;
    this.state.roomName = roomDef.name;
    this.state.roomType = roomDef.type;
    this.state.exitOpen = roomDef.type === "rest" || roomDef.type === "treasure";
    this.state.enemies.clear();
    this.state.items.clear();
    this.enemyLogics.clear();
    this.respawnAt.clear();

    if (roomDef.type === "boss" && roomDef.boss) {
      const def = bossDefs[roomDef.boss];
      const spawn = roomDef.bossSpawn ?? { x: 640, y: 320 };
      const logic = new BossLogic(def, spawn.x, spawn.y);
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
    } else if (roomDef.type === "arena" && roomDef.spawns) {
      roomDef.spawns.forEach((defId, i) => {
        const def = enemyDefs[defId];
        if (!def) return;
        const x = ENEMY_SPREAD_X[i % ENEMY_SPREAD_X.length];
        const y = ENEMY_SPREAD_Y[i % ENEMY_SPREAD_Y.length] + (i >= 3 ? 60 : 0);
        const logic = new BossLogic(def, x, y);
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
    } else if (roomDef.type === "treasure" && roomDef.item) {
      const item = new ItemPickupState();
      item.id = "pickup_0";
      item.itemId = roomDef.item;
      item.x = 480;
      item.y = 320;
      this.state.items.set(item.id, item);
    }

    const entrance = roomDef.entrance;
    this.state.players.forEach((player) => {
      player.hp = player.hpMax;
      player.x = entrance.x;
      player.y = entrance.y + (Math.random() * 60 - 30);
    });

    this.syncEnemyStates();
  }

  private syncEnemyStates() {
    this.enemyLogics.forEach((logic, id) => {
      const enemyState = this.state.enemies.get(id);
      if (!enemyState) return;
      enemyState.x = logic.x;
      enemyState.y = logic.y;
      enemyState.hp = logic.hp;
      enemyState.hpMax = logic.hpMax;
      enemyState.state = logic.state;
      enemyState.currentAttackId = logic.currentAttackId ?? "";
      if (enemyState.isBoss) {
        const def = logic.def;
        const sortedPhases = [...def.phases].sort((a, b) => a.hpThreshold - b.hpThreshold);
        enemyState.phaseIndex = sortedPhases.findIndex((phase) => phase === logic.phase);
      }
    });
  }

  private tick(deltaMs: number) {
    const now = Date.now();

    if (this.state.runPhase !== "playing") {
      if (now >= this.state.resetAt) {
        this.state.runPhase = "playing";
        this.state.clearTimeMs = 0;
        this.loadRoom(0);
      }
      return;
    }

    // Respawn handling.
    this.state.players.forEach((player, sessionId) => {
      if (player.hp > 0) {
        this.respawnAt.delete(sessionId);
        return;
      }
      const scheduledAt = this.respawnAt.get(sessionId);
      if (scheduledAt === undefined) {
        this.respawnAt.set(sessionId, now + RESPAWN_DELAY_MS);
      } else if (now >= scheduledAt) {
        const entrance = this.currentRoomDef().entrance;
        player.hp = player.hpMax;
        player.x = entrance.x;
        player.y = entrance.y;
        this.respawnAt.delete(sessionId);
      }
    });

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
        if (def.stat === "hpMax") {
          player.hpMax += def.amount;
          player.hp += def.amount;
        } else if (def.stat === "speedPct") {
          player.bonusSpeedPct += def.amount;
        } else if (def.stat === "damage") {
          player.bonusDamage += def.amount;
        }
      });
    });

    // Enemy simulation.
    const targets: BossTarget[] = [];
    this.state.players.forEach((player, sessionId) => {
      targets.push({ id: sessionId, x: player.x, y: player.y, alive: player.hp > 0 });
    });

    let anyAlive = false;
    this.enemyLogics.forEach((logic) => {
      const events = logic.update(now, deltaMs, targets);
      for (const event of events) {
        const player = this.state.players.get(event.targetId);
        if (!player || player.rolling || player.hp <= 0) continue;
        player.hp = Math.max(0, player.hp - event.damage);
      }
      if (logic.isAlive) anyAlive = true;
    });
    this.syncEnemyStates();

    const roomDef = this.currentRoomDef();
    const combatRoom = roomDef.type === "arena" || roomDef.type === "boss";
    if (combatRoom && this.enemyLogics.size > 0 && !anyAlive) {
      this.state.exitOpen = true;
    }

    // Exit transition: every living player standing in the exit zone.
    if (this.state.exitOpen) {
      if (roomDef.exit === null) {
        this.triggerVictory();
      } else {
        const exit = roomDef.exit;
        const hasPlayers = this.state.players.size > 0;
        const allInExit = [...this.state.players.values()].every(
          (player) =>
            player.hp <= 0 ||
            (player.x >= exit.x && player.x <= exit.x + exit.w && player.y >= exit.y && player.y <= exit.y + exit.h),
        );
        const anyAlivePlayer = [...this.state.players.values()].some((player) => player.hp > 0);
        if (hasPlayers && anyAlivePlayer && allInExit) {
          const nextIndex = this.state.roomIndex + 1;
          if (nextIndex >= this.dungeonDef.rooms.length) {
            this.triggerVictory();
          } else {
            this.loadRoom(nextIndex);
          }
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

  private triggerVictory() {
    this.state.runPhase = "victory";
    this.state.clearTimeMs = Date.now() - this.runStartedAt;
    this.state.resetAt = Date.now() + ROOM_RESET_DELAY_MS * 2;
  }

  onJoin(client: Client, options: JoinOptions) {
    const player = new PlayerState();
    const stats = CLASS_STATS[options.className ?? "warrior"] ?? CLASS_STATS.warrior;
    player.className = options.className ?? "warrior";
    player.hpMax = stats.hpMax;
    player.hp = stats.hpMax;
    player.bonusSpeedPct = stats.speedPct;
    player.name = (options.name ?? "Player").slice(0, 16);
    player.color = options.color ?? "0x4da6ff";
    const entrance = this.currentRoomDef().entrance;
    player.x = entrance.x;
    player.y = entrance.y + (this.state.players.size === 0 ? -20 : 20);
    this.state.players.set(client.sessionId, player);
  }

  async onLeave(client: Client, consented?: boolean) {
    if (consented) {
      this.state.players.delete(client.sessionId);
      this.respawnAt.delete(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    } catch {
      this.state.players.delete(client.sessionId);
      this.respawnAt.delete(client.sessionId);
    }
  }
}
