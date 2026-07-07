import Phaser from "phaser";
import { Client, type Room } from "colyseus.js";
import { GameScene } from "./scenes/GameScene";
import { joinOptions } from "./joinOptions";
import { getStats, formatSummary } from "./progression";
import { DungeonRoomState } from "./network/schema";
import dungeonsData from "../../data/dungeons.json";
import roomsData from "../../data/rooms.json";
import enemiesData from "../../data/enemies.json";
import bossesData from "../../data/bosses.json";
import itemsData from "../../data/items.json";

type RoomType = "arena" | "rest" | "boss" | "treasure";
type AdminTool = "select" | "wall" | "entrance" | "exit" | "enemy" | "boss" | "item";

interface RectDef {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DungeonRoomDef {
  id: string;
  type: RoomType;
  name: string;
  spawns?: string[];
  enemySpawns?: { enemyId: string; x: number; y: number }[];
  boss?: string;
  bossSpawn?: { x: number; y: number };
  item?: string;
  itemSpawns?: { itemId: string; x: number; y: number }[];
  entrance: { x: number; y: number };
  exit: RectDef | null;
  walls: RectDef[];
  offset?: { x: number; y: number };
  exits?: string[];
}

interface DungeonDef {
  id: string;
  name: string;
  rooms: DungeonRoomDef[];
}

interface RoomTemplateDef {
  id: string;
  name: string;
  room: DungeonRoomDef;
}

interface NamedDef {
  id: string;
  name: string;
}

type Selection =
  | { kind: "entrance" }
  | { kind: "exit" }
  | { kind: "wall"; index: number }
  | { kind: "enemy"; index: number }
  | { kind: "boss" }
  | { kind: "item"; index: number }
  | null;

const SERVER_WS_URL = `ws://${window.location.hostname}:2567`;
const SERVER_HTTP_URL = `http://${window.location.hostname}:2567`;
const ROOM_W = 960;
const ROOM_H = 640;
const GRID = 10;
const localDungeons = dungeonsData as Record<string, DungeonDef>;
const localRoomTemplates = roomsData as Record<string, RoomTemplateDef>;
const enemyDefs = enemiesData as Record<string, NamedDef>;
const bossDefs = bossesData as Record<string, NamedDef>;
const itemDefs = itemsData as Record<string, NamedDef>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number) {
  return Math.round(value / GRID) * GRID;
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "new-room"
  );
}

function hasSize(value: { x: number; y: number } | RectDef): value is RectDef {
  return "w" in value && "h" in value;
}

function startGame() {
  // Exposed for debugging/automation (e.g. window.game.scene.keys.GameScene).
  return ((window as unknown as { game?: Phaser.Game }).game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 960,
      height: 640,
    },
    backgroundColor: "#1b1b22",
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scene: [GameScene],
  }));
}

// Remembers the student's chosen identity for the browser tab session so a page
// reload skips the join form and reconnects straight into their character.
const PROFILE_KEY = "dungeon_player_profile";

function saveProfile() {
  sessionStorage.setItem(
    PROFILE_KEY,
    JSON.stringify({
      name: joinOptions.name,
      color: joinOptions.color,
      trimColor: joinOptions.trimColor,
      cape: joinOptions.cape,
      className: joinOptions.className,
    }),
  );
}

function restoreProfile(): boolean {
  const raw = sessionStorage.getItem(PROFILE_KEY);
  if (!raw) return false;
  try {
    Object.assign(joinOptions, JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

function setupPlayerJoin() {
  const overlay = document.getElementById("join-overlay")!;
  const adminOverlay = document.getElementById("admin-overlay")!;
  const app = document.getElementById("app")!;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const nameInput = document.getElementById("join-name") as HTMLInputElement;
  const classSelect = document.getElementById("join-class") as HTMLSelectElement;
  const swatches = Array.from(document.querySelectorAll<HTMLDivElement>(".swatch"));

  overlay.hidden = false;
  adminOverlay.hidden = true;
  app.hidden = false;

  const progressSummary = document.getElementById("progress-summary")!;
  const stats = getStats();
  if (stats.runsPlayed > 0) {
    progressSummary.textContent = formatSummary(stats);
    progressSummary.hidden = false;
  }

  // joinOptions starts with a randomly-rolled armored look; highlight the swatch
  // matching the rolled body color so the form reflects what the player will spawn as.
  let selectedColor = joinOptions.color;
  swatches.forEach((swatch) => {
    swatch.classList.toggle("selected", swatch.dataset.color === selectedColor);
    swatch.addEventListener("click", () => {
      swatches.forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
      selectedColor = swatch.dataset.color ?? selectedColor;
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    joinOptions.name = nameInput.value.trim() || "Player";
    joinOptions.color = selectedColor; // trim + cape keep their rolled values
    joinOptions.className = classSelect.value;
    saveProfile();
    overlay.remove();
    startGame();
  });
}

function validateDungeon(input: unknown): DungeonDef {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Dungeon must be an object.");
  const dungeon = input as Partial<DungeonDef>;
  if (typeof dungeon.id !== "string" || dungeon.id.trim() === "") throw new Error("Dungeon id is required.");
  if (typeof dungeon.name !== "string" || dungeon.name.trim() === "") throw new Error("Dungeon name is required.");
  if (!Array.isArray(dungeon.rooms) || dungeon.rooms.length === 0) throw new Error("Dungeon needs at least one room.");
  dungeon.rooms.forEach((room, index) => {
    if (typeof room.id !== "string" || room.id.trim() === "") throw new Error(`Room ${index + 1} needs an id.`);
    if (!["arena", "rest", "boss", "treasure"].includes(room.type)) throw new Error(`Room ${index + 1} has an invalid type.`);
    if (typeof room.name !== "string" || room.name.trim() === "") throw new Error(`Room ${index + 1} needs a name.`);
    if (!room.entrance || typeof room.entrance.x !== "number" || typeof room.entrance.y !== "number") {
      throw new Error(`Room ${index + 1} needs an entrance point.`);
    }
    if (!Array.isArray(room.walls)) throw new Error(`Room ${index + 1} needs a walls array.`);
  });
  return input as DungeonDef;
}

function setupAdmin() {
  document.documentElement.classList.add("admin-mode");
  document.body.classList.add("admin-mode");

  const joinOverlay = document.getElementById("join-overlay")!;
  const adminOverlay = document.getElementById("admin-overlay")!;
  const app = document.getElementById("app")!;
  const loginForm = document.getElementById("admin-login-form") as HTMLFormElement;
  const pinInput = document.getElementById("admin-pin") as HTMLInputElement;
  const statusEl = document.getElementById("admin-status")!;
  const panel = document.getElementById("admin-panel")!;
  const stateEl = document.getElementById("admin-state")!;
  const launchDungeonSelect = document.getElementById("admin-launch-dungeon-select") as HTMLSelectElement;
  const launchSelectionEl = document.getElementById("admin-launch-selection")!;
  const builderDungeonSelect = document.getElementById("builder-dungeon-select") as HTMLSelectElement;
  const builderStateEl = document.getElementById("builder-dungeon-state")!;
  const dungeonJson = document.getElementById("admin-dungeon-json") as HTMLTextAreaElement;
  const saveStatus = document.getElementById("admin-save-status")!;
  const playerList = document.getElementById("admin-player-list")!;
  const noticeInput = document.getElementById("admin-notice-input") as HTMLInputElement;
  const builderDungeonId = document.getElementById("builder-dungeon-id") as HTMLInputElement;
  const builderDungeonName = document.getElementById("builder-dungeon-name") as HTMLInputElement;
  const roomList = document.getElementById("admin-room-list")!;
  const templateList = document.getElementById("template-list")!;
  const stage = document.getElementById("room-stage")!;
  const roomIdInput = document.getElementById("room-id-input") as HTMLInputElement;
  const roomNameInput = document.getElementById("room-name-input") as HTMLInputElement;
  const roomTypeInput = document.getElementById("room-type-input") as HTMLSelectElement;
  const enemyPalette = document.getElementById("enemy-palette-select") as HTMLSelectElement;
  const bossPalette = document.getElementById("boss-palette-select") as HTMLSelectElement;
  const itemPalette = document.getElementById("item-palette-select") as HTMLSelectElement;
  const selectionText = document.getElementById("inspector-selection")!;
  const selectedX = document.getElementById("selected-x") as HTMLInputElement;
  const selectedY = document.getElementById("selected-y") as HTMLInputElement;
  const selectedW = document.getElementById("selected-w") as HTMLInputElement;
  const selectedH = document.getElementById("selected-h") as HTMLInputElement;

  joinOverlay.hidden = true;
  adminOverlay.hidden = false;
  app.hidden = true;
  pinInput.value = sessionStorage.getItem("dungeon_admin_pin") ?? "";

  let adminPin = "";
  let adminRoom: Room<DungeonRoomState> | null = null;
  let dungeonCatalog: Record<string, DungeonDef> = { ...localDungeons };
  let roomTemplateCatalog: Record<string, RoomTemplateDef> = { ...localRoomTemplates };
  let builderDungeon: DungeonDef = normalizeDungeon(clone(Object.values(localDungeons)[0]));
  let launchDungeonId = builderDungeon.id;
  let builderSourceDungeonId = builderDungeon.id;
  let builderDirty = false;
  let selectedRoomIndex = 0;
  let selectedTemplateId = "";
  let activeTool: AdminTool = "select";
  let selectedObject: Selection = null;

  function normalizeRoom(room: DungeonRoomDef): DungeonRoomDef {
    const normalized: DungeonRoomDef = {
      ...room,
      type: room.type ?? "arena",
      entrance: room.entrance ?? { x: 80, y: 320 },
      exit: room.exit === undefined ? { x: 900, y: 240, w: 60, h: 160 } : room.exit,
      walls: room.walls ?? [],
    };
    if (normalized.spawns && !normalized.enemySpawns) {
      normalized.enemySpawns = normalized.spawns.map((enemyId, i) => ({
        enemyId,
        x: [560, 720, 640][i % 3],
        y: [280, 280, 420][i % 3] + (i >= 3 ? 60 : 0),
      }));
    }
    if (normalized.enemySpawns) normalized.spawns = normalized.enemySpawns.map((spawn) => spawn.enemyId);
    return normalized;
  }

  function normalizeDungeon(dungeon: DungeonDef): DungeonDef {
    return { ...dungeon, rooms: dungeon.rooms.map((room) => normalizeRoom(room)) };
  }

  function currentRoom() {
    return builderDungeon.rooms[selectedRoomIndex];
  }

  function setStatus(message: string) {
    statusEl.textContent = message;
  }

  function setSaveStatus(message: string) {
    saveStatus.textContent = message;
  }

  function populateNamedSelect(select: HTMLSelectElement, defs: Record<string, NamedDef>) {
    select.replaceChildren();
    Object.values(defs)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((def) => {
        const option = document.createElement("option");
        option.value = def.id;
        option.textContent = def.name;
        select.append(option);
      });
  }

  function populateDungeonSelect(select: HTMLSelectElement, selectedId = "") {
    select.replaceChildren();
    Object.values(dungeonCatalog)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((dungeon) => {
        const option = document.createElement("option");
        option.value = dungeon.id;
        option.textContent = `${dungeon.name} (${dungeon.rooms.length})`;
        select.append(option);
      });
    if (selectedId && dungeonCatalog[selectedId]) select.value = selectedId;
    if (!select.value && select.options.length > 0) select.selectedIndex = 0;
    return select.value;
  }

  function renderLaunchSelection() {
    const dungeon = dungeonCatalog[launchDungeonId];
    launchSelectionEl.textContent = dungeon
      ? `Launch will send everyone into ${dungeon.name}.`
      : "Select a dungeon to launch for the whole lobby.";
  }

  function renderBuilderState() {
    const sourceName = builderSourceDungeonId ? dungeonCatalog[builderSourceDungeonId]?.name ?? builderSourceDungeonId : "";
    if (builderDirty) {
      builderStateEl.textContent = sourceName
        ? `Editing ${builderDungeon.name} with unsaved changes. Loaded from ${sourceName}.`
        : `Editing ${builderDungeon.name}. This draft is not saved yet.`;
      return;
    }
    builderStateEl.textContent = sourceName ? `Loaded ${sourceName} into the builder.` : "Builder is ready.";
  }

  function refreshDungeonSelects(preferred: { launchId?: string; builderId?: string } = {}) {
    launchDungeonId = populateDungeonSelect(launchDungeonSelect, preferred.launchId ?? (launchDungeonId || builderDungeon.id));
    populateDungeonSelect(builderDungeonSelect, preferred.builderId ?? (builderSourceDungeonId || builderDungeon.id));
    renderLaunchSelection();
    renderBuilderState();
  }

  function setBuilderDirty(dirty: boolean) {
    builderDirty = dirty;
    renderBuilderState();
  }

  function populateTemplates() {
    templateList.replaceChildren();
    const templates = Object.values(roomTemplateCatalog).sort((a, b) => a.name.localeCompare(b.name));
    if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id;
    templates.forEach((template) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `template-list-button${template.id === selectedTemplateId ? " active" : ""}`;
      button.innerHTML = `<span>${template.name}<br><small>${template.room.type} · ${template.room.id}</small></span><small>${template.room.walls.length} walls</small>`;
      button.addEventListener("click", () => {
        selectedTemplateId = template.id;
        populateTemplates();
      });
      templateList.append(button);
    });
  }

  function syncJsonFromBuilder() {
    builderDungeon.id = slugify(builderDungeonId.value || builderDungeon.id);
    builderDungeon.name = builderDungeonName.value.trim() || builderDungeon.name;
    dungeonJson.value = JSON.stringify(builderDungeon, null, 2);
  }

  function loadBuilderDungeon(dungeon: DungeonDef, options: { sourceId?: string; dirty?: boolean } = {}) {
    builderDungeon = normalizeDungeon(clone(dungeon));
    selectedRoomIndex = clamp(selectedRoomIndex, 0, builderDungeon.rooms.length - 1);
    selectedObject = null;
    builderSourceDungeonId = options.sourceId ?? dungeon.id;
    builderDungeonId.value = builderDungeon.id;
    builderDungeonName.value = builderDungeon.name;
    if (builderSourceDungeonId && dungeonCatalog[builderSourceDungeonId]) {
      builderDungeonSelect.value = builderSourceDungeonId;
    }
    setBuilderDirty(options.dirty ?? false);
    renderAll();
  }

  function confirmDiscardBuilderChanges() {
    return !builderDirty || window.confirm("Discard unsaved dungeon builder changes?");
  }

  function createDraftDungeon(): DungeonDef {
    return {
      id: `new-dungeon-${Date.now().toString(36).slice(-4)}`,
      name: "New Dungeon",
      rooms: [newRoom(0)],
    };
  }

  function buildDungeonFromBuilder() {
    persistRoomInputs();
    syncJsonFromBuilder();
    return validateDungeon(JSON.parse(dungeonJson.value));
  }

  async function loadDungeons() {
    try {
      const response = await fetch(`${SERVER_HTTP_URL}/admin/dungeons`);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const payload = (await response.json()) as { dungeons?: Record<string, DungeonDef> };
      if (payload.dungeons) dungeonCatalog = payload.dungeons;
    } catch {
      dungeonCatalog = { ...localDungeons };
    }
    refreshDungeonSelects();
    const selectedId = builderDungeonSelect.value || launchDungeonSelect.value;
    const selected = selectedId ? dungeonCatalog[selectedId] : Object.values(dungeonCatalog)[0];
    if (selected) {
      loadBuilderDungeon(selected, { sourceId: selected.id, dirty: false });
      refreshDungeonSelects({ launchId: launchDungeonId, builderId: selected.id });
    }
  }

  async function loadRoomTemplates() {
    try {
      const response = await fetch(`${SERVER_HTTP_URL}/admin/rooms`);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const payload = (await response.json()) as { rooms?: Record<string, RoomTemplateDef> };
      if (payload.rooms) roomTemplateCatalog = payload.rooms;
    } catch {
      roomTemplateCatalog = { ...localRoomTemplates };
    }
    populateTemplates();
  }

  async function saveDungeon(): Promise<DungeonDef> {
    const dungeon = buildDungeonFromBuilder();
    const previousSourceDungeonId = builderSourceDungeonId;
    const response = await fetch(`${SERVER_HTTP_URL}/admin/dungeons/${encodeURIComponent(dungeon.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminPin, dungeon }),
    });
    const payload = (await response.json()) as { dungeon?: DungeonDef; error?: string };
    if (!response.ok || !payload.dungeon) throw new Error(payload.error ?? "Could not save dungeon.");
    dungeonCatalog = { ...dungeonCatalog, [payload.dungeon.id]: payload.dungeon };
    const nextLaunchId = launchDungeonId === previousSourceDungeonId ? payload.dungeon.id : launchDungeonId;
    loadBuilderDungeon(payload.dungeon, { sourceId: payload.dungeon.id, dirty: false });
    refreshDungeonSelects({ launchId: nextLaunchId, builderId: payload.dungeon.id });
    return payload.dungeon;
  }

  async function saveCurrentRoomTemplate() {
    const room = normalizeRoom(clone(currentRoom()));
    const name = window.prompt("Room template name", room.name)?.trim();
    if (!name) return;
    const roomTemplate: RoomTemplateDef = {
      id: `${slugify(name)}-${Date.now().toString(36).slice(-4)}`,
      name,
      room,
    };
    const response = await fetch(`${SERVER_HTTP_URL}/admin/rooms/${encodeURIComponent(roomTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminPin, roomTemplate }),
    });
    const payload = (await response.json()) as { roomTemplate?: RoomTemplateDef; error?: string };
    if (!response.ok || !payload.roomTemplate) throw new Error(payload.error ?? "Could not save room template.");
    roomTemplateCatalog = { ...roomTemplateCatalog, [payload.roomTemplate.id]: payload.roomTemplate };
    selectedTemplateId = payload.roomTemplate.id;
    populateTemplates();
    setSaveStatus(`Saved room template ${payload.roomTemplate.name}.`);
  }

  function sendAdminCommand(type: string, payload: Record<string, unknown> = {}) {
    if (!adminRoom) {
      setStatus("Admin is not connected.");
      return;
    }
    adminRoom.send(type, payload);
  }

  function renderAdminState() {
    if (!adminRoom) return;
    const state = adminRoom.state;
    const playerCount = state.players.size;
    stateEl.textContent =
      state.runPhase === "lobby"
        ? `Lobby · ${playerCount} player${playerCount === 1 ? "" : "s"}`
        : `${state.dungeonName} · ${state.roomName} · room ${state.roomIndex + 1}/${state.roomCount} · ${playerCount} player${
            playerCount === 1 ? "" : "s"
          }`;

    playerList.replaceChildren();
    if (playerCount === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players connected.";
      playerList.append(empty);
      return;
    }

    state.players.forEach((player, sessionId) => {
      const row = document.createElement("div");
      row.className = "admin-player";
      const name = document.createElement("div");
      name.textContent = player.name;
      const detail = document.createElement("small");
      detail.textContent = `${player.className} · ${player.weaponId} · ${sessionId.slice(0, 6)}`;
      name.append(document.createElement("br"), detail);
      const hp = document.createElement("div");
      hp.textContent = `${Math.ceil(player.hp)}/${player.hpMax} HP`;
      row.append(name, hp);
      playerList.append(row);
    });
  }

  function renderRooms() {
    roomList.replaceChildren();
    builderDungeon.rooms.forEach((room, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `room-list-button${index === selectedRoomIndex ? " active" : ""}`;
      button.innerHTML = `<span>${index + 1}. ${room.name}<br><small>${room.type} · ${room.id}</small></span><small>${room.walls.length} walls</small>`;
      button.addEventListener("click", () => {
        persistRoomInputs();
        selectedRoomIndex = index;
        selectedObject = null;
        renderAll();
      });
      roomList.append(button);
    });
  }

  function renderRoomInputs() {
    const room = currentRoom();
    roomIdInput.value = room.id;
    roomNameInput.value = room.name;
    roomTypeInput.value = room.type;
  }

  function selectionLabel(selection: Selection) {
    if (!selection) return "Nothing selected.";
    if (selection.kind === "wall") return `Wall ${selection.index + 1}`;
    if (selection.kind === "enemy") return `Enemy ${selection.index + 1}`;
    if (selection.kind === "item") return `Item ${selection.index + 1}`;
    return selection.kind[0].toUpperCase() + selection.kind.slice(1);
  }

  function rectToStyle(rect: RectDef) {
    return {
      left: `${(rect.x / ROOM_W) * 100}%`,
      top: `${(rect.y / ROOM_H) * 100}%`,
      width: `${(rect.w / ROOM_W) * 100}%`,
      height: `${(rect.h / ROOM_H) * 100}%`,
    };
  }

  function markerToStyle(point: { x: number; y: number }) {
    return { left: `${(point.x / ROOM_W) * 100}%`, top: `${(point.y / ROOM_H) * 100}%` };
  }

  function applyStyles(el: HTMLElement, styles: Record<string, string>) {
    Object.entries(styles).forEach(([key, value]) => {
      el.style.setProperty(key, value);
    });
  }

  function isSelected(selection: Selection) {
    return JSON.stringify(selection) === JSON.stringify(selectedObject);
  }

  function createStageObject(className: string, label: string, selection: Selection, styles: Record<string, string>) {
    const el = document.createElement("div");
    el.className = `stage-object ${className}${isSelected(selection) ? " selected" : ""}`;
    el.textContent = label;
    applyStyles(el, styles);
    el.addEventListener("pointerdown", (event) => beginDrag(event, selection));
    stage.append(el);
  }

  function renderStage() {
    const room = currentRoom();
    stage.replaceChildren();
    room.walls.forEach((wall, index) => createStageObject("stage-wall", "wall", { kind: "wall", index }, rectToStyle(wall)));
    if (room.exit) createStageObject("stage-exit", "exit", { kind: "exit" }, rectToStyle(room.exit));
    createStageObject("stage-entrance", "in", { kind: "entrance" }, markerToStyle(room.entrance));
    room.enemySpawns?.forEach((spawn, index) =>
      createStageObject("stage-enemy", enemyDefs[spawn.enemyId]?.name.slice(0, 2) ?? "E", { kind: "enemy", index }, markerToStyle(spawn)),
    );
    if (room.bossSpawn) createStageObject("stage-boss", "boss", { kind: "boss" }, markerToStyle(room.bossSpawn));
    room.itemSpawns?.forEach((spawn, index) =>
      createStageObject("stage-item", itemDefs[spawn.itemId]?.name.slice(0, 2) ?? "I", { kind: "item", index }, markerToStyle(spawn)),
    );
  }

  function selectedGeometry() {
    const room = currentRoom();
    if (!selectedObject) return null;
    if (selectedObject.kind === "entrance") return { x: room.entrance.x, y: room.entrance.y };
    if (selectedObject.kind === "exit") return room.exit;
    if (selectedObject.kind === "wall") return room.walls[selectedObject.index];
    if (selectedObject.kind === "enemy") return room.enemySpawns?.[selectedObject.index] ?? null;
    if (selectedObject.kind === "boss") return room.bossSpawn ?? null;
    if (selectedObject.kind === "item") return room.itemSpawns?.[selectedObject.index] ?? null;
    return null;
  }

  function renderInspector() {
    const room = currentRoom();
    const geometry = selectedGeometry();
    selectionText.textContent = selectionLabel(selectedObject);
    selectedX.value = geometry ? String(Math.round(geometry.x)) : "";
    selectedY.value = geometry ? String(Math.round(geometry.y)) : "";
    selectedW.value = geometry && hasSize(geometry) ? String(Math.round(geometry.w)) : "";
    selectedH.value = geometry && hasSize(geometry) ? String(Math.round(geometry.h)) : "";
    if (selectedObject?.kind === "enemy" && room.enemySpawns?.[selectedObject.index]) {
      enemyPalette.value = room.enemySpawns[selectedObject.index].enemyId;
    } else if (selectedObject?.kind === "boss" && room.boss) {
      bossPalette.value = room.boss;
    } else if (selectedObject?.kind === "item" && room.itemSpawns?.[selectedObject.index]) {
      itemPalette.value = room.itemSpawns[selectedObject.index].itemId;
    }
  }

  function renderTools() {
    document.querySelectorAll<HTMLDivElement>(".tool-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === activeTool);
    });
  }

  function renderAll() {
    renderTools();
    renderRooms();
    renderRoomInputs();
    renderStage();
    renderInspector();
    renderBuilderState();
    syncJsonFromBuilder();
  }

  function persistRoomInputs() {
    const room = currentRoom();
    room.id = slugify(roomIdInput.value || room.id);
    room.name = roomNameInput.value.trim() || room.name;
    room.type = roomTypeInput.value as RoomType;
    if (room.enemySpawns) room.spawns = room.enemySpawns.map((spawn) => spawn.enemyId);
    builderDungeon.id = slugify(builderDungeonId.value || builderDungeon.id);
    builderDungeon.name = builderDungeonName.value.trim() || builderDungeon.name;
  }

  function stagePoint(clientX: number, clientY: number) {
    const bounds = stage.getBoundingClientRect();
    return {
      x: snap(clamp(((clientX - bounds.left) / bounds.width) * ROOM_W, 0, ROOM_W)),
      y: snap(clamp(((clientY - bounds.top) / bounds.height) * ROOM_H, 0, ROOM_H)),
    };
  }

  function selectObject(selection: Selection) {
    selectedObject = selection;
    renderAll();
  }

  function addAt(tool: AdminTool, x: number, y: number) {
    const room = currentRoom();
    if (tool === "select") return;
    if (tool === "wall") {
      room.walls.push({ x: clamp(x - 60, 0, ROOM_W - 120), y: clamp(y - 20, 0, ROOM_H - 40), w: 120, h: 40 });
      selectedObject = { kind: "wall", index: room.walls.length - 1 };
    } else if (tool === "entrance") {
      room.entrance = { x, y };
      selectedObject = { kind: "entrance" };
    } else if (tool === "exit") {
      room.exit = { x: clamp(x - 30, 0, ROOM_W - 60), y: clamp(y - 80, 0, ROOM_H - 160), w: 60, h: 160 };
      selectedObject = { kind: "exit" };
    } else if (tool === "enemy") {
      room.type = "arena";
      room.enemySpawns = room.enemySpawns ?? [];
      room.enemySpawns.push({ enemyId: enemyPalette.value, x, y });
      room.spawns = room.enemySpawns.map((spawn) => spawn.enemyId);
      selectedObject = { kind: "enemy", index: room.enemySpawns.length - 1 };
    } else if (tool === "boss") {
      room.type = "boss";
      room.boss = bossPalette.value;
      room.bossSpawn = { x, y };
      selectedObject = { kind: "boss" };
    } else if (tool === "item") {
      room.itemSpawns = room.itemSpawns ?? [];
      room.itemSpawns.push({ itemId: itemPalette.value, x, y });
      selectedObject = { kind: "item", index: room.itemSpawns.length - 1 };
    }
    setBuilderDirty(true);
    renderAll();
  }

  function moveSelection(selection: Selection, x: number, y: number) {
    const room = currentRoom();
    if (!selection) return;
    if (selection.kind === "entrance") room.entrance = { x, y };
    else if (selection.kind === "exit" && room.exit) {
      room.exit.x = clamp(x - room.exit.w / 2, 0, ROOM_W - room.exit.w);
      room.exit.y = clamp(y - room.exit.h / 2, 0, ROOM_H - room.exit.h);
    } else if (selection.kind === "wall") {
      const wall = room.walls[selection.index];
      wall.x = clamp(x - wall.w / 2, 0, ROOM_W - wall.w);
      wall.y = clamp(y - wall.h / 2, 0, ROOM_H - wall.h);
    } else if (selection.kind === "enemy" && room.enemySpawns?.[selection.index]) {
      room.enemySpawns[selection.index].x = x;
      room.enemySpawns[selection.index].y = y;
    } else if (selection.kind === "boss") room.bossSpawn = { x, y };
    else if (selection.kind === "item" && room.itemSpawns?.[selection.index]) {
      room.itemSpawns[selection.index].x = x;
      room.itemSpawns[selection.index].y = y;
    }
    setBuilderDirty(true);
  }

  function beginDrag(event: PointerEvent, selection: Selection) {
    event.preventDefault();
    event.stopPropagation();
    selectedObject = selection;
    renderAll();
    const move = (moveEvent: PointerEvent) => {
      const point = stagePoint(moveEvent.clientX, moveEvent.clientY);
      moveSelection(selection, point.x, point.y);
      renderStage();
      renderInspector();
      syncJsonFromBuilder();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function updateSelectedFromInputs() {
    const geometry = selectedGeometry();
    if (!geometry) return;
    const x = snap(Number(selectedX.value));
    const y = snap(Number(selectedY.value));
    const w = snap(Number(selectedW.value));
    const h = snap(Number(selectedH.value));
    geometry.x = clamp(Number.isFinite(x) ? x : geometry.x, 0, ROOM_W);
    geometry.y = clamp(Number.isFinite(y) ? y : geometry.y, 0, ROOM_H);
    if (hasSize(geometry)) {
      geometry.w = clamp(Number.isFinite(w) && w > 0 ? w : geometry.w, GRID, ROOM_W);
      geometry.h = clamp(Number.isFinite(h) && h > 0 ? h : geometry.h, GRID, ROOM_H);
    }
    setBuilderDirty(true);
    renderAll();
  }

  function deleteSelection() {
    const room = currentRoom();
    if (!selectedObject) return;
    if (selectedObject.kind === "wall") room.walls.splice(selectedObject.index, 1);
    else if (selectedObject.kind === "exit") room.exit = null;
    else if (selectedObject.kind === "enemy") room.enemySpawns?.splice(selectedObject.index, 1);
    else if (selectedObject.kind === "boss") {
      delete room.boss;
      delete room.bossSpawn;
    } else if (selectedObject.kind === "item") room.itemSpawns?.splice(selectedObject.index, 1);
    if (room.enemySpawns) room.spawns = room.enemySpawns.map((spawn) => spawn.enemyId);
    selectedObject = null;
    setBuilderDirty(true);
    renderAll();
  }

  function newRoom(index: number): DungeonRoomDef {
    return {
      id: `room-${index + 1}`,
      type: "arena",
      name: `Room ${index + 1}`,
      spawns: [],
      enemySpawns: [],
      entrance: { x: 80, y: 320 },
      exit: { x: 900, y: 240, w: 60, h: 160 },
      walls: [],
    };
  }

  function insertRoom(room: DungeonRoomDef) {
    const inserted = normalizeRoom(clone(room));
    inserted.id = `${slugify(inserted.id)}-${builderDungeon.rooms.length + 1}`;
    builderDungeon.rooms.splice(selectedRoomIndex + 1, 0, inserted);
    selectedRoomIndex += 1;
    selectedObject = null;
    setBuilderDirty(true);
    renderAll();
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    adminPin = pinInput.value || "teacher";
    sessionStorage.setItem("dungeon_admin_pin", adminPin);
    setStatus("Connecting...");

    try {
      const client = new Client(SERVER_WS_URL);
      adminRoom = await client.joinOrCreate<DungeonRoomState>("dungeon_room", { role: "admin", adminPin }, DungeonRoomState);
      adminRoom.onMessage("admin_status", (message: { message?: string }) => setStatus(message.message ?? "Connected."));
      adminRoom.onMessage("admin_error", (message: { message?: string }) => setStatus(message.message ?? "Admin command failed."));
      adminRoom.onLeave(() => {
        adminRoom = null;
        panel.hidden = true;
        loginForm.hidden = false;
        setStatus("Disconnected.");
      });
      adminRoom.onStateChange(() => renderAdminState());
      loginForm.hidden = true;
      panel.hidden = false;
      setStatus("Connected.");
      renderAdminState();
      void loadDungeons();
      void loadRoomTemplates();
    } catch {
      setStatus("Could not connect. Check the server and PIN.");
    }
  });

  // Room view: let the admin drop into the live room to watch or play, while the
  // admin control connection stays open in the background.
  let adminGame: Phaser.Game | null = null;
  const gameBar = document.getElementById("admin-game-bar")!;
  const gameModeLabel = document.getElementById("admin-game-mode")!;

  function enterGameView(spectate: boolean) {
    if (!adminRoom) {
      setStatus("Connect with the admin PIN first.");
      return;
    }
    joinOptions.adminPin = adminPin;
    joinOptions.spectator = spectate;
    joinOptions.name = spectate ? "Spectator" : "Teacher";
    if (adminGame) adminGame.destroy(true);
    adminOverlay.hidden = true;
    app.hidden = false;
    app.classList.add("admin-game");
    gameBar.hidden = false;
    gameModeLabel.textContent = spectate ? "Spectating" : "Playing";
    adminGame = startGame();
  }

  function exitGameView() {
    if (adminGame) {
      adminGame.destroy(true);
      adminGame = null;
    }
    app.hidden = true;
    app.classList.remove("admin-game");
    gameBar.hidden = true;
    adminOverlay.hidden = false;
  }

  document.getElementById("admin-spectate")!.addEventListener("click", () => enterGameView(true));
  document.getElementById("admin-play")!.addEventListener("click", () => enterGameView(false));
  document.getElementById("admin-game-spectate")!.addEventListener("click", () => enterGameView(true));
  document.getElementById("admin-game-play")!.addEventListener("click", () => enterGameView(false));
  document.getElementById("admin-game-back")!.addEventListener("click", exitGameView);

  launchDungeonSelect.addEventListener("change", () => {
    launchDungeonId = launchDungeonSelect.value;
    renderLaunchSelection();
  });
  builderDungeonSelect.addEventListener("change", () => {
    const nextDungeonId = builderDungeonSelect.value;
    const dungeon = dungeonCatalog[nextDungeonId];
    if (!dungeon) return;
    if (!confirmDiscardBuilderChanges()) {
      builderDungeonSelect.value = builderSourceDungeonId && dungeonCatalog[builderSourceDungeonId] ? builderSourceDungeonId : "";
      return;
    }
    loadBuilderDungeon(dungeon, { sourceId: nextDungeonId, dirty: false });
    refreshDungeonSelects({ launchId: launchDungeonId, builderId: nextDungeonId });
  });
  builderDungeonId.addEventListener("input", () => {
    setBuilderDirty(true);
    syncJsonFromBuilder();
  });
  builderDungeonName.addEventListener("input", () => {
    setBuilderDirty(true);
    syncJsonFromBuilder();
  });
  roomIdInput.addEventListener("input", () => {
    persistRoomInputs();
    setBuilderDirty(true);
    renderRooms();
    syncJsonFromBuilder();
  });
  roomNameInput.addEventListener("input", () => {
    persistRoomInputs();
    setBuilderDirty(true);
    renderRooms();
    syncJsonFromBuilder();
  });
  roomTypeInput.addEventListener("change", () => {
    persistRoomInputs();
    setBuilderDirty(true);
    renderAll();
  });
  enemyPalette.addEventListener("change", () => {
    if (selectedObject?.kind !== "enemy") return;
    const spawn = currentRoom().enemySpawns?.[selectedObject.index];
    if (!spawn) return;
    spawn.enemyId = enemyPalette.value;
    currentRoom().spawns = currentRoom().enemySpawns?.map((entry) => entry.enemyId);
    setBuilderDirty(true);
    renderAll();
  });
  bossPalette.addEventListener("change", () => {
    if (selectedObject?.kind !== "boss") return;
    currentRoom().boss = bossPalette.value;
    setBuilderDirty(true);
    renderAll();
  });
  itemPalette.addEventListener("change", () => {
    if (selectedObject?.kind !== "item") return;
    const spawn = currentRoom().itemSpawns?.[selectedObject.index];
    if (!spawn) return;
    spawn.itemId = itemPalette.value;
    setBuilderDirty(true);
    renderAll();
  });
  document.getElementById("admin-launch")!.addEventListener("click", () => sendAdminCommand("admin_launch", { dungeonId: launchDungeonId }));
  document.getElementById("admin-send-notice")!.addEventListener("click", () => {
    sendAdminCommand("admin_notice", { text: noticeInput.value });
    noticeInput.value = "";
  });
  document.querySelectorAll<HTMLButtonElement>("[data-admin-command]").forEach((button) => {
    button.addEventListener("click", () => sendAdminCommand(button.dataset.adminCommand ?? ""));
  });
  document.getElementById("builder-new-dungeon")!.addEventListener("click", () => {
    if (!confirmDiscardBuilderChanges()) return;
    loadBuilderDungeon(createDraftDungeon(), { sourceId: "", dirty: true });
    builderDungeonSelect.value = "";
    renderBuilderState();
  });
  document.getElementById("room-add")!.addEventListener("click", () => insertRoom(newRoom(builderDungeon.rooms.length)));
  document.getElementById("room-duplicate")!.addEventListener("click", () => insertRoom(currentRoom()));
  document.getElementById("room-delete")!.addEventListener("click", () => {
    if (builderDungeon.rooms.length <= 1) return;
    builderDungeon.rooms.splice(selectedRoomIndex, 1);
    selectedRoomIndex = clamp(selectedRoomIndex, 0, builderDungeon.rooms.length - 1);
    selectedObject = null;
    setBuilderDirty(true);
    renderAll();
  });
  document.getElementById("room-up")!.addEventListener("click", () => {
    if (selectedRoomIndex <= 0) return;
    [builderDungeon.rooms[selectedRoomIndex - 1], builderDungeon.rooms[selectedRoomIndex]] = [
      builderDungeon.rooms[selectedRoomIndex],
      builderDungeon.rooms[selectedRoomIndex - 1],
    ];
    selectedRoomIndex -= 1;
    setBuilderDirty(true);
    renderAll();
  });
  document.getElementById("room-down")!.addEventListener("click", () => {
    if (selectedRoomIndex >= builderDungeon.rooms.length - 1) return;
    [builderDungeon.rooms[selectedRoomIndex + 1], builderDungeon.rooms[selectedRoomIndex]] = [
      builderDungeon.rooms[selectedRoomIndex],
      builderDungeon.rooms[selectedRoomIndex + 1],
    ];
    selectedRoomIndex += 1;
    setBuilderDirty(true);
    renderAll();
  });
  document.getElementById("template-insert")!.addEventListener("click", () => {
    const template = roomTemplateCatalog[selectedTemplateId];
    if (template) insertRoom(template.room);
  });
  document.getElementById("template-save")!.addEventListener("click", async () => {
    try {
      await saveCurrentRoomTemplate();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Could not save room template.");
    }
  });
  document.getElementById("admin-validate")!.addEventListener("click", () => {
    try {
      validateDungeon(JSON.parse(dungeonJson.value));
      setSaveStatus("JSON is valid.");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Invalid JSON.");
    }
  });
  document.getElementById("admin-apply-json")!.addEventListener("click", () => {
    try {
      loadBuilderDungeon(validateDungeon(JSON.parse(dungeonJson.value)), { sourceId: builderSourceDungeonId, dirty: true });
      setSaveStatus("Applied JSON to the visual editor.");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Invalid JSON.");
    }
  });
  document.getElementById("admin-save")!.addEventListener("click", async () => {
    try {
      const dungeon = await saveDungeon();
      setSaveStatus(`Saved ${dungeon.name}.`);
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Could not save dungeon.");
    }
  });
  document.getElementById("admin-launch-edited")!.addEventListener("click", async () => {
    try {
      const dungeon = await saveDungeon();
      launchDungeonId = dungeon.id;
      launchDungeonSelect.value = dungeon.id;
      renderLaunchSelection();
      sendAdminCommand("admin_launch", { dungeonId: dungeon.id });
      setSaveStatus(`Saved and launched ${dungeon.name}.`);
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Could not save dungeon.");
    }
  });
  document.querySelectorAll<HTMLDivElement>(".tool-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeTool = (button.dataset.tool as AdminTool) ?? "select";
      renderTools();
    });
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", button.dataset.tool ?? "select");
    });
  });
  stage.addEventListener("dragover", (event) => event.preventDefault());
  stage.addEventListener("drop", (event) => {
    event.preventDefault();
    const tool = (event.dataTransfer?.getData("text/plain") || activeTool) as AdminTool;
    const point = stagePoint(event.clientX, event.clientY);
    addAt(tool, point.x, point.y);
  });
  stage.addEventListener("pointerdown", (event) => {
    if (event.target !== stage) return;
    const point = stagePoint(event.clientX, event.clientY);
    if (activeTool === "select") selectObject(null);
    else addAt(activeTool, point.x, point.y);
  });
  [selectedX, selectedY, selectedW, selectedH].forEach((input) => input.addEventListener("change", updateSelectedFromInputs));
  document.getElementById("selected-delete")!.addEventListener("click", deleteSelection);

  populateNamedSelect(enemyPalette, enemyDefs);
  populateNamedSelect(bossPalette, bossDefs);
  populateNamedSelect(itemPalette, itemDefs);
  refreshDungeonSelects({ launchId: builderDungeon.id, builderId: builderDungeon.id });
  populateTemplates();
  loadBuilderDungeon(builderDungeon, { sourceId: builderDungeon.id, dirty: false });
  void loadDungeons();
  void loadRoomTemplates();
  window.setInterval(renderAdminState, 500);
}

const params = new URLSearchParams(window.location.search);
const adminMode = params.has("admin") || window.location.pathname.replace(/\/$/, "") === "/admin";

if (adminMode) {
  setupAdmin();
} else if (restoreProfile()) {
  // Returning player in the same tab session: skip the form and reconnect
  // (Network.connect resumes via the stored token, or rejoins with this identity).
  document.getElementById("join-overlay")!.remove();
  document.getElementById("app")!.hidden = false;
  startGame();
} else {
  setupPlayerJoin();
}
