import { Client, Room } from "colyseus.js";
import { DungeonRoomState, PlayerState, EnemyState, ItemPickupState, ProjectileState } from "./schema";

export type { PlayerState as RemotePlayerState, EnemyState, ItemPickupState, ProjectileState, DungeonRoomState };

const SERVER_URL = `ws://${window.location.hostname}:2567`;
const RECONNECT_TOKEN_KEY = "boss_room_reconnect_token";

export interface JoinOptions {
  name?: string;
  color?: string;
  trimColor?: string;
  cape?: boolean;
  className?: string;
  role?: "player" | "spectator";
  adminPin?: string;
}

export class Network {
  private client = new Client(SERVER_URL);
  room: Room<DungeonRoomState> | null = null;

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  async connect(options: JoinOptions): Promise<Room<DungeonRoomState> | null> {
    const role = options.role ?? "player";
    // Only ordinary players resume via a stored reconnect token; admin
    // spectate/play sessions always open a fresh connection.
    const storedToken = role === "player" ? sessionStorage.getItem(RECONNECT_TOKEN_KEY) : null;
    try {
      let room: Room<DungeonRoomState>;
      if (storedToken) {
        try {
          room = await this.client.reconnect<DungeonRoomState>(storedToken, DungeonRoomState);
        } catch {
          sessionStorage.removeItem(RECONNECT_TOKEN_KEY);
          room = await this.client.joinOrCreate<DungeonRoomState>("dungeon_room", { ...options, role }, DungeonRoomState);
        }
      } else {
        room = await this.client.joinOrCreate<DungeonRoomState>("dungeon_room", { ...options, role }, DungeonRoomState);
      }

      this.room = room;
      if (role === "player") sessionStorage.setItem(RECONNECT_TOKEN_KEY, room.reconnectionToken);

      room.onLeave(() => {
        this.room = null;
      });

      return room;
    } catch (err) {
      console.warn("[Network] Could not connect to server, continuing single-player:", err);
      sessionStorage.removeItem(RECONNECT_TOKEN_KEY);
      return null;
    }
  }

  get connected() {
    return this.room !== null;
  }

  leave() {
    this.room?.leave(true);
    this.room = null;
  }

  sendMove(x: number, y: number, facingX: number, facingY: number, rolling: boolean) {
    this.room?.send("move", { x, y, facingX, facingY, rolling });
  }

  sendEnemyHit(enemyId: string, damage: number) {
    this.room?.send("enemy_hit", { enemyId, damage });
  }

  sendPlayerHit(targetId: string, damage: number) {
    this.room?.send("player_hit", { targetId, damage });
  }

  sendUsePotion() {
    this.room?.send("use_potion");
  }
}
