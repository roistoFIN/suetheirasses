// ============================================================
// Room & Phase Types
// ============================================================

export enum RoomStatus {
  WAITING = 'WAITING',
  STRATEGY = 'STRATEGY',
  RESULTS = 'RESULTS',
  LAWSUITS = 'LAWSUITS',
  RESOLVING = 'RESOLVING',
}

export const PHASE_ORDER: RoomStatus[] = [
  RoomStatus.WAITING,
  RoomStatus.STRATEGY,
  RoomStatus.RESULTS,
  RoomStatus.LAWSUITS,
  RoomStatus.RESOLVING,
];

export const RESULTS_DISPLAY_DURATION = 15;

export const PHASE_TIMERS: Record<RoomStatus, number> = {
  [RoomStatus.WAITING]: 0,
  [RoomStatus.STRATEGY]: 120,
  [RoomStatus.RESULTS]: RESULTS_DISPLAY_DURATION,
  [RoomStatus.LAWSUITS]: 90,
  [RoomStatus.RESOLVING]: 90,
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
  isReady: boolean;
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
  lawsuitsFiled: Lawsuit[];
  lawsuitsReceived: Lawsuit[];
}

export interface Asset {
  id: string;
  companyId: string;
  type: string;
  value: number;
}

// ============================================================
// Lawsuit Types
// ============================================================

export enum Verdict {
  WON = 'WON',
  LOST = 'LOST',
  SETTLED = 'SETTLED',
}

export interface Lawsuit {
  id: string;
  plaintiffId: string;
  defendantId: string;
  claimAmount: number;
  grounds: string;
  resolved: boolean;
  verdict?: Verdict;
  resolution?: string;
}

// ============================================================
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
  ROOM_READY = 'room:ready',
  ROOM_LIST = 'room:list',
  STRATEGY_SUBMIT = 'strategy:submit',
  LAWSUIT_FILE = 'lawsuit:file',
  LAWSUIT_RESPOND = 'lawsuit:respond',
  LAWSUIT_SETTLE = 'lawsuit:settle',
  CHAT_MESSAGE = 'chat:message',
}

// Server → Client events
export enum ServerEvents {
  ROOM_JOINED = 'room:joined',
  ROOM_LEFT = 'room:left',
  ROOM_PLAYER_READY = 'room:playerReady',
  ROOM_PLAYER_JOINED = 'room:playerJoined',
  ROOM_PLAYER_LEFT = 'room:playerLeft',
  ROOMS_LISTED = 'rooms:list',
  PHASE_CHANGED = 'phase:changed',
  TIMER_UPDATE = 'timer:update',
  BOARD_UPDATE = 'board:update',
  STRATEGY_COLLECT = 'strategy:collect',
  RESULTS_REVEAL = 'results:reveal',
  LAWSUITS_OPEN = 'lawsuits:open',
  LAWSUITS_RESOLVE = 'lawsuits:resolve',
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

export interface StrategySubmitPayload {
  actions: GameAction[];
}

export interface GameAction {
  type: StrategyActionType;
  target?: string;
  amount?: number;
  details?: string;
}

export enum StrategyActionType {
  INVEST = 'INVEST',
  EXPAND = 'EXPAND',
  LAYOFF = 'LAYOFF',
  MERGER = 'MERGER',
  AD_CAMPAIGN = 'AD_CAMPAIGN',
  RESEARCH_AND_DEVELOPMENT = 'RD',
  OUTSOURCE = 'OUTSOURCE',
  ACQUISITION = 'ACQUISITION',
}

export interface LawsuitFilePayload {
  defendantId: string;
  claimAmount: number;
  grounds: string;
}

export interface LawsuitRespondPayload {
  lawsuitId: string;
  defense: string;
  settlementOffer?: number;
}

// ============================================================
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

export interface ResultsRevealResponse {
  outcomes: PhaseOutcome[];
}

export interface PhaseOutcome {
  playerId: string;
  playerName: string;
  changes: PhaseChange[];
}

export interface PhaseChange {
  type: string;
  description: string;
  cashDelta: number;
  assetDelta?: number;
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
// Room State (in-memory, for game engine)
// ============================================================

export interface RoomState {
  room: Room;
  players: Map<string, Player>;
  submissions: Map<string, StrategySubmitPayload>;
  timer: ReturnType<typeof setInterval> | null;
  timerValue: number;
}

export type Nullable<T> = T | null;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
