import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy, type BossDef } from "../entities/Enemy";
import { RemotePlayer } from "../entities/RemotePlayer";
import { Bar } from "../ui/Bar";
import { BossBar } from "../ui/BossBar";
import { sfx } from "../audio/sfx";
import { Network, type RemotePlayerState, type EnemyState, type ItemPickupState, type DungeonRoomState } from "../network/Network";
import { joinOptions } from "../joinOptions";
import bossesData from "../../../data/bosses.json";
import enemiesData from "../../../data/enemies.json";
import dungeonsData from "../../../data/dungeons.json";
import itemsData from "../../../data/items.json";
import bossArtData from "../../../data/boss-art.json";
import { preloadBossArt, ensureWeaponPickupTexture, ensureFloorTexture } from "../gfx/sprites";
import { WEAPONS, type WeaponDef } from "../entities/weapons";
import type { BossAttackDef } from "../../../shared/boss";

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
}
interface DungeonDef {
  id: string;
  name: string;
  rooms: DungeonRoomDef[];
}
const dungeonDefs = dungeonsData as Record<string, DungeonDef>;

const CLASS_STATS: Record<string, { hpMax: number; speedPct: number }> = {
  warrior: { hpMax: 100, speedPct: 0 },
  guardian: { hpMax: 130, speedPct: -15 },
};

const MOVE_SEND_INTERVAL_MS = 50;
const HIT_STOP_MS = 70;
const SHAKE_DURATION_MS = 80;
const SHAKE_INTENSITY = 0.006;
const DEFAULT_HINT = "WASD move · SPACE dodge roll (i-frames) · J attack";
const OFFLINE_BOSS_ID = "sentinel";

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private playerHpBar!: Bar;
  private staminaBar!: Bar;
  private cooldownBar!: Bar;
  private cooldownLabel!: Phaser.GameObjects.Text;
  private goldText!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private roomText!: Phaser.GameObjects.Text;
  private bossBar!: BossBar;
  private vignette!: Phaser.GameObjects.Rectangle;
  private deathText!: Phaser.GameObjects.Text;
  private wasPlayerAlive = true;
  private lastRunPhase = "playing";
  private hurtFlashing = false;

  // Spectator = an admin watching the room with no controllable body.
  private spectator = false;

  private network = new Network();
  private remotePlayers = new Map<string, RemotePlayer>();
  private enemies = new Map<string, Enemy>();
  private itemVisuals = new Map<string, Phaser.GameObjects.Arc | Phaser.GameObjects.Sprite>();
  private projectileVisuals = new Map<string, { core: Phaser.GameObjects.Arc; glow: Phaser.GameObjects.Arc }>();
  private wallBodies: Phaser.GameObjects.Rectangle[] = [];
  private wallCollider?: Phaser.Physics.Arcade.Collider;
  private exitGraphic?: Phaser.GameObjects.Rectangle;
  private seenRoomKey = "";
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

    // Tiled stone floor behind everything for dungeon atmosphere.
    this.add.tileSprite(480, 320, 960, 640, ensureFloorTexture(this)).setScrollFactor(0).setDepth(-10);

    const classStats = CLASS_STATS[joinOptions.className] ?? CLASS_STATS.warrior;
    this.player = new Player(this, 260, 460, {
      color: Number(joinOptions.color),
      hpMax: classStats.hpMax,
      speedPct: classStats.speedPct,
    });

    this.player.onAttack = (x, y, dx, dy) => this.handlePlayerAttack(x, y, dx, dy);
    this.player.onSwing = () => sfx.swing();
    this.player.onRoll = () => {
      sfx.roll();
      this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0x4da6ff, 5);
      this.spawnRollTrail();
    };
    this.player.onHurt = () => this.handlePlayerHurt();

    this.playerHpBar = new Bar(this, 20, 24, 200, 18, this.player.hpMax, 0x4dff88);
    this.staminaBar = new Bar(this, 20, 48, 200, 12, this.player.staminaMax, 0xffdd44);
    // Minecraft-style attack-cooldown bar: drains on swing, refills over the weapon's cooldown.
    this.cooldownBar = new Bar(this, 20, 66, 200, 8, 1, 0x66ccff);
    this.cooldownLabel = this.add
      .text(226, 66, "", { fontSize: "10px", color: "#66ccff" })
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(101);

    this.goldText = this.add
      .text(20, 84, "Gold: 0", { fontSize: "12px", color: "#ffd24a" })
      .setScrollFactor(0)
      .setDepth(101);

    this.add
      .text(20, 4, joinOptions.name.toUpperCase(), { fontSize: "12px", color: "#ffffff" })
      .setScrollFactor(0);

    this.roomText = this.add
      .text(480, 4, "", { fontSize: "13px", color: "#ffffff" })
      .setOrigin(0.5, 0)
      .setScrollFactor(0);

    this.hint = this.add
      .text(480, 610, DEFAULT_HINT, { fontSize: "13px", color: "#888888" })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0);

    this.statusText = this.add
      .text(480, 22, "connecting...", { fontSize: "11px", color: "#666666" })
      .setOrigin(0.5, 0)
      .setScrollFactor(0);

    this.bossBar = new BossBar(this);

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

    // Web Audio starts suspended; resume it on the first key/pointer input.
    this.input.keyboard?.once("keydown", () => sfx.resume());
    this.input.once("pointerdown", () => sfx.resume());

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
    this.playerHpBar.setVisible(false);
    this.staminaBar.setVisible(false);
    this.cooldownBar.setVisible(false);
    this.cooldownLabel.setVisible(false);
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
  private weaponHits(weapon: WeaponDef, x: number, y: number, dirX: number, dirY: number, tx: number, ty: number) {
    switch (weapon.hitShape) {
      case "projectile":
        return false;
      case "thrust":
        return this.inThrustBox(x, y, dirX, dirY, tx, ty, weapon.reach, weapon.width ?? 24);
      case "slam":
        return Phaser.Math.Distance.Between(x, y, tx, ty) <= weapon.reach;
      case "arc":
      default:
        return this.inSwingArc(x, y, dirX, dirY, tx, ty, weapon.reach, Phaser.Math.DegToRad(weapon.arcDegrees) / 2);
    }
  }

  /** True when (tx, ty) falls inside the weapon's swing arc centered at (x, y) facing (dirX, dirY). */
  private inSwingArc(x: number, y: number, dirX: number, dirY: number, tx: number, ty: number, reach: number, halfArcRad: number) {
    const dist = Phaser.Math.Distance.Between(x, y, tx, ty);
    if (dist > reach) return false;
    const facingAngle = Math.atan2(dirY, dirX);
    const toTarget = Math.atan2(ty - y, tx - x);
    return Math.abs(Phaser.Math.Angle.Wrap(toTarget - facingAngle)) <= halfArcRad;
  }

  /** True when (tx, ty) is inside a straight stab: within `reach` ahead and `width/2` to either side of the aim. */
  private inThrustBox(x: number, y: number, dirX: number, dirY: number, tx: number, ty: number, reach: number, width: number) {
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;
    const relX = tx - x;
    const relY = ty - y;
    const along = relX * nx + relY * ny; // distance ahead along the aim
    if (along < 0 || along > reach) return false;
    const perp = Math.abs(relX * -ny + relY * nx); // sideways distance from the aim line
    return perp <= width / 2;
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
        if (!this.weaponHits(weapon, x, y, dirX, dirY, enemy.sprite.x, enemy.sprite.y)) continue;
        this.network.sendEnemyHit(enemy.id, this.player.damage);
        this.onEnemyHit(enemy, x, y);
        hitAny = true;
      }
      // PvP: only live while everyone is idling in the lobby, not mid-dungeon.
      if (this.network.room?.state.runPhase === "lobby") {
        for (const [sessionId, remote] of this.remotePlayers) {
          if (remote.hp <= 0) continue;
          if (!this.weaponHits(weapon, x, y, dirX, dirY, remote.sprite.x, remote.sprite.y)) continue;
          this.network.sendPlayerHit(sessionId, this.player.damage);
          this.spawnHitParticles(remote.sprite.x, remote.sprite.y, 0xff6688);
          this.spawnDamageNumber(remote.sprite.x, remote.sprite.y - 20, this.player.damage);
          hitAny = true;
        }
      }
    } else if (this.offlineEnemy?.isAlive) {
      if (this.weaponHits(weapon, x, y, dirX, dirY, this.offlineEnemy.sprite.x, this.offlineEnemy.sprite.y)) {
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

  /** Floating damage number that drifts up and fades. */
  private spawnDamageNumber(x: number, y: number, amount: number) {
    const text = this.add
      .text(x, y, String(Math.round(amount)), { fontSize: "16px", color: "#ffe08a", fontStyle: "bold" })
      .setOrigin(0.5)
      .setDepth(60);
    this.tweens.add({
      targets: text,
      y: y - 28,
      alpha: 0,
      duration: 600,
      ease: "Cubic.easeOut",
      onComplete: () => text.destroy(),
    });
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

  /** Player took a hit: red flash + edge-vignette pulse + knockback away from the nearest enemy. */
  private handlePlayerHurt() {
    sfx.hurt();
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

  private showDeathScreen() {
    sfx.death();
    this.deathText.setAlpha(0).setScale(1.4);
    this.tweens.add({ targets: this.deathText, alpha: 1, scale: 1, duration: 700, ease: "Cubic.easeOut" });
    this.cameras.main.shake(400, 0.008);
  }

  private hideDeathScreen() {
    this.tweens.add({ targets: this.deathText, alpha: 0, duration: 400 });
  }

  /** One-shot centered banner (dungeon cleared / team wiped) that fades in then drifts away. */
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
    this.cooldownBar.setValue(frac);
    this.cooldownBar.setFillColor(ready ? 0x66ff66 : 0x66ccff);
    this.cooldownLabel.setText(this.player.weapon.name);
    this.cooldownLabel.setColor(ready ? "#66ff66" : "#66ccff");
  }

  private rebuildRoom(roomDef: DungeonRoomDef) {
    this.wallCollider?.destroy();
    this.wallCollider = undefined;
    this.wallBodies.forEach((wall) => wall.destroy());
    this.wallBodies = [];

    roomDef.walls.forEach((wall) => {
      const rect = this.add
        .rectangle(wall.x + wall.w / 2, wall.y + wall.h / 2, wall.w, wall.h, 0x2a2a35)
        .setStrokeStyle(1, 0x44445a);
      this.physics.add.existing(rect, true);
      this.wallBodies.push(rect);
    });
    if (this.wallBodies.length > 0) {
      this.wallCollider = this.physics.add.collider(this.player.sprite, this.wallBodies);
    }

    this.exitGraphic?.destroy();
    if (roomDef.exit) {
      const exit = roomDef.exit;
      this.exitGraphic = this.add
        .rectangle(exit.x + exit.w / 2, exit.y + exit.h / 2, exit.w, exit.h, 0x333333, 0.4)
        .setStrokeStyle(2, 0x555555);
      this.exitGraphic.setDepth(-1);
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

  private async connectToServer() {
    const room = await this.network.connect({
      name: joinOptions.name,
      color: joinOptions.color,
      className: joinOptions.className,
      role: this.spectator ? "spectator" : "player",
      adminPin: joinOptions.adminPin,
    });
    if (!room) {
      this.statusText.setText(this.spectator ? "offline — nothing to spectate" : "offline — single-player only");
      if (this.spectator) return;
      this.offlineEnemy = new Enemy(this, 640, 320, bossDefs[OFFLINE_BOSS_ID], { id: "offline_boss", isBoss: true }, true);
      this.offlineEnemy.onBossAttack = (x, y, range, attack) => this.handleBossAttack(x, y, range, attack);
      this.offlineEnemy.onPhaseChange = (x, y) => this.handleBossPhaseChange(x, y);
      this.offlineEnemy.onBlink = (fx, fy, tx, ty) => this.handleBossBlink(fx, fy, tx, ty);
      return;
    }

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
      const remote = new RemotePlayer(this, state.x, state.y, Number(state.color), state.name);
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
      const visual = weapon
        ? this.add.sprite(state.x, state.y, ensureWeaponPickupTexture(this, weapon.sprite, weapon.color))
        : this.add.circle(state.x, state.y, 10, def ? Number(def.color) : 0xffffff);
      this.tweens.add({ targets: visual, y: state.y - 8, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.itemVisuals.set(itemId, visual);
    });

    room.state.items.onRemove((_state: ItemPickupState, itemId: string) => {
      sfx.pickup();
      this.itemVisuals.get(itemId)?.destroy();
      this.itemVisuals.delete(itemId);
    });
  }

  update(time: number, delta: number) {
    if (this.player.isAlive && !this.spectator) {
      this.player.update(time, delta);
    }
    this.staminaBar.setValue(this.player.stamina);
    this.updateCooldownBar();

    if (this.network.connected && this.network.room) {
      const room = this.network.room;
      const state = room.state;

      const roomKey = `${state.dungeonId}:${state.roomId}:${state.roomRevision}`;
      if (roomKey !== this.seenRoomKey) {
        const firstRoom = this.seenRoomKey === "";
        this.seenRoomKey = roomKey;
        this.rebuildRoom(this.roomDefFromState(state));
        // Wipe into each new room (the initial room already fades in from create()).
        if (!firstRoom) this.cameras.main.fadeIn(320, 0, 0, 0);
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
        this.goldText.setText(`Gold: ${localPlayer.gold}`);
        this.playerHpBar.setMax(localPlayer.hpMax);
        if (!wasAlive && this.player.isAlive) {
          this.player.sprite.setPosition(localPlayer.x, localPlayer.y);
        }
      }
      this.playerHpBar.setValue(this.player.hp);
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
        if (enemy.isBoss && enemy.isAlive) {
          boss = enemy;
          bossState = enemyState;
        }
      }
      this.updateBossBar(boss, bossState);

      const projectiles: { id: string; x: number; y: number; radius: number; color: number }[] = [];
      state.projectiles.forEach((proj, id) => projectiles.push({ id, x: proj.x, y: proj.y, radius: proj.radius, color: Number(proj.color) }));
      this.syncProjectiles(projectiles);

      for (const [itemId, visual] of this.itemVisuals) {
        const itemState = state.items.get(itemId);
        visual.setVisible(!!itemState && !itemState.taken);
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
        remote.setTarget(remoteState.x, remoteState.y, remoteState.rolling, remoteState.hp, remoteState.facingX, remoteState.weaponId);
        remote.update();
      }

      this.roomText.setText(
        state.runPhase === "lobby"
          ? "Lobby — waiting for admin"
          : `${state.dungeonName} — ${state.roomName} (${state.roomIndex + 1}/${state.roomCount})`,
      );

      if (state.adminNoticeId !== this.lastAdminNoticeId) {
        this.lastAdminNoticeId = state.adminNoticeId;
        if (state.adminNotice) this.showBanner(state.adminNotice, "#d8e8ff");
      }

      // "YOU DIED" on downing, cleared on respawn.
      if (this.wasPlayerAlive && !this.player.isAlive) this.showDeathScreen();
      else if (!this.wasPlayerAlive && this.player.isAlive) this.hideDeathScreen();
      this.wasPlayerAlive = this.player.isAlive;

      // Run-phase transitions: victory / wipe banners.
      if (state.runPhase !== this.lastRunPhase) {
        if (state.runPhase === "victory") {
          sfx.victory();
          this.showBanner("DUNGEON CLEARED", "#e8d8b0");
        } else if (state.runPhase === "wiped") {
          this.showBanner("TEAM WIPED", "#a01818");
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
        this.hint.setText("DOWN — respawning soon...");
      } else if (state.exitOpen && this.exitGraphic) {
        this.hint.setText("Room cleared — walk into the glowing exit!");
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
      this.playerHpBar.setValue(this.player.hp);

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
      if (!this.hurtFlashing) this.vignette.setAlpha(this.lowHpVignetteAlpha());

      if (!this.player.isAlive) {
        this.hint.setText("YOU DIED — refresh to retry");
      } else if (!this.offlineEnemy.isAlive) {
        this.hint.setText("BOSS DEFEATED — refresh to retry");
      } else {
        this.hint.setText(DEFAULT_HINT);
      }
    }
  }
}
