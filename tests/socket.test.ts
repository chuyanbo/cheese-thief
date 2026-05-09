import { afterEach, describe, expect, it } from "vitest";
import { io as Client, type Socket } from "socket.io-client";
import { buildApp } from "../src/server/index";
import type { ClientToServerEvents, ServerToClientEvents } from "../src/shared/types";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let sockets: TestSocket[] = [];
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  sockets.forEach((socket) => socket.disconnect());
  sockets = [];
  await closeServer?.();
  closeServer = undefined;
});

async function startTestServer() {
  const { httpServer } = buildApp();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  closeServer = () => new Promise((resolve) => httpServer.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
}

function connect(url: string): Promise<TestSocket> {
  const socket: TestSocket = Client(url);
  sockets.push(socket);
  return new Promise((resolve) => socket.on("connect", () => resolve(socket)));
}

describe("socket rooms", () => {
  it("creates, joins, reconnects by nickname, and isolates private dice", async () => {
    const url = await startTestServer();
    const host = await connect(url);
    const created = await host.emitWithAck("createRoom", { name: "阿一" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const roomCode = created.room.code;

    const joiner = await connect(url);
    const joined = await joiner.emitWithAck("joinRoom", { code: roomCode, name: "阿二" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(JSON.stringify(joined.privateState.inspectOptions)).not.toContain("\"dice\"");
    expect(JSON.stringify(joined.privateState.inspectOptions)).not.toContain("\"role\"");

    joiner.disconnect();
    const reconnectedSocket = await connect(url);
    const reconnected = await reconnectedSocket.emitWithAck("joinRoom", { code: roomCode, name: "阿二" });
    expect(reconnected.ok).toBe(true);
    if (!reconnected.ok) return;
    expect(reconnected.privateState.playerId).toBe(joined.privateState.playerId);
    expect(reconnected.room.players).toHaveLength(2);
  });
});
