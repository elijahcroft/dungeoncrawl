import { Schema, type, MapSchema } from "@colyseus/schema";

/**
 * Mirrors server/src/rooms/DungeonRoom.ts state shape. Passed as the client's
 * rootSchema so decoding doesn't rely on ambient reflection.
 */
export class PlayerState extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") facingX = 0;
  @type("number") facingY = 1;
  @type("boolean") rolling = false;
  @type("number") hp = 100;
  @type("number") hpMax = 100;
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
  @type("string") runPhase = "playing";
  @type("number") resetAt = 0;
  @type("number") clearTimeMs = 0;
}
