import Phaser from "phaser";

interface LeaderSummary {
  id: string;
  name: string;
  entries: { clearMs: number; party: string[]; playerCount: number }[];
}

/**
 * Lobby-only leaderboard of the fastest party clears per dungeon (fed by the
 * server's persistent `leaderboardJson`). Shows the best time for each dungeon,
 * fastest first — the cross-session competition hook between classes/periods.
 */
export class LeaderboardPanel {
  private container: Phaser.GameObjects.Container;
  private title: Phaser.GameObjects.Text;
  private lines: Phaser.GameObjects.Text;
  private lastJson = "";

  private static readonly X = 704;
  private static readonly Y = 60;
  private static readonly W = 244;

  constructor(scene: Phaser.Scene) {
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(98).setVisible(false);

    const frame = scene.add
      .rectangle(LeaderboardPanel.X, LeaderboardPanel.Y, LeaderboardPanel.W, 220, 0x0a0a0f, 0.55)
      .setOrigin(0, 0)
      .setStrokeStyle(2, 0x6b5a3a);
    this.container.add(frame);

    this.title = scene.add
      .text(LeaderboardPanel.X + 12, LeaderboardPanel.Y + 10, "🏆 FASTEST CLEARS", { fontSize: "12px", color: "#f3e4bd", fontStyle: "bold" })
      .setOrigin(0, 0);
    this.container.add(this.title);

    this.lines = scene.add
      .text(LeaderboardPanel.X + 12, LeaderboardPanel.Y + 34, "No clears yet — be the first!", {
        fontSize: "11px",
        color: "#c8cfda",
        lineSpacing: 5,
        wordWrap: { width: LeaderboardPanel.W - 24 },
      })
      .setOrigin(0, 0);
    this.container.add(this.lines);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
  }

  /** Re-render from the server's leaderboard JSON (no-op if unchanged). */
  update(json: string) {
    if (json === this.lastJson) return;
    this.lastJson = json;

    let summary: LeaderSummary[] = [];
    try {
      if (json) summary = JSON.parse(json) as LeaderSummary[];
    } catch {
      summary = [];
    }

    const best = summary
      .filter((d) => d.entries.length > 0)
      .map((d) => ({ name: d.name, ...d.entries[0] }))
      .sort((a, b) => a.clearMs - b.clearMs)
      .slice(0, 9);

    if (best.length === 0) {
      this.lines.setText("No clears yet — be the first!");
      return;
    }
    this.lines.setText(best.map((b) => `${clock(b.clearMs)}  ${b.name} (${b.playerCount}p)`).join("\n"));
  }
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
