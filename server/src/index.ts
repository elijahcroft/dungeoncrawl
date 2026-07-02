import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { DungeonRoom } from "./rooms/DungeonRoom";

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("dungeon_room", DungeonRoom).filterBy(["dungeonId"]);

gameServer.listen(port);
console.log(`Colyseus server listening on ws://0.0.0.0:${port}`);
