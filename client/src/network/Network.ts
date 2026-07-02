import { Client, Room } from "colyseus.js";
import { BossRoomState, PlayerState } from "./schema";

export type { PlayerState as RemotePlayerState, BossRoomState };

const SERVER_URL = `ws://${window.location.hostname}:2567`;
const RECONNECT_TOKEN_KEY = "boss_room_reconnect_token";

export class Network {
  private client = new Client(SERVER_URL);
  room: Room<BossRoomState> | null = null;

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  async connect(): Promise<Room<BossRoomState> | null> {
    const storedToken = sessionStorage.getItem(RECONNECT_TOKEN_KEY);
    try {
      const room = storedToken
        ? await this.client.reconnect<BossRoomState>(storedToken, BossRoomState)
        : await this.client.joinOrCreate<BossRoomState>("boss_room", {}, BossRoomState);

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

  sendBossHit(damage: number) {
    this.room?.send("boss_hit", damage);
  }
}
