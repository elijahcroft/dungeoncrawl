// The weapon table moved to shared/weapons.ts so the server can compute hit
// damage authoritatively. This re-export keeps every existing client import
// (`from "../entities/weapons"`) working unchanged.
export * from "../../../shared/weapons";
