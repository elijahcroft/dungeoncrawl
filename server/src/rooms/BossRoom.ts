import * as fs from "fs";
import * as path from "path";
import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";
import { BossLogic, type BossDef, type BossTarget } from "../../../shared/boss";

// Resolved from the server package's cwd rather than __dirname so this works
// whether running from source (tsx, src/rooms/) or the build output (which
// nests deeper: build/server/src/rooms/, since rootDir now spans the repo
// root to include the shared/ module).
const bossesPath = path.join(process.cwd(), "../data/bosses.json");
const bossDefs = JSON.parse(fs.readFileSync(bossesPath, "utf-8")) as Record<string, BossDef>;
const ACTIVE_BOSS_ID = "sentinel";
const RECONNECT_GRACE_SECONDS = 20;
const SIMULATION_INTERVAL_MS = 50;
const BOSS_SPAWN_X = 640;
const BOSS_SPAWN_Y = 320;
const PLAYER_HP_MAX = 100;
const RESPAWN_DELAY_MS = 3000;
const ROOM_RESET_DELAY_MS = 5000;
const RESPAWN_X = 480;
const RESPAWN_Y = 580;

export class PlayerState extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") facingX = 0;
  @type("number") facingY = 1;
  @type("boolean") rolling = false;
  @type("number") hp = 100;
}

export class BossRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type("number") bossHp = 0;
  @type("number") bossHpMax = 0;
  @type("number") bossX = BOSS_SPAWN_X;
  @type("number") bossY = BOSS_SPAWN_Y;
  @type("string") bossState = "idle";
  @type("number") bossPhase = 0;
  @type("string") currentAttackId = "";
  @type("string") roomPhase = "fighting";
  @type("number") resetAt = 0;
}

interface MoveMessage {
  x: number;
  y: number;
  facingX: number;
  facingY: number;
  rolling: boolean;
}

export class BossRoom extends Room<BossRoomState> {
  maxClients = 2;

  private bossDef = bossDefs[ACTIVE_BOSS_ID];
  private boss = new BossLogic(this.bossDef, BOSS_SPAWN_X, BOSS_SPAWN_Y);
  private respawnAt = new Map<string, number>();

  onCreate() {
    this.setState(new BossRoomState());
    this.state.bossHp = this.boss.hp;
    this.state.bossHpMax = this.boss.hpMax;
    this.syncBossState();

    this.onMessage("move", (client, message: MoveMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.x = message.x;
      player.y = message.y;
      player.facingX = message.facingX;
      player.facingY = message.facingY;
      player.rolling = message.rolling;
    });

    this.onMessage("boss_hit", (_client, damage: number) => {
      if (typeof damage !== "number" || damage <= 0) return;
      this.boss.takeDamage(damage);
      this.state.bossHp = this.boss.hp;
    });

    this.onMessage("boss_reset", () => {
      this.boss.reset();
      this.state.bossHp = this.boss.hp;
      this.syncBossState();
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), SIMULATION_INTERVAL_MS);
  }

  private tick(deltaMs: number) {
    const now = Date.now();

    if (this.state.roomPhase !== "fighting") {
      if (now >= this.state.resetAt) {
        this.resetRoom();
      }
      return;
    }

    this.state.players.forEach((player, sessionId) => {
      if (player.hp > 0) {
        this.respawnAt.delete(sessionId);
        return;
      }
      const scheduledAt = this.respawnAt.get(sessionId);
      if (scheduledAt === undefined) {
        this.respawnAt.set(sessionId, now + RESPAWN_DELAY_MS);
      } else if (now >= scheduledAt) {
        player.hp = PLAYER_HP_MAX;
        player.x = RESPAWN_X;
        player.y = RESPAWN_Y;
        this.respawnAt.delete(sessionId);
      }
    });

    const targets: BossTarget[] = [];
    this.state.players.forEach((player, sessionId) => {
      targets.push({ id: sessionId, x: player.x, y: player.y, alive: player.hp > 0 });
    });

    const events = this.boss.update(now, deltaMs, targets);
    for (const event of events) {
      const player = this.state.players.get(event.targetId);
      if (!player || player.rolling || player.hp <= 0) continue;
      player.hp = Math.max(0, player.hp - event.damage);
    }

    this.state.bossHp = this.boss.hp;
    this.syncBossState();

    if (!this.boss.isAlive) {
      this.triggerRoomReset("victory");
      return;
    }

    const hasPlayers = this.state.players.size > 0;
    const allDown = [...this.state.players.values()].every((player) => player.hp <= 0);
    if (hasPlayers && allDown) {
      this.triggerRoomReset("wipe");
    }
  }

  private triggerRoomReset(phase: "victory" | "wipe") {
    this.state.roomPhase = phase;
    this.state.resetAt = Date.now() + ROOM_RESET_DELAY_MS;
  }

  private resetRoom() {
    this.boss.reset();
    this.state.bossHp = this.boss.hp;
    this.syncBossState();
    this.respawnAt.clear();
    this.state.players.forEach((player) => {
      player.hp = PLAYER_HP_MAX;
      player.x = RESPAWN_X;
      player.y = RESPAWN_Y;
    });
    this.state.roomPhase = "fighting";
    this.state.resetAt = 0;
  }

  private syncBossState() {
    this.state.bossX = this.boss.x;
    this.state.bossY = this.boss.y;
    this.state.bossState = this.boss.state;
    this.state.currentAttackId = this.boss.currentAttackId ?? "";
    const sortedPhases = [...this.bossDef.phases].sort((a, b) => a.hpThreshold - b.hpThreshold);
    this.state.bossPhase = sortedPhases.findIndex((phase) => phase === this.boss.phase);
  }

  onJoin(client: Client) {
    const player = new PlayerState();
    // Spread spawn points so two players don't stack on join.
    const isFirst = this.state.players.size === 0;
    player.x = isFirst ? 260 : 220;
    player.y = isFirst ? 460 : 500;
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
