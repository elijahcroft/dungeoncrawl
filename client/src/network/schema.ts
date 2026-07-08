import { Schema, type, MapSchema } from "@colyseus/schema";

/**
 * Mirrors server/src/rooms/DungeonRoom.ts state shape. Passed as the client's
 * rootSchema so decoding doesn't rely on ambient reflection.
 */
export class PlayerState extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") teleportId = 0;
  @type("number") facingX = 0;
  @type("number") facingY = 1;
  @type("boolean") rolling = false;
  @type("number") hp = 100;
  @type("number") hpMax = 100;
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
  @type("string") accessory0 = "";
  @type("string") accessory1 = "";
  @type("number") level = 1;
  @type("number") xp = 0;
  @type("number") xpToNext = 40;
  @type("number") pendingLevelUps = 0;
  @type("string") powerUpIds = "";
  @type("number") reviveProgress = 0;
  @type("boolean") guarding = false;
  @type("number") bonusAttackSpeedPct = 0;
  @type("number") critChancePct = 0;
  @type("number") lifestealPct = 0;
  @type("number") cdrPct = 0;
  @type("number") regenPerSec = 0;
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
  @type("string") runPhase = "lobby";
  @type("number") resetAt = 0;
  @type("number") clearTimeMs = 0;
  @type("number") adminCount = 0;
  @type("string") adminNotice = "";
  @type("number") adminNoticeId = 0;
  @type("string") leaderboardJson = "";
}
