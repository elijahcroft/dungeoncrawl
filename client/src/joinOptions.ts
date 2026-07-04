import { rollAppearance } from "./gfx/appearance";

export interface JoinOptions {
  name: string;
  color: string;
  /** Metal armor-trim color (hex string, e.g. "0xf0c14b"). */
  trimColor: string;
  /** Whether the hero wears a cape. */
  cape: boolean;
  className: string;
  // Set when an admin boots the game view: "spectator" watches without a body,
  // "player" spawns a normal controllable hero. adminPin authorizes both.
  role?: "player" | "spectator";
  adminPin?: string;
  spectator?: boolean;
}

// Roll a random armored look up front so a player who never touches the swatches
// still spawns distinct from everyone else (the join form can override the body color).
const initialLook = rollAppearance();

export const joinOptions: JoinOptions = {
  name: "Player",
  color: `0x${initialLook.body.toString(16)}`,
  trimColor: `0x${initialLook.trim.toString(16)}`,
  cape: initialLook.cape,
  className: "warrior",
};
