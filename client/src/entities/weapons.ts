import type { WeaponSprite } from "../gfx/sprites";

/**
 * Player weapons. Each weapon is the single item a player carries; better
 * weapons are collected over the course of a run (acquisition wiring lives
 * elsewhere — this module just defines the stat blocks and looks).
 *
 * Weapons differ by their hitbox SHAPE, not just their numbers:
 *   - "arc"    a swing cone centered on the player (`reach` radius, `arcDegrees` wide)
 *   - "thrust" a straight stab: a rectangle `reach` long and `width` wide along the aim
 *   - "slam"   a full circle of radius `reach` around the player, with heavy impact FX
 *   - "projectile" a delayed ranged shot that travels through the room
 * plus a few behaviors: `hits` (multi-hit combos), `lunge` (forward dash on stab).
 */
export type HitShape = "arc" | "thrust" | "slam" | "projectile";

export interface WeaponDef {
  id: string;
  name: string;
  /** Which held-weapon art the sprite renderer draws. */
  sprite: WeaponSprite;
  /** Blade/metal color used for both the held sprite and the swing slash. */
  color: number;
  damage: number;
  /** Hitbox geometry. */
  hitShape: HitShape;
  /** arc/slam: radius (px). thrust: stab length (px). */
  reach: number;
  /** Arc cone width (degrees). Only used by `hitShape: "arc"`. */
  arcDegrees: number;
  /** Thrust rectangle full width (px). Only used by `hitShape: "thrust"`. */
  width?: number;
  /** Active hit window + slash animation duration (ms). */
  swingMs: number;
  /** Time before the next swing is allowed (ms). */
  cooldownMs: number;
  /** Number of hitbox activations per swing (fast combos). Defaults to 1. */
  hits?: number;
  /** Forward dash distance on attack (px), for thrusting weapons. Defaults to 0. */
  lunge?: number;
  /** Delay before a projectile leaves the weapon (ms). Defaults to immediate. */
  windupMs?: number;
  /** Projectile travel speed (px/sec). Only used by `hitShape: "projectile"`. */
  projectileSpeed?: number;
  /** Projectile collision radius (px). Only used by `hitShape: "projectile"`. */
  projectileRadius?: number;
  /** How many enemies a projectile can hit before stopping. Defaults to 1. */
  pierce?: number;
  /** Backward shove on release (px). Only used by projectile weapons. */
  recoil?: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  dagger:     { id: "dagger",     name: "Rusty Dagger",  sprite: "dagger",     color: 0xbfc6d0, hitShape: "arc",    damage: 10, reach: 40, arcDegrees: 70,  swingMs: 90,  cooldownMs: 220, hits: 2 },
  sword:      { id: "sword",      name: "Iron Sword",    sprite: "sword",      color: 0xcfd6e0, hitShape: "arc",    damage: 20, reach: 60, arcDegrees: 100, swingMs: 150, cooldownMs: 400 },
  spear:      { id: "spear",      name: "Long Spear",    sprite: "spear",      color: 0xd9dee6, hitShape: "thrust", damage: 24, reach: 95, arcDegrees: 45,  width: 22, swingMs: 160, cooldownMs: 470, lunge: 60 },
  axe:        { id: "axe",        name: "Battle Axe",    sprite: "axe",        color: 0xc7cdd6, hitShape: "arc",    damage: 34, reach: 56, arcDegrees: 150, swingMs: 210, cooldownMs: 580 },
  mace:       { id: "mace",       name: "Spiked Mace",   sprite: "mace",       color: 0x9aa2ae, hitShape: "slam",   damage: 40, reach: 50, arcDegrees: 360, swingMs: 230, cooldownMs: 650 },
  rapier:     { id: "rapier",     name: "Duelist Rapier", sprite: "rapier",    color: 0xe2e6ee, hitShape: "thrust", damage: 14, reach: 80, arcDegrees: 30,  width: 16, swingMs: 90,  cooldownMs: 200, lunge: 70 },
  greatsword: { id: "greatsword", name: "Greatsword",    sprite: "greatsword", color: 0xd0d6e2, hitShape: "arc",    damage: 40, reach: 72, arcDegrees: 120, swingMs: 240, cooldownMs: 700 },
  warhammer:  { id: "warhammer",  name: "War Hammer",    sprite: "warhammer",  color: 0x8f97a4, hitShape: "slam",   damage: 55, reach: 62, arcDegrees: 360, swingMs: 280, cooldownMs: 850 },
  katana:     { id: "katana",     name: "Katana",        sprite: "katana",     color: 0xdfe4ec, hitShape: "arc",    damage: 18, reach: 62, arcDegrees: 90,  swingMs: 110, cooldownMs: 300, hits: 2 },
  crossbow:   { id: "crossbow",   name: "Clockwork Crossbow", sprite: "crossbow", color: 0xd8b15f, hitShape: "projectile", damage: 30, reach: 430, arcDegrees: 0, width: 14, swingMs: 280, cooldownMs: 760, windupMs: 180, projectileSpeed: 820, projectileRadius: 9, pierce: 2, recoil: 24 },
};

export const STARTER_WEAPON_ID = "sword";
