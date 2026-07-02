import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";

const BOSS_HP_MAX = 150;
const RECONNECT_GRACE_SECONDS = 20;

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
  @type("number") bossHp = BOSS_HP_MAX;
  @type("number") bossHpMax = BOSS_HP_MAX;
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

  onCreate() {
    this.setState(new BossRoomState());

    this.onMessage("move", (client, message: MoveMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.x = message.x;
      player.y = message.y;
      player.facingX = message.facingX;
      player.facingY = message.facingY;
      player.rolling = message.rolling;
    });

    this.onMessage("player_hp", (client, hp: number) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.hp = hp;
    });

    this.onMessage("boss_hit", (_client, damage: number) => {
      if (typeof damage !== "number" || damage <= 0) return;
      this.state.bossHp = Math.max(0, this.state.bossHp - damage);
    });

    this.onMessage("boss_reset", () => {
      this.state.bossHp = this.state.bossHpMax;
    });
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
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    } catch {
      this.state.players.delete(client.sessionId);
    }
  }
}
