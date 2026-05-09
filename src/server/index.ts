import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/types";
import {
  addOrReconnectPlayer,
  advanceNight,
  confirmIdentity,
  beginVoting,
  chooseAccomplices,
  chooseInspectTarget,
  createPlayer,
  createRoom,
  finalizeAccompliceSelection,
  markDisconnected,
  restartGame,
  skipCurrentInspect,
  startGame,
  submitVote,
  toPrivateState,
  toRoomState,
  type Room
} from "./game";

const rooms = new Map<string, Room>();
const playerBySocket = new Map<string, { code: string; playerId: string }>();
const nightTimers = new Map<string, NodeJS.Timeout>();

export function buildApp() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: true
    }
  });

  io.on("connection", (socket) => {
    socket.on("createRoom", ({ name }, ack) => {
      handle(socket, ack, () => {
        const cleanName = validateName(name);
        const code = makeRoomCode();
        const player = createPlayer(crypto.randomUUID(), cleanName, socket.id);
        const room = createRoom(code, player);
        rooms.set(code, room);
        socket.join(code);
        playerBySocket.set(socket.id, { code, playerId: player.id });
        broadcastRoom(io, room);
        return { room: toRoomState(room), privateState: toPrivateState(room, player.id) };
      });
    });

    socket.on("joinRoom", ({ code, name }, ack) => {
      handle(socket, ack, () => {
        const cleanCode = code.trim().toUpperCase();
        const room = getRoom(cleanCode);
        const player = addOrReconnectPlayer(room, createPlayer(crypto.randomUUID(), validateName(name), socket.id));
        socket.join(room.code);
        playerBySocket.set(socket.id, { code: room.code, playerId: player.id });
        broadcastRoom(io, room);
        return { room: toRoomState(room), privateState: toPrivateState(room, player.id) };
      });
    });

    socket.on("startGame", ({ code }) => {
      mutate(socket, code, (room, playerId) => startGame(room, playerId));
    });

    socket.on("confirmIdentity", ({ code }) => {
      mutate(socket, code, (room, playerId) => confirmIdentity(room, playerId));
    });

    socket.on("chooseInspectTarget", ({ code, targetId }) => {
      mutate(socket, code, (room, playerId) => chooseInspectTarget(room, playerId, targetId));
    });

    socket.on("skipInspect", ({ code }) => {
      mutate(socket, code, (room) => skipCurrentInspect(room));
    });

    socket.on("chooseAccomplice", ({ code, targetIds }) => {
      mutate(socket, code, (room, playerId) => chooseAccomplices(room, playerId, targetIds));
    });

    socket.on("beginVoting", ({ code }) => {
      mutate(socket, code, (room, playerId) => beginVoting(room, playerId));
    });

    socket.on("submitVote", ({ code, targetId }) => {
      mutate(socket, code, (room, playerId) => submitVote(room, playerId, targetId));
    });

    socket.on("restartGame", ({ code }) => {
      mutate(socket, code, (room, playerId) => restartGame(room, playerId));
    });

    socket.on("disconnect", () => {
      const link = playerBySocket.get(socket.id);
      if (!link) return;
      playerBySocket.delete(socket.id);
      const room = rooms.get(link.code);
      if (!room) return;
      markDisconnected(room, socket.id);
      broadcastRoom(io, room);
    });
  });

  const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
  app.use(express.static(distPath));
  app.use((_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });

  return { app, httpServer, io, rooms };
}

function mutate(
  socket: Parameters<Parameters<Server<ClientToServerEvents, ServerToClientEvents>["on"]>[1]>[0],
  code: string,
  fn: (room: Room, playerId: string) => unknown
): void {
  try {
    const cleanCode = code.trim().toUpperCase();
    const room = getRoom(cleanCode);
    const link = playerBySocket.get(socket.id);
    if (!link || link.code !== room.code) throw new Error("你还没有加入这个房间。");
    const beforePhase = room.phase;
    const result = fn(room, link.playerId);
    if (room.phase !== beforePhase) {
      socket.nsp.to(room.code).emit("phaseChanged", room.phase);
    }
    if (result && room.result) {
      socket.nsp.to(room.code).emit("gameResult", room.result);
    }
    broadcastRoom(socket.nsp, room);
    schedulePhaseTimer(socket.nsp, room);
  } catch (error) {
    socket.emit("error", error instanceof Error ? error.message : "操作失败。");
  }
}

function handle<T>(
  socket: Parameters<Parameters<Server<ClientToServerEvents, ServerToClientEvents>["on"]>[1]>[0],
  ack: ((response: { ok: true } & T | { ok: false; error: string }) => void) | undefined,
  fn: () => T
): void {
  try {
    ack?.({ ok: true, ...fn() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败。";
    ack?.({ ok: false, error: message });
    socket.emit("error", message);
  }
}

function broadcastRoom(io: Server<ClientToServerEvents, ServerToClientEvents>, room: Room): void {
  io.to(room.code).emit("roomState", toRoomState(room));
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit("privateState", toPrivateState(room, player.id));
    const privateState = toPrivateState(room, player.id);
    if (privateState.canInspect) io.to(player.socketId).emit("actionRequired", "你单独醒来，可以查看一名玩家的骰子。");
    if (privateState.canChooseAccomplice) io.to(player.socketId).emit("actionRequired", "请选择你的共犯。");
  }
}

function schedulePhaseTimer(io: Server<ClientToServerEvents, ServerToClientEvents>, room: Room): void {
  const existing = nightTimers.get(room.code);
  if (existing) clearTimeout(existing);
  nightTimers.delete(room.code);

  const endsAt =
    room.phase === "night" && room.currentHour
      ? room.nightLog.find((entry) => entry.hour === room.currentHour)?.endsAt
      : room.phase === "accomplice"
        ? room.phaseEndsAt
        : undefined;
  if (!endsAt) return;

  const delay = Math.max(0, endsAt - Date.now());
  const timer = setTimeout(() => {
    const beforePhase = room.phase;
    if (room.phase === "night") {
      skipCurrentInspect(room);
      advanceNight(room);
    } else if (room.phase === "accomplice") {
      finalizeAccompliceSelection(room);
    }
    if (room.phase !== beforePhase) io.to(room.code).emit("phaseChanged", room.phase);
    broadcastRoom(io, room);
    schedulePhaseTimer(io, room);
  }, delay);
  nightTimers.set(room.code, timer);
}

function getRoom(code: string): Room {
  const room = rooms.get(code);
  if (!room) throw new Error("找不到这个房间。");
  return room;
}

function validateName(name: string): string {
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > 12) throw new Error("昵称需要 1 到 12 个字符。");
  return cleanName;
}

function makeRoomCode(): string {
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  } while (rooms.has(code));
  return code;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3001);
  buildApp().httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Cheese Thief server listening on http://localhost:${port}`);
  });
}
