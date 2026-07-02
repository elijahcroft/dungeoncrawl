import Phaser from "phaser";
import { Player } from "../entities/Player";
import { DummyBoss } from "../entities/DummyBoss";
import { Bar } from "../ui/Bar";

const PLAYER_ATTACK_HIT_RADIUS = 46;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private boss!: DummyBoss;
  private playerHpBar!: Bar;
  private staminaBar!: Bar;
  private bossHpBar!: Bar;
  private hint!: Phaser.GameObjects.Text;

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
      }
    };

    this.boss.onAttack = (x, y, radius) => {
      const dist = Phaser.Math.Distance.Between(x, y, this.player.sprite.x, this.player.sprite.y);
      if (dist <= radius) {
        this.player.takeDamage(DummyBoss.attackDamage);
        this.playerHpBar.setValue(this.player.hp);
      }
    };

    this.playerHpBar = new Bar(this, 20, 24, 200, 18, this.player.hpMax, 0x4dff88);
    this.staminaBar = new Bar(this, 20, 48, 200, 12, this.player.staminaMax, 0xffdd44);
    this.bossHpBar = new Bar(this, 740, 24, 200, 18, this.boss.hpMax, 0xff5555);

    this.add.text(20, 4, "PLAYER", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);
    this.add.text(740, 4, "DUMMY BOSS", { fontSize: "12px", color: "#ffffff" }).setScrollFactor(0);

    this.hint = this.add
      .text(
        480,
        610,
        "WASD move · SPACE dodge roll (i-frames) · J attack",
        { fontSize: "13px", color: "#888888" },
      )
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0);
  }

  update(time: number, delta: number) {
    if (this.player.isAlive) {
      this.player.update(time, delta);
    }
    this.boss.update(this.player.sprite.x, this.player.sprite.y);

    this.staminaBar.setValue(this.player.stamina);

    if (!this.player.isAlive) {
      this.hint.setText("YOU DIED — refresh to retry");
    } else if (!this.boss.isAlive) {
      this.hint.setText("BOSS DEFEATED — refresh to retry");
    }
  }
}
