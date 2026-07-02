import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
}

export class BossRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}

export class BossRoom extends Room<{ state: BossRoomState }> {
  maxClients = 2;

  onCreate() {
    this.setState(new BossRoomState());
  }

  onJoin(client: Client) {
    const player = new PlayerState();
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}
