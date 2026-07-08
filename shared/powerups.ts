/**
 * Roguelite level-up power-ups — the single source of truth shared by client and
 * server, imported the same way as `classes.ts` and `abilities.ts`.
 *
 * Players earn XP by killing enemies (granted server-side, mirroring gold). On
 * hitting an XP threshold they level up and are offered a small random hand of
 * power-ups to pick from; because the hand is rolled fresh each level-up from a
 * rarity-weighted pool, the choices differ every run.
 *
 * Effects are deliberately declarative. A power-up is either a flat stat line
 * (`stat`/`amount`, folded into the server's `recomputeStats`) or a list of
 * triggered `effects` (see effects.ts) dispatched by the server's damage
 * pipeline — or both. Either way, new power-ups are data, not code.
 */
import type { EffectDef, ModifierDef } from "./effects";

export type PowerUpRarity = "common" | "rare" | "epic" | "legendary";
export type PowerUpStat =
  | "damage"
  | "hpMax"
  | "speedPct"
  | "attackSpeedPct"
  | "critPct"
  | "lifestealPct"
  | "cdrPct"
  | "regenPerSec";

export interface PowerUpDef {
  id: string;
  name: string;
  /** One-line effect summary shown on the card. */
  desc: string;
  /** Emoji glyph shown large on the card. */
  icon: string;
  rarity: PowerUpRarity;
  /** Simple flat stat line (the original power-up shape). */
  stat?: PowerUpStat;
  /** Flat amount added to the stat (damage/hp are points, speedPct is percent). */
  amount?: number;
  /** Triggered effects (see effects.ts) — the Isaac-style build-changing kind. */
  effects?: EffectDef[];
}

/** Adapt a power-up (old stat/amount shape or new effects shape) into the unified ModifierDef. */
export function powerUpModifier(def: PowerUpDef): ModifierDef {
  return {
    stats: def.stat !== undefined ? { [def.stat]: def.amount ?? 0 } : undefined,
    effects: def.effects,
  };
}

export const POWERUPS: Record<string, PowerUpDef> = {
  // --- Flat stat lines (fold into recomputeStats' bonusDamage/hpMax/bonusSpeedPct) ---
  keen_edge:    { id: "keen_edge",    name: "Keen Edge",     icon: "⚔️", rarity: "common", stat: "damage",   amount: 4,  desc: "+4 Damage" },
  vitality:     { id: "vitality",     name: "Vitality",      icon: "❤️", rarity: "common", stat: "hpMax",    amount: 20, desc: "+20 Max HP" },
  quickstep:    { id: "quickstep",    name: "Quickstep",     icon: "👟", rarity: "common", stat: "speedPct", amount: 8,  desc: "+8% Move Speed" },
  berserker:    { id: "berserker",    name: "Berserker",     icon: "🗡️", rarity: "rare",   stat: "damage",   amount: 8,  desc: "+8 Damage" },
  ironhide:     { id: "ironhide",     name: "Ironhide",      icon: "🛡️", rarity: "rare",   stat: "hpMax",    amount: 40, desc: "+40 Max HP" },
  fleetfoot:    { id: "fleetfoot",    name: "Fleetfoot",     icon: "🌀", rarity: "rare",   stat: "speedPct", amount: 15, desc: "+15% Move Speed" },
  executioner:  { id: "executioner", name: "Executioner",   icon: "💀", rarity: "epic",   stat: "damage",   amount: 14, desc: "+14 Damage" },
  titan_heart:  { id: "titan_heart",  name: "Titan Heart",   icon: "👑", rarity: "epic",   stat: "hpMax",    amount: 70, desc: "+70 Max HP" },
  windwalker:   { id: "windwalker",   name: "Windwalker",    icon: "⚡", rarity: "epic",   stat: "speedPct", amount: 25, desc: "+25% Move Speed" },

  // --- Attack speed (client scales weapon cooldown) ---
  swift_blade:  { id: "swift_blade",  name: "Swift Blade",   icon: "🐝", rarity: "common", stat: "attackSpeedPct", amount: 10, desc: "+10% Attack Speed" },
  frenzy:       { id: "frenzy",       name: "Frenzy",        icon: "🔪", rarity: "rare",   stat: "attackSpeedPct", amount: 18, desc: "+18% Attack Speed" },
  bloodrage:    { id: "bloodrage",    name: "Bloodrage",     icon: "🥊", rarity: "epic",   stat: "attackSpeedPct", amount: 30, desc: "+30% Attack Speed" },

  // --- Crit (client rolls per swing, hits land for double) ---
  lucky_strike: { id: "lucky_strike", name: "Lucky Strike",  icon: "🎯", rarity: "rare",   stat: "critPct", amount: 12, desc: "+12% Crit Chance (2× dmg)" },
  deadeye:      { id: "deadeye",      name: "Deadeye",       icon: "👁️", rarity: "epic",   stat: "critPct", amount: 22, desc: "+22% Crit Chance (2× dmg)" },

  // --- Lifesteal (server heals attacker on hit) ---
  vampiric:     { id: "vampiric",     name: "Vampiric",      icon: "🦇", rarity: "rare",   stat: "lifestealPct", amount: 8,  desc: "Heal 8% of damage dealt" },
  bloodthirst:  { id: "bloodthirst",  name: "Bloodthirst",   icon: "🩸", rarity: "epic",   stat: "lifestealPct", amount: 15, desc: "Heal 15% of damage dealt" },

  // --- Cooldown reduction (faster signature ability) ---
  focus:        { id: "focus",        name: "Focus",         icon: "🔮", rarity: "rare",   stat: "cdrPct", amount: 15, desc: "-15% Ability Cooldown" },
  overclock:    { id: "overclock",    name: "Overclock",     icon: "⏱️", rarity: "epic",   stat: "cdrPct", amount: 25, desc: "-25% Ability Cooldown" },

  // --- Health regen (server ticks HP back over time) ---
  regrowth:     { id: "regrowth",     name: "Regrowth",      icon: "🌱", rarity: "common", stat: "regenPerSec", amount: 2, desc: "Regen 2 HP/sec" },
  troll_blood:  { id: "troll_blood",  name: "Troll Blood",   icon: "🧪", rarity: "rare",   stat: "regenPerSec", amount: 5, desc: "Regen 5 HP/sec" },

  // --- Triggered effects (Isaac-style build-changers; dispatched by the server's damage pipeline) ---
  powder_keg:   { id: "powder_keg",   name: "Powder Keg",     icon: "💥", rarity: "epic", desc: "Kills explode for 40% of the hit",
                  effects: [{ trigger: "onKill", action: { kind: "aoeDamage", center: "target", radius: 100, pctOfHit: 40, element: "fire" } }] },
  storm_conduit:{ id: "storm_conduit", name: "Storm Conduit", icon: "🌩️", rarity: "epic", desc: "Crits chain lightning to 3 foes (60%)",
                  effects: [{ trigger: "onCrit", action: { kind: "chainDamage", jumps: 3, pctOfHit: 60, range: 220, element: "shock" } }] },
  echo_strike:  { id: "echo_strike",  name: "Echo Strike",    icon: "🔔", rarity: "rare", desc: "15% on hit: echo burst for 12 dmg",
                  effects: [{ trigger: "onHit", chancePct: 15, action: { kind: "aoeDamage", center: "target", radius: 70, flat: 12 } }] },
  thorn_pulse:  { id: "thorn_pulse",  name: "Thorn Pulse",    icon: "🌵", rarity: "rare", desc: "Getting hit blasts nearby foes for 15",
                  effects: [{ trigger: "onHurt", cooldownMs: 800, action: { kind: "aoeDamage", center: "self", radius: 110, flat: 15 } }] },
  midas_touch:  { id: "midas_touch",  name: "Midas Touch",    icon: "🪙", rarity: "rare", desc: "25% on kill: +6 bonus gold",
                  effects: [{ trigger: "onKill", chancePct: 25, action: { kind: "grantGold", amount: 6 } }] },
  adrenal_gland:{ id: "adrenal_gland", name: "Adrenal Gland", icon: "🫀", rarity: "epic", desc: "Kills grant +30% attack speed for 2.5s",
                  effects: [{ trigger: "onKill", action: { kind: "tempBuff", stat: "attackSpeedPct", amount: 30, durationMs: 2500 } }] },
  battle_trance:{ id: "battle_trance", name: "Battle Trance", icon: "🌀", rarity: "rare", desc: "Ability use: +20% speed for 3s",
                  effects: [{ trigger: "onAbilityUse", action: { kind: "tempBuff", stat: "speedPct", amount: 20, durationMs: 3000 } }] },
  second_wind:  { id: "second_wind",  name: "Second Wind",    icon: "🕊️", rarity: "epic", desc: "Below 30% HP: shield 1.5s + heal 20 (20s CD)",
                  effects: [{ trigger: "onLowHp", cooldownMs: 20000, action: { kind: "grantShield", durationMs: 1500 } },
                            { trigger: "onLowHp", cooldownMs: 20000, action: { kind: "heal", flat: 20 } }] },
  blood_pact:   { id: "blood_pact",   name: "Blood Pact",     icon: "🩹", rarity: "rare", desc: "Kills heal 6 HP",
                  effects: [{ trigger: "onKill", action: { kind: "heal", flat: 6 } }] },

  // --- Legendary payoffs (rare, run-defining) ---
  godslayer:    { id: "godslayer",    name: "Godslayer",     icon: "🌟", rarity: "legendary", stat: "damage",         amount: 30,  desc: "+30 Damage" },
  immortal:     { id: "immortal",     name: "Immortal",      icon: "💎", rarity: "legendary", stat: "hpMax",          amount: 150, desc: "+150 Max HP" },
  apex_hunter:  { id: "apex_hunter",  name: "Apex Hunter",   icon: "🏹", rarity: "legendary", stat: "critPct",        amount: 35,  desc: "+35% Crit Chance (2× dmg)" },
  leech_king:   { id: "leech_king",   name: "Leech King",    icon: "🦍", rarity: "legendary", stat: "lifestealPct",   amount: 25,  desc: "Heal 25% of damage dealt" },
};

export const POWERUP_LIST: PowerUpDef[] = Object.values(POWERUPS);

export const RARITY_WEIGHT: Record<PowerUpRarity, number> = { common: 60, rare: 30, epic: 10, legendary: 4 };

/** Damage multiplier applied to a hit that rolls a critical strike. */
export const CRIT_MULTIPLIER = 2;

/** Power-up lookup that returns undefined for unknown ids. */
export function powerUpDef(id: string | undefined): PowerUpDef | undefined {
  return id ? POWERUPS[id] : undefined;
}

/**
 * XP required to advance FROM `level` to the next one. Grows geometrically so
 * early levels come fast (a room or two) and later ones pace out. Level is
 * 1-based; the first threshold is xpToNext(1).
 */
export function xpToNext(level: number): number {
  return Math.round(40 * Math.pow(1.5, Math.max(0, level - 1)));
}

/**
 * Roll `count` distinct power-ups weighted by rarity — the hand offered on a
 * level-up. Rolls independently each call, so a run's choices vary. Never
 * returns duplicates within one hand; falls back to fewer if the pool is small.
 */
export function rollPowerUps(count = 3): PowerUpDef[] {
  const pool = [...POWERUP_LIST];
  const picked: PowerUpDef[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + RARITY_WEIGHT[p.rarity], 0);
    let roll = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      roll -= RARITY_WEIGHT[pool[i].rarity];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}
