import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy, type BossDef } from "../entities/Enemy";
import { RemotePlayer } from "../entities/RemotePlayer";
import { Bar } from "../ui/Bar";
import { Network, type RemotePlayerState, type EnemyState, type ItemPickupState } from "../network/Network";
import { joinOptions } from "../joinOptions";
import bossesData from "../../../data/bosses.json";
import enemiesData from "../../../data/enemies.json";
import dungeonsData from "../../../data/dungeons.json";
import itemsData from "../../../data/items.json";

const bossDefs = bossesData as Record<string, BossDef>;
const enemyDefs = enemiesData as Record<string, BossDef>;
const itemDefs = itemsData as Record<string, { id: string; name: string; color: string }>;

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

const PLAYER_ATTACK_HIT_RADIUS = 46;
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
  private hint!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private roomText!: Phaser.GameObjects.Text;

  private network = new Network();
  private remotePlayers = new Map<string, RemotePlayer>();
  private enemies = new Map<string, Enemy>();
  private itemVisuals = new Map<string, Phaser.GameObjects.Arc>();
  private wallBodies: Phaser.GameObjects.Rectangle[] = [];
  private wallCollider?: Phaser.Physics.Arcade.Collider;
  private exitGraphic?: Phaser.GameObjects.Rectangle;
  private seenRoomKey = "";
  private moveSendAccumulator = 0;

  // Offline (no server) fallback: single fixed boss fight, same as pre-dungeon builds.
  private offlineEnemy?: Enemy;

  constructor() {
    super("GameScene");
  }

  create() {
    this.physics.world.setBounds(0, 0, 960, 640);
    this.createParticleTexture();

    const classStats = CLASS_STATS[joinOptions.className] ?? CLASS_STATS.warrior;
    this.player = new Player(this, 260, 460, {
      color: Number(joinOptions.color),
      hpMax: classStats.hpMax,
      speedPct: classStats.speedPct,
    });

    this.player.onAttack = (x, y) => this.handlePlayerAttack(x, y);
    this.player.onRoll = () => this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0x4da6ff, 5);

    this.playerHpBar = new Bar(this, 20, 24, 200, 18, this.player.hpMax, 0x4dff88);
    this.staminaBar = new Bar(this, 20, 48, 200, 12, this.player.staminaMax, 0xffdd44);

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

    this.connectToServer();
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

  private hitStop() {
    this.physics.world.pause();
    this.time.delayedCall(HIT_STOP_MS, () => this.physics.world.resume());
    this.cameras.main.shake(SHAKE_DURATION_MS, SHAKE_INTENSITY);
  }

  private handlePlayerAttack(x: number, y: number) {
    if (this.network.connected) {
      let nearest: Enemy | null = null;
      let nearestDist = Infinity;
      for (const enemy of this.enemies.values()) {
        if (!enemy.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(x, y, enemy.sprite.x, enemy.sprite.y);
        if (dist <= PLAYER_ATTACK_HIT_RADIUS && dist < nearestDist) {
          nearest = enemy;
          nearestDist = dist;
        }
      }
      if (nearest) {
        this.network.sendEnemyHit(nearest.id, this.player.damage);
        this.spawnHitParticles(nearest.sprite.x, nearest.sprite.y, 0xffcc33);
        this.hitStop();
      }
    } else if (this.offlineEnemy?.isAlive) {
      const dist = Phaser.Math.Distance.Between(x, y, this.offlineEnemy.sprite.x, this.offlineEnemy.sprite.y);
      if (dist <= PLAYER_ATTACK_HIT_RADIUS) {
        this.offlineEnemy.takeDamage(this.player.damage);
        this.spawnHitParticles(this.offlineEnemy.sprite.x, this.offlineEnemy.sprite.y, 0xffcc33);
        this.hitStop();
      }
    }
  }

  private rebuildRoom(roomDef: DungeonRoomDef) {
    this.wallCollider?.destroy();
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

  private async connectToServer() {
    const room = await this.network.connect({
      dungeonId: joinOptions.dungeonId,
      name: joinOptions.name,
      color: joinOptions.color,
      className: joinOptions.className,
    });
    if (!room) {
      this.statusText.setText("offline — single-player only");
      this.offlineEnemy = new Enemy(this, 640, 320, bossDefs[OFFLINE_BOSS_ID], { id: "offline_boss", isBoss: true }, true);
      return;
    }

    const spawn = room.state.players.get(room.sessionId);
    if (spawn) {
      this.player.sprite.setPosition(spawn.x, spawn.y);
    }

    const updateStatusText = () => {
      const count = room.state.players.size;
      this.statusText.setText(`connected · ${count} player${count === 1 ? "" : "s"}`);
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
      this.enemies.set(enemyId, enemy);
    });

    room.state.enemies.onRemove((_state: EnemyState, enemyId: string) => {
      this.enemies.get(enemyId)?.destroy();
      this.enemies.delete(enemyId);
    });

    room.state.items.onAdd((state: ItemPickupState, itemId: string) => {
      const def = itemDefs[state.itemId];
      const circle = this.add.circle(state.x, state.y, 10, def ? Number(def.color) : 0xffffff);
      this.tweens.add({ targets: circle, y: state.y - 8, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.itemVisuals.set(itemId, circle);
    });

    room.state.items.onRemove((_state: ItemPickupState, itemId: string) => {
      this.itemVisuals.get(itemId)?.destroy();
      this.itemVisuals.delete(itemId);
    });
  }

  update(time: number, delta: number) {
    if (this.player.isAlive) {
      this.player.update(time, delta);
    }
    this.staminaBar.setValue(this.player.stamina);

    if (this.network.connected && this.network.room) {
      const room = this.network.room;
      const state = room.state;

      const roomKey = `${state.dungeonId}:${state.roomId}`;
      if (roomKey !== this.seenRoomKey) {
        this.seenRoomKey = roomKey;
        const roomDef = dungeonDefs[state.dungeonId]?.rooms[state.roomIndex];
        if (roomDef) this.rebuildRoom(roomDef);
      }

      const localPlayer = state.players.get(room.sessionId);
      if (localPlayer) {
        const wasAlive = this.player.isAlive;
        this.player.applyBonuses(localPlayer.hpMax, localPlayer.bonusDamage, localPlayer.bonusSpeedPct);
        this.player.syncHp(localPlayer.hp, localPlayer.hpMax);
        this.playerHpBar.setMax(localPlayer.hpMax);
        if (!wasAlive && this.player.isAlive) {
          this.player.sprite.setPosition(localPlayer.x, localPlayer.y);
        }
      }
      this.playerHpBar.setValue(this.player.hp);

      for (const [enemyId, enemy] of this.enemies) {
        const enemyState = state.enemies.get(enemyId);
        if (!enemyState) continue;
        const def = enemy.isBoss ? bossDefs[enemyState.defId] : enemyDefs[enemyState.defId];
        const phaseDef = enemy.isBoss ? def?.phases[enemyState.phaseIndex] : undefined;
        const phaseColor = phaseDef?.color ?? def?.color ?? "0xffffff";
        enemy.applyServerState(enemyState.x, enemyState.y, enemyState.hp, enemyState.hpMax, enemyState.state, phaseColor);
      }

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
      if (this.moveSendAccumulator >= MOVE_SEND_INTERVAL_MS) {
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
        remote.setTarget(remoteState.x, remoteState.y, remoteState.rolling, remoteState.hp, remoteState.facingX);
        remote.update();
      }

      this.roomText.setText(`${state.dungeonName} — ${state.roomName} (${state.roomIndex + 1}/${state.roomCount})`);

      if (state.runPhase === "victory") {
        const seconds = (state.clearTimeMs / 1000).toFixed(1);
        this.hint.setText(`DUNGEON CLEARED in ${seconds}s — restarting soon...`);
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

      for (const event of events) {
        if (!this.player.isAlive || this.player.isInvulnerable) continue;
        this.player.takeDamage(event.damage);
        this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0xff3333);
        this.hitStop();
      }
      this.playerHpBar.setValue(this.player.hp);

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
