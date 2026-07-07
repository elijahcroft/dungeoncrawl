import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy, type BossDef } from "../entities/Enemy";
import { RemotePlayer } from "../entities/RemotePlayer";
import { BossBar } from "../ui/BossBar";
import { Hud } from "../ui/Hud";
import { ShopPanel, type ShopOffering } from "../ui/ShopPanel";
import { showDamageText } from "../ui/DamageText";
import { PauseMenu } from "../ui/PauseMenu";
import { sfx } from "../audio/sfx";
import { Network, type RemotePlayerState, type EnemyState, type ItemPickupState, type DungeonRoomState } from "../network/Network";
import { joinOptions } from "../joinOptions";
import { recordRun, bumpBossDefeated } from "../progression";
import bossesData from "../../../data/bosses.json";
import enemiesData from "../../../data/enemies.json";
import dungeonsData from "../../../data/dungeons.json";
import itemsData from "../../../data/items.json";
import bossArtData from "../../../data/boss-art.json";
import { preloadBossArt, ensureWeaponPickupTexture, ensureFloorTexture } from "../gfx/sprites";
import { WEAPONS, type WeaponDef } from "../entities/weapons";
import type { BossAttackDef } from "../../../shared/boss";
import { classDef } from "../../../shared/classes";

const bossDefs = bossesData as Record<string, BossDef>;
const enemyDefs = enemiesData as Record<string, BossDef>;
const itemDefs = itemsData as Record<string, { id: string; name: string; color: string; weaponId?: string }>;

interface RoomWallDef {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface DungeonRoomDef {
  id: string;
  type: string;
  name: string;
  entrance: { x: number; y: number };
  exit: { x: number; y: number; w: number; h: number } | null;
  walls: RoomWallDef[];
  offset?: { x: number; y: number };
  exits?: string[];
}
interface DungeonDef {
  id: string;
  name: string;
  rooms: DungeonRoomDef[];
}
const dungeonDefs = dungeonsData as Record<string, DungeonDef>;

// Game objects we render for the dungeon (floors/walls/corridors) all support
// alpha, which is how inactive rooms are dimmed. Rectangles use AlphaSingle
// while TileSprites use the 4-corner Alpha, so we match structurally.
type AlphaObject = Phaser.GameObjects.GameObject & { setAlpha(value?: number): unknown };
type Side = "N" | "S" | "E" | "W";
type ItemVisual = {
  visual: Phaser.GameObjects.Arc | Phaser.GameObjects.Sprite;
  glow: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
};

// One room is a fixed 960x640 chamber; the dungeon places many of them in a
// shared world space (each room's `offset`) linked by walkable corridors, so the
// player physically walks the whole floor plan and the camera scrolls with them.
const ROOM_W = 960;
const ROOM_H = 640;
const CORRIDOR_FALLBACK_GAP = 220; // used only if a room has no authored offset
const INACTIVE_ROOM_ALPHA = 0.4; // rooms you haven't reached are dimmed for depth
const WORLD_PAD = 200; // camera slack around the dungeon's bounding box
const CAM_LERP = 0.1; // follow smoothing
const WALL_T = 20; // wall thickness
const CORRIDOR_HALF = 90; // half-width of the walkable hallway / doorway opening
const WALL_COLOR = 0x2a2a35;
const WALL_STROKE = 0x44445a;
const DOOR_COLOR = 0x6b4a2a; // closed doors read as a warm barrier; they vanish when the room is cleared
const TORCH_COLOR = 0xffb454;

const MOVE_SEND_INTERVAL_MS = 50;
const HIT_STOP_MS = 70;
const SHAKE_DURATION_MS = 80;
const SHAKE_INTENSITY = 0.006;
const DEFAULT_HINT = "WASD move · SPACE dodge roll (i-frames) · J attack · M mute · T/Y/U/G emotes 😂❤️😱🐔";
const OFFLINE_BOSS_ID = "sentinel";
const MELEE_ENEMY_HURT_RADIUS = 18;
const MELEE_BOSS_HURT_RADIUS = 36;
const MELEE_PLAYER_HURT_RADIUS = 16;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private hud!: Hud;
  private shopPanel!: ShopPanel;
  private shopOfferings: ShopOffering[] = [];
  private pauseMenu!: PauseMenu;
  private hint!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private roomText!: Phaser.GameObjects.Text;
  private objectiveText!: Phaser.GameObjects.Text;
  private bossBar!: BossBar;
  private vignette!: Phaser.GameObjects.Rectangle;
  private darkness!: Phaser.GameObjects.Rectangle;
  private minimap!: Phaser.GameObjects.Graphics;
  private deathText!: Phaser.GameObjects.Text;
  private muteText!: Phaser.GameObjects.Text;
  private wasPlayerAlive = true;
  private offlineBossWasAlive = true;
  private lastRunPhase = "playing";
  private lastBossDefId = ""; // remembered so a victory can credit the boss just cleared
  private hurtFlashing = false;

  // Spectator = an admin watching the room with no controllable body.
  private spectator = false;

  private network = new Network();
  private remotePlayers = new Map<string, RemotePlayer>();
  private enemies = new Map<string, Enemy>();
  private itemVisuals = new Map<string, ItemVisual>();
  private projectileVisuals = new Map<string, { core: Phaser.GameObjects.Arc; glow: Phaser.GameObjects.Arc }>();
  private wallBodies: Phaser.GameObjects.Rectangle[] = [];
  private wallCollider?: Phaser.Physics.Arcade.Collider;
  private exitGraphic?: Phaser.GameObjects.Rectangle;

  // Contiguous-dungeon rendering: the whole dungeon is one walkable world; the
  // server sends world coordinates directly, so nothing is offset client-side.
  // `roomOrigins` positions each room's geometry; doors gate progress.
  private screenFloor!: Phaser.GameObjects.TileSprite;
  private dungeonGeomId = "";
  private roomOrigins: { x: number; y: number }[] = [];
  private roomObjects: AlphaObject[][] = []; // per-room floor + walls, for dimming
  private corridorObjects: AlphaObject[] = []; // corridor floor strips, for dimming
  private doors: { index: number; body: Phaser.GameObjects.Rectangle }[] = []; // `index` is the from-room
  private dungeonEdges: { from: number; to: number }[] = []; // room graph, for the minimap
  private clearedRooms = new Set<number>(); // rooms whose exits have opened this run
  private seenRoomKey = "";
  private lastRoomIntroKey = "";
  private lastTeleportId = -1;
  private lastAdminNoticeId = 0;
  private moveSendAccumulator = 0;
  private lastHitSeq = -1;
  private networkHitSource = { x: 0, y: 0 };

  // Offline (no server) fallback: single fixed boss fight, same as pre-dungeon builds.
  private offlineEnemy?: Enemy;

  constructor() {
    super("GameScene");
  }

  preload() {
    preloadBossArt(this, bossArtData as Record<string, string>);
  }

  create() {
    this.physics.world.setBounds(0, 0, 960, 640);
    this.createParticleTexture();

    // Screen-filling floor used in the lobby and offline single-room mode. In a
    // launched dungeon it's hidden and per-room world-space floors take over.
    this.screenFloor = this.add
      .tileSprite(480, 320, 960, 640, ensureFloorTexture(this))
      .setScrollFactor(0)
      .setDepth(-10);

    const cls = classDef(joinOptions.className);
    this.player = new Player(this, 260, 460, {
      color: Number(joinOptions.color),
      trimColor: Number(joinOptions.trimColor),
      cape: joinOptions.cape,
      hpMax: cls.hpMax,
      speedPct: cls.speedPct,
      staminaMax: cls.staminaMax,
      damageMult: cls.damageMult,
      weaponId: cls.starterWeaponId,
    });

    this.player.onAttack = (x, y, dx, dy) => this.handlePlayerAttack(x, y, dx, dy);
    this.player.onSwing = () => sfx.swing();
    this.player.onRoll = () => {
      sfx.roll();
      this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0x4da6ff, 5);
      this.spawnRollTrail();
    };
    this.player.onHurt = (amount) => this.handlePlayerHurt(amount);
    this.player.onDenied = () => {
      sfx.deny();
      this.hud.flashStamina();
    };
    this.player.onHeal = () => {
      sfx.heal();
      this.spawnHealSparkle(this.player.sprite.x, this.player.sprite.y);
    };
    this.player.onUseItem = () => {
      if (this.network.connected) this.network.sendUsePotion();
    };

    this.hud = new Hud(this, joinOptions.name);
    this.hud.setHpMax(this.player.hpMax);
    this.shopPanel = new ShopPanel(this);

    this.roomText = this.add
      .text(480, 8, "", {
        fontSize: "13px",
        color: "#f3e4bd",
        fontStyle: "bold",
        stroke: "#08080b",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(102)
      .setScrollFactor(0);

    this.objectiveText = this.add
      .text(480, 30, "", {
        fontSize: "11px",
        color: "#aeb8c8",
        stroke: "#08080b",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(102)
      .setScrollFactor(0);

    // y=630 keeps the hint clear of the boss bar (frame spans ~583–609).
    this.hint = this.add
      .text(480, 630, DEFAULT_HINT, {
        fontSize: "13px",
        color: "#d8d1bd",
        stroke: "#08080b",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(102)
      .setScrollFactor(0);

    this.statusText = this.add
      .text(948, 12, "connecting...", { fontSize: "11px", color: "#7f8896" })
      .setOrigin(1, 0)
      .setDepth(102)
      .setScrollFactor(0);

    this.bossBar = new BossBar(this);

    this.darkness = this.add
      .rectangle(480, 320, 960, 640, 0x050509, 0.12)
      .setScrollFactor(0)
      .setDepth(90);
    this.minimap = this.add.graphics().setScrollFactor(0).setDepth(104);

    // Red screen-edge vignette that intensifies at low HP and flashes on hurt.
    // Fill stays invisible (alpha 0); only the thick red border shows, driven by the object's alpha.
    this.vignette = this.add
      .rectangle(480, 320, 960, 640, 0xff0000, 0)
      .setScrollFactor(0)
      .setDepth(115)
      .setStrokeStyle(90, 0x990000, 1)
      .setAlpha(0);

    this.deathText = this.add
      .text(480, 300, "YOU DIED", { fontSize: "64px", color: "#a01818", fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(200)
      .setAlpha(0);

    // Controls overlay: ESC toggles it. Client-side only — it never pauses the
    // networked sim, so co-op partners and the server keep running underneath.
    this.pauseMenu = new PauseMenu(this);
    this.input.keyboard?.on("keydown-ESC", () => this.pauseMenu.toggle());

    // Web Audio starts suspended; resume it on the first key/pointer input.
    this.input.keyboard?.once("keydown", () => sfx.resume());
    this.input.once("pointerdown", () => sfx.resume());

    this.muteText = this.add
      .text(948, 26, "", { fontSize: "11px", color: "#c99a4a" })
      .setOrigin(1, 0)
      .setDepth(102)
      .setScrollFactor(0);
    // M toggles a persisted master mute for all sound effects.
    this.input.keyboard?.on("keydown-M", () => {
      const muted = sfx.toggleMute();
      this.muteText.setText(muted ? "SOUND OFF · M" : "");
    });

    // R rerolls the shop when a stall is open; otherwise it's the offline retry key.
    this.input.keyboard?.on("keydown-R", () => {
      if (this.shopOfferings.length > 0 && this.network.connected) this.network.sendReroll();
      else this.retryOffline();
    });

    // Number keys 1-5 buy the matching shop offering while a stall is visible.
    (["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const).forEach((key, i) => {
      this.input.keyboard?.on(`keydown-${key}`, () => this.buyShopOffering(i));
    });

    // T/Y/U/G fire emotes everyone in the room can see (indices into the server's emote list).
    (["T", "Y", "U", "G"] as const).forEach((key, i) => {
      this.input.keyboard?.on(`keydown-${key}`, () => this.network.sendEmote(i));
    });

    this.game.events.on("boss-telegraph", () => sfx.bossTelegraph());

    this.spectator = joinOptions.spectator === true;
    if (this.spectator) this.enterSpectatorMode();

    // Leave the room cleanly when the game is torn down (e.g. admin toggling
    // spectate/play), so no ghost body lingers server-side.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.network.leave());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.network.leave());

    this.cameras.main.fadeIn(400, 0, 0, 0);
    this.connectToServer();
  }

  /** Hide the local hero and its personal HUD — spectators only watch the room. */
  private enterSpectatorMode() {
    this.player.sprite.setVisible(false);
    this.player.sprite.body.enable = false;
    this.hud.setVisible(false);
    this.hint.setText("SPECTATING — watching the room");
  }

  private createParticleTexture() {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 4, 4);
    g.generateTexture("particle", 4, 4);
    g.destroy();
  }

  private spawnHitParticles(x: number, y: number, color: number, quantity = 8) {
    const emitter = this.add.particles(x, y, "particle", {
      tint: color,
      speed: { min: 60, max: 160 },
      lifespan: 220,
      scale: { start: 1.5, end: 0 },
      quantity,
      emitting: false,
    });
    emitter.explode(quantity);
    this.time.delayedCall(250, () => emitter.destroy());
  }

  private hitStop(scale = 1) {
    this.physics.world.pause();
    this.time.delayedCall(HIT_STOP_MS * scale, () => this.physics.world.resume());
    this.cameras.main.shake(SHAKE_DURATION_MS * scale, SHAKE_INTENSITY * scale);
  }

  /** Dispatches hit detection to the geometry for this weapon's hitbox shape. */
  private weaponHits(
    weapon: WeaponDef,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    tx: number,
    ty: number,
    targetRadius = MELEE_ENEMY_HURT_RADIUS,
  ) {
    switch (weapon.hitShape) {
      case "projectile":
        return false;
      case "thrust":
        return this.inThrustBox(x, y, dirX, dirY, tx, ty, weapon.reach, weapon.width ?? 24, targetRadius);
      case "slam":
        return Phaser.Math.Distance.Between(x, y, tx, ty) <= weapon.reach + targetRadius;
      case "arc":
      default:
        return this.inSwingArc(
          x,
          y,
          dirX,
          dirY,
          tx,
          ty,
          weapon.reach,
          Phaser.Math.DegToRad(weapon.arcDegrees) / 2,
          targetRadius,
        );
    }
  }

  /** True when the target circle overlaps the weapon's swing arc centered at (x, y) facing (dirX, dirY). */
  private inSwingArc(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    tx: number,
    ty: number,
    reach: number,
    halfArcRad: number,
    targetRadius: number,
  ) {
    const dist = Phaser.Math.Distance.Between(x, y, tx, ty);
    if (dist > reach + targetRadius) return false;
    if (dist <= targetRadius) return true;
    const facingAngle = Math.atan2(dirY, dirX);
    const toTarget = Math.atan2(ty - y, tx - x);
    const angleForgiveness = Math.asin(Phaser.Math.Clamp(targetRadius / dist, 0, 1));
    return Math.abs(Phaser.Math.Angle.Wrap(toTarget - facingAngle)) <= halfArcRad + angleForgiveness;
  }

  /** True when the target circle overlaps a straight stab along the aim direction. */
  private inThrustBox(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    tx: number,
    ty: number,
    reach: number,
    width: number,
    targetRadius: number,
  ) {
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;
    const relX = tx - x;
    const relY = ty - y;
    const along = relX * nx + relY * ny; // distance ahead along the aim
    if (along < -targetRadius || along > reach + targetRadius) return false;
    const perp = Math.abs(relX * -ny + relY * nx); // sideways distance from the aim line
    return perp <= width / 2 + targetRadius;
  }

  private handlePlayerAttack(x: number, y: number, dirX: number, dirY: number) {
    const weapon = this.player.weapon;
    if (weapon.hitShape === "projectile") {
      this.spawnCrossbowBolt(weapon, x, y, dirX, dirY);
      return;
    }

    this.spawnAttackFx(weapon, x, y, dirX, dirY);

    let hitAny = false;
    if (this.network.connected) {
      // Cleave: the hitbox strikes every enemy inside it.
      for (const enemy of this.enemies.values()) {
        if (!enemy.isAlive) continue;
        const targetRadius = enemy.isBoss ? MELEE_BOSS_HURT_RADIUS : MELEE_ENEMY_HURT_RADIUS;
        if (!this.weaponHits(weapon, x, y, dirX, dirY, enemy.sprite.x, enemy.sprite.y, targetRadius)) continue;
        this.network.sendEnemyHit(enemy.id, this.player.damage);
        this.onEnemyHit(enemy, x, y);
        hitAny = true;
      }
      // PvP: only live while everyone is idling in the lobby, not mid-dungeon.
      if (this.network.room?.state.runPhase === "lobby") {
        for (const [sessionId, remote] of this.remotePlayers) {
          if (remote.hp <= 0) continue;
          if (!this.weaponHits(weapon, x, y, dirX, dirY, remote.sprite.x, remote.sprite.y, MELEE_PLAYER_HURT_RADIUS)) continue;
          this.network.sendPlayerHit(sessionId, this.player.damage);
          this.spawnHitParticles(remote.sprite.x, remote.sprite.y, 0xff6688);
          this.spawnDamageNumber(remote.sprite.x, remote.sprite.y - 20, this.player.damage);
          hitAny = true;
        }
      }
    } else if (this.offlineEnemy?.isAlive) {
      const targetRadius = this.offlineEnemy.isBoss ? MELEE_BOSS_HURT_RADIUS : MELEE_ENEMY_HURT_RADIUS;
      if (this.weaponHits(weapon, x, y, dirX, dirY, this.offlineEnemy.sprite.x, this.offlineEnemy.sprite.y, targetRadius)) {
        this.offlineEnemy.takeDamage(this.player.damage);
        this.onEnemyHit(this.offlineEnemy, x, y);
        hitAny = true;
      }
    }
    if (hitAny) {
      sfx.hit();
      this.hitStop(weapon.hitShape === "slam" ? 2 : 1);
    }
  }

  /** Shared hit reaction: particles, floating damage number and a knockback shove away from the player. */
  private onEnemyHit(enemy: Enemy, fromX: number, fromY: number) {
    this.spawnHitParticles(enemy.sprite.x, enemy.sprite.y, 0xffcc33);
    this.spawnDamageNumber(enemy.sprite.x, enemy.sprite.y - 20, this.player.damage);
    const knock = enemy.isBoss ? 12 : 28;
    enemy.applyKnockback(enemy.sprite.x - fromX, enemy.sprite.y - fromY, knock);
  }

  /** Floating damage number over an enemy/PvP target. */
  private spawnDamageNumber(x: number, y: number, amount: number) {
    showDamageText(this, x, y, amount);
  }

  /** Fading afterimages that trail the player through a dodge roll. */
  private spawnRollTrail() {
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      this.time.delayedCall((this.player.rollDurationMs / steps) * i, () => {
        const ghost = this.add
          .image(this.player.sprite.x, this.player.sprite.y, this.player.sprite.texture.key)
          .setFlipX(this.player.sprite.flipX)
          .setTint(0x9fd0ff)
          .setAlpha(0.5)
          .setDepth(this.player.sprite.depth - 1);
        this.tweens.add({ targets: ghost, alpha: 0, duration: 240, onComplete: () => ghost.destroy() });
      });
    }
  }

  /** Green motes drifting upward off a healed player. */
  private spawnHealSparkle(x: number, y: number) {
    const emitter = this.add.particles(x, y, "particle", {
      tint: 0x7dffa8,
      speedY: { min: -90, max: -40 },
      speedX: { min: -30, max: 30 },
      lifespan: 500,
      scale: { start: 1.2, end: 0 },
      emitting: false,
    });
    emitter.explode(12);
    this.time.delayedCall(550, () => emitter.destroy());
  }

  /** Player took a hit: red flash + edge-vignette pulse + knockback away from the nearest enemy. */
  private handlePlayerHurt(amount = 0) {
    sfx.hurt();
    if (amount > 0) {
      showDamageText(this, this.player.sprite.x, this.player.sprite.y - 20, amount, { color: "#ff7a6b", fontSize: "18px" });
    }
    this.cameras.main.shake(120, 0.008);
    this.hurtFlashing = true;
    this.tweens.add({
      targets: this.vignette,
      alpha: 0.4,
      duration: 60,
      yoyo: true,
      onComplete: () => {
        this.hurtFlashing = false;
        this.vignette.setAlpha(this.lowHpVignetteAlpha());
      },
    });

    const px = this.player.sprite.x;
    const py = this.player.sprite.y;

    // Multiplayer: the server tells us exactly where the hit came from (enemy or PvP attacker).
    if (this.network.connected) {
      this.player.knockback(px - this.networkHitSource.x, py - this.networkHitSource.y);
      return;
    }

    let nearest: Enemy | undefined;
    let best = Infinity;
    for (const enemy of this.enemies.values()) {
      if (!enemy.isAlive) continue;
      const d = Phaser.Math.Distance.Between(px, py, enemy.sprite.x, enemy.sprite.y);
      if (d < best) {
        best = d;
        nearest = enemy;
      }
    }
    const src = nearest ?? this.offlineEnemy;
    if (src) this.player.knockback(px - src.sprite.x, py - src.sprite.y);
  }

  private lowHpVignetteAlpha() {
    const frac = this.player.hp / Math.max(1, this.player.hpMax);
    return frac < 0.35 ? (0.35 - frac) * 1.1 : 0;
  }

  private updateAmbientDarkness() {
    const hpFrac = this.player.hp / Math.max(1, this.player.hpMax);
    const lowHp = hpFrac < 0.35 ? (0.35 - hpFrac) * 0.18 : 0;
    this.darkness.setAlpha(this.player.isAlive ? 0.1 + lowHp : 0.24);
  }

  /** Boss swing FX + sound + screen shake, keyed off the synced attack def. */
  private handleBossAttack(x: number, y: number, range: number, attack: BossAttackDef) {
    // The slime's leap fires this on landing (impactAtEnd) — a bigger, gooier crash.
    if (attack.animationKey === "jump") {
      sfx.bossJump();
      this.spawnJumpImpact(x, y, range);
      this.hitStop(1.5);
      this.cameras.main.shake(280, 0.017);
      return;
    }
    if (attack.animationKey === "summon") {
      sfx.bossSummon();
      this.spawnSummonBurst(x, y, range);
      this.cameras.main.shake(130, 0.008);
      return;
    }
    // Projectile launch: a muzzle-flash puff at the caster; the traveling bolts carry the danger.
    if (attack.projectile) {
      sfx.cast();
      this.spawnHitParticles(x, y, Number(attack.projectile.color ?? "0xffaa44"), 10);
      return;
    }
    // Donut nova: shockwave ring that races from the safe inner circle out to the rim.
    if (attack.rangeMin) {
      sfx.bossAttack();
      this.spawnDonutBlast(x, y, attack.rangeMin, range);
      this.cameras.main.shake(220, 0.013);
      return;
    }
    // Ground-target eruption: the blast lands at the marked zone (x/y are the aim point here).
    if (attack.groundTarget) {
      sfx.eruption();
      this.spawnSlam(x, y, range, 0xff7733, 340);
      this.spawnSlam(x, y, range * 0.55, 0xffdd66, 240);
      this.spawnHitParticles(x, y, 0xff8844, 14);
      this.cameras.main.shake(150, 0.009);
      return;
    }
    sfx.bossAttack();
    this.spawnSlam(x, y, range, 0xff5533, Math.max(220, attack.activeMs + 200));
    this.spawnHitParticles(x, y, 0xff6644, 12);
    this.cameras.main.shake(140, 0.01);
    // Multi-hit slams pound again on each scheduled hit so the FX match the hitbox timing.
    const hits = attack.hits ?? 1;
    if (hits > 1) {
      const interval = attack.hitIntervalMs ?? attack.activeMs / hits;
      for (let i = 1; i < hits; i++) {
        this.time.delayedCall(interval * i, () => {
          sfx.bossAttack();
          this.spawnSlam(x, y, range, 0xff5533, 220);
          this.cameras.main.shake(100, 0.008);
        });
      }
    }
  }

  /** Expanding annulus shockwave for donut novas — the inside stays visibly safe. */
  private spawnDonutBlast(x: number, y: number, inner: number, outer: number) {
    const g = this.add.graphics().setDepth(50);
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 420,
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        const r = inner + (outer - inner) * t;
        const fade = 1 - t;
        g.clear();
        g.lineStyle(14, 0xff5533, 0.4 * fade);
        g.strokeCircle(x, y, r);
        g.lineStyle(4, 0xffffff, 0.9 * fade);
        g.strokeCircle(x, y, r);
        g.lineStyle(2, 0x66ff88, 0.6 * fade); // safe-zone rim
        g.strokeCircle(x, y, inner);
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Purple pop at both ends of a blink teleport. */
  private handleBossBlink(fromX: number, fromY: number, toX: number, toY: number) {
    sfx.blink();
    this.spawnHitParticles(fromX, fromY, 0xaa77ff, 10);
    this.spawnHitParticles(toX, toY, 0xaa77ff, 10);
  }

  /**
   * Reconciles bolt visuals against the authoritative list (synced state online,
   * the local BossLogic sim offline). Spent bolts fizzle out with a small pop.
   */
  private syncProjectiles(list: { id: string; x: number; y: number; radius: number; color: number }[]) {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const existing = this.projectileVisuals.get(p.id);
      if (!existing) {
        const glow = this.add.circle(p.x, p.y, p.radius * 2.4, p.color, 0.18).setDepth(39);
        const core = this.add.circle(p.x, p.y, p.radius, p.color, 0.95).setStrokeStyle(2, 0xffffff, 0.85).setDepth(40);
        this.projectileVisuals.set(p.id, { core, glow });
      } else {
        existing.core.setPosition(Phaser.Math.Linear(existing.core.x, p.x, 0.5), Phaser.Math.Linear(existing.core.y, p.y, 0.5));
        existing.glow.setPosition(existing.core.x, existing.core.y);
      }
    }
    for (const [id, vis] of this.projectileVisuals) {
      if (seen.has(id)) continue;
      this.spawnHitParticles(vis.core.x, vis.core.y, vis.core.fillColor, 5);
      vis.core.destroy();
      vis.glow.destroy();
      this.projectileVisuals.delete(id);
    }
  }

  /** The slime crashing down: a double green shockwave, a bright core flash and a spray of goo. */
  private spawnJumpImpact(x: number, y: number, range: number) {
    this.spawnSlam(x, y, range, 0x8fe36a, 440);
    this.spawnSlam(x, y, range * 0.62, 0xffffff, 300);
    this.spawnHitParticles(x, y, 0x5aa83e, 24);
    this.spawnHitParticles(x, y, 0xbef29a, 16);
  }

  /** The slime bulging and spitting out minions: an outward green pulse plus rising goo flecks. */
  private spawnSummonBurst(x: number, y: number, range: number) {
    this.spawnSlam(x, y, range, 0x8fe36a, 320);
    this.spawnHitParticles(x, y, 0x9fe07a, 18);
  }

  private handleBossPhaseChange(x: number, y: number) {
    sfx.phase();
    this.cameras.main.flash(300, 120, 20, 20);
    this.cameras.main.shake(260, 0.012);
    this.spawnHitParticles(x, y, 0xffaa33, 20);
  }

  private updateBossBar(boss: Enemy | undefined, bossState: EnemyState | undefined) {
    if (boss && bossState) {
      this.bossBar.show(this);
      this.bossBar.setBoss(boss.def.name, boss.def.phases.length, bossState.phaseIndex);
      this.bossBar.setFraction(bossState.hp / Math.max(1, bossState.hpMax));
    } else {
      this.bossBar.hide(this);
    }
    this.bossBar.update();
  }

  private showDeathScreen(label = "YOU DIED") {
    sfx.death();
    this.deathText.setText(label);
    this.deathText.setAlpha(0).setScale(1.4);
    this.tweens.add({ targets: this.deathText, alpha: 1, scale: 1, duration: 700, ease: "Cubic.easeOut" });
    this.cameras.main.shake(400, 0.008);
  }

  private hideDeathScreen() {
    this.tweens.add({ targets: this.deathText, alpha: 0, duration: 400 });
  }

  /** One-shot centered banner (dungeon cleared / team wiped) that fades in then drifts away. */
  /** Pop an emote bubble above the emoting player's head; it drifts up and fades out. */
  private showEmote(sessionId: string, emote: string) {
    const isLocal = sessionId === this.network.room?.sessionId;
    const source = isLocal ? this.player.sprite : this.remotePlayers.get(sessionId)?.sprite;
    if (!source) return;
    const text = this.add.text(source.x, source.y - 34, emote, { fontSize: "22px" }).setOrigin(0.5, 1).setDepth(60);
    this.tweens.add({
      targets: text,
      y: source.y - 74,
      alpha: 0,
      scale: 1.5,
      duration: 1200,
      ease: "Cubic.easeOut",
      onComplete: () => text.destroy(),
    });
  }

  private showBanner(message: string, color: string) {
    const banner = this.add
      .text(480, 260, message, { fontSize: "44px", color, fontStyle: "bold" })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(200)
      .setAlpha(0);
    this.tweens.add({ targets: banner, alpha: 1, duration: 500, yoyo: true, hold: 2200, onComplete: () => banner.destroy() });
  }

  /** Picks the swing visual matching the weapon's hitbox shape. */
  private spawnAttackFx(weapon: WeaponDef, x: number, y: number, dirX: number, dirY: number) {
    switch (weapon.hitShape) {
      case "projectile":
        this.spawnCrossbowBolt(weapon, x, y, dirX, dirY);
        break;
      case "thrust":
        this.spawnThrust(x, y, dirX, dirY, weapon.reach, weapon.width ?? 20, weapon.color, weapon.swingMs);
        break;
      case "slam":
        this.spawnSlam(x, y, weapon.reach, weapon.color, weapon.swingMs);
        break;
      case "arc":
      default:
        this.spawnSwing(x, y, dirX, dirY, weapon.reach, Phaser.Math.DegToRad(weapon.arcDegrees) / 2, weapon.color, weapon.swingMs);
    }
  }

  /** Stylized slash: a crescent that sweeps through the weapon's arc and fades, tracing exactly the hit region. */
  private spawnSwing(x: number, y: number, dirX: number, dirY: number, reach: number, halfArcRad: number, color: number, durationMs: number) {
    const facingAngle = Math.atan2(dirY, dirX);
    const startAngle = facingAngle - halfArcRad;
    const sweep = halfArcRad * 2;
    const bandWidth = Math.min(sweep * 0.5, Phaser.Math.DegToRad(50));

    const g = this.add.graphics().setDepth(50);
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: durationMs,
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        const lead = startAngle + sweep * t;
        const trail = Math.max(startAngle, lead - bandWidth);
        const fade = 1 - t;
        g.clear();
        // filled crescent body
        g.fillStyle(color, 0.35 * fade);
        g.slice(x, y, reach, trail, lead, false);
        g.fillPath();
        // bright leading edge
        g.lineStyle(3, 0xffffff, 0.85 * fade);
        g.beginPath();
        g.arc(x, y, reach, trail, lead, false);
        g.strokePath();
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Stylized thrust: a narrow blade streak that lances out along the aim then fades. */
  private spawnThrust(x: number, y: number, dirX: number, dirY: number, reach: number, width: number, color: number, durationMs: number) {
    const angle = Math.atan2(dirY, dirX);
    const g = this.add.graphics().setDepth(50);
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: durationMs,
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        const ext = reach * Math.min(1, t * 2); // lance out over the first half of the swing
        const fade = 1 - t;
        g.clear();
        g.save();
        g.translateCanvas(x, y);
        g.rotateCanvas(angle);
        g.fillStyle(color, 0.35 * fade);
        g.fillRect(0, -width / 2, ext, width);
        g.fillStyle(0xffffff, 0.85 * fade);
        g.fillRect(Math.max(0, ext - 6), -width / 2, 6, width); // bright tip
        g.restore();
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Stylized slam: a shockwave ring that expands to the weapon's radius and fades. */
  private spawnSlam(x: number, y: number, radius: number, color: number, durationMs: number) {
    const g = this.add.graphics().setDepth(50);
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: durationMs,
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        const r = radius * t;
        const fade = 1 - t;
        g.clear();
        g.fillStyle(color, 0.25 * fade);
        g.fillCircle(x, y, r);
        g.lineStyle(4, 0xffffff, 0.9 * fade);
        g.strokeCircle(x, y, r);
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Crossbow shot: a wind-up release followed by a fast, continuous-collision bolt with pierce sparks. */
  private spawnCrossbowBolt(weapon: WeaponDef, x: number, y: number, dirX: number, dirY: number) {
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;
    const startX = x + nx * 26;
    const startY = y + ny * 26;
    const range = weapon.reach;
    const speed = weapon.projectileSpeed ?? 760;
    const radius = weapon.projectileRadius ?? 8;
    const maxHits = weapon.pierce ?? 1;
    const durationMs = (range / speed) * 1000;
    const hitEnemies = new Set<string>();
    const hitPlayers = new Set<string>();
    let hits = 0;
    let stopped = false;
    let prevX = startX;
    let prevY = startY;

    sfx.cast();
    this.cameras.main.shake(55, 0.0025);
    this.spawnCrossbowMuzzle(startX, startY, nx, ny, weapon.color);

    const bolt = this.add.graphics().setDepth(51);
    const glow = this.add.graphics().setDepth(50);

    const finish = (impactX: number, impactY: number, color = weapon.color) => {
      if (stopped) return;
      stopped = true;
      this.spawnHitParticles(impactX, impactY, color, 6);
      this.tweens.killTweensOf(bolt);
      bolt.destroy();
      glow.destroy();
    };

    const applyHit = (targetId: string, tx: number, ty: number, kind: "enemy" | "player", enemy?: Enemy) => {
      hits++;
      if (kind === "enemy" && enemy) {
        if (this.network.connected) this.network.sendEnemyHit(targetId, this.player.damage);
        else enemy.takeDamage(this.player.damage);
        this.onEnemyHit(enemy, x, y);
      } else {
        this.network.sendPlayerHit(targetId, this.player.damage);
        this.spawnHitParticles(tx, ty, 0xff6688);
        this.spawnDamageNumber(tx, ty - 20, this.player.damage);
      }
      sfx.hit();
      this.hitStop(0.65);
      this.spawnBoltPierce(tx, ty, nx, ny, weapon.color);
      if (hits >= maxHits) finish(tx, ty, 0xfff0a0);
    };

    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: durationMs,
      onUpdate: (tween) => {
        if (stopped) return;
        const t = tween.getValue() ?? 0;
        const bx = startX + nx * range * t;
        const by = startY + ny * range * t;

        if (this.segmentHitsWall(prevX, prevY, bx, by, radius)) {
          finish(bx, by, 0xb8c8d8);
          return;
        }

        if (this.network.connected) {
          for (const [enemyId, enemy] of this.enemies) {
            if (!enemy.isAlive || hitEnemies.has(enemyId)) continue;
            const hitRadius = radius + (enemy.isBoss ? 36 : 18);
            if (!this.segmentHitsCircle(prevX, prevY, bx, by, enemy.sprite.x, enemy.sprite.y, hitRadius)) continue;
            hitEnemies.add(enemyId);
            applyHit(enemyId, enemy.sprite.x, enemy.sprite.y, "enemy", enemy);
            if (stopped) return;
          }

          if (this.network.room?.state.runPhase === "lobby") {
            for (const [sessionId, remote] of this.remotePlayers) {
              if (remote.hp <= 0 || hitPlayers.has(sessionId)) continue;
              if (!this.segmentHitsCircle(prevX, prevY, bx, by, remote.sprite.x, remote.sprite.y, radius + 16)) continue;
              hitPlayers.add(sessionId);
              applyHit(sessionId, remote.sprite.x, remote.sprite.y, "player");
              if (stopped) return;
            }
          }
        } else if (this.offlineEnemy?.isAlive && !hitEnemies.has(this.offlineEnemy.id)) {
          const hitRadius = radius + (this.offlineEnemy.isBoss ? 36 : 18);
          if (this.segmentHitsCircle(prevX, prevY, bx, by, this.offlineEnemy.sprite.x, this.offlineEnemy.sprite.y, hitRadius)) {
            hitEnemies.add(this.offlineEnemy.id);
            applyHit(this.offlineEnemy.id, this.offlineEnemy.sprite.x, this.offlineEnemy.sprite.y, "enemy", this.offlineEnemy);
            if (stopped) return;
          }
        }

        this.drawBoltTrail(bolt, glow, bx, by, nx, ny, weapon.color);
        prevX = bx;
        prevY = by;
      },
      onComplete: () => finish(prevX, prevY, 0xb8c8d8),
    });
  }

  private segmentHitsCircle(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, radius: number) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const segLenSq = dx * dx + dy * dy;
    if (segLenSq <= 0) return Phaser.Math.Distance.Between(x1, y1, cx, cy) <= radius;
    const t = Phaser.Math.Clamp(((cx - x1) * dx + (cy - y1) * dy) / segLenSq, 0, 1);
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    return Phaser.Math.Distance.Between(px, py, cx, cy) <= radius;
  }

  private segmentHitsWall(x1: number, y1: number, x2: number, y2: number, radius: number) {
    const line = new Phaser.Geom.Line(x1, y1, x2, y2);
    return this.wallBodies.some((wall) => {
      const rect = new Phaser.Geom.Rectangle(
        wall.x - wall.displayWidth / 2 - radius,
        wall.y - wall.displayHeight / 2 - radius,
        wall.displayWidth + radius * 2,
        wall.displayHeight + radius * 2,
      );
      return Phaser.Geom.Intersects.LineToRectangle(line, rect);
    });
  }

  private drawBoltTrail(
    bolt: Phaser.GameObjects.Graphics,
    glow: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    color: number,
  ) {
    const tail = 42;
    const tx = x - dirX * tail;
    const ty = y - dirY * tail;
    const px = -dirY;
    const py = dirX;

    glow.clear();
    glow.lineStyle(10, color, 0.16);
    glow.lineBetween(tx, ty, x, y);
    glow.lineStyle(4, 0xfff0a0, 0.22);
    glow.lineBetween(x - dirX * 20, y - dirY * 20, x, y);

    bolt.clear();
    bolt.lineStyle(3, 0x3a2715, 1);
    bolt.lineBetween(tx, ty, x, y);
    bolt.lineStyle(1.5, 0xfff0a0, 1);
    bolt.lineBetween(x - dirX * 18, y - dirY * 18, x, y);
    bolt.fillStyle(0xe8edf3, 1);
    bolt.fillTriangle(x + dirX * 7, y + dirY * 7, x - dirX * 7 + px * 4, y - dirY * 7 + py * 4, x - dirX * 7 - px * 4, y - dirY * 7 - py * 4);
  }

  private spawnCrossbowMuzzle(x: number, y: number, dirX: number, dirY: number, color: number) {
    const flash = this.add.graphics().setDepth(52);
    const px = -dirY;
    const py = dirX;
    flash.fillStyle(0xfff0a0, 0.9);
    flash.fillTriangle(x + dirX * 22, y + dirY * 22, x - dirX * 5 + px * 9, y - dirY * 5 + py * 9, x - dirX * 5 - px * 9, y - dirY * 5 - py * 9);
    flash.lineStyle(2, color, 0.8);
    flash.lineBetween(x - px * 12, y - py * 12, x + px * 12, y + py * 12);
    this.tweens.add({ targets: flash, alpha: 0, scale: 1.7, duration: 120, ease: "Cubic.easeOut", onComplete: () => flash.destroy() });
  }

  private spawnBoltPierce(x: number, y: number, dirX: number, dirY: number, color: number) {
    const spark = this.add.graphics().setDepth(52);
    const px = -dirY;
    const py = dirX;
    spark.lineStyle(2, 0xffffff, 0.95);
    spark.lineBetween(x - px * 14, y - py * 14, x + px * 14, y + py * 14);
    spark.lineStyle(2, color, 0.75);
    spark.lineBetween(x - dirX * 11, y - dirY * 11, x + dirX * 11, y + dirY * 11);
    this.tweens.add({ targets: spark, alpha: 0, scale: 1.5, duration: 160, ease: "Cubic.easeOut", onComplete: () => spark.destroy() });
  }

  /** Drives the attack-cooldown bar; it flashes ready-green the moment the next swing is available. */
  private updateCooldownBar() {
    const frac = this.player.attackCooldownFraction;
    const ready = frac >= 1;
    this.hud.setCooldown(frac, ready, this.player.weapon.name);
  }

  /** World-space origin for a room; authored `offset` or a horizontal fallback chain. */
  private originForRoom(dungeonDef: DungeonDef, index: number): { x: number; y: number } {
    const room = dungeonDef.rooms[index];
    if (room?.offset) return room.offset;
    return { x: index * (ROOM_W + CORRIDOR_FALLBACK_GAP), y: 0 };
  }

  /** Creates a visible, solid wall segment (world coords, top-left + size) and registers it for collision. */
  private addWall(x: number, y: number, w: number, h: number, color = WALL_COLOR): Phaser.GameObjects.Rectangle {
    const rect = this.add.rectangle(x + w / 2, y + h / 2, w, h, color).setStrokeStyle(1, WALL_STROKE);
    this.physics.add.existing(rect, true);
    this.wallBodies.push(rect);
    return rect;
  }

  private hashRoom(roomId: string, salt: number) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < roomId.length; i++) {
      h ^= roomId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  private roomRand(roomId: string, salt: number, min: number, max: number) {
    return min + (max - min) * this.hashRoom(roomId, salt);
  }

  private addRoomDressings(room: DungeonRoomDef, origin: { x: number; y: number }, roomIndex: number): AlphaObject[] {
    const objs: AlphaObject[] = [];

    for (let i = 0; i < 18; i++) {
      const x = origin.x + this.roomRand(room.id, i * 11 + 1, 70, ROOM_W - 70);
      const y = origin.y + this.roomRand(room.id, i * 11 + 2, 70, ROOM_H - 70);
      const w = this.roomRand(room.id, i * 11 + 3, 18, 70);
      const h = this.roomRand(room.id, i * 11 + 4, 2, 5);
      const crack = this.add.rectangle(x, y, w, h, 0x0f0f14, 0.32).setRotation(this.roomRand(room.id, i * 11 + 5, -0.8, 0.8)).setDepth(-8);
      objs.push(crack);
    }

    for (let i = 0; i < 7; i++) {
      const x = origin.x + this.roomRand(room.id, i * 17 + 70, 90, ROOM_W - 90);
      const y = origin.y + this.roomRand(room.id, i * 17 + 71, 90, ROOM_H - 90);
      const r = this.roomRand(room.id, i * 17 + 72, 3, 8);
      objs.push(this.add.circle(x, y, r, 0x15151d, 0.55).setDepth(-7));
      objs.push(this.add.circle(x - r * 0.35, y - r * 0.35, r * 0.36, 0x323240, 0.45).setDepth(-6));
    }

    const torchPoints = [
      { x: origin.x + 58, y: origin.y + 58 },
      { x: origin.x + ROOM_W - 58, y: origin.y + 58 },
      { x: origin.x + 58, y: origin.y + ROOM_H - 58 },
      { x: origin.x + ROOM_W - 58, y: origin.y + ROOM_H - 58 },
    ];
    for (const [i, p] of torchPoints.entries()) {
      if ((roomIndex + i) % 2 === 1 && room.type !== "boss") continue;
      const glow = this.add.circle(p.x, p.y, 92, TORCH_COLOR, room.type === "boss" ? 0.11 : 0.08).setDepth(91);
      glow.setBlendMode(Phaser.BlendModes.ADD);
      const sconce = this.add.rectangle(p.x, p.y, 10, 18, 0x5c4630, 0.9).setDepth(1);
      const flame = this.add.circle(p.x, p.y - 11, 6, TORCH_COLOR, 0.95).setDepth(3);
      flame.setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: glow,
        alpha: { from: glow.alpha, to: glow.alpha * 1.45 },
        scale: { from: 0.95, to: 1.08 },
        duration: 420 + i * 80,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.tweens.add({
        targets: flame,
        alpha: { from: 0.78, to: 1 },
        scale: { from: 0.82, to: 1.1 },
        duration: 260 + i * 60,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      objs.push(glow, sconce, flame);
    }

    if (room.type === "boss") {
      const sigil = this.add.graphics().setDepth(-6);
      sigil.lineStyle(2, 0x8d4dff, 0.18);
      sigil.strokeCircle(origin.x + ROOM_W / 2, origin.y + ROOM_H / 2, 132);
      sigil.strokeCircle(origin.x + ROOM_W / 2, origin.y + ROOM_H / 2, 96);
      sigil.lineStyle(1, 0xe8d8ff, 0.15);
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8;
        sigil.lineBetween(
          origin.x + ROOM_W / 2 + Math.cos(a) * 72,
          origin.y + ROOM_H / 2 + Math.sin(a) * 72,
          origin.x + ROOM_W / 2 + Math.cos(a) * 138,
          origin.y + ROOM_H / 2 + Math.sin(a) * 138,
        );
      }
      objs.push(sigil);
    }

    return objs;
  }

  private opposite(side: Side): Side {
    return side === "N" ? "S" : side === "S" ? "N" : side === "E" ? "W" : "E";
  }

  /**
   * The rooms `index` connects to, as indices — mirrors the server. Defaults to
   * the linear next room (i+1) when `exits` is omitted; an explicit `exits` list
   * (by room id) forks the path.
   */
  private exitIndices(dungeonDef: DungeonDef, index: number): number[] {
    const room = dungeonDef.rooms[index];
    if (!room) return [];
    if (room.exits) {
      return room.exits.map((id) => dungeonDef.rooms.findIndex((r) => r.id === id)).filter((j) => j >= 0 && j !== index);
    }
    return index + 1 < dungeonDef.rooms.length ? [index + 1] : [];
  }

  /** Cardinal direction from room a to room b (they're one grid cell apart). */
  private dirBetween(a: { x: number; y: number }, b: { x: number; y: number }): Side {
    if (b.x > a.x) return "E";
    if (b.x < a.x) return "W";
    if (b.y > a.y) return "S";
    return "N";
  }

  /**
   * Builds the whole dungeon as one walkable space: per-room floors, interior +
   * perimeter walls (with a doorway gap toward each neighbor), connecting
   * corridors with side walls, and a door barrier per connection. One collider
   * covers it all; the camera follows the player across the full extent.
   */
  private buildDungeonGeometry(dungeonDef: DungeonDef) {
    this.teardownDungeonGeometry();
    this.clearedRooms.clear();
    this.screenFloor.setVisible(false);

    const floorKey = ensureFloorTexture(this);
    const origins = dungeonDef.rooms.map((_room, i) => this.originForRoom(dungeonDef, i));
    this.roomOrigins = origins;

    // Which sides of each room open into a corridor.
    const gaps = new Map<number, Set<Side>>();
    const addGap = (i: number, side: Side) => {
      const set = gaps.get(i) ?? new Set<Side>();
      set.add(side);
      gaps.set(i, set);
    };
    const connections: { from: number; to: number; dir: Side }[] = [];
    dungeonDef.rooms.forEach((_room, i) => {
      for (const j of this.exitIndices(dungeonDef, i)) {
        // A corridor is shared by both endpoints; don't draw it twice if both list each other.
        if (connections.some((c) => (c.from === i && c.to === j) || (c.from === j && c.to === i))) continue;
        const dir = this.dirBetween(origins[i], origins[j]);
        connections.push({ from: i, to: j, dir });
        addGap(i, dir);
        addGap(j, this.opposite(dir));
      }
    });
    this.dungeonEdges = connections.map((c) => ({ from: c.from, to: c.to }));

    // Rooms: floor + interior walls + perimeter (with doorway gaps).
    dungeonDef.rooms.forEach((room, i) => {
      const o = origins[i];
      const objs: AlphaObject[] = [];
      objs.push(this.add.tileSprite(o.x + ROOM_W / 2, o.y + ROOM_H / 2, ROOM_W, ROOM_H, floorKey).setDepth(-10));
      objs.push(...this.addRoomDressings(room, o, i));
      room.walls.forEach((w) => objs.push(this.addWall(o.x + w.x, o.y + w.y, w.w, w.h)));
      for (const seg of this.perimeterSegments(o, gaps.get(i))) objs.push(this.addWall(seg.x, seg.y, seg.w, seg.h));
      objs.forEach((obj) => obj.setAlpha(INACTIVE_ROOM_ALPHA));
      this.roomObjects.push(objs);
    });

    // Corridors + doors.
    for (const { from, to, dir } of connections) this.buildCorridor(floorKey, origins[from], origins[to], dir, from);

    this.wallCollider = this.physics.add.collider(this.player.sprite, this.wallBodies);

    // Physics bounds span the whole dungeon (walls do the real confinement).
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of origins) {
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + ROOM_W);
      maxY = Math.max(maxY, o.y + ROOM_H);
    }
    const bx = minX - WORLD_PAD;
    const by = minY - WORLD_PAD;
    const bw = maxX - minX + WORLD_PAD * 2;
    const bh = maxY - minY + WORLD_PAD * 2;
    this.physics.world.setBounds(bx, by, bw, bh);
    this.cameras.main.setBounds(bx, by, bw, bh);
    if (!this.spectator) this.cameras.main.startFollow(this.player.sprite, true, CAM_LERP, CAM_LERP);
  }

  /** Perimeter wall segments for a room, leaving a centered gap on any side that opens into a corridor. */
  private perimeterSegments(o: { x: number; y: number }, sides: Set<Side> | undefined): { x: number; y: number; w: number; h: number }[] {
    const segs: { x: number; y: number; w: number; h: number }[] = [];
    const midX = o.x + ROOM_W / 2;
    const midY = o.y + ROOM_H / 2;
    // Horizontal side (top or bottom) at edge-y, optionally split around a gap centered on midX.
    const horizontal = (edgeY: number, open: boolean) => {
      const y = edgeY - WALL_T / 2;
      if (!open) return segs.push({ x: o.x, y, w: ROOM_W, h: WALL_T });
      segs.push({ x: o.x, y, w: midX - CORRIDOR_HALF - o.x, h: WALL_T });
      segs.push({ x: midX + CORRIDOR_HALF, y, w: o.x + ROOM_W - (midX + CORRIDOR_HALF), h: WALL_T });
    };
    const vertical = (edgeX: number, open: boolean) => {
      const x = edgeX - WALL_T / 2;
      if (!open) return segs.push({ x, y: o.y, w: WALL_T, h: ROOM_H });
      segs.push({ x, y: o.y, w: WALL_T, h: midY - CORRIDOR_HALF - o.y });
      segs.push({ x, y: midY + CORRIDOR_HALF, w: WALL_T, h: o.y + ROOM_H - (midY + CORRIDOR_HALF) });
    };
    horizontal(o.y, sides?.has("N") ?? false);
    horizontal(o.y + ROOM_H, sides?.has("S") ?? false);
    vertical(o.x, sides?.has("W") ?? false);
    vertical(o.x + ROOM_W, sides?.has("E") ?? false);
    return segs;
  }

  /** Walkable hallway (floor + two side walls) between two rooms, plus a door barrier that opens when the room clears. */
  private buildCorridor(floorKey: string, a: { x: number; y: number }, b: { x: number; y: number }, dir: Side, index: number) {
    if (dir === "E" || dir === "W") {
      const x0 = Math.min(a.x, b.x) + ROOM_W; // right edge of the left room
      const x1 = Math.max(a.x, b.x); // left edge of the right room
      const cy = a.y + ROOM_H / 2; // connected rooms share a row
      this.corridorObjects.push(
        this.add.tileSprite((x0 + x1) / 2, cy, x1 - x0, CORRIDOR_HALF * 2, floorKey).setDepth(-10).setAlpha(INACTIVE_ROOM_ALPHA),
      );
      this.addWall(x0, cy - CORRIDOR_HALF - WALL_T, x1 - x0, WALL_T);
      this.addWall(x0, cy + CORRIDOR_HALF, x1 - x0, WALL_T);
      const mid = (x0 + x1) / 2;
      const door = this.addWall(mid - WALL_T / 2, cy - CORRIDOR_HALF, WALL_T, CORRIDOR_HALF * 2, DOOR_COLOR).setDepth(1);
      this.doors.push({ index, body: door });
    } else {
      const y0 = Math.min(a.y, b.y) + ROOM_H; // bottom edge of the upper room
      const y1 = Math.max(a.y, b.y); // top edge of the lower room
      const cx = a.x + ROOM_W / 2; // connected rooms share a column
      this.corridorObjects.push(
        this.add.tileSprite(cx, (y0 + y1) / 2, CORRIDOR_HALF * 2, y1 - y0, floorKey).setDepth(-10).setAlpha(INACTIVE_ROOM_ALPHA),
      );
      this.addWall(cx - CORRIDOR_HALF - WALL_T, y0, WALL_T, y1 - y0);
      this.addWall(cx + CORRIDOR_HALF, y0, WALL_T, y1 - y0);
      const mid = (y0 + y1) / 2;
      const door = this.addWall(cx - CORRIDOR_HALF, mid - WALL_T / 2, CORRIDOR_HALF * 2, WALL_T, DOOR_COLOR).setDepth(1);
      this.doors.push({ index, body: door });
    }
  }

  /** Opens/closes door barriers: a door out of room i opens once room i has been cleared. */
  private updateDoors(currentIndex: number) {
    for (const door of this.doors) {
      const open = this.clearedRooms.has(door.index);
      const body = door.body.body as Phaser.Physics.Arcade.StaticBody | undefined;
      if (body) body.enable = !open;
      if (open && door.body.visible && door.index === currentIndex) {
        this.spawnDoorOpenFx(door.body.x, door.body.y, Math.max(door.body.displayWidth, door.body.displayHeight));
      }
      door.body.setVisible(!open);
    }
  }

  private spawnDoorOpenFx(x: number, y: number, span: number) {
    sfx.pickup();
    const ring = this.add.graphics().setDepth(45);
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 420,
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        ring.clear();
        ring.lineStyle(5, 0x55ff88, 0.65 * (1 - t));
        ring.strokeCircle(x, y, span * (0.2 + t * 0.45));
        ring.lineStyle(2, 0xffffff, 0.75 * (1 - t));
        ring.strokeCircle(x, y, span * (0.12 + t * 0.32));
      },
      onComplete: () => ring.destroy(),
    });
    this.spawnHitParticles(x, y, 0x55ff88, 16);
  }

  /** Brightens the current room, dims the rest and the corridors. */
  private updateHighlight(currentIndex: number) {
    this.roomObjects.forEach((objs, i) => {
      const alpha = i === currentIndex ? 1 : INACTIVE_ROOM_ALPHA;
      objs.forEach((obj) => obj.setAlpha(alpha));
    });
    this.corridorObjects.forEach((obj) => obj.setAlpha(INACTIVE_ROOM_ALPHA));
  }

  private updateMinimap(dungeonDef: DungeonDef | undefined, currentIndex: number) {
    this.minimap.clear();
    if (!dungeonDef || this.roomOrigins.length === 0) return;

    const x = 770;
    const y = 486;
    const w = 172;
    const h = 112;
    const pad = 12;
    this.minimap.fillStyle(0x07080c, 0.58);
    this.minimap.fillRoundedRect(x, y, w, h, 6);
    this.minimap.lineStyle(1, 0x506070, 0.9);
    this.minimap.strokeRoundedRect(x, y, w, h, 6);

    const minX = Math.min(...this.roomOrigins.map((o) => o.x));
    const minY = Math.min(...this.roomOrigins.map((o) => o.y));
    const maxX = Math.max(...this.roomOrigins.map((o) => o.x + ROOM_W));
    const maxY = Math.max(...this.roomOrigins.map((o) => o.y + ROOM_H));
    const scale = Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY));
    const ox = x + w / 2 - ((minX + maxX) / 2 - minX) * scale;
    const oy = y + h / 2 - ((minY + maxY) / 2 - minY) * scale;
    const px = (worldX: number) => ox + (worldX - minX) * scale;
    const py = (worldY: number) => oy + (worldY - minY) * scale;

    this.minimap.lineStyle(3, 0x3b4658, 0.9);
    for (const { from, to } of this.dungeonEdges) {
      const a = this.roomOrigins[from];
      const b = this.roomOrigins[to];
      this.minimap.lineBetween(px(a.x + ROOM_W / 2), py(a.y + ROOM_H / 2), px(b.x + ROOM_W / 2), py(b.y + ROOM_H / 2));
    }

    this.roomOrigins.forEach((o, i) => {
      const rw = Math.max(14, ROOM_W * scale);
      const rh = Math.max(10, ROOM_H * scale);
      const active = i === currentIndex;
      const cleared = this.clearedRooms.has(i);
      const color = active ? 0xf3d27a : cleared ? 0x55ff88 : 0x6c7482;
      this.minimap.fillStyle(color, active ? 0.92 : 0.42);
      this.minimap.fillRoundedRect(px(o.x), py(o.y), rw, rh, 3);
      this.minimap.lineStyle(active ? 2 : 1, active ? 0xffffff : 0x242936, active ? 0.95 : 0.8);
      this.minimap.strokeRoundedRect(px(o.x), py(o.y), rw, rh, 3);
    });

    const p = this.player.sprite;
    this.minimap.fillStyle(0x4da6ff, 1);
    this.minimap.fillCircle(px(p.x), py(p.y), 3.5);
  }

  private syncShop(state: DungeonRoomState, gold: number) {
    const offerings: ShopOffering[] = [];
    state.shop.forEach((o) =>
      offerings.push({ id: o.id, itemId: o.itemId, name: o.name, price: o.price, basePrice: o.basePrice, sold: o.sold, rarity: o.rarity }),
    );
    offerings.sort((a, b) => a.id.localeCompare(b.id));
    this.shopOfferings = offerings;
    this.shopPanel.setVisible(offerings.length > 0);
    if (offerings.length > 0) this.shopPanel.update(offerings, gold);
  }

  private buyShopOffering(index: number) {
    const offer = this.shopOfferings[index];
    if (!offer || offer.sold || !this.network.connected) return;
    this.network.sendBuy(offer.id);
  }

  private objectiveForState(state: DungeonRoomState) {
    if (state.runPhase === "lobby") return "Choose your class, spar if you want, and wait for launch.";
    if (state.runPhase === "victory") return "Run complete.";
    if (state.runPhase === "wiped") return "Party down. Reset incoming.";
    if (state.exitOpen) return "Exit open. Move through the corridor.";
    const enemiesLeft = state.enemies.size;
    if (enemiesLeft > 0) return `Clear the room: ${enemiesLeft} hostile${enemiesLeft === 1 ? "" : "s"} left.`;
    if (state.items.size > 0) return "Collect the loot, then move on.";
    return "Hold position.";
  }

  private showRoomIntro(state: DungeonRoomState) {
    const label = `${state.roomName}  ${state.roomIndex + 1}/${state.roomCount}`;
    const text = this.add
      .text(480, 118, label.toUpperCase(), {
        fontSize: "26px",
        color: "#f3e4bd",
        fontStyle: "bold",
        stroke: "#060609",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(201)
      .setAlpha(0);
    const line = this.add.rectangle(480, 148, 300, 2, 0xf3d27a, 0.55).setScrollFactor(0).setDepth(201).setAlpha(0);
    this.tweens.add({
      targets: [text, line],
      alpha: 1,
      y: "-=8",
      duration: 260,
      ease: "Cubic.easeOut",
      yoyo: true,
      hold: 900,
      onComplete: () => {
        text.destroy();
        line.destroy();
      },
    });
  }

  /** Removes all dungeon geometry and restores the fixed single-screen setup (lobby / offline). */
  private teardownDungeonGeometry() {
    this.roomObjects.forEach((objs) =>
      objs.forEach((obj) => {
        this.tweens.killTweensOf(obj);
        obj.destroy();
      }),
    );
    this.roomObjects = [];
    this.corridorObjects.forEach((obj) => {
      this.tweens.killTweensOf(obj);
      obj.destroy();
    });
    this.corridorObjects = [];
    this.wallCollider?.destroy();
    this.wallCollider = undefined;
    this.wallBodies.forEach((wall) => wall.destroy()); // corridor walls + doors (room walls already gone, destroy is a no-op)
    this.wallBodies = [];
    this.doors = [];
    this.dungeonEdges = [];
    this.roomOrigins = [];
    this.minimap.clear();
    this.exitGraphic?.destroy();
    this.exitGraphic = undefined;
    this.cameras.main.stopFollow();
    this.cameras.main.setBounds(0, 0, ROOM_W, ROOM_H);
    this.cameras.main.setScroll(0, 0);
    this.physics.world.setBounds(0, 0, ROOM_W, ROOM_H);
    this.screenFloor.setVisible(true);
  }

  /** Single-room setup for the lobby / offline fallback (origin 0, fixed screen). */
  private setActiveRoom(roomDef: DungeonRoomDef) {
    this.wallCollider?.destroy();
    this.wallCollider = undefined;
    this.wallBodies.forEach((wall) => wall.destroy());
    this.wallBodies = [];

    roomDef.walls.forEach((wall) => this.addWall(wall.x, wall.y, wall.w, wall.h));
    if (this.wallBodies.length > 0) {
      this.wallCollider = this.physics.add.collider(this.player.sprite, this.wallBodies);
    }
    this.physics.world.setBounds(0, 0, ROOM_W, ROOM_H);

    this.exitGraphic?.destroy();
    if (roomDef.exit) {
      const exit = roomDef.exit;
      this.exitGraphic = this.add
        .rectangle(exit.x + exit.w / 2, exit.y + exit.h / 2, exit.w, exit.h, 0x333333, 0.4)
        .setStrokeStyle(2, 0x555555)
        .setDepth(-1);
    } else {
      this.exitGraphic = undefined;
    }
  }

  private roomDefFromState(state: DungeonRoomState): DungeonRoomDef {
    const fallback = state.dungeonId ? dungeonDefs[state.dungeonId]?.rooms[state.roomIndex] : undefined;
    let layout: Partial<DungeonRoomDef> = {};
    if (state.roomLayoutJson) {
      try {
        layout = JSON.parse(state.roomLayoutJson) as Partial<DungeonRoomDef>;
      } catch {
        layout = {};
      }
    }

    return {
      id: state.roomId,
      type: state.roomType,
      name: state.roomName,
      entrance: layout.entrance ?? fallback?.entrance ?? { x: 480, y: 460 },
      exit: Object.prototype.hasOwnProperty.call(layout, "exit") ? layout.exit ?? null : fallback?.exit ?? null,
      walls: layout.walls ?? fallback?.walls ?? [],
    };
  }

  private spawnOfflineBoss() {
    this.offlineEnemy = new Enemy(this, 640, 320, bossDefs[OFFLINE_BOSS_ID], { id: "offline_boss", isBoss: true }, true);
    this.offlineEnemy.onBossAttack = (x, y, range, attack) => this.handleBossAttack(x, y, range, attack);
    this.offlineEnemy.onPhaseChange = (x, y) => this.handleBossPhaseChange(x, y);
    this.offlineEnemy.onBlink = (fx, fy, tx, ty) => this.handleBossBlink(fx, fy, tx, ty);
    this.offlineBossWasAlive = true;
  }

  /** Offline rematch (R): once the duel is decided, reset the hero and respawn the boss in place. */
  private retryOffline() {
    if (this.network.connected || !this.offlineEnemy) return;
    if (this.player.isAlive && this.offlineEnemy.isAlive) return;
    this.offlineEnemy.destroy();
    this.syncProjectiles([]);
    this.spawnOfflineBoss();
    this.player.sprite.setPosition(260, 460);
    this.player.syncHp(this.player.hpMax);
    this.player.stamina = this.player.staminaMax;
    this.hideDeathScreen();
    this.wasPlayerAlive = true;
    this.cameras.main.fadeIn(300, 0, 0, 0);
  }

  private async connectToServer() {
    const room = await this.network.connect({
      name: joinOptions.name,
      color: joinOptions.color,
      trimColor: joinOptions.trimColor,
      cape: joinOptions.cape,
      className: joinOptions.className,
      role: this.spectator ? "spectator" : "player",
      adminPin: joinOptions.adminPin,
    });
    if (!room) {
      this.statusText.setText(this.spectator ? "offline — nothing to spectate" : "offline — single-player only");
      if (this.spectator) return;
      this.spawnOfflineBoss();
      return;
    }

    room.onMessage("emote", (message: { sessionId: string; emote: string }) => {
      this.showEmote(message.sessionId, message.emote);
    });

    const spawn = room.state.players.get(room.sessionId);
    if (spawn) {
      this.player.sprite.setPosition(spawn.x, spawn.y);
      this.lastTeleportId = spawn.teleportId;
    }
    this.lastAdminNoticeId = room.state.adminNoticeId;

    const updateStatusText = () => {
      const count = room.state.players.size;
      const admin = room.state.adminCount > 0 ? "admin online" : "waiting for admin";
      this.statusText.setText(`connected · ${count} player${count === 1 ? "" : "s"} · ${admin}`);
    };
    updateStatusText();

    room.state.players.onAdd((state: RemotePlayerState, sessionId: string) => {
      updateStatusText();
      if (sessionId === room.sessionId) return;
      const remote = new RemotePlayer(this, state.x, state.y, Number(state.color), state.name, Number(state.trimColor), state.cape);
      this.remotePlayers.set(sessionId, remote);
    });

    room.state.players.onRemove((_state: RemotePlayerState, sessionId: string) => {
      updateStatusText();
      this.remotePlayers.get(sessionId)?.destroy();
      this.remotePlayers.delete(sessionId);
    });

    room.state.enemies.onAdd((state: EnemyState, enemyId: string) => {
      const def = state.isBoss ? bossDefs[state.defId] : enemyDefs[state.defId];
      if (!def) return;
      const enemy = new Enemy(this, state.x, state.y, def, { id: enemyId, isBoss: state.isBoss });
      enemy.onBossAttack = (x, y, range, attack) => this.handleBossAttack(x, y, range, attack);
      enemy.onPhaseChange = (x, y) => this.handleBossPhaseChange(x, y);
      enemy.onBlink = (fx, fy, tx, ty) => this.handleBossBlink(fx, fy, tx, ty);
      this.enemies.set(enemyId, enemy);
    });

    room.state.enemies.onRemove((_state: EnemyState, enemyId: string) => {
      this.enemies.get(enemyId)?.destroy();
      this.enemies.delete(enemyId);
    });

    room.state.items.onAdd((state: ItemPickupState, itemId: string) => {
      const def = itemDefs[state.itemId];
      const weapon = def?.weaponId ? WEAPONS[def.weaponId] : undefined;
      const color = weapon ? weapon.color : def ? Number(def.color) : 0xffffff;
      const visual = weapon
        ? this.add.sprite(state.x, state.y, ensureWeaponPickupTexture(this, weapon.sprite, weapon.color))
        : this.add.circle(state.x, state.y, 10, color);
      visual.setDepth(10);
      const glow = this.add.circle(state.x, state.y, 28, color, 0.16).setDepth(9);
      glow.setBlendMode(Phaser.BlendModes.ADD);
      const label = this.add
        .text(state.x, state.y + 30, def?.name ?? "Loot", {
          fontSize: "10px",
          color: "#f6e7bf",
          stroke: "#050507",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 0)
        .setDepth(11);
      this.tweens.add({ targets: visual, y: state.y - 8, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.tweens.add({ targets: glow, scale: 1.18, alpha: 0.28, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.tweens.add({ targets: label, alpha: 0.58, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.itemVisuals.set(itemId, { visual, glow, label });
    });

    room.state.items.onRemove((_state: ItemPickupState, itemId: string) => {
      sfx.pickup();
      const item = this.itemVisuals.get(itemId);
      if (item) {
        this.spawnHitParticles(item.visual.x, item.visual.y, item.glow.fillColor, 12);
        this.tweens.killTweensOf([item.visual, item.glow, item.label]);
        item.visual.destroy();
        item.glow.destroy();
        item.label.destroy();
      }
      this.itemVisuals.delete(itemId);
    });
  }

  update(time: number, delta: number) {
    if (this.player.isAlive && !this.spectator) {
      this.player.update(time, delta);
    }
    this.hud.setStamina(this.player.stamina);
    this.hud.update(delta);
    this.updateCooldownBar();
    this.updateAmbientDarkness();

    if (this.network.connected && this.network.room) {
      const room = this.network.room;
      const state = room.state;

      // Build the whole dungeon's walkable geometry once, whenever the dungeon changes.
      const dungeonDef = state.dungeonId ? dungeonDefs[state.dungeonId] : undefined;
      if (state.dungeonId !== this.dungeonGeomId) {
        this.dungeonGeomId = state.dungeonId;
        if (dungeonDef) this.buildDungeonGeometry(dungeonDef);
        else this.teardownDungeonGeometry();
        this.seenRoomKey = "";
        this.lastRoomIntroKey = "";
      }

      if (dungeonDef) {
        // Contiguous mode: no per-room rebuild — just move the highlight and open
        // doors as rooms are cleared. The player walks the corridors themselves.
        const roomKey = `${state.roomIndex}:${state.exitOpen}`;
        const introKey = `${state.dungeonId}:${state.roomIndex}:${state.roomName}`;
        if (roomKey !== this.seenRoomKey) {
          this.seenRoomKey = roomKey;
          // A run restarts back at room 0 (not yet cleared) — forget the old cleared path.
          if (state.roomIndex === 0 && !state.exitOpen) this.clearedRooms.clear();
          if (state.exitOpen) this.clearedRooms.add(state.roomIndex);
          this.updateHighlight(state.roomIndex);
          this.updateDoors(state.roomIndex);
          const o = this.roomOrigins[state.roomIndex];
          if (this.spectator && o) this.cameras.main.pan(o.x + ROOM_W / 2, o.y + ROOM_H / 2, 600, "Sine.easeInOut");
        }
        if (introKey !== this.lastRoomIntroKey && state.runPhase === "playing") {
          this.lastRoomIntroKey = introKey;
          this.showRoomIntro(state);
        }
        this.updateMinimap(dungeonDef, state.roomIndex);
      } else {
        // Lobby / offline: single fixed room at the origin.
        const roomKey = `${state.dungeonId}:${state.roomId}:${state.roomRevision}`;
        if (roomKey !== this.seenRoomKey) {
          this.seenRoomKey = roomKey;
          this.setActiveRoom(this.roomDefFromState(state));
        }
        this.updateMinimap(undefined, 0);
      }

      const localPlayer = state.players.get(room.sessionId);
      if (localPlayer) {
        const wasAlive = this.player.isAlive;
        if (localPlayer.teleportId !== this.lastTeleportId) {
          this.player.sprite.setPosition(localPlayer.x, localPlayer.y);
          this.lastTeleportId = localPlayer.teleportId;
        }
        if (localPlayer.weaponId !== this.player.weapon.id) this.player.setWeapon(localPlayer.weaponId);
        this.player.applyBonuses(localPlayer.hpMax, localPlayer.bonusDamage, localPlayer.bonusSpeedPct);
        if (localPlayer.lastHitSeq !== this.lastHitSeq) {
          this.lastHitSeq = localPlayer.lastHitSeq;
          this.networkHitSource = { x: localPlayer.lastHitX, y: localPlayer.lastHitY };
        }
        this.player.syncHp(localPlayer.hp, localPlayer.hpMax);
        this.hud.setGold(localPlayer.gold);
        this.hud.setPotions(localPlayer.potionCharges);
        this.hud.setHpMax(localPlayer.hpMax);
        this.syncShop(state, localPlayer.gold);
        const accNames = [localPlayer.accessory0, localPlayer.accessory1]
          .filter(Boolean)
          .map((id) => itemDefs[id]?.name ?? id);
        this.hud.setAccessories(accNames);
        if (!wasAlive && this.player.isAlive) {
          this.player.sprite.setPosition(localPlayer.x, localPlayer.y);
        }
      }
      this.hud.setHp(this.player.hp);
      const playerCount = state.players.size;
      const admin = state.adminCount > 0 ? "admin online" : "waiting for admin";
      this.statusText.setText(`connected · ${playerCount} player${playerCount === 1 ? "" : "s"} · ${admin}`);

      let boss: Enemy | undefined;
      let bossState: EnemyState | undefined;
      for (const [enemyId, enemy] of this.enemies) {
        const enemyState = state.enemies.get(enemyId);
        if (!enemyState) continue;
        const def = enemy.isBoss ? bossDefs[enemyState.defId] : enemyDefs[enemyState.defId];
        const phaseDef = enemy.isBoss ? def?.phases[enemyState.phaseIndex] : undefined;
        const phaseColor = phaseDef?.color ?? def?.color ?? "0xffffff";
        enemy.applyServerState(
          enemyState.x,
          enemyState.y,
          enemyState.hp,
          enemyState.hpMax,
          enemyState.state,
          phaseColor,
          enemyState.currentAttackId,
          enemyState.phaseIndex,
          enemyState.aimX,
          enemyState.aimY,
        );
        if (enemy.isBoss) {
          this.lastBossDefId = enemyState.defId;
          if (enemy.isAlive) {
            boss = enemy;
            bossState = enemyState;
          }
        }
      }
      this.updateBossBar(boss, bossState);

      const projectiles: { id: string; x: number; y: number; radius: number; color: number }[] = [];
      state.projectiles.forEach((proj, id) =>
        projectiles.push({ id, x: proj.x, y: proj.y, radius: proj.radius, color: Number(proj.color) }),
      );
      this.syncProjectiles(projectiles);

      for (const [itemId, item] of this.itemVisuals) {
        const itemState = state.items.get(itemId);
        const visible = !!itemState && !itemState.taken;
        item.visual.setVisible(visible);
        item.glow.setVisible(visible);
        item.label.setVisible(visible);
        item.glow.setPosition(item.visual.x, item.visual.y);
        item.label.setPosition(item.visual.x, item.visual.y + 28);
      }

      if (this.exitGraphic) {
        if (state.exitOpen) {
          const pulse = 0.25 + 0.15 * Math.sin(time / 150);
          this.exitGraphic.setFillStyle(0x55ff88, pulse);
          this.exitGraphic.setStrokeStyle(2, 0x55ff88);
        } else {
          this.exitGraphic.setFillStyle(0x333333, 0.4);
          this.exitGraphic.setStrokeStyle(2, 0x555555);
        }
      }

      this.moveSendAccumulator += delta;
      if (!this.spectator && this.moveSendAccumulator >= MOVE_SEND_INTERVAL_MS) {
        this.moveSendAccumulator = 0;
        this.network.sendMove(
          this.player.sprite.x,
          this.player.sprite.y,
          this.player.facing.x,
          this.player.facing.y,
          this.player.rolling,
        );
      }

      for (const [sessionId, remote] of this.remotePlayers) {
        const remoteState = state.players.get(sessionId);
        if (!remoteState) continue;
        remote.setTarget(
          remoteState.x,
          remoteState.y,
          remoteState.rolling,
          remoteState.hp,
          remoteState.facingX,
          remoteState.weaponId,
          remoteState.reviveProgress,
        );
        remote.update();
      }

      this.roomText.setText(
        state.runPhase === "lobby"
          ? "Lobby — waiting for admin"
          : `${state.dungeonName} — ${state.roomName} (${state.roomIndex + 1}/${state.roomCount})`,
      );
      this.objectiveText.setText(this.objectiveForState(state));

      if (state.runPhase === "lobby") this.hud.setRoomProgress(0, 0);
      else this.hud.setRoomProgress(state.roomIndex + 1, state.roomCount, state.roomName);

      if (state.adminNoticeId !== this.lastAdminNoticeId) {
        this.lastAdminNoticeId = state.adminNoticeId;
        if (state.adminNotice) this.showBanner(state.adminNotice, "#d8e8ff");
      }

      // "DOWNED" on going down (a teammate can revive you), cleared on revive/respawn.
      if (this.wasPlayerAlive && !this.player.isAlive) this.showDeathScreen("DOWNED");
      else if (!this.wasPlayerAlive && this.player.isAlive) this.hideDeathScreen();
      this.wasPlayerAlive = this.player.isAlive;

      // Run-phase transitions: victory / wipe banners.
      if (state.runPhase !== this.lastRunPhase) {
        if (state.runPhase === "victory") {
          sfx.victory();
          this.showBanner("DUNGEON CLEARED", "#e8d8b0");
          if (!this.spectator) {
            recordRun({ won: true, clearMs: state.clearTimeMs });
            bumpBossDefeated(this.lastBossDefId);
          }
        } else if (state.runPhase === "wiped") {
          this.showBanner("TEAM WIPED", "#a01818");
          if (!this.spectator) recordRun({ won: false });
        }
        this.lastRunPhase = state.runPhase;
      }

      if (!this.hurtFlashing) this.vignette.setAlpha(this.lowHpVignetteAlpha());

      if (this.spectator) {
        const phase = state.runPhase === "lobby" ? "lobby" : state.runPhase;
        this.hint.setText(`SPECTATING — watching the room (${phase})`);
      } else if (state.runPhase === "lobby") {
        this.hint.setText("LOBBY — PvP is on! J to attack other players · waiting for the admin to launch a dungeon");
      } else if (state.runPhase === "victory") {
        const seconds = (state.clearTimeMs / 1000).toFixed(1);
        this.hint.setText(`DUNGEON CLEARED in ${seconds}s — returning to lobby soon...`);
      } else if (state.runPhase === "wiped") {
        const secondsLeft = Math.max(0, Math.ceil((state.resetAt - Date.now()) / 1000));
        this.hint.setText(`TEAM WIPED — restarting in ${secondsLeft}...`);
      } else if (!this.player.isAlive) {
        const pct = Math.round((state.players.get(room.sessionId)?.reviveProgress ?? 0) * 100);
        this.hint.setText(
          pct > 0
            ? `DOWNED — an ally is reviving you (${pct}%)`
            : "DOWNED — a teammate must reach you to revive",
        );
      } else if (state.exitOpen) {
        this.hint.setText("Room cleared — the door ahead is open. Move on!");
      } else {
        this.hint.setText(DEFAULT_HINT);
      }
    } else if (this.offlineEnemy) {
      const events = this.offlineEnemy.update(time, delta, {
        id: "local",
        x: this.player.sprite.x,
        y: this.player.sprite.y,
        alive: this.player.isAlive,
      });
      this.syncProjectiles(
        this.offlineEnemy.localProjectiles.map((p) => ({ id: `off:${p.id}`, x: p.x, y: p.y, radius: p.radius, color: Number(p.color) })),
      );

      for (const event of events) {
        if (!this.player.isAlive || this.player.isInvulnerable) continue;
        this.player.takeDamage(event.damage);
        this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0xff3333);
        this.hitStop();
      }
      this.hud.setHp(this.player.hp);

      const offBoss = this.offlineEnemy.isAlive ? this.offlineEnemy : undefined;
      if (offBoss) {
        this.bossBar.show(this);
        this.bossBar.setBoss(offBoss.def.name, offBoss.def.phases.length, offBoss.phaseIndex);
        this.bossBar.setFraction(offBoss.hp / Math.max(1, offBoss.hpMax));
      } else {
        this.bossBar.hide(this);
      }
      this.bossBar.update();

      if (this.wasPlayerAlive && !this.player.isAlive) this.showDeathScreen();
      this.wasPlayerAlive = this.player.isAlive;
      if (this.offlineBossWasAlive && !this.offlineEnemy.isAlive) {
        this.offlineBossWasAlive = false;
        sfx.victory();
        this.showBanner("BOSS DEFEATED", "#e8d8b0");
      }
      if (!this.hurtFlashing) this.vignette.setAlpha(this.lowHpVignetteAlpha());

      if (!this.player.isAlive) {
        this.hint.setText("YOU DIED — press R to retry");
        this.objectiveText.setText("Defeat. Press R to retry.");
      } else if (!this.offlineEnemy.isAlive) {
        this.hint.setText("BOSS DEFEATED — press R for a rematch");
        this.objectiveText.setText("Boss defeated. Press R for a rematch.");
      } else {
        this.hint.setText(DEFAULT_HINT);
        this.objectiveText.setText("Offline duel: defeat the Sentinel.");
      }
    }
  }
}
