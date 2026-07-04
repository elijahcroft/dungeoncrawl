export interface JoinOptions {
  name: string;
  color: string;
  className: string;
  // Set when an admin boots the game view: "spectator" watches without a body,
  // "player" spawns a normal controllable hero. adminPin authorizes both.
  role?: "player" | "spectator";
  adminPin?: string;
  spectator?: boolean;
}

export const joinOptions: JoinOptions = {
  name: "Player",
  color: "0x4da6ff",
  className: "warrior",
};
