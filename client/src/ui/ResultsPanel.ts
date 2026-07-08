import Phaser from "phaser";

/** One player's row in the end-of-run scoreboard (mirrors the server `run_results` payload). */
export interface RunResultRow {
  sessionId: string;
  name: string;
  className: string;
  color: string;
  damageDealt: number;
  kills: number;
  revives: number;
  deaths: number;
  goldEarned: number;
  biggestHit: number;
}

export interface RunResults {
  won: boolean;
  clearTimeMs: number;
  dungeonName: string;
  players: RunResultRow[];
  superlatives: {
    mvp: string | null;
    mostRevives: string | null;
    biggestHit: string | null;
    mostGold: string | null;
  };
}

/**
 * End-of-run MVP scoreboard: a centered board of per-player stats with fun
 * superlative badges (🏆 MVP, ✚ Medic, 💥 Big Hit, 💰 Rich). Rebuilt on each
 * show() so it always reflects the latest run. Purely informational — like the
 * PauseMenu it draws over the running scene and never pauses the sim.
 */
export class ResultsPanel {
  private scene: Phaser.Scene;
  private container?: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  show(results: RunResults, localSessionId: string | null) {
    this.hide();
    const scene = this.scene;

    const rows = [...results.players].sort((a, b) => b.damageDealt - a.damageDealt).slice(0, 10);
    const badges = this.badgesBySession(results.superlatives);

    const panelW = 620;
    const headerH = 96;
    const rowH = 26;
    const panelH = headerH + rows.length * rowH + 28;
    const panelX = 480 - panelW / 2;
    const panelY = 320 - panelH / 2;

    const container = scene.add.container(0, 0).setScrollFactor(0).setDepth(310);
    this.container = container;

    container.add(scene.add.rectangle(480, 320, 960, 640, 0x05050a, 0.72).setOrigin(0.5).setScrollFactor(0));
    container.add(
      scene.add
        .rectangle(panelX, panelY, panelW, panelH, 0x0b0b12, 0.96)
        .setOrigin(0, 0)
        .setStrokeStyle(2, results.won ? 0xc9a94a : 0x8a3a3a),
    );

    container.add(
      scene.add
        .text(480, panelY + 16, results.won ? "VICTORY" : "TEAM WIPED", {
          fontSize: "26px",
          color: results.won ? "#f3e4bd" : "#e88",
          fontStyle: "bold",
        })
        .setOrigin(0.5, 0),
    );
    const sub = results.won
      ? `${results.dungeonName} cleared in ${(results.clearTimeMs / 1000).toFixed(1)}s`
      : `${results.dungeonName} — the party fell`;
    container.add(scene.add.text(480, panelY + 50, sub, { fontSize: "13px", color: "#aeb8c8" }).setOrigin(0.5, 0));

    // Column layout.
    const cols = [
      { x: panelX + 20, label: "PLAYER", align: 0 as const },
      { x: panelX + 300, label: "DMG", align: 1 as const },
      { x: panelX + 370, label: "KILLS", align: 1 as const },
      { x: panelX + 440, label: "REVIVES", align: 1 as const },
      { x: panelX + 520, label: "DIED", align: 1 as const },
      { x: panelX + 600, label: "GOLD", align: 1 as const },
    ];
    const headerY = panelY + 76;
    for (const c of cols) {
      container.add(
        scene.add.text(c.x, headerY, c.label, { fontSize: "10px", color: "#7f8896", fontStyle: "bold" }).setOrigin(c.align, 0.5),
      );
    }

    rows.forEach((r, i) => {
      const y = headerY + 22 + i * rowH;
      const isLocal = r.sessionId === localSessionId;
      const badge = badges.get(r.sessionId);
      if (isLocal) {
        container.add(
          scene.add.rectangle(panelX + 10, y - rowH / 2 + 3, panelW - 20, rowH - 4, 0x2a3550, 0.5).setOrigin(0, 0).setScrollFactor(0),
        );
      }
      const nameStr = badge ? `${r.name}  ${badge}` : r.name;
      container.add(
        scene.add
          .text(cols[0].x, y, nameStr, { fontSize: "13px", color: isLocal ? "#ffffff" : "#d8d1bd", fontStyle: isLocal ? "bold" : "normal" })
          .setOrigin(0, 0.5),
      );
      const vals = [r.damageDealt, r.kills, r.revives, r.deaths, r.goldEarned];
      vals.forEach((v, ci) => {
        container.add(
          scene.add.text(cols[ci + 1].x, y, String(Math.round(v)), { fontSize: "12px", color: "#c8cfda" }).setOrigin(1, 0.5),
        );
      });
    });

    container.add(
      scene.add
        .text(480, panelY + panelH - 14, "Back to the lobby shortly…", { fontSize: "11px", color: "#8892a2" })
        .setOrigin(0.5, 0.5),
    );
  }

  private badgesBySession(s: RunResults["superlatives"]): Map<string, string> {
    const m = new Map<string, string>();
    const add = (id: string | null, label: string) => {
      if (!id) return;
      m.set(id, m.has(id) ? `${m.get(id)} ${label}` : label);
    };
    add(s.mvp, "🏆 MVP");
    add(s.mostRevives, "✚ Medic");
    add(s.biggestHit, "💥 Big Hit");
    add(s.mostGold, "💰 Rich");
    return m;
  }

  hide() {
    this.container?.destroy(true);
    this.container = undefined;
  }
}
