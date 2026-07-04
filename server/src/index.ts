import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  DungeonRoom,
  getDungeonDefs,
  getRoomTemplates,
  isAdminPin,
  upsertDungeonDef,
  upsertRoomTemplateDef,
} from "./rooms/DungeonRoom";

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/admin/dungeons", (_req, res) => {
  res.json({ dungeons: getDungeonDefs() });
});

app.get("/admin/rooms", (_req, res) => {
  res.json({ rooms: getRoomTemplates() });
});

app.post("/admin/dungeons/:id", (req, res) => {
  if (!isAdminPin(req.body?.adminPin)) {
    res.status(403).json({ error: "Invalid admin PIN." });
    return;
  }
  if (req.body?.dungeon?.id !== req.params.id) {
    res.status(400).json({ error: "Dungeon id must match the URL id." });
    return;
  }
  try {
    const dungeon = upsertDungeonDef(req.body?.dungeon);
    res.json({ dungeon });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid dungeon JSON." });
  }
});

app.post("/admin/rooms/:id", (req, res) => {
  if (!isAdminPin(req.body?.adminPin)) {
    res.status(403).json({ error: "Invalid admin PIN." });
    return;
  }
  if (req.body?.roomTemplate?.id !== req.params.id) {
    res.status(400).json({ error: "Room template id must match the URL id." });
    return;
  }
  try {
    const roomTemplate = upsertRoomTemplateDef(req.body?.roomTemplate);
    res.json({ roomTemplate });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid room template JSON." });
  }
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("dungeon_room", DungeonRoom);

gameServer.listen(port);
console.log(`Colyseus server listening on ws://0.0.0.0:${port}`);
