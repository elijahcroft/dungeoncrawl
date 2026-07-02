import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Boss, type BossDef } from "../entities/Boss";
import { RemotePlayer } from "../entities/RemotePlayer";
import { Bar } from "../ui/Bar";
import { Network, type RemotePlayerState } from "../network/Network";
import bossesData from "../../../data/bosses.json";

const bossDefs = bossesData as Record<string, BossDef>;
const ACTIVE_BOSS_ID = "sentinel";
const LOCAL_PLAYER_ID = "local";

const PLAYER_ATTACK_HIT_RADIUS = 46;
const MOVE_SEND_INTERVAL_MS = 50;
const HIT_STOP_MS = 70;
const SHAKE_DURATION_MS = 80;
const SHAKE_INTENSITY = 0.006;
const DEFAULT_HINT = "WASD move · SPACE dodge roll (i-frames) · J attack";

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private boss!: Boss;
  private playerHpBar!: Bar;
  private staminaBar!: Bar;
  private bossHpBar!: Bar;
  private hint!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  private network = new Network();
  private remotePlayers = new Map<string, RemotePlayer>();
  private moveSendAccumulator = 0;

  constructor() {
    super("GameScene");
  }

  create() {
    this.physics.world.setBounds(0, 0, 960, 640);

    this.createParticleTexture();

    this.player = new Player(this, 260, 460);
    this.boss = new Boss(this, 640, 320, bossDefs[ACTIVE_BOSS_ID]);

    this.player.onAttack = (x, y) => {
      if (!this.boss.isAlive) return;
      const dist = Phaser.Math.Distance.Between(x, y, this.boss.sprite.x, this.boss.sprite.y);
      if (dist <= PLAYER_ATTACK_HIT_RADIUS) {
        if (this.network.connected) {
          this.network.sendBossHit(Player.attackDamage);
        } else {
          this.boss.takeDamage(Player.attackDamage);
          this.bossHpBar.setValue(this.boss.hp);
        }
        this.spawnHitParticles(this.boss.sprite.x, this.boss.sprite.y, 0xffcc33);
        this.hitStop();
      }
    };

    this.player.onRoll = () => {
      this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0x4da6ff, 5);
    };

    this.playerHpBar = new Bar(this, 20, 24, 200, 18, this.player.hpMax, 0x4dff88);
    this.staminaBar = new Bar(this, 20, 48, 200, 12, this.player.staminaMax, 0xffdd44);
    this.bossHpBar = new Bar(this, 740, 24, 200, 18, this.boss.hpMax, 0xff5555);

    this.add.text(20, 4, "PLAYER", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);
    this.add
      .text(740, 4, bossDefs[ACTIVE_BOSS_ID].name.toUpperCase(), { fontSize: "12px", color: "#ffffff" })
      .setScrollFactor(0);

    this.hint = this.add
      .text(480, 610, DEFAULT_HINT, {
        fontSize: "13px",
        color: "#888888",
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0);

    this.statusText = this.add
      .text(480, 12, "connecting...", { fontSize: "12px", color: "#666666" })
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

  private async connectToServer() {
    const room = await this.network.connect();
    if (!room) {
      this.statusText.setText("offline — single-player only");
      return;
    }

    const spawn = room.state.players.get(room.sessionId);
    if (spawn) {
      this.player.sprite.setPosition(spawn.x, spawn.y);
    }

    const updateStatusText = () => {
      const count = room.state.players.size;
      this.statusText.setText(
        `connected · session ${room.sessionId.slice(0, 6)} · ${count} player${count === 1 ? "" : "s"}`,
      );
    };
    updateStatusText();

    room.state.players.onAdd((state: RemotePlayerState, sessionId: string) => {
      updateStatusText();
      if (sessionId === room.sessionId) return;
      const remote = new RemotePlayer(this, state.x, state.y);
      this.remotePlayers.set(sessionId, remote);
    });

    room.state.players.onRemove((_state: RemotePlayerState, sessionId: string) => {
      updateStatusText();
      this.remotePlayers.get(sessionId)?.destroy();
      this.remotePlayers.delete(sessionId);
    });
  }

  update(time: number, delta: number) {
    if (this.player.isAlive) {
      this.player.update(time, delta);
    }

    this.staminaBar.setValue(this.player.stamina);

    if (this.network.connected && this.network.room) {
      const state = this.network.room.state;
      this.bossHpBar.setValue(state.bossHp);
      const phaseDef = bossDefs[ACTIVE_BOSS_ID].phases[state.bossPhase];
      this.boss.applyServerState(
        state.bossX,
        state.bossY,
        state.bossState,
        phaseDef?.color ?? bossDefs[ACTIVE_BOSS_ID].color,
      );
      this.boss.syncHp(state.bossHp);

      const localPlayer = state.players.get(this.network.room.sessionId);
      if (localPlayer) {
        const wasAlive = this.player.isAlive;
        this.player.syncHp(localPlayer.hp);
        if (!wasAlive && this.player.isAlive) {
          // Respawned server-side — snap to the server's respawn position.
          this.player.sprite.setPosition(localPlayer.x, localPlayer.y);
        }
      }
      this.playerHpBar.setValue(this.player.hp);

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
        remote.setTarget(remoteState.x, remoteState.y, remoteState.rolling, remoteState.hp);
        remote.update();
      }
    } else {
      const events = this.boss.update(time, delta, {
        id: LOCAL_PLAYER_ID,
        x: this.player.sprite.x,
        y: this.player.sprite.y,
        alive: this.player.isAlive,
      });
      this.bossHpBar.setValue(this.boss.hp);

      for (const event of events) {
        if (!this.player.isAlive || this.player.isInvulnerable) continue;
        this.player.takeDamage(event.damage);
        this.spawnHitParticles(this.player.sprite.x, this.player.sprite.y, 0xff3333);
        this.hitStop();
      }
      this.playerHpBar.setValue(this.player.hp);
    }

    if (this.network.connected && this.network.room) {
      const { roomPhase, resetAt } = this.network.room.state;
      if (roomPhase !== "fighting") {
        const secondsLeft = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
        const label = roomPhase === "victory" ? "BOSS DEFEATED" : "TEAM WIPED";
        this.hint.setText(`${label} — restarting in ${secondsLeft}...`);
      } else if (!this.player.isAlive) {
        this.hint.setText("DOWN — respawning soon...");
      } else {
        this.hint.setText(DEFAULT_HINT);
      }
    } else if (!this.player.isAlive) {
      this.hint.setText("YOU DIED — refresh to retry");
    } else if (!this.boss.isAlive) {
      this.hint.setText("BOSS DEFEATED — refresh to retry");
    } else {
      this.hint.setText(DEFAULT_HINT);
    }
  }
}
