import type {
  GameResult,
  InspectResult,
  NightLogEntry,
  Phase,
  PlayerSummary,
  PersonalNightLogEntry,
  PrivateState,
  Role,
  RoomState
} from "../shared/types";

export type Player = {
  id: string;
  name: string;
  socketId?: string;
  connected: boolean;
  role?: Role;
  dice?: number;
  identityConfirmed: boolean;
  isAccomplice: boolean;
  inspectResults: InspectResult[];
  votedForId?: string;
};

export type Room = {
  code: string;
  phase: Phase;
  players: Player[];
  hostId: string;
  currentHour?: number;
  phaseEndsAt?: number;
  cheesePresent: boolean;
  thiefId?: string;
  requiredAccomplices: number;
  selectedAccompliceIds: string[];
  nightLog: NightLogEntry[];
  result?: GameResult;
  inspectDecisions: Record<number, string | "skipped">;
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;

export function createRoom(code: string, host: Player): Room {
  return {
    code,
    phase: "lobby",
    players: [host],
    hostId: host.id,
    cheesePresent: true,
    requiredAccomplices: 0,
    selectedAccompliceIds: [],
    nightLog: [],
    inspectDecisions: {}
  };
}

export function createPlayer(id: string, name: string, socketId?: string): Player {
  return {
    id,
    name: name.trim(),
    socketId,
    connected: true,
    identityConfirmed: false,
    isAccomplice: false,
    inspectResults: []
  };
}

export function addOrReconnectPlayer(room: Room, player: Player): Player {
  const existing = room.players.find((p) => sameName(p.name, player.name));
  if (existing) {
    existing.socketId = player.socketId;
    existing.connected = true;
    return existing;
  }
  if (room.phase !== "lobby") {
    throw new Error("游戏已经开始，只能用原昵称重连。");
  }
  if (room.players.length >= MAX_PLAYERS) {
    throw new Error("房间最多支持 8 名玩家。");
  }
  room.players.push(player);
  return player;
}

export function markDisconnected(room: Room, socketId: string): void {
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return;
  player.connected = false;
  player.socketId = undefined;
}

export function startGame(room: Room, hostId: string, random = Math.random): void {
  assertHost(room, hostId);
  if (room.phase !== "lobby" && room.phase !== "result") {
    throw new Error("当前阶段不能开始新游戏。");
  }
  if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) {
    throw new Error("游戏需要 4 到 8 名玩家。");
  }

  resetRound(room);
  room.phase = "confirm";
  room.requiredAccomplices = accompliceCount(room.players.length);
  const thief = pick(room.players, random);
  room.thiefId = thief.id;
  for (const player of room.players) {
    player.role = player.id === thief.id ? "thief" : "mouse";
    player.dice = 1 + Math.floor(random() * 6);
  }
}

export function confirmIdentity(room: Room, playerId: string): void {
  if (room.phase !== "confirm") throw new Error("现在不是身份确认阶段。");
  const player = findPlayer(room, playerId);
  player.identityConfirmed = true;
  if (room.players.every((p) => p.identityConfirmed)) {
    room.phase = "night";
    advanceNight(room);
  }
}

export function chooseInspectTarget(room: Room, playerId: string, targetId: string): void {
  if (room.phase !== "night") throw new Error("现在不是夜晚查看阶段。");
  const player = findPlayer(room, playerId);
  const target = findPlayer(room, targetId);
  if (!canInspect(room, player)) throw new Error("你现在不能查看骰子。");
  if (target.id === player.id) throw new Error("不能查看自己的骰子。");
  if (!target.dice) throw new Error("目标还没有骰点。");
  player.inspectResults.push({
    hour: room.currentHour ?? 0,
    targetId: target.id,
    targetName: target.name,
    dice: target.dice
  });
  room.inspectDecisions[room.currentHour ?? 0] = target.id;
}

export function skipCurrentInspect(room: Room): void {
  if (room.phase === "night" && currentSoloInspector(room)) {
    room.inspectDecisions[room.currentHour ?? 0] = "skipped";
  }
}

export function chooseAccomplices(room: Room, playerId: string, targetIds: string[]): void {
  if (room.phase !== "accomplice") throw new Error("现在不能选择共犯。");
  if (room.thiefId !== playerId) throw new Error("只有奶酪大盗可以选择共犯。");
  validateAccompliceTargets(room, targetIds);
  room.selectedAccompliceIds = targetIds;
}

export function finalizeAccompliceSelection(room: Room, random = Math.random): void {
  if (room.phase !== "accomplice") return;
  if (room.selectedAccompliceIds.length !== room.requiredAccomplices) {
    const candidates = room.players.filter((player) => player.id !== room.thiefId);
    const shuffled = shuffle(candidates, random);
    room.selectedAccompliceIds = shuffled.slice(0, room.requiredAccomplices).map((player) => player.id);
  }
  applyAccomplicesAndStartDiscussion(room);
}

function validateAccompliceTargets(room: Room, targetIds: string[]): void {
  if (targetIds.length !== room.requiredAccomplices) {
    throw new Error(`请选择 ${room.requiredAccomplices} 名共犯。`);
  }
  const uniqueIds = new Set(targetIds);
  if (uniqueIds.size !== targetIds.length) throw new Error("不能重复选择同一名玩家。");
  for (const id of targetIds) {
    const player = findPlayer(room, id);
    if (player.id === room.thiefId) throw new Error("奶酪大盗不能选择自己。");
  }
}

function applyAccomplicesAndStartDiscussion(room: Room): void {
  validateAccompliceTargets(room, room.selectedAccompliceIds);
  for (const id of room.selectedAccompliceIds) {
    findPlayer(room, id).isAccomplice = true;
  }
  room.phaseEndsAt = undefined;
  room.phase = "discussion";
}

export function beginVoting(room: Room, hostId: string): void {
  assertHost(room, hostId);
  if (room.phase !== "discussion") throw new Error("当前阶段不能进入投票。");
  room.phase = "voting";
}

export function submitVote(room: Room, playerId: string, targetId: string): GameResult | undefined {
  if (room.phase !== "voting") throw new Error("现在不是投票阶段。");
  const player = findPlayer(room, playerId);
  const target = findPlayer(room, targetId);
  player.votedForId = target.id;
  if (room.players.every((p) => p.votedForId)) {
    room.result = resolveVotes(room);
    room.phase = "result";
    return room.result;
  }
  return undefined;
}

export function restartGame(room: Room, hostId: string): void {
  assertHost(room, hostId);
  resetRound(room);
  room.phase = "lobby";
}

export function toRoomState(room: Room): RoomState {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => toPlayerSummary(room, p)),
    hostId: room.hostId,
    currentHour: room.currentHour,
    phaseEndsAt: room.phaseEndsAt,
    cheesePresent: room.phase === "night" ? undefined : room.cheesePresent,
    requiredAccomplices: room.requiredAccomplices,
    selectedAccomplices: room.selectedAccompliceIds.length,
    nightLog: [],
    result: room.result
  };
}

export function toPrivateState(room: Room, playerId: string): PrivateState {
  const player = findPlayer(room, playerId);
  const awake = isAwake(room, player);
  const awakePlayers = currentAwakePlayers(room);
  const thiefCanChoose =
    room.phase === "accomplice" &&
    room.thiefId === player.id &&
    room.selectedAccompliceIds.length !== room.requiredAccomplices;
  return {
    playerId: player.id,
    role: player.role,
    dice: player.dice,
    identityConfirmed: player.identityConfirmed,
    isAccomplice: player.isAccomplice,
    isAwake: awake,
    visibleCheesePresent: awake || room.phase !== "night" ? room.cheesePresent : undefined,
    awakePlayerNames: awake ? awakePlayers.map((p) => p.name) : [],
    hourEndsAt: room.phase === "night" ? getCurrentHourLog(room)?.endsAt : undefined,
    personalNightLog: personalNightLog(room, player),
    canInspect: canInspect(room, player),
    inspectOptions: room.players.filter((p) => p.id !== player.id).map((p) => toPlayerSummary(room, p)),
    inspectResults: player.inspectResults,
    canChooseAccomplice: thiefCanChoose,
    accompliceOptions: thiefCanChoose
      ? room.players.filter((p) => p.id !== player.id).map((p) => toPlayerSummary(room, p))
      : [],
    accompliceIds: room.thiefId === player.id || player.isAccomplice ? room.selectedAccompliceIds : [],
    canVote: room.phase === "voting" && !player.votedForId,
    votedForId: player.votedForId
  };
}

export function advanceNight(room: Room): void {
  if (room.phase !== "night") return;
  const nextHour = (room.currentHour ?? 0) + 1;
  if (nextHour > 6) {
    room.currentHour = undefined;
    if (room.requiredAccomplices > 0) {
      room.phase = "accomplice";
      room.phaseEndsAt = Date.now() + 15_000;
    } else {
      room.phase = "discussion";
      room.phaseEndsAt = undefined;
    }
    return;
  }

  room.currentHour = nextHour;
  room.phaseEndsAt = undefined;
  const awake = currentAwakePlayers(room);
  const cheesePresentAtStart = room.cheesePresent;
  const thiefAwake = awake.some((p) => p.id === room.thiefId);
  const cheeseStolen = Boolean(thiefAwake && room.cheesePresent);
  if (cheeseStolen) room.cheesePresent = false;
  room.nightLog.push({
    hour: nextHour,
    awakeCount: awake.length,
    cheesePresentAtStart,
    cheeseStolen,
    cheesePresentAfter: room.cheesePresent,
    awakePlayerIds: awake.map((p) => p.id),
    awakePlayerNames: awake.map((p) => p.name),
    thiefWitnessedId: cheeseStolen ? room.thiefId : undefined,
    thiefWitnessedName: cheeseStolen ? room.players.find((p) => p.id === room.thiefId)?.name : undefined,
    endsAt: Date.now() + 15_000
  });
}

export function canInspect(room: Room, player: Player): boolean {
  return currentSoloInspector(room)?.id === player.id;
}

export function currentAwakePlayers(room: Room): Player[] {
  if (room.phase !== "night" || !room.currentHour) return [];
  return room.players.filter((p) => p.dice === room.currentHour);
}

function currentSoloInspector(room: Room): Player | undefined {
  const awake = currentAwakePlayers(room);
  if (awake.length !== 1) return undefined;
  const only = awake[0];
  const latestLog = room.nightLog.at(-1);
  if (latestLog?.cheeseStolen && only.role !== "thief") return undefined;
  if (room.inspectDecisions[room.currentHour ?? 0]) return undefined;
  return only;
}

function getCurrentHourLog(room: Room): NightLogEntry | undefined {
  return room.nightLog.find((entry) => entry.hour === room.currentHour);
}

function personalNightLog(room: Room, player: Player): PersonalNightLogEntry[] {
  return room.nightLog
    .filter((entry) => entry.awakePlayerIds.includes(player.id))
    .map((entry) => ({
      hour: entry.hour,
      awakePlayerNames: entry.awakePlayerNames,
      cheesePresentAtStart: entry.cheesePresentAtStart,
      cheesePresentAfter: entry.cheesePresentAfter,
      cheeseStolen: entry.cheeseStolen,
      thiefWitnessedName: entry.thiefWitnessedName
    }));
}

function resolveVotes(room: Room): GameResult {
  const voteCounts: Record<string, number> = {};
  for (const player of room.players) {
    if (!player.votedForId) continue;
    voteCounts[player.votedForId] = (voteCounts[player.votedForId] ?? 0) + 1;
  }
  const majority = Math.floor(room.players.length / 2) + 1;
  const ejectedId = Object.entries(voteCounts).find(([, count]) => count >= majority)?.[0];
  const thief = findPlayer(room, room.thiefId ?? "");
  const ejected = ejectedId ? findPlayer(room, ejectedId) : undefined;
  const miceWin = ejectedId === room.thiefId;
  return {
    winner: miceWin ? "mice" : "thief",
    reason: ejected
      ? `${ejected.name} 获得过半票数，被投出。`
      : "没有任何玩家获得过半票数。",
    thiefId: thief.id,
    thiefName: thief.name,
    ejectedPlayerId: ejected?.id,
    ejectedPlayerName: ejected?.name,
    voteCounts
  };
}

function resetRound(room: Room): void {
  room.currentHour = undefined;
  room.phaseEndsAt = undefined;
  room.cheesePresent = true;
  room.thiefId = undefined;
  room.requiredAccomplices = 0;
  room.selectedAccompliceIds = [];
  room.nightLog = [];
  room.inspectDecisions = {};
  room.result = undefined;
  for (const player of room.players) {
    player.role = undefined;
    player.dice = undefined;
    player.identityConfirmed = false;
    player.isAccomplice = false;
    player.inspectResults = [];
    player.votedForId = undefined;
  }
}

function accompliceCount(playerCount: number): number {
  if (playerCount <= 4) return 0;
  if (playerCount <= 6) return 1;
  return 2;
}

function toPlayerSummary(room: Room, player: Player): PlayerSummary {
  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    isHost: player.id === room.hostId,
    hasConfirmed: room.phase === "confirm" ? player.identityConfirmed : undefined,
    hasVoted: room.phase === "voting" || room.phase === "result" ? Boolean(player.votedForId) : undefined
  };
}

function findPlayer(room: Room, playerId: string): Player {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw new Error("找不到玩家。");
  return player;
}

function isAwake(room: Room, player: Player): boolean {
  return room.phase === "night" && player.dice === room.currentHour;
}

function assertHost(room: Room, playerId: string): void {
  if (room.hostId !== playerId) throw new Error("只有房主可以执行这个操作。");
}

function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function shuffle<T>(items: T[], random: () => number): T[] {
  return [...items].sort(() => random() - 0.5);
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}
