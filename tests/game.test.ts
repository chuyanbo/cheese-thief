import { describe, expect, it } from "vitest";
import {
  addOrReconnectPlayer,
  advanceNight,
  beginVoting,
  chooseInspectTarget,
  createPlayer,
  createRoom,
  skipCurrentInspect,
  startGame,
  submitVote,
  toPrivateState,
  toRoomState,
  type Room
} from "../src/server/game";

function makeRoom(count: number): Room {
  const host = createPlayer("p1", "玩家1");
  const room = createRoom("TEST", host);
  for (let index = 2; index <= count; index += 1) {
    addOrReconnectPlayer(room, createPlayer(`p${index}`, `玩家${index}`));
  }
  return room;
}

function randomFrom(values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0.5;
}

function finishNight(room: Room) {
  while (room.phase === "night") {
    skipCurrentInspect(room);
    advanceNight(room);
  }
}

describe("game engine", () => {
  it.each([
    [4, 0],
    [5, 1],
    [6, 1],
    [7, 2],
    [8, 2]
  ])("sets roles and accomplice count for %i players", (count, accomplices) => {
    const room = makeRoom(count);
    startGame(room, "p1", randomFrom([0.1, 0, 0.2, 0.4, 0.6, 0.8, 0.1, 0.3, 0.5]));
    expect(room.players.filter((player) => player.role === "thief")).toHaveLength(1);
    expect(room.requiredAccomplices).toBe(accomplices);
    expect(room.players.every((player) => player.dice && player.dice >= 1 && player.dice <= 6)).toBe(true);
  });

  it("keeps dice private to each player state", () => {
    const room = makeRoom(4);
    startGame(room, "p1", randomFrom([0, 0, 0.2, 0.2, 0.4]));
    const privateState = toPrivateState(room, "p4");
    expect(privateState.dice).toBe(3);
    expect(privateState.inspectOptions).not.toHaveProperty("dice");
    expect(JSON.stringify(privateState.inspectOptions)).not.toContain("\"dice\"");
  });

  it("steals cheese when the thief wakes and allows a later solo mouse to inspect", () => {
    const room = makeRoom(4);
    startGame(room, "p1", randomFrom([0, 0, 0.2, 0.2, 0.4]));
    expect(room.cheesePresent).toBe(false);
    advanceNight(room);
    advanceNight(room);
    expect(room.currentHour).toBe(3);
    expect(toPrivateState(room, "p4").canInspect).toBe(true);
    chooseInspectTarget(room, "p4", "p2");
    expect(room.players.find((player) => player.id === "p4")?.inspectResults[0]).toMatchObject({
      targetId: "p2",
      dice: 2
    });
  });

  it("resolves over-half votes as mice win when thief is ejected", () => {
    const room = makeRoom(5);
    startGame(room, "p1", randomFrom([0, 0, 0.2, 0.2, 0.4, 0.5]));
    finishNight(room);
    room.phase = "discussion";
    beginVoting(room, "p1");
    submitVote(room, "p1", "p1");
    submitVote(room, "p2", "p1");
    submitVote(room, "p3", "p1");
    expect(room.phase).toBe("voting");
    submitVote(room, "p4", "p2");
    const finalResult = submitVote(room, "p5", "p3");
    expect(finalResult?.winner).toBe("mice");
    expect(room.phase).toBe("result");
  });

  it("gives thief team the win when no player reaches majority", () => {
    const room = makeRoom(5);
    startGame(room, "p1", randomFrom([0, 0, 0.2, 0.2, 0.4, 0.5]));
    room.phase = "voting";
    submitVote(room, "p1", "p2");
    submitVote(room, "p2", "p3");
    submitVote(room, "p3", "p4");
    submitVote(room, "p4", "p5");
    const result = submitVote(room, "p5", "p2");
    expect(result?.winner).toBe("thief");
    expect(result?.ejectedPlayerId).toBeUndefined();
  });

  it("can advance through empty hours without getting stuck", () => {
    const room = makeRoom(4);
    room.phase = "night";
    room.thiefId = "p1";
    room.players.forEach((player) => {
      player.role = player.id === "p1" ? "thief" : "mouse";
      player.dice = 6;
    });
    finishNight(room);
    expect(room.phase).toBe("discussion");
    expect(room.currentHour).toBeUndefined();
  });

  it("hides global night logs and only exposes a player's awake observations", () => {
    const room = makeRoom(4);
    startGame(room, "p1", randomFrom([0, 0, 0.2, 0.2, 0.4]));
    advanceNight(room);
    advanceNight(room);
    expect(toRoomState(room).nightLog).toHaveLength(0);
    expect(toPrivateState(room, "p4").personalNightLog).toHaveLength(1);
    expect(toPrivateState(room, "p2").personalNightLog.every((entry) => entry.awakePlayerNames.includes("玩家2"))).toBe(true);
  });
});
