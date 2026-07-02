import { Client, Room } from "colyseus.js";
import { DungeonRoomState, PlayerState, EnemyState, ItemPickupState } from "./schema";

export type { PlayerState as RemotePlayerState, EnemyState, ItemPickupState, DungeonRoomState };

const SERVER_URL = `ws://${window.location.hostname}:2567`;
const RECONNECT_TOKEN_KEY = "boss_room_reconnect_token";

export interface JoinOptions {
  dungeonId?: string;
  name?: string;
  color?: string;
  className?: string;
}

export class Network {
  private client = new Client(SERVER_URL);
  room: Room<DungeonRoomState> | null = null;

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  async connect(options: JoinOptions): Promise<Room<DungeonRoomState> | null> {
    const storedToken = sessionStorage.getItem(RECONNECT_TOKEN_KEY);
    try {
      const room = storedToken
        ? await this.client.reconnect<DungeonRoomState>(storedToken, DungeonRoomState)
        : await this.client.joinOrCreate<DungeonRoomState>("dungeon_room", options, DungeonRoomState);

      this.room = room;
      sessionStorage.setItem(RECONNECT_TOKEN_KEY, room.reconnectionToken);

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

  sendMove(x: number, y: number, facingX: number, facingY: number, rolling: boolean) {
    this.room?.send("move", { x, y, facingX, facingY, rolling });
  }

  sendEnemyHit(enemyId: string, damage: number) {
    this.room?.send("enemy_hit", { enemyId, damage });
  }
}
