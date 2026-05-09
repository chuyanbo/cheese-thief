export type Phase = "lobby" | "confirm" | "night" | "accomplice" | "discussion" | "voting" | "result";

export type Role = "mouse" | "thief";

export type PlayerSummary = {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
  hasConfirmed?: boolean;
  hasVoted?: boolean;
};

export type NightLogEntry = {
  hour: number;
  awakeCount: number;
  cheesePresentAtStart: boolean;
  cheesePresentAfter: boolean;
  cheeseStolen: boolean;
  awakePlayerIds: string[];
  awakePlayerNames: string[];
  thiefWitnessedId?: string;
  thiefWitnessedName?: string;
  endsAt?: number;
};

export type PersonalNightLogEntry = {
  hour: number;
  awakePlayerNames: string[];
  cheesePresentAtStart: boolean;
  cheesePresentAfter: boolean;
  cheeseStolen: boolean;
  thiefWitnessedName?: string;
};

export type InspectResult = {
  hour: number;
  targetId: string;
  targetName: string;
  dice: number;
};

export type GameResult = {
  winner: "mice" | "thief";
  reason: string;
  thiefId: string;
  thiefName: string;
  ejectedPlayerId?: string;
  ejectedPlayerName?: string;
  voteCounts: Record<string, number>;
};

export type RoomState = {
  code: string;
  phase: Phase;
  players: PlayerSummary[];
  hostId: string;
  currentHour?: number;
  cheesePresent?: boolean;
  requiredAccomplices: number;
  selectedAccomplices: number;
  nightLog: NightLogEntry[];
  result?: GameResult;
};

export type PrivateState = {
  playerId: string;
  role?: Role;
  dice?: number;
  identityConfirmed: boolean;
  isAccomplice: boolean;
  isAwake: boolean;
  visibleCheesePresent?: boolean;
  awakePlayerNames: string[];
  hourEndsAt?: number;
  personalNightLog: PersonalNightLogEntry[];
  canInspect: boolean;
  inspectOptions: PlayerSummary[];
  inspectResults: InspectResult[];
  canChooseAccomplice: boolean;
  accompliceOptions: PlayerSummary[];
  accompliceIds: string[];
  canVote: boolean;
  votedForId?: string;
};

export type ClientToServerEvents = {
  createRoom: (payload: { name: string }, ack: Ack<{ room: RoomState; privateState: PrivateState }>) => void;
  joinRoom: (payload: { code: string; name: string }, ack: Ack<{ room: RoomState; privateState: PrivateState }>) => void;
  startGame: (payload: { code: string }) => void;
  confirmIdentity: (payload: { code: string }) => void;
  chooseInspectTarget: (payload: { code: string; targetId: string }) => void;
  skipInspect: (payload: { code: string }) => void;
  chooseAccomplice: (payload: { code: string; targetIds: string[] }) => void;
  beginVoting: (payload: { code: string }) => void;
  submitVote: (payload: { code: string; targetId: string }) => void;
  restartGame: (payload: { code: string }) => void;
};

export type ServerToClientEvents = {
  roomState: (state: RoomState) => void;
  privateState: (state: PrivateState) => void;
  phaseChanged: (phase: Phase) => void;
  actionRequired: (message: string) => void;
  gameResult: (result: GameResult) => void;
  error: (message: string) => void;
};

export type Ack<T> = (response: { ok: true } & T | { ok: false; error: string }) => void;
