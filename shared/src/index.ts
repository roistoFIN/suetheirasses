import type { DecisionDefinition, GameSettings } from './gameTypes.js';

// ============================================================
// Room & Phase Types
// ============================================================

export enum RoomStatus {
  WAITING = 'WAITING',
  /** Single interactive phase that loops until only one player remains */
  GAME_PHASE = 'GAME_PHASE',
  /** Final standings and winner announcement before game over */
  AFTERMATH = 'AFTERMATH',
}

export const PHASE_ORDER: RoomStatus[] = [
  RoomStatus.WAITING,
  RoomStatus.GAME_PHASE,
  RoomStatus.AFTERMATH,
];

export const PHASE_TIMERS: Record<RoomStatus, number> = {
  [RoomStatus.WAITING]: 0,
  [RoomStatus.GAME_PHASE]: 120,
  [RoomStatus.AFTERMATH]: 30,
};

export interface Room {
  id: string;
  status: RoomStatus;
  maxPlayers: number;
  currentPhaseRound: number;
  players: Player[];
  createdAt: Date;
  timer?: number;
}

// ============================================================
// Player Types
// ============================================================

export interface Player {
  id: string;
  name: string;
  roomId: string;
  isHost: boolean;
  bankrupt: boolean;
  companyId?: string | null;
  socketId?: string | null;
}

// ============================================================
// Company & Asset Types
// ============================================================

export interface Company {
  id: string;
  playerId: string;
  cash: number;
  debt: number;
  assets: Asset[];
}

export interface Asset {
  id: string;
  companyId: string;
  type: string;
  value: number;
}

// ===========================================================
// Game State (full snapshot)
// ============================================================

export interface GameState {
  room: Room;
  companies: Company[];
  currentPlayerId?: string;
}

// ============================================================
// Socket Event Types
// ============================================================

// Client → Server events
export enum ClientEvents {
  ROOM_JOIN = 'room:join',
  ROOM_LEAVE = 'room:leave',
  ROOM_KICK = 'room:kick',
  ROOM_START_GAME = 'room:startGame',
  ROOM_LIST = 'room:list',
  CHAT_MESSAGE = 'chat:message',
  GAME_SUBMIT_DECISIONS = 'game:submitDecisions',
}

// Server → Client events
export enum ServerEvents {
  ROOM_JOINED = 'room:joined',
  ROOM_LEFT = 'room:left',
  ROOM_PLAYER_KICKED = 'room:playerKicked',
  ROOM_PLAYER_JOINED = 'room:playerJoined',
  ROOM_PLAYER_LEFT = 'room:playerLeft',
  ROOMS_LISTED = 'rooms:list',
  PHASE_CHANGED = 'phase:changed',
  TIMER_UPDATE = 'timer:update',
  BOARD_UPDATE = 'board:update',
  GAME_DECK = 'game:deck',
  TURN_RESOLVED = 'turn:resolved',
  PLAYER_BANKRUPT = 'player:bankrupt',
  GAME_OVER = 'game:over',
  ERROR = 'error',
  CHAT_MESSAGE = 'chat:message',
}

// ============================================================
// Action Payload Types
// ============================================================

export interface RoomJoinPayload {
  playerName: string;
  roomName?: string;
}

// ===========================================================
// Response Types
// ============================================================

export interface RoomJoinedResponse {
  room: Room;
  player: Player;
  companies: Company[];
}

export interface PhaseChangedResponse {
  phase: RoomStatus;
  round: number;
  timeLimit: number;
}

/** The 45-decision library + per-turn limits, sent once when GAME_PHASE starts. */
export interface GameDeckResponse {
  decisions: DecisionDefinition[];
  gameSettings: GameSettings;
}

export interface RoomInfo {
  id: string;
  status: RoomStatus;
  maxPlayers: number;
  currentPhaseRound: number;
  playerCount: number;
}

export interface RoomsListedResponse {
  rooms: RoomInfo[];
}



export interface GameOverResponse {
  winner: Player;
  finalStandings: PlayerStanding[];
}

export interface PlayerStanding {
  player: Player;
  company: Company | null;
  rank: number;
}

// ============================================================
// Error Response
// ============================================================

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}

// ============================================================
// Constants
// ============================================================

/** Maximum number of players per room. This is the single source of truth — both the Prisma schema default and game engine logic reference this value. */
export const MAX_PLAYERS = 4;

// ============================================================
// Utility Types
// ============================================================

export type SocketId = string;

// ============================================================
// Game Engine Types (calculation engine, decision system, etc.)
// ============================================================

export * from './gameTypes.js';

// ============================================================
// Turn Result Types — re-exported for convenience
// ============================================================

export type { PlayerTurnResult, TurnResolutionResult } from './gameTypes.js';

// ============================================================
// Room State (in-memory, for game engine)
// ============================================================

export interface RoomState {
  room: Room;
  players: Map<string, Player>;
  timer: ReturnType<typeof setInterval> | null;
  timerValue: number;
}


export type Nullable<T> = T | null;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
}
