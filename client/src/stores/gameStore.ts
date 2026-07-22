import { create } from 'zustand';
import {
  RoomStatus,
  type Room,
  type Player,
  type Company,
  type PhaseChangedResponse,
  type GameOverResponse,
  type ErrorResponse,
  type TurnResolutionResult,
  type DecisionDefinition,
  type GameSettings,
  type GameDeckResponse,
  type DigDeeperResultPayload,
  type AnnualReportEntry,
  type LegalCaseData,
} from '@suetheirasses/shared';

interface GameState {
  // Room state
  room: Room | null;
  updateRoom: (room: Room) => void;

  // Player state — the current player's identity
  player: Player | null;
  updatePlayer: (player: Player) => void;
  kickPlayer: (playerId: string) => void;
  addPlayer: (player: Player) => void;
  markPlayerBankrupt: (playerId: string) => void;

  // Company state
  companies: Map<string, Company>;
  setCompanies: (companies: Company[]) => void;

  // Phase state
  currentPhase: RoomStatus | null;
  round: number;
  timer: number;
  updatePhase: (data: PhaseChangedResponse) => void;
  updateTimer: (timeLeft: number) => void;

  // Turn results — all players' computed states after each turn
  turnResults: TurnResolutionResult | null;
  handleTurnResolved: (data: TurnResolutionResult) => void;
  clearTurnResults: () => void;
  /** Instant, out-of-band "Dig Deeper" response — patches just the requesting player's cash + incomingAttacks. */
  applyDigDeeperResult: (playerId: string, data: DigDeeperResultPayload) => void;
  /** Instant, out-of-band lawsuit-filing-fee response — patches just the requesting player's cash, same "don't wait for the next turn:resolved" reasoning as applyDigDeeperResult. */
  applyFileLawsuitResult: (playerId: string, newCash: number) => void;
  /** Instant, out-of-band settlement-negotiation response (`game:legalCaseUpdate`, from `game:makeOffer`/`game:acceptOffer`/`game:goToCourt`) — patches the updated case into every matching player's `legalCases` in `turnResults` (the plaintiff's and the defendant's, whichever are present — this event only ever reaches the two parties on the case), and this client's own cash if `newCash` is set (a settlement). */
  applyLegalCaseUpdate: (updatedCase: LegalCaseData, newCash?: number) => void;

  /** AI-narrated "annual report" text per rival, keyed by rivalPlayerId — requested on demand from the Full Filing modal. */
  annualReports: Map<string, AnnualReportEntry[]>;
  annualReportLoading: Set<string>;
  setAnnualReportLoading: (rivalPlayerId: string) => void;
  applyAnnualReportResult: (rivalPlayerId: string, entries: AnnualReportEntry[]) => void;

  // Decision deck — the 45-decision library + per-turn limits, sent once per game
  decisions: DecisionDefinition[];
  gameSettings: GameSettings | null;
  setGameDeck: (data: GameDeckResponse) => void;

  // Game over
  gameOver: GameOverResponse | null;
  setGameOver: (data: GameOverResponse) => void;
  clearGameOver: () => void;

  // UI state
  error: ErrorResponse | null;
  setError: (error: ErrorResponse | null) => void;
  notification: string | null;
  setNotification: (message: string | null) => void;

  /** True while attempting to resume a saved session on connect — gates the first paint so the landing page doesn't flash before the attempt resolves. */
  isRejoining: boolean;
  setIsRejoining: (isRejoining: boolean) => void;

  /** Wipes room/player/in-game state back to a fresh landing-page state — used when a player is kicked or otherwise removed from a room they can no longer resume. */
  resetSession: () => void;

  /** Set once this player's own bankruptcy is detected (natural cash<0 elimination, or a `game:leave` forfeit) — GamePhase shows a full-screen "lost" takeover keyed off this instead of redirecting instantly, so the player has a moment to see it before returning to the landing page. */
  selfElimination: { reason: 'bankrupt' | 'forfeit' } | null;
  setSelfEliminationReason: (reason: 'bankrupt' | 'forfeit') => void;

  /** One "X has gone bankrupt" notice queued per elimination every *other* still-in-the-game
   * player should be told about — the eliminated player themselves gets `selfElimination`'s
   * full-screen takeover instead, never this. Queued (not a single value) since more than one
   * player can be eliminated in the same turn. App.tsx renders `bankruptcyEvents[0]` as a
   * full-screen takeover ahead of the phase switch — including ahead of AFTERMATH/GameOver, so
   * the message is seen even when this same elimination ends the game. */
  bankruptcyEvents: { playerId: string; playerName: string }[];
  enqueueBankruptcyEvent: (event: { playerId: string; playerName: string }) => void;
  dismissBankruptcyEvent: () => void;
}

export const useGameStore = create<GameState>((set) => ({
  // Initial state
  room: null,
  player: null,
  companies: new Map(),
  currentPhase: null,
  round: 1,
  timer: 0,

  turnResults: null,
  decisions: [],
  gameSettings: null,
  gameOver: null,
  error: null,
  notification: null,
  isRejoining: false,
  selfElimination: null,
  bankruptcyEvents: [],
  annualReports: new Map(),
  annualReportLoading: new Set(),

  updateRoom: (room) => set({ room, currentPhase: room.status }),
  updatePlayer: (player) => set({ player }),
  kickPlayer: (playerId) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: state.room.players.filter((p) => p.id !== playerId),
          }
        : null,
    })),
  addPlayer: (player) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: [...state.room.players, player],
          }
        : null,
    })),
  markPlayerBankrupt: (playerId) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: state.room.players.map((p) =>
              p.id === playerId ? { ...p, bankrupt: true } : p,
            ),
          }
        : null,
    })),
  updatePhase: (data) =>
    set((state) => ({
      currentPhase: data.phase,
      round: data.round,
      timer: data.timeLimit,
      room: state.room ? { ...state.room, status: data.phase } : null,
    })),
  updateTimer: (timeLeft) => set({ timer: timeLeft }),
  handleTurnResolved: (data) =>
    set({
      turnResults: data,
      round: data.round,
    }),
  clearTurnResults: () => set({ turnResults: null }),
  applyDigDeeperResult: (playerId, data) =>
    set((state) => {
      if (!state.turnResults) return {};
      const players = state.turnResults.players.map((p) => {
        if (p.playerId !== playerId) return p;
        return {
          ...p,
          variables: { ...p.variables, cash: data.newCash },
          incomingAttacks: p.incomingAttacks.map((a) => (a.attackId === data.attackId ? data.attack : a)),
        };
      });
      return { turnResults: { ...state.turnResults, players } };
    }),
  applyFileLawsuitResult: (playerId, newCash) =>
    set((state) => {
      if (!state.turnResults) return {};
      const players = state.turnResults.players.map((p) =>
        p.playerId !== playerId ? p : { ...p, variables: { ...p.variables, cash: newCash } },
      );
      return { turnResults: { ...state.turnResults, players } };
    }),
  applyLegalCaseUpdate: (updatedCase, newCash) =>
    set((state) => {
      if (!state.turnResults || !state.player) return {};
      const myId = state.player.id;
      const players = state.turnResults.players.map((p) => {
        if (p.playerId !== updatedCase.plaintiffId && p.playerId !== updatedCase.defendantId) return p;
        const legalCases = p.legalCases.map((c) => (c.id === updatedCase.id ? updatedCase : c));
        if (p.playerId === myId && newCash !== undefined) {
          return { ...p, legalCases, variables: { ...p.variables, cash: newCash } };
        }
        return { ...p, legalCases };
      });
      return { turnResults: { ...state.turnResults, players } };
    }),
  setAnnualReportLoading: (rivalPlayerId) =>
    set((state) => ({ annualReportLoading: new Set(state.annualReportLoading).add(rivalPlayerId) })),
  applyAnnualReportResult: (rivalPlayerId, entries) =>
    set((state) => {
      const annualReportLoading = new Set(state.annualReportLoading);
      annualReportLoading.delete(rivalPlayerId);
      const annualReports = new Map(state.annualReports);
      annualReports.set(rivalPlayerId, entries);
      return { annualReports, annualReportLoading };
    }),
  setGameDeck: (data) => set({ decisions: data.decisions, gameSettings: data.gameSettings }),
  setGameOver: (data) => set({ gameOver: data, notification: `Game Over! ${data.winner?.name || 'Unknown'} wins!` }),
  clearGameOver: () => set({ gameOver: null }),
  setError: (error) => set({ error }),
  setNotification: (notification) => set({ notification }),
  setIsRejoining: (isRejoining) => set({ isRejoining }),
  resetSession: () =>
    set({
      room: null,
      player: null,
      companies: new Map(),
      currentPhase: null,
      round: 1,
      timer: 0,
      turnResults: null,
      decisions: [],
      gameSettings: null,
      gameOver: null,
      annualReports: new Map(),
      annualReportLoading: new Set(),
      selfElimination: null,
      bankruptcyEvents: [],
    }),
  setSelfEliminationReason: (reason) => set({ selfElimination: { reason } }),
  enqueueBankruptcyEvent: (event) =>
    set((state) => ({ bankruptcyEvents: [...state.bankruptcyEvents, event] })),
  dismissBankruptcyEvent: () =>
    set((state) => ({ bankruptcyEvents: state.bankruptcyEvents.slice(1) })),
  setCompanies: (companies) => {
    const companyMap = new Map<string, Company>();
    for (const c of companies) {
      companyMap.set(c.id, c);
    }
    return set({ companies: companyMap });
  },
}));
