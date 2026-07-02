import Phaser from "phaser";
import { Player } from "../entities/Player";
import { DummyBoss } from "../entities/DummyBoss";
import { RemotePlayer } from "../entities/RemotePlayer";
import { Bar } from "../ui/Bar";
import { Network, type RemotePlayerState } from "../network/Network";

const PLAYER_ATTACK_HIT_RADIUS = 46;
const MOVE_SEND_INTERVAL_MS = 50;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private boss!: DummyBoss;
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

    this.player = new Player(this, 260, 460);
    this.boss = new DummyBoss(this, 640, 320);

    this.player.onAttack = (x, y) => {
      if (!this.boss.isAlive) return;
      const dist = Phaser.Math.Distance.Between(x, y, this.boss.sprite.x, this.boss.sprite.y);
      if (dist <= PLAYER_ATTACK_HIT_RADIUS) {
        this.boss.takeDamage(Player.attackDamage);
        this.bossHpBar.setValue(this.boss.hp);
        this.network.sendBossHit(Player.attackDamage);
      }
    };

    this.boss.onAttack = (x, y, radius) => {
      const dist = Phaser.Math.Distance.Between(x, y, this.player.sprite.x, this.player.sprite.y);
      if (dist <= radius) {
        this.player.takeDamage(DummyBoss.attackDamage);
        this.playerHpBar.setValue(this.player.hp);
        this.network.sendPlayerHp(this.player.hp);
      }
    };

    this.playerHpBar = new Bar(this, 20, 24, 200, 18, this.player.hpMax, 0x4dff88);
    this.staminaBar = new Bar(this, 20, 48, 200, 12, this.player.staminaMax, 0xffdd44);
    this.bossHpBar = new Bar(this, 740, 24, 200, 18, this.boss.hpMax, 0xff5555);

    this.add.text(20, 4, "PLAYER", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);
    this.add.text(740, 4, "DUMMY BOSS", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);

    this.hint = this.add
      .text(480, 610, "WASD move · SPACE dodge roll (i-frames) · J attack", {
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

  private async connectToServer() {
    const room = await this.network.connect();
    if (!room) {
      this.statusText.setText("offline — single-player only");
      return;
    }

    this.statusText.setText(`connected · session ${room.sessionId.slice(0, 6)}`);

    const spawn = room.state.players.get(room.sessionId);
    if (spawn) {
      this.player.sprite.setPosition(spawn.x, spawn.y);
    }

    room.state.players.onAdd((state: RemotePlayerState, sessionId: string) => {
      if (sessionId === room.sessionId) return;
      const remote = new RemotePlayer(this, state.x, state.y);
      this.remotePlayers.set(sessionId, remote);
    });

    room.state.players.onRemove((_state: RemotePlayerState, sessionId: string) => {
      this.remotePlayers.get(sessionId)?.destroy();
      this.remotePlayers.delete(sessionId);
    });
  }

  update(time: number, delta: number) {
    if (this.player.isAlive) {
      this.player.update(time, delta);
    }
    this.boss.update(this.player.sprite.x, this.player.sprite.y);

    this.staminaBar.setValue(this.player.stamina);

    if (this.network.connected && this.network.room) {
      this.bossHpBar.setValue(this.network.room.state.bossHp);
      this.boss.syncHp(this.network.room.state.bossHp);

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
        const state = this.network.room.state.players.get(sessionId);
        if (!state) continue;
        remote.setTarget(state.x, state.y, state.rolling);
        remote.update();
      }
    }

    if (!this.player.isAlive) {
      this.hint.setText("YOU DIED — refresh to retry");
    } else if (!this.boss.isAlive) {
      this.hint.setText("BOSS DEFEATED — refresh to retry");
    }
  }
}
