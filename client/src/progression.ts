// Lightweight per-browser progression stored in localStorage. Purely local and
// cosmetic — the server stays authoritative for gameplay. Every access is
// guarded because localStorage can throw in private-browsing modes.

const STORAGE_KEY = "dg_progress";

export interface ProgressStats {
  runsPlayed: number;
  runsWon: number;
  bestClearMs: number | null;
  bossesDefeated: string[];
}

const EMPTY: ProgressStats = { runsPlayed: 0, runsWon: 0, bestClearMs: null, bossesDefeated: [] };

export function getStats(): ProgressStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<ProgressStats>;
    return {
      runsPlayed: Number(parsed.runsPlayed) || 0,
      runsWon: Number(parsed.runsWon) || 0,
      bestClearMs: typeof parsed.bestClearMs === "number" ? parsed.bestClearMs : null,
      bossesDefeated: Array.isArray(parsed.bossesDefeated) ? parsed.bossesDefeated : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function save(stats: ProgressStats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Ignore write failures (private mode, quota) — progression is best-effort.
  }
}

export function recordRun(run: { won: boolean; clearMs?: number }) {
  const stats = getStats();
  stats.runsPlayed += 1;
  if (run.won) {
    stats.runsWon += 1;
    if (typeof run.clearMs === "number" && run.clearMs > 0) {
      stats.bestClearMs = stats.bestClearMs === null ? run.clearMs : Math.min(stats.bestClearMs, run.clearMs);
    }
  }
  save(stats);
}

export function bumpBossDefeated(id: string) {
  if (!id) return;
  const stats = getStats();
  if (!stats.bossesDefeated.includes(id)) {
    stats.bossesDefeated.push(id);
    save(stats);
  }
}

/** "Runs: 3 · Wins: 1 · Best: 01:24" — Best omitted until a run is cleared. */
export function formatSummary(stats: ProgressStats = getStats()): string {
  const parts = [`Runs: ${stats.runsPlayed}`, `Wins: ${stats.runsWon}`];
  if (stats.bestClearMs !== null) parts.push(`Best: ${formatClock(stats.bestClearMs)}`);
  return parts.join(" · ");
}

function formatClock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
