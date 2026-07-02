import { Schema, type, MapSchema } from "@colyseus/schema";

/**
 * Mirrors server/src/rooms/BossRoom.ts state shape. Passed as the client's
 * rootSchema so decoding doesn't rely on ambient reflection.
 */
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
  @type("number") bossX = 0;
  @type("number") bossY = 0;
  @type("string") bossState = "idle";
  @type("number") bossPhase = 0;
  @type("string") currentAttackId = "";
  @type("string") roomPhase = "fighting";
  @type("number") resetAt = 0;
}
