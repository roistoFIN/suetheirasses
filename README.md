# ⚖️ Sue Their Asses

A multiplayer web-based business strategy game where players manage companies and eliminate opponents through bankruptcy.

## 🎮 Game Overview

### Game Flow

The game progresses through a continuous loop until only one player remains:

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                     │
│  Matchmaking ──▶ Game Loop round (120s) ──▶ resolveGameTurn        │
│   (Lobby)         submit decisions          bankruptcy check runs  │
│       ▲            (all players at once)    every round, inline    │
│       │                                              │             │
│       │                              ┌───────────────┴──────┐      │
│       │                        >1 player still active  1 player   │
│       │                              │                left        │
│       │                              ▼                   │        │
│       └───────────── loop back into another Game Loop round        │
│                                                           ▼        │
│                                                     GAME OVER       │
│                                                    (Aftermath)      │
│                                                                     │
└───────────────────────────────────────────────────────────────────┘
```

### Phase Details

| Phase | Name | Description | Timer |
|-------|------|-------------|-------|
| 1 | **Matchmaking** | Players join/create rooms, or use Quick Play | No timer |
| 2 | **Game Loop** | Repeats every round: players submit decisions, server resolves outcomes (P&L, market share, legal risk, bankruptcy check) and broadcasts `turn:resolved` | 120s per round |
| 3 | **Aftermath** | Terminal state — reached the instant only one player remains. Shows the winner and final standings; the game does not return to the Game Loop from here. | 30s |

Bankruptcy is checked as part of every single Game Loop round, not in a separate pass: a
player is eliminated the instant their cash goes below $0 on any turn (FORMULAS §12). The
loop continues — incrementing the round and resolving again every 120s — until only one
player remains, at which point the room moves to Aftermath and the game ends.

### Invite Link Feature

Hosts can share direct web links to invite other players to their room:

1. **Copy Link**: Host clicks the copy icon next to "Room Invite Link" in the lobby → copies URL like `http://localhost:5173/?room=<roomId>` to clipboard
2. **Invite Flow**: When a player opens an invite link, the matchmaking page shows only the "Join a Room" section with the room code pre-filled — "Create a Room" and "Quick Play" are hidden
3. **Normal Flow**: Players who navigate directly to `/matchmaking` see all options (Quick Play, Create Room, Join Room, Available Rooms)
4. **Server Validation**: The room code from the URL is passed as `roomName` in the `room:join` payload; UUID v4 codes (36 chars) and CUID-style IDs (~25 chars) are both supported

### Quick Play Feature

Players can join existing rooms without knowing the room ID through the Quick Play system:

1. **Search**: Player clicks "Search for Available Room" → sends `room:list` event
2. **Room Discovery**: Server merges in-memory active rooms with database rooms for consistency
3. **Auto-Join**: Server finds the room with the fewest players (< 4) and joins the player — invite-only rooms (see *Lobby Features* below) are never a candidate
4. **Fallback**: If no rooms available, a new room is created automatically
5. **Live Updates**: Other players receive `room:playerJoined` events when someone joins

The room list is dynamically updated via the `rooms:list` server event, showing:
- Room ID (truncated)
- Current player count (e.g., 2/4)
- Room status and phase round

### Lobby Features

- **Remembered name** — `Matchmaking.tsx` saves the player's name to `localStorage`
  (`stita_player_name`) the moment it's non-empty, and pre-fills + locks the name field on
  return visits so it never needs re-typing. A **Change Name** button sits next to the
  field, enabled only once a name exists (freshly typed or remembered) — clicking it
  unlocks the field for editing again.
- **About modal** — the landing page's title/subtitle text was replaced with a single
  **About** button; clicking it opens a closeable modal with a plain-language rules
  summary (round flow, decisions, lawsuits, win condition), for players who land on the
  page without prior context.
- **Room Lobby chat** — a simple text chat scoped to the WAITING-phase lobby (`chat:message`,
  client → server payload `{ message }`, broadcast back to the room as
  `{ playerId, playerName, message, timestamp }`). Ephemeral — nothing is persisted, and a
  newly-joined/rejoined player gets no history replay, only messages sent while they're
  actually in the room.
- **Kicked player redirect** — `room:playerKicked` for *your own* id now fully resets
  `gameStore` (room/player/turn state, not just your roster entry) and clears the saved
  session, landing you back on the plain landing page with a dismissible "You've been
  removed from the room by the host." notification (`App.tsx`'s `NotificationBanner`,
  fixed to the top of the screen, auto-dismisses after 6s).
- **Minimum 2 players to start** — `room:startGame`'s **Start Game** button is disabled
  client-side below 2 players (covers "just created the room" and "kicked back down to
  alone"), and the server independently rejects a `room:startGame` attempt with
  `NOT_ENOUGH_PLAYERS` below 2 regardless of what the client sends.
- **Name-taken message** — trying to join with a name already in use in that room (or a
  name that was just kicked from it, see below) surfaces as a dismissible red alert on the
  landing page instead of failing silently; the same fix also resets the stuck loading
  spinner that any failed join used to leave behind (nothing previously reset it on error).
- **Invite Only** — the host can toggle a room between 🔓 **Public** and 🔒 **Invite Only**
  (`room:setInviteOnly`, host-only, WAITING phase only). An invite-only room is excluded
  from Quick Play matching and the Available Rooms list, but a direct room-code or
  invite-link join is never blocked by it — "invite only" means "not auto-discoverable,"
  not "unjoinable."
- **Leave Room** — a button in the lobby (`room:leave`/`room:left`, WAITING phase only)
  that actually removes the player from the room (DB row deleted, same cleanup as a kick)
  and returns them to a fully-reset landing page: the loading spinner and lobby chat
  history are both explicitly cleared (see CLAUDE.md — neither used to be, since
  `Matchmaking` never unmounts across a room ↔ landing transition, so leftover component
  state from the room you just left would otherwise carry into whatever's next). Distinct
  from GAME_PHASE's **Leave Game**, which forfeits (marks bankrupt) rather than removing
  the player, since there's a game in progress to lose.
- **Host reassignment** — if the host disconnects past the grace period, gets kicked (host
  can't kick themselves, so this only ever happens via the other two paths), or leaves
  voluntarily, the longest-tenured remaining player (`GameEngine.promoteNewHostIfNeeded`)
  is promoted automatically, both in-memory and in the DB.
- **Kicked players can't rejoin** — each room tracks kicked *names* (`RoomState.kickedNames`
  — see CLAUDE.md for why this is name-based rather than a real ban) and rejects a fresh
  `room:join` reusing one, whether via invite link or Quick Play, for the lifetime of the
  room. Quick Play treats that rejection like any other unusable candidate room (full,
  gone, whatever) — it skips to the next one, or creates a fresh room if none work, rather
  than surfacing a hard error and stranding the player on the landing page.

---

## 🏗️ Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSERS (Clients)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Player 1   │  │   Player 2   │  │   Player N   │              │
│  │  React + UI  │  │  React + UI  │  │  React + UI  │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┼──────────────────┘                       │
│                        WebSocket                                      │
└────────────────────────┬─────────────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   SOCKET.IO SERVER  │
              │                     │
              │  • Room Manager     │
              │  • Phase Engine     │
              │  • Action Validator │
              │  • Broadcast Hub    │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐     ┌──────────────────┐
              │   PRISMA ORM        │────▶│   PostgreSQL     │
              │                     │     │   (Game State,   │
              │  • Game State       │     │    Players,       │
              │  • Player Data      │     │    Companies,     │
              │  • Asset Records    │     │    Actions,       │
              └──────────┬──────────┘     └──────────────────┘
                         │
```

### Design Principles

1. **Server-Authoritative**: The server is the single source of truth. Clients send intentions; the server validates and resolves.
2. **Phase-Based State Machine**: Each game phase is an isolated handler, making the system testable and extensible.
3. **Action Logging**: Every action is persisted, enabling replay, debugging, and dispute resolution.
4. **Optimistic UI**: Clients show immediate feedback; the server reconciles authoritative state.
5. **Room Garbage Collection**: Empty rooms are automatically cleaned up from both in-memory state and the database to prevent ghost rooms from appearing in Quick Play queries.
6. **Dual-Source Room Consistency**: Room listings merge in-memory active rooms with database records to ensure accuracy across server restarts and Quick Play scenarios.

---

## 🛠️ Tech Stack

Tech stack is defined in tech-stack.md 

---

## 📁 Project Structure

```
suetheirasses/
├── client/                          # React frontend application
│   ├── public/
│   │   └── images/                  # Static assets served as-is (Vite public/ convention)
│   │       ├── hero.png             # Landing page hero art
│   │       ├── sued.png             # "sued" post-turn info window art
│   │       ├── lawsuit-won.png      # "lawsuit verdict: won" post-turn info window art
│   │       ├── lawsuit-lost.png     # "lawsuit verdict: lost" post-turn info window art
│   │       ├── turn-change.png      # "turn change" post-turn info window art
│   │       └── lost.png             # "lost" takeover art (bankrupt/forfeit)
│   ├── src/
│   │   ├── components/              # Reusable UI components
│   │   │   ├── Timer.tsx            # Phase countdown timer
│   │   │   └── ...
│   │   ├── pages/                   # Page components
│   │   │   ├── Matchmaking.tsx      # Lobby: create/join/quick-play, invite links
│   │   │   ├── GamePhase.tsx        # The GAME_PHASE loop UI (KPIs, decisions, lawsuits)
│   │   │   ├── GameOver.tsx         # AFTERMATH: winner + final standings
│   │   │   └── AdminPortal.tsx      # /admin — token-gated room monitoring + config view
│   │   ├── stores/                  # Zustand state stores
│   │   │   ├── gameStore.ts         # Game state (room, phase, timer, turn results)
│   │   │   └── socketStore.ts       # Socket.IO connection & events
│   │   ├── App.tsx                  # Root component — renders phase/`/admin` directly,
│   │   │                            # no path-based routing for game phases (see CLAUDE.md);
│   │   │                            # also owns the global NotificationBanner and the
│   │   │                            # "lost" takeover (bankrupt/forfeit)
│   │   └── main.tsx                 # Entry point
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── Dockerfile
│   ├── nginx-entrypoint.sh
│   ├── .env.example
│   └── package.json
│
├── server/                          # Node.js backend application
│   ├── src/
│   │   ├── socket/                  # Socket.IO handlers
│   │   │   └── gameEngine.ts        # Room/phase lifecycle + GameLoop orchestration
│   │   ├── engine/                  # Turn-resolution engine (FORMULAS.md, see below)
│   │   │   ├── gameLoop.ts          # Orchestrates one full turn, per-room
│   │   │   ├── calcEngine.ts        # P&L, balance sheet, market share, risk gauge
│   │   │   ├── decisionEngine.ts    # Decision deployment, maturity, exclusions
│   │   │   ├── legalEngine.ts       # Deliberate lawsuit filing (see Lawsuits below)
│   │   │   ├── formulaEngine.ts     # Safe expression parser/evaluator for DB-backed
│   │   │   │                        # formulas (see Formulas below) — no eval/Function/vm
│   │   │   └── defaultFormulas.ts   # The 23 seed formula expressions — shared by
│   │   │                            # prisma/seed.ts and the engine test fixtures
│   │   ├── data/                    # Seed-only now — see Decisions & Game Config below
│   │   │   ├── game_engine.json     # 45 decisions: impacts, legal risks, exclusions
│   │   │   └── game_config.json     # Starting values + admin-tunable variables
│   │   ├── validation/              # Zod schemas
│   │   │   └── schemas.ts           # All input validation
│   │   ├── services/                # External service clients (real network I/O, no game math)
│   │   │   └── llmService.ts        # Local llama.cpp client — AI-narrated annual report text
│   │   ├── middleware/
│   │   │   └── adminAuth.ts         # ADMIN_TOKEN gate for /api/admin/* (see Admin Portal below)
│   │   └── index.ts                 # Server entry point + REST endpoints (/health, /api/room,
│   │                                 # /api/admin/*)
│   ├── prisma/
│   │   ├── schema.prisma            # Database schema (incl. Decision, GameConfigRow,
│   │   │                            # Formula — the decision library, game config, and
│   │   │                            # pure-math formulas, all DB-backed)
│   │   ├── seed.ts                  # npm run db:seed — seeds Decision/GameConfigRow
│   │   │                            # from server/src/data/*.json and Formula from
│   │   │                            # defaultFormulas.ts (idempotent)
│   │   └── migrations/              # Database migrations
│   ├── .env.example                 # Environment variables template
│   ├── .env                         # Environment variables (gitignored)
│   ├── Dockerfile
│   ├── tsconfig.json
│   └── package.json
│
├── shared/                          # Shared types between client/server
│   ├── src/
│   │   ├── index.ts                 # Room/player/socket-event types, enums, payloads
│   │   └── gameTypes.ts             # Engine types: DecisionDefinition, PlayerVariables,
│   │                                 # LegalCaseData, TurnResolutionResult, GameConfig
│   ├── tsconfig.json
│   └── package.json
│
├── definitionDocumentation/         # Source of truth for game math — never derive
│   └── FORMULAS.md                  # every formula + the per-turn calculation order
│
├── tests/                           # Integration & E2E Tests
│   ├── api/                         # Vitest interface tests (DB via testcontainers)
│   │   ├── health.test.ts
│   │   ├── room.test.ts             # Room/Player/Company CRUD, incl. engineState/variables
│   │   ├── socket.test.ts           # Socket.IO event contracts (incl. game:submitDecisions,
│   │   │                            # turn:resolved, game:over)
│   │   └── validation.test.ts       # Zod schema contracts
│   ├── e2e/                         # Playwright E2E tests
│   │   ├── matchmaking.spec.ts      # Lobby: create/join/quick-play/invite-link flows
│   │   └── gamePhase.spec.ts        # Starting a game reaches GAME_PHASE cleanly
│   ├── playwright.config.ts
│   ├── vitest.config.ts
│   └── test-setup.ts
│
├── models/                          # Local LLM weights (gitignored — see "Local LLM" below)
├── .github/                         # GitHub Actions CI/CD
├── .dockerignore
├── Dockerfile                       # Full-stack multi-stage build
├── docker-compose.yml               # Docker orchestration (PostgreSQL, server, client, llm)
├── package.json                     # Monorepo root (workspaces)
├── .gitignore
└── README.md                        # This file
```

---

## 🗄️ Data Model

### Entity Relationship Diagram

```
┌──────────┐       ┌──────────┐       ┌──────────┐
│  Room    │1    *│  Player  │1    1│ Company  │
├──────────┤       ├──────────┤       ├──────────┤
│ id       │──────▶│ id       │──────▶│ id       │
│ status   │       │ name     │       │ playerId │
│ maxPlayers│      │ roomId   │       │ cash     │
│ round    │       │ isHost   │       │ debt     │
│ createdAt│       │ socketId │       └────┬─────┘
└──────────┘       │ bankrupt │            │
                   │ createdAt│            │
                   │          │ 1    *  ┌──▼────┐
                   │          │       │  │ Asset │
                   │          │       │  └───────┘
```

### Database Schema (Prisma)

```prisma
model Room {
  id                String       @id @default(cuid())
  status            RoomStatus   @default(WAITING)
  maxPlayers        Int          @default(4)
  currentPhaseRound Int          @default(1)
  createdAt         DateTime     @default(now())
  inviteOnly        Boolean      @default(false) // host-toggled — see "Invite Only" above
  players           Player[]

  @@index([status])
  @@index([createdAt])
}

model Player {
  id           String     @id @default(cuid())
  name         String
  roomId       String
  room         Room       @relation(fields: [roomId], references: [id], onDelete: Cascade)
  isHost       Boolean    @default(false)
  bankrupt     Boolean    @default(false)
  socketId     String?
  createdAt    DateTime   @default(now())
  companyId    String?    @unique
  company      Company?

  @@index([roomId])
  @@index([roomId, bankrupt])
}

// All per-player game-engine state lives in JSONB columns so GameLoop can read/write
// it atomically each turn without a schema migration per new field. `cash`/`debt` stay
// as typed columns too, for quick queries (e.g. bankruptcy checks, standings).
model Company {
  id                String  @id @default(cuid())
  playerId          String  @unique
  player            Player  @relation(fields: [playerId], references: [id], onDelete: Cascade)
  cash              Decimal @default(100000) @db.Decimal(15, 2)
  debt              Decimal @default(0)      @db.Decimal(15, 2)
  // Full PlayerVariables (cash, assets, price, outrage, scrutiny, ...) — FORMULAS.md
  variables         Json    @default("{}")
  // Snapshot of last turn's computed results, for UI display/history
  lastTurnSnapshot  Json?   @default("{}")
  // activeDecisions, depreciationLedger, legalCases, investigations (GameLoop's CompanyEngineState)
  engineState       Json    @default("{}")
  assets            Asset[]

  @@index([playerId])
}

model Asset {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  type      String
  value     Decimal  @db.Decimal(15, 2)

  @@index([companyId])
}

// One row per player per round — the source of the KPI history graphs (every KPI card
// and breakdown line item is clickable, see "KPI History & Prediction" above). Stores
// the same variables/derived/riskGauge shape turn:resolved already carries per player,
// verbatim, so any current or future clickable field can be graphed without a further
// migration. Written by GameEngine, never read/written by GameLoop itself.
model KpiSnapshot {
  id        String   @id @default(cuid())
  playerId  String
  player    Player   @relation(fields: [playerId], references: [id], onDelete: Cascade)
  round     Int
  variables Json
  derived   Json
  riskGauge Float
  createdAt DateTime @default(now())

  @@unique([playerId, round])
  @@index([playerId])
}
```

---

## 🔌 Real-Time Communication

### Socket.IO Events

#### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:join` | `{ playerName, roomName?, searchForRoom? }` | Join a specific room by ID (`roomName`), create one (no params), or search for an available room (`searchForRoom: true`). When joining via invite link, `roomName` contains the UUID v4 room code from the URL query param. |
| `room:rejoin` | `{ roomId, playerId }` | Resume an existing session on a new socket — after a page refresh, an accidental back button, or a brief network drop — as long as it's within the server's reconnect grace period. See *Reconnection & Session Resume* below. |
| `room:list` | — | Request list of available rooms |
| `room:kick` | `{ playerId }` | Host removes a player from the room |
| `room:leave` | — | Voluntarily leave the room lobby — WAITING phase only. Distinct from `game:leave`'s GAME_PHASE forfeit; this actually removes the player rather than marking them bankrupt. See *Lobby Features* above. |
| `room:setInviteOnly` | `{ inviteOnly }` | Host toggles whether the room can be found via Quick Play / the Available Rooms list — WAITING phase only. Never blocks a direct room-code/invite-link join. |
| `room:startGame` | — | Host starts the game (WAITING → GAME_PHASE, round 1) |
| `game:submitDecisions` | `{ strategic: DecisionEntry[], operational: DecisionEntry[], lawsuits: LawsuitEntry[] }` | Full replacement of this turn's pending decisions (`{ name, targetId? }` each) *and* deliberate lawsuit filings (`{ targetId, decisionName, groundName }` each — see *Lawsuits* below). Structural validation only — per-turn limits (max 1 strategic / 2 operational / 3 lawsuits) come from `game_config.json` and are enforced by `DecisionEngine.canDeploy` / `GameLoop`'s lawsuit-filing step. |
| `game:digDeeper` | `{ attackId }` | Pay `gameSettings.digDeeperCost` ($10,000 by default) to reveal the next tier of intel on one incoming attack — instant, outside the turn-resolution cycle. See *Attack Awareness & Dig Deeper* below. |
| `game:fileLawsuit` | `{ targetId, decisionName, groundName }` | Pay `gameSettings.lawsuitFilingCost` ($15,000 by default) the instant a lawsuit is actually filed — instant, outside the turn-resolution cycle, same pattern as `game:digDeeper`. The client still separately queues the same entry via `game:submitDecisions` for the case itself to be created at the next turn resolution. See *Lawsuits* below. |
| `game:getAnnualReport` | `{ rivalPlayerId }` | Request AI-narrated "annual report" text for one rival's active decisions — on demand, outside the turn-resolution cycle. See *AI-Narrated Annual Reports* below. |
| `game:getKpiHistory` | — | Request this player's own KPI history (persisted `KpiSnapshot` rows) plus a 3-turn-ahead prediction — on demand, opened by clicking any KPI card or breakdown line item. No payload — always "my own data." See *KPI History & Prediction* below. |
| `game:leave` | — | Voluntary forfeit — GAME_PHASE only. Instant bankruptcy for the requesting player; the game continues for everyone else. See *Leave Game* below. |
| `game:ready` | `{ ready }` | Toggle ready status for the in-flight turn — GAME_PHASE only. Once every active player is ready, the turn resolves immediately. See *Ready-Up* below. |
| `chat:message` | `{ message }` | Send a chat message to the room — WAITING phase only. See *Lobby Features* above. |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ room, player, companies }` | Successfully joined a room — also the response to a successful `room:rejoin` |
| `room:left` | — | Sent only to the requesting socket, confirming a successful `room:leave` — the client's cue to reset to the landing page |
| `room:playerJoined` | `{ playerId, playerName, isHost, roomId }` | New player joined the room |
| `room:playerKicked` | `{ kickedPlayerId, kickedPlayerName }` | Player was kicked from room |
| `room:playerLeft` | `{ playerId, playerName, roomId }` | A disconnected player's reconnect grace period expired without them coming back — they're now actually removed. Never fires for a disconnect that reconnects in time; the rest of the room isn't told about those at all. |
| `room:updated` | `{ room }` | Broadcast to the whole room whenever the roster or room-level settings change outside a fresh join (kick, `room:leave`, host reassignment, `room:setInviteOnly`) — always a freshly-rebuilt `Room` snapshot (`GameEngine.buildRoomSnapshot`), never a stale cached one. Deliberately carries no `player` field, unlike `room:joined` — see *Game Engine Architecture* below for why that matters. |
| `rooms:list` | `{ rooms: RoomInfo[] }` | List of available rooms (Quick Play) — never includes invite-only rooms |
| `phase:changed` | `{ phase, round, timeLimit }` | Room advanced phase, or looped into another GAME_PHASE round |
| `timer:update` | `{ timeLeft }` | Countdown tick |
| `game:deck` | `{ decisions: DecisionDefinition[], gameSettings: GameSettings }` | Sent once, right when GAME_PHASE starts — the full 45-decision library and per-turn limits, static for the whole game. Also re-sent on a successful `room:rejoin` during GAME_PHASE. |
| `turn:resolved` | `TurnResolutionResult` (`{ round, players: PlayerTurnResult[], gameOver, winnerId? }`) | Sent twice per round-1: once immediately when the game starts (starting-position preview, `GameLoop.getInitialSnapshot`), and again whenever a GAME_PHASE turn actually finishes resolving (`GameLoop.resolveTurn`) — full per-player state either way. `GameEngine` caches the most recent one per room and re-sends it on a successful `room:rejoin` during GAME_PHASE, so a reconnecting player doesn't wait for the next turn to see where things stand. |
| `player:bankrupt` | `{ playerId, playerName }` | Player eliminated — either their cash went below $0 this turn (FORMULAS §12), or they voluntarily forfeited via `game:leave` |
| `game:over` | `{ winner, finalStandings }` | Only one player remains; room moved to AFTERMATH. Also re-sent on a successful `room:rejoin` during AFTERMATH. |
| `game:digDeeperResult` | `{ attackId, cost, newCash, attack: IncomingAttackInfo }` | Sent only to the requesting socket, never broadcast — the newly-unlocked intel tier for one attack |
| `game:fileLawsuitResult` | `{ cost, newCash }` | Sent only to the requesting socket, on a successful `game:fileLawsuit` charge — a failed charge (insufficient funds, per-turn limit reached) is reported via the generic `error` event instead, same convention as `game:digDeeper` |
| `game:annualReportResult` | `{ rivalPlayerId, entries: AnnualReportEntry[] }` | Sent only to the requesting socket, never broadcast — AI-narrated (or static-fallback) flavor text for the rival's active decisions |
| `game:kpiHistoryResult` | `{ history: KpiSnapshotPoint[], predicted: KpiSnapshotPoint[], bankruptAtRound? }` | Sent only to the requesting socket — this player's own persisted KPI history (oldest round first) plus up to 3 predicted future turns |
| `game:left` | — | Sent only to the requesting socket, confirming a successful `game:leave` forfeit — the client's cue to show the "lost" takeover with the forfeit-specific message |
| `game:readyUpdate` | `{ readyPlayerIds: string[], activePlayerCount: number }` | Broadcast on every `game:ready` toggle, and reset to an empty `readyPlayerIds` at the start of every new round |
| `chat:message` | `{ playerId, playerName, message, timestamp }` | Broadcast to the room in response to a `chat:message` from any player in it |
| `error` | `{ code, message }` | Error occurred (e.g. `NOT_HOST`, `INVALID_DECISIONS`, `REJOIN_FAILED`, `ANNUAL_REPORT_FAILED`, `NOT_ENOUGH_PLAYERS`, `LEAVE_GAME_FAILED`, `INVALID_READY`, `INVALID_CHAT_MESSAGE`, `NAME_TAKEN`, `ROOM_FULL`, `ROOM_NOT_FOUND`, `KICKED_FROM_ROOM`, `LEAVE_ROOM_FAILED`, `INVALID_INVITE_ONLY`) |

### API Type Definitions

```typescript
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

export interface RoomJoinPayload {
  playerName: string;
  roomName?: string;
  searchForRoom?: boolean;
}

export interface RoomRejoinPayload {
  roomId: string;
  playerId: string;
}

export interface RoomSetInviteOnlyPayload {
  inviteOnly: boolean;
}

/** Broadcast for `room:updated` — see the enum entry for why this never carries a `player` field. */
export interface RoomUpdatedResponse {
  room: Room;
}

/** One rival's active decision, narrated for their "annual report" — see `game:getAnnualReport`. */
export interface AnnualReportEntry {
  decisionName: string;
  text: string;   // AI-generated (or static-fallback) flavor text — never the real numbers
  year: number;   // deployedYear + 1
}

export interface ChatMessagePayload {
  message: string;
}

export interface ChatMessageBroadcast {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: string;
}

export interface GameReadyPayload {
  ready: boolean;
}

export interface GameReadyUpdateResponse {
  readyPlayerIds: string[];
  activePlayerCount: number;
}
```

### Zustand State Stores

The client uses Zustand for lightweight, TypeScript-safe state management:

#### `gameStore.ts`

Manages all game-related state including room state, player data, phase tracking, and timer.

| Method | Description |
|--------|-------------|
| `updateRoom(room)` | Replace the current room state |
| `updatePlayer(player)` | Replace the current player object with updated DB-generated ID |
| `kickPlayer(playerId)` | Remove a player from the room — despite the name, just "remove from roster"; also reused for the `room:playerLeft` (grace-period-expired) case |
| `addPlayer(player)` | Add a new player to the room when they join dynamically |
| `markPlayerBankrupt(playerId)` | Mark a player as bankrupt and remove them from active play |
| `updatePhase(data)` | Update the current game phase, round, and timer |
| `updateTimer(timeLeft)` | Update the countdown timer value |
| `handleTurnResolved(data)` | Replace `turnResults` with the latest `turn:resolved` payload |
| `clearTurnResults()` | Clear `turnResults` |
| `applyDigDeeperResult(playerId, data)` | Immutably patches just the requesting player's cash + the matching `incomingAttacks` entry inside `turnResults` — the instant, out-of-band response to `game:digDeeper`, applied without waiting for the next turn |
| `applyFileLawsuitResult(playerId, newCash)` | Immutably patches just the requesting player's cash inside `turnResults` — the instant, out-of-band response to `game:fileLawsuit`, same "don't wait for the next turn" reasoning as `applyDigDeeperResult` |
| `setAnnualReportLoading(rivalPlayerId)` | Marks one rival's AI annual report as in-flight, so `RivalFullReportView` doesn't fire a duplicate `game:getAnnualReport` while waiting |
| `applyAnnualReportResult(rivalPlayerId, entries)` | Caches the AI-narrated entries for one rival, keyed by id — the response to `game:getAnnualReport` |
| `setGameDeck(data)` | Store the decision library + per-turn limits |
| `setGameOver(data)` | Set game over state with winner and standings |
| `clearGameOver()` | Clear game over state |
| `setError(error)` | Set error state |
| `setNotification(message)` | Set UI notification message |
| `setCompanies(companies)` | Update company data for all players |
| `setIsRejoining(isRejoining)` | Toggle the "attempting to resume a saved session" flag — gates `App.tsx`'s first paint so Matchmaking doesn't flash before a `room:rejoin` attempt resolves |
| `resetSession()` | Wipes room/player/in-game state back to a fresh landing-page state — used when a player is kicked, or acknowledges the "lost" takeover via **Return to Start** |
| `setSelfEliminationReason(reason)` | Sets `selfElimination` (`'bankrupt' \| 'forfeit'`) — checked by `App.tsx` ahead of the normal phase switch to show the full-screen "lost" takeover regardless of what phase the room is actually in. Set from `player:bankrupt` for the current player's own id (`'bankrupt'`), then upgraded to `'forfeit'` if a `game:left` ack follows. |

#### `socketStore.ts`

Manages the Socket.IO connection and event routing, plus session persistence for
reconnection (see *Reconnection & Session Resume* below):

| Method | Description |
|--------|-------------|
| `send(event, payload)` | Emit a socket event to the server |
| `on(event, handler)` | Subscribe to a server event, returns unsubscribe function |
| `disconnect()` | Close the socket connection |
| `returnToLanding()` | Clears the saved session and calls `gameStore.resetSession()` — the shared "acknowledge and go back to the landing page" step behind both a kick and the "lost" takeover's **Return to Start** button |

**Key event handlers:**
- `connect` → If a session (`{ roomId, playerId }`) is saved in `localStorage`, sets
  `isRejoining` and emits `room:rejoin`. Fires on the first connect *and* on every
  Socket.IO-driven auto-reconnect after a transient drop — so a brief network blip with
  the tab still open self-heals here too, not just a full page reload.
- `room:joined` → Calls `gameStore.updateRoom()`/`updatePlayer()`, and saves the session
  to `localStorage` — covers both a fresh join and a successful rejoin, since the server
  reuses this same event for both
- `room:playerJoined` → Calls `gameStore.addPlayer()` with deduplication guard
- `room:playerKicked` → For *my own* id: clears the saved session and calls
  `gameStore.resetSession()` plus `setNotification(...)`, landing back on the plain
  landing page — not just a roster removal. For anyone else, calls `gameStore.kickPlayer()`
  (roster removal only).
- `room:playerLeft` → Calls `gameStore.kickPlayer()` (same roster-removal logic) plus a
  distinguishing notification ("…connection timed out")
- `room:updated` → Calls `gameStore.updateRoom()`, then re-derives *my own* player object
  by matching my own id inside the fresh roster and calling `updatePlayer()` with that
  entry — not a shared `player` field from the payload (there isn't one). This is the fix
  for a real bug: broadcasting one shared player object to the whole room after a kick
  used to silently overwrite every other client's own identity with the kicking host's.
  Also how a newly-promoted host's own `isHost` flag reaches their own client, not just
  how others see them.
- `room:left` → Clears the saved session and calls `gameStore.resetSession()` plus
  `setNotification('You left the room.')` — the ack for my own voluntary `room:leave`
- `phase:changed` → Calls `gameStore.updatePhase()`
- `timer:update` → Calls `gameStore.updateTimer()`
- `player:bankrupt` → Calls `gameStore.markPlayerBankrupt()`; for *my own* id, also calls
  `setSelfEliminationReason('bankrupt')` — see *Leave Game* above; for anyone else's,
  calls `enqueueBankruptcyEvent()` instead — see *Bankruptcy & Game Over* below
- `game:over` → Calls `gameStore.setGameOver()`; clears the saved session (nothing left
  to reconnect to)
- `game:digDeeperResult` → Calls `gameStore.applyDigDeeperResult()`
- `game:fileLawsuitResult` → Calls `gameStore.applyFileLawsuitResult()`
- `game:annualReportResult` → Calls `gameStore.applyAnnualReportResult()`
- `game:left` → Calls `setSelfEliminationReason('forfeit')` — upgrades the reason set by
  the `player:bankrupt` handler moments earlier; does **not** itself reset the session,
  that's deferred to the takeover screen's **Return to Start** button
- `error` → Calls `gameStore.setError()`; a `REJOIN_FAILED` code additionally clears the
  saved session and `isRejoining`, so a stale/expired session self-heals into the normal
  landing page

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+ and npm 9+
- **Docker** and **Docker Compose** (for containerized deployment)

### Option 1: Local Development (Recommended for Development)

```bash
# 1. Clone and enter the project
cd suetheirasses

# 2. Start PostgreSQL via Docker
docker-compose up -d postgres

# 3. Install all dependencies (monorepo workspaces)
npm install

# 4. Set up the database
cp server/.env.example server/.env
npm run db:generate
npm run db:migrate
npm run db:seed   # required — the server loads the decision library + game config
                  # from the database at startup, not from JSON directly (see
                  # "Decisions & Game Config" below); it won't start without this

# 5. Start development servers (client + server with hot reload)
npm run dev
```

The application will be available at:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001

### Option 2: Full Docker Deployment

```bash
# 1. Clone and enter the project
cd suetheirasses

# 2. Build and start all services (PostgreSQL, server, client)
docker-compose up -d --build

# 3. Apply migrations + seed the decision library/game config against the
# containerized Postgres — required once (the server container doesn't run
# migrations/seed automatically on boot): from server/, pointed at the exposed
# Postgres port, e.g.
#   DATABASE_URL=postgresql://stita:stita_password@localhost:5432/stita_db \
#     npx prisma migrate deploy && npm run db:seed
#
# The application will be available at:
# - Frontend: http://localhost:80
# - Backend API: http://localhost:3001
```

### Local LLM (optional — AI-narrated annual report text)

The rival "Full Filing" annual report uses a local LLM (see *AI-Narrated Annual
Reports* below) instead of the old fixed flavor text. This is fully optional — the
game works identically without it, falling back to the original static text.

```bash
# 1. Download the model (not committed to the repo — ~1.1GB)
mkdir -p models
# Place Qwen3-1.7B-Q4_K_M.gguf in ./models/ — e.g. from https://huggingface.co/Qwen/Qwen3-1.7B-GGUF

# 2. Start the llama.cpp server
docker-compose up -d llm

# The server (LLM_URL) checks http://localhost:8080 by default in local dev;
# in the full Docker stack it resolves to the `llm` service automatically.
```

### Admin Portal (optional — room monitoring)

`/admin` (see *Admin Portal* below) is disabled by default — set `ADMIN_TOKEN` in
`server/.env` (local dev) or in your shell/root `.env` before `docker-compose up`
(it's read via `${ADMIN_TOKEN}` in `docker-compose.yml`). Unset = the admin API
returns 503 for every request; this never affects the game itself.

### Rebuilding and Restarting

```bash
# Rebuild Docker containers (after code changes)
docker-compose up -d --build

# Rebuild only a specific service
docker-compose up -d --build server
docker-compose up -d --build client

# Restart all services (without rebuilding)
docker-compose restart

# Stop all Docker services
docker-compose down

# Stop and remove volumes (wipes database!)
docker-compose down -v
```

### Database Management

```bash
# Generate Prisma client (after schema changes)
npm run db:generate

# Run pending migrations
npm run db:migrate

# Reset database (drops and recreates all tables)
npx prisma migrate reset

# Open Prisma Studio (database GUI)
npm run db:studio

# Seed the decision library + game config from server/src/data/*.json — required
# after a fresh migrate/reset, since GameEngine now loads both from the database,
# not from the JSON files directly (see "Decisions & Game Config" below). Idempotent.
npm run db:seed
```

### Individual Service Commands

```bash
# Start only the backend server
npm run dev:server

# Start only the frontend client
npm run dev:client

# Build for production
npm run build

# Build only client or server
npm run build:client
npm run build:server
```

### Environment Variables

**Server** (`server/.env` — copy from `server/.env.example`):

```env
DATABASE_URL="postgresql://stita:stita_password@localhost:5432/stita_db"
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:5173
LLM_URL=http://localhost:8080   # optional — see "Local LLM" below; falls back to static text if unset/unreachable
ADMIN_TOKEN=                    # optional — enables /admin (see "Admin Portal"); unset disables the admin API
```

**Client** (`client/.env` — copy from `client/.env.example`):

```env
VITE_SERVER_URL=http://localhost:3001
```

> **Note**: When running via Docker Compose, environment variables are injected automatically. The client uses `http://server:3001` internally, and the server uses the PostgreSQL service name `postgres`.

---

## 🎯 Game Mechanics

Full detail lives in `definitionDocumentation/FORMULAS.md` (every formula and the exact
per-turn calculation order) and the `Decision` table's data (seeded from, and originally
mirrored by, `server/src/data/game_engine.json` — see *Decisions & Game Config* below).
This section is a summary of what the server's `engine/` actually does.

### Business Decisions (Game Loop)

The instant the host starts the game, every player lands straight in the game room
showing their real starting position (cash, equity, revenue, stock value) — `GameLoop`
computes this via `getInitialSnapshot`, the same formula pipeline as a real turn but with
zero decisions applied and nothing persisted, so there's no blank "waiting" screen for
the first round's timer.

The client renders the actual Decision Deck from `game:deck` — filterable by level
(Strategic/Operational) and nature (Traditional/Grey Area/Dirty), one card per decision
with its description, an **EFFECTS** panel, and a DEPLOY button. The effects panel
answers "what does this do, when does it start, how long does it last": a maturity
badge (`INSTANT` or `MATURES IN Nt`, from the max explicit year key across the
decision's impact schedules, FORMULAS §9) plus a per-field timeline like
`Yr 1: -$100,000 → Yr 2: -$100,000 → Ongoing: +40%`, built client-side from the raw
`impacts` schedules (no server round-trip). `target.*` fields are labeled `Target's …`
to make clear they hit the chosen opponent, not the decision-maker. Clicking DEPLOY
(target picker first, for `requiresTarget` decisions like Buy Shares) queues it locally
and re-sends the player's full pending selection via `game:submitDecisions` on every
change — the server treats each submission as a full replacement, not an increment. The
deck mirrors `DecisionEngine.canDeploy`'s exclusion rules client-side (same decision
maturing, forward/reverse `excludes`) so a card is visibly greyed out with a reason
rather than letting a player queue a move the server would reject.

Each 120s GAME_PHASE round, every player submits up to 1 strategic + 2 operational
decision from a shared library of 45 decisions — spanning `Traditional`, `Grey Area`,
and `Dirty` in nature. When the timer expires, `GameLoop` resolves the turn for all
players simultaneously:

1. Apply active decisions' impacts (additive relative stacking across matured instances)
2. Depreciation ledger (genuine asset purchases only)
3. Competitiveness & market share (zero-sum across all players)
4. Volume, capped by installed capacity
5. P&L (revenue, COGS, EBITDA, tax, net profit)
6. Lawsuits filed this turn resolve (or await trial) — see *Lawsuits* below
7. Balance sheet & cash flow (one unified formula, FORMULAS §5)
8. Bankruptcy check
9. Global Risk Gauge

Results broadcast via `turn:resolved`. `legalExposure` from open cases lowers a player's
own stock value and increases how likely every case against them is to succeed — a
deliberate snowball effect that punishes concentrated risk-taking (FORMULAS §6, §13).

### Lawsuits — deliberate filing, not automatic

> **Deviation from FORMULAS.md by explicit product decision:** the spec's literal design
> (§6/§13) has *every* decision with `legalRisks` automatically generate a case against
> the decision-maker from *every other player* the instant it's deployed. That's been
> replaced with deliberate filing — a case only exists if a player actively chooses to
> sue over it. If you want to restore the spec-literal automatic behavior, see
> `GameLoop`'s Step 8 and `LegalEngine.fileLawsuit`.

There is no fixed catalog of lawsuit grounds. `SueModal` derives the grounds you can sue
a given target over live, from that target's *actual* `activeDecisions` cross-referenced
against `game:deck`'s `legalRisks` — you can only cite something the target really did.
Filing queues `{ targetId, decisionName, groundName }` into the same pending state as
deployed decisions (up to `gameSettings.maxLawsuitsPerPlayerPerTurn`, 3 by default) and
submits it via `game:submitDecisions`. At turn resolution, `LegalEngine.fileLawsuit`
re-validates that the target still has that decision active, then prices the case using
`getScheduleValue` against the legal risk's `probability` schedule at the target
decision's `elapsedYears` — the longer a risky decision has been live, the higher the
probability tier, exactly like a normal impact schedule (FORMULAS §6, §9).

Filing also costs a flat `gameSettings.lawsuitFilingCost` ($15,000 by default), shown right
on the **SUE THEIR ASSES** button and deducted **instantly** the moment the "File" button
is clicked in `SueModal` — a `game:fileLawsuit` round trip, same "instant, outside turn
resolution" pattern as Dig Deeper, not something that waits for the round timer. The case
itself is still only created/validated later, at the next turn resolution, exactly as
described above — the fee purely gates the *act of filing*. It is **not refunded** if that
later validation rejects the case (e.g. the target no longer has the cited decision
deployed by the time the turn resolves), and is capped at
`gameSettings.maxLawsuitsPerPlayerPerTurn` same as the filings themselves, so a player can't
rack up fee charges for lawsuits that would be silently dropped at resolution anyway.

`target.*` impact fields (FORMULAS §0 — the 9 fields like `target.cash`, `target.outrage`
that route a decision's effect to the chosen target rather than the decision-maker, used
by Buy Shares/Sell Shares and the offensive-sabotage decisions) route to the chosen
opponent every turn the decision stays active, applied in `resolveTurn`'s Step 2 right
alongside the decision's own self-effects (`calcEngine.extractTargetImpacts`/
`applyTargetImpacts`, `DecisionEngine.getTargetImpacts`, `GameLoop.buildIncomingAttacks`)
— see *Attack Awareness & Dig Deeper* below for how a targeted player finds out.

A filed case starts at `status: 'negotiating'` — a richer addition than FORMULAS.md,
which doesn't model a negotiation phase at all (§6 just resolves a case via a probability
draw "this turn"). The lawsuit card shows an offer history, a counter-offer slider, and
ACCEPT/COURT buttons for it, but as of now none of them do anything — there's no server
action wired up behind any of them yet (tracked separately). Without a way out of
`'negotiating'`, a case between two solvent players used to sit there forever, never
reaching a verdict — the *only* other exit was the bankruptcy waterfall (§16) cancelling
or settling it if a party fell. **Negotiation timeout** closes that gap: each case tracks
`turnsNegotiating`, incremented once per turn it's still negotiating (a case filed this
turn doesn't get incremented in the same turn it's created); once that hits
`gameSettings.negotiationPeriodTurns` (2 by default), the case is forced to
`awaiting_trial` and resolves via the existing trial logic in that same turn's
resolution — the client never observes an intermediate `awaiting_trial` snapshot for a
case that timed out this way, it just jumps from its last negotiating turn straight to a
verdict. The lawsuit card shows a live countdown ("Goes to trial automatically in N more
turn(s)") for exactly this reason, so the mechanic isn't invisible to players.

### Attack Awareness & Dig Deeper

Offensive decisions (Bot Attack, Social Astroturf, and the rest of the `target.*`-bearing
library) used to land invisibly — the target's stats moved with no signal pointing at the
cause. Every player who currently has an active `target.*` decision aimed at them gets an
`incomingAttacks` entry on their own `PlayerTurnResult`, computed fresh by
`GameLoop.buildIncomingAttacks` each turn — this is server-gated, not just UI-hidden: the
attacker's identity is never sent to the client below whatever tier that player has
personally unlocked, so there's nothing to read via devtools before paying for it.

The client shows a hint next to the SUE THEIR ASSES button — *"Somebody did something to
you"* — with a **🔍 Dig Deeper** button. Each click emits `game:digDeeper` and costs
`gameSettings.digDeeperCost` ($10,000 by default), deducted **instantly** via
`GameEngine.digDeeper`/`GameLoop.digDeeper` — a genuinely out-of-band mutation, not routed
through the normal turn-resolution cycle (see CLAUDE.md's *"Two exceptions to
'everything happens in resolveTurn'"*). Investigation unlocks progressively, tracked per
attack instance in `Company.engineState.investigations`:

1. **Who** — the attacker's id and name
2. **What** — the decision name, description, and a human-readable effect summary (e.g.
   *"-20% Capacity Utilization"*), via `decisionEngine.summarizeTargetImpacts`
3. **Suggested lawsuit + estimated odds** — the strongest `legalRisks` ground against that
   decision, picked by `decisionEngine.pickBestGround` using the *same* adjusted-probability
   formula as real trial resolution (FORMULAS §6) evaluated against the attacker's current
   scrutiny/legal exposure — an estimate; the real probability is still recomputed fresh at
   trial time. A **SUE NOW** button at this tier pre-fills `SueModal` with the right target
   and ground (still requires the player's own QUEUE LAWSUIT confirmation).

Once fully investigated (tier 3), the button disables — no further charge. The button is
also disabled client-side whenever cash is below `digDeeperCost`; the server enforces the
same rule independently, so it's never possible to Dig Deeper into bankruptcy.

### Ready-Up (Instant Turn Resolution)

The 120s per-round timer doesn't have to run out — a separate **Turn** box in the header
(distinct from the Threat Level bar, which used to carry the countdown itself) shows the
round number, the countdown, and a **Ready** toggle (`READY (x/y)` → `✓ READY (x/y)`,
`x`/`y` = ready count / active-player count). The instant every active (non-bankrupt)
player is ready, `GameEngine` clears the timer and calls `resolveGameTurn` immediately
instead of waiting out the rest of it — `GameEngine.toggleReady` tracks ready state as a
`Set<playerId>` per room (`RoomState.readyPlayerIds`), reset to empty at the start of
every new round (`game:readyUpdate` broadcasts `{ readyPlayerIds: [], activePlayerCount }`
right alongside the round's `phase:changed`) and when the game first starts. Readiness is
purely a timing trigger, not a turn-resolution mutation — it never changes what a turn
computes, only when it fires. A player forfeiting (see *Leave Game* below) also drops
their own ready flag and re-checks the condition, since their departure can be the thing
that makes everyone *remaining* ready.

### Reconnection & Session Resume

A raw socket disconnect — a network hiccup, an accidental browser back button, a page
refresh — never deletes a player anymore. `GameEngine.markPlayerDisconnected` clears their
live socket association but leaves them in the room; their still-open decisions/lawsuits
keep resolving normally on schedule, exactly like an AFK player who simply didn't submit
that turn. They have `RECONNECT_GRACE_PERIOD_MS` (60s by default) to reconnect before the
same heartbeat interval that sweeps stale empty rooms (`STALE_ROOM_THRESHOLD`) also calls
`finalizePlayerRemoval` — the original immediate-delete behavior, just deferred. Because
the player is never removed from the room during the grace window, **the rest of the room
is never told they left** — no broadcast fires unless the grace period actually expires
(at which point `room:playerLeft` fires, distinct from a real kick).

On the client, `socketStore.ts` persists `{ roomId, playerId }` to `localStorage` on every
successful join, and attempts `room:rejoin` on every socket `connect` event — which fires
on first load *and* on every Socket.IO-driven auto-reconnect, so a brief network blip with
the tab still open self-heals without a page reload too. `App.tsx` shows a "Reconnecting…"
state while that attempt is in flight, and `GamePhase.tsx` redirects to matchmaking if it
ever lands with a genuinely empty store and no rejoin attempt underway (closing off what
was previously an infinite "Waiting for game data…" spinner on a raw refresh with no saved
session). A failed rejoin (`REJOIN_FAILED` — expired grace period, ended game, bogus
session) self-heals into the normal matchmaking flow by clearing the stale saved session.

### Leave Game (Voluntary Forfeit)

A red **Leave Game** button in the GAME_PHASE header (confirmation modal first — it's
irreversible) emits `game:leave`. `GameEngine.forfeitGame` marks the requesting player
bankrupt immediately — same DB write and `player:bankrupt` broadcast shape as a natural
cash<0 elimination — and, if that leaves at most one active player, ends the game exactly
like a normal turn's post-resolution win check would. The game continues uninterrupted for
everyone else.

The forfeiting player doesn't just get redirected — `App.tsx` shows a full-screen "lost"
takeover (`lost.png`, "YOU FORFEITED") ahead of whatever phase the room is actually in, so
even if their own forfeit just ended the game, they see this instead of the winner's
GameOver screen. A **Return to Start** button on that screen is what actually resets the
session and sends them back to the landing page — the takeover itself is just an
acknowledgement step, not an auto-redirect. The identical takeover (`lost.png`, "YOU'VE
GONE BANKRUPT") also covers natural cash<0 elimination, which previously had no client-side
handling at all — both paths set the same `gameStore.selfElimination` flag from
`player:bankrupt`/`game:left`, just with a different `reason`.

### AI-Narrated Annual Reports

A rival's "Full Filing" report used to show one of 3-4 fixed, hand-written
`competitorsView` flavor sentences per decision (cycled by `elapsedYears % length`),
sourced straight from `game_engine.json`. That text is now generated by a local LLM —
a `llama.cpp` server (the `llm` service in `docker-compose.yml`, running Qwen3-1.7B,
model weights mounted read-only from `./models/`, not committed to the repo) — so the
narration varies year to year instead of repeating the same handful of lines forever.

Opening a rival's Full Filing modal emits `game:getAnnualReport` with just their player
id; `GameEngine.getAnnualReport` re-derives what to narrate server-side from that
player's own `Company.engineState` (`GameLoop.getActiveDecisionSummaries` — a pure,
read-only lookup, never trusting anything about the rival the requesting client sent),
then asks `services/llmService.ts` to narrate each active decision via the local
model's OpenAI-compatible `/v1/chat/completions` endpoint. Responses are cached
in-process per `decisionName#elapsedYears` (not per-player — the same decision at the
same age gets the same blurb for every viewer), so opening the same rival's report
twice, or a second player opening it, doesn't re-hit the model.

This is entirely best-effort: the client renders the static `competitorsView` text
immediately and unconditionally (so the modal is never blank or stuck loading), then
swaps in the AI-generated version — tagged **✨ AI-generated** — if and when
`game:annualReportResult` arrives. `llmService` itself catches every failure mode
(unreachable host, non-2xx, request timeout, empty/unparseable response) and falls
back to that same static text before it ever reaches the socket layer, so the whole
feature is fully optional — the game plays identically whether or not the `llm`
container is running. See CLAUDE.md's *"Local LLM for narrated annual report text"*
for the architectural rationale.

### KPI History & Prediction

Every KPI card (CASH, EQUITY, REVENUE, STOCK VALUE, THREAT LEVEL) and every individual
tracked-field row inside their breakdown views (e.g. Operating expenses/Staff costs/Tax
inside the Cash Waterfall, Volume/Price inside Revenue, each balance-sheet line inside
Equity, each factor inside Shares) is clickable — it opens a graph combining this
player's own actual history with a 3-turn-ahead prediction, via `game:getKpiHistory`
(no payload, always "my own data") → `game:kpiHistoryResult`. History is one
`KpiSnapshot` DB row per player per round, written alongside every turn resolution.
Purely computed intermediate figures in the breakdown views (COGS, gross profit,
EBITDA, EBIT, profit before tax, net profit, market equity, net demand) aren't
clickable — they're derived-of-derived inside the view itself, not a single tracked
field anywhere.

The 3-turn prediction is computed by the real game engine, not an approximation — it
literally re-runs `GameLoop.resolveTurn` forward, using the exact same competitiveness/
market-share/P&L/balance-sheet/depreciation math a real turn does. By explicit product
decision, it **assumes only this player's own decisions and their causes continue
applying — it does not take other players' decisions into account**: every rival is
held frozen at their current snapshot for the whole predicted window (no new rival
decisions, attacks, or lawsuits), while the player's own already-active decisions keep
maturing and scheduling normally. The graph shows this as a dashed continuation of the
solid actual-history line, with a caption spelling out the assumption. If the
projection shows the player going bankrupt within the window, the dashed line simply
stops at that round instead of showing further (meaningless) points. See CLAUDE.md's
*"KPI history + prediction graphs"* section for how the prediction is implemented
(reusing `resolveTurn` itself, sandboxed) without forking or approximating the engine.

### Admin Portal

`/admin` is a real, independent URL — the only one in this app that isn't rendered off
`currentPhase` state (see CLAUDE.md's *"Client: no path-based routing for game phases"*).
It has two parts:

- **Room monitoring** — every in-memory room in every phase (not just WAITING/joinable
  ones, unlike Quick Play's `room:list`), each with its players' host/bankrupt/connected
  status. Polled every 5 seconds while open.
- **Decision library + game config editing** — the full 45-decision list and the
  `GameConfig` (`gameSettings`/`playerStartingValues`/`adminVariables`) are edited as raw
  JSON in a textarea (client-validated for parseable JSON, then server-validated against
  a Zod schema before being written) rather than a structured form per field — the
  decision library's `impacts` shape is an open-ended nested record, so a bespoke form
  builder isn't worth it over textarea + real validation. Unlike the rooms table, these
  are fetched once on login (and again right after a successful save), not polled — so
  an in-progress edit can never be silently overwritten by a background refresh.
- **Formulas editing** — the 23 pure-math formulas from FORMULAS.md §2-§7 (see
  *Formulas* below), each shown as its description plus a single-line text input for
  the expression (not a JSON textarea — these are one-line math expressions, not nested
  objects). A parse or unknown-variable error from the server is surfaced inline on the
  row that failed. Same fetch-once-on-auth-plus-after-save pattern as the other two tabs.

The decision library, game config, and formulas are all **stored in Postgres, not static
JSON** (see *Decisions & Game Config* and *Formulas* below) — every save here takes
effect on the very next turn resolved anywhere in the game, no restart required. Deleting
a decision that's currently deployed in a live game is rejected (409) rather than allowed
to crash the next turn resolution for whoever has it active; formulas can't be deleted at
all (see below), only retuned.

Access is gated by a single shared-secret token — set `ADMIN_TOKEN` in `server/.env` (no
default; unset disables the admin API entirely, returning 503 rather than accepting any
request). `AdminPortal.tsx` prompts for the token at runtime and keeps it in
`sessionStorage`, sending it as the `x-admin-token` header on every request — it is
**never** embedded in the client bundle as a `VITE_*` env var, since those are public in
the built JS. There's no broader auth system in this app (see *Reconnection & Session
Resume* above for the same unauthenticated-id-pair trust model elsewhere), so this is
deliberately the simplest thing that works: one token, no users, no expiry.

### Decisions & Game Config (database-backed)

The 45-decision library and `GameConfig` used to be static JSON files
(`server/src/data/game_engine.json`/`game_config.json`) loaded once at server startup.
They're now rows in Postgres (`Decision`, `GameConfigRow`) — authoritative at runtime,
editable live from `/admin` above, with changes taking effect on the next turn resolved
(no restart). The JSON files still exist on disk, repurposed as the **versioned seed
source** for `npm run db:seed` (see `prisma/seed.ts`) — useful for `git diff`-able review
of balance changes and as the disaster-recovery reset path
(`npx prisma migrate reset && npm run db:seed` restores the default library exactly), but
editing them directly has no effect on a running server.

`GameEngine.loadGameData()` reads both tables once at startup (awaited before the server
starts accepting connections); every admin write calls the same
`GameLoop.loadDecisions()`/`updateConfig()` used there to live-reload the in-memory copy
`GameLoop` actually resolves turns against. Deleting a decision is blocked while it's
currently deployed by any non-bankrupt player, anywhere — several places in
`GameLoop.resolveTurn` assume an active decision's definition always exists, so removing
one still in use would otherwise crash the next turn resolution for whoever has it
deployed.

### Formulas (database-backed)

`FORMULAS.md` §2-§7 — the 23 pure, scalar, named-input formulas that drive competitiveness
and market share, volume, P&L, balance sheet, legal-risk probability, and the risk gauge
(`competitiveness`, `revenue`, `netProfit`, `riskGauge`, etc.) — are rows in Postgres
(`Formula`: `key`/`expression`/`description`), editable live from `/admin`'s Formulas tab,
the same live-reload-no-restart story as decisions/config above. Everything else in
FORMULAS.md — the per-turn execution order, the depreciation ledger, decision
maturity/exclusion locking, the bankruptcy waterfall, simultaneous-purchase FIFO
tie-breaking — is control flow and multi-player ordering, not tunable math, and stays as
TypeScript permanently; it was never a candidate for this.

Expressions are parsed and evaluated by `formulaEngine.ts`, a small hand-rolled
recursive-descent parser/evaluator — **deliberately not `eval`/`new Function`/`vm`**,
since an admin-editable string reaching any of those would be arbitrary code execution
behind a single shared token, a categorically worse risk than a math typo. The grammar is
fixed and tiny: number literals, identifiers, `+ - * /`, unary `-`, parentheses, and
exactly two whitelisted calls, `MIN`/`MAX` — no member access, no assignment, no string
literals, no arbitrary function calls, so there's no path from a formula string to
anything beyond that AST. `calcEngine.ts`'s 7 exported functions each take a `FormulaSet`
(`Map<string, CompiledFormula>`) and call `evalNamed(formulas, 'key', context)` instead of
inline arithmetic — a mechanical refactor, not a rebalancing; the seeded expressions
(`defaultFormulas.ts`, shared by `prisma/seed.ts` and the engine test fixtures) match the
old hardcoded behavior exactly.

**The formula key set is fixed — no create/delete via `/admin`, only `PUT`.** Each of the
23 keys is referenced by name at a specific `calcEngine.ts` call site `GameLoop`
hard-depends on; unlike decision deletion, there's no way to make removing one safe, so
the option doesn't exist. Every write is validated twice before it reaches `GameLoop`: a
real syntax parse (`parseFormula`) and a fixed per-key variable whitelist
(`FORMULA_VARIABLES` in `validation/schemas.ts`) — an expression that parses fine but
references a variable the call site never supplies would otherwise throw mid-turn, for
every active game, the next time it's evaluated.

### Bankruptcy & Game Over (Aftermath)

A player is eliminated the instant their cash goes below $0 on any turn — strictly
`cash < 0`, no debt-based rule. When a player falls, their still-unresolved lawsuits
(as both plaintiff and defendant) lapse; cases against them are paid out from a pool of
that turn's positive income-side cash flow, oldest filing first, until the pool runs out
(FORMULAS §16). The game continues, looping GAME_PHASE rounds, until only one player
remains — there is no fixed round limit and no score-based win condition. The eliminated
player themselves sees the "lost" takeover described in *Leave Game* above, regardless of
whether they left voluntarily or actually ran out of cash. Everyone else still in the game
gets a matching full-screen "X HAS GONE BANKRUPT" takeover (same `lost.png` art), queued in
`gameStore.bankruptcyEvents` and rendered by `App.tsx`'s `BankruptcyOverlay` ahead of the
`currentPhase` switch — so it's shown even when this same elimination ends the game (the
`player:bankrupt` and `game:over`/`phase:changed` broadcasts arrive back-to-back from the
same turn resolution; without the overlay taking priority, the Game Over screen would
render immediately and the message would never be seen).

A bankrupted player's Company row must have its real (negative) `cash` persisted, not just
their `Player.bankrupt` flag — `GameLoop.resolveTurn` excludes bankrupted players from
`companyUpdates` (their engine state is done being touched), so `BankruptedPlayer.finalCash`
carries their actual balance at elimination for `GameEngine` to write to the DB alongside
the `bankrupt: true` flag. Skipping this left a bankrupted player's `cash` column frozen at
whatever positive value it had from their last still-active turn — including on the Game
Over / Final Standings screen, which read the DB straight through `buildGameOverPayload`.

### Post-Turn Info Windows (sued / lawsuit verdict / turn change)

Three events queue up a dismissible full-image modal after a turn resolves: getting
sued, one of your own lawsuits reaching a verdict, and the round simply advancing.
They're queued rather than each having an independent modal, specifically so a turn
that both sues you *and* advances the round doesn't pop two modals on top of each
other — a single `Modal` renders whatever's at the front of `GamePhase.tsx`'s
`eventQueue` (`PostTurnEvent[]`), and **Got it** pops the front to reveal whatever's
next, one at a time.

- **Sued** (`sued.png`) — `detectNewlySuedCases` diffs this turn's legal cases against
  last turn's to find cases newly filed against the current player (by id, so an
  existing case is never re-reported). Shows the plaintiff, decision, ground, and
  stakes for every newly-filed case that turn.
- **Lawsuit verdict** (`lawsuit-won.png` / `lawsuit-lost.png`) — `detectNewlyResolvedCases`
  finds cases *I'm a party to* (plaintiff or defendant) that just reached a trial
  verdict (`status: 'resolved'`, `verdict: 'won' | 'lost'` — not `'settled'`/`'cancelled'`,
  the bankruptcy-waterfall outcomes, which aren't a trial result and don't match the
  "gavel drop" imagery). The `won`/`lost` label is from **my own perspective**, not the
  raw `verdict` field — a defendant's case resolving `'lost'` (the plaintiff lost) is a
  *win* for that defendant, so the outcome is flipped for whichever role I actually
  have in the case, with role-aware copy for all four win/lose × plaintiff/defendant
  combinations ("You received $X from…", "You paid $X to…", etc.).
- **Turn change** (`turn-change.png`) — every round after the first (round 1 is the
  initial game start, not a change from anything) queues one of these the moment the
  round number advances.

Both detection functions are pure and unit-tested independently of any live turn cycle
(`GamePhase.utils.test.ts`), and the effect that drives them is guarded against React
18 StrictMode's dev-only double-invocation via a `useRef` — see CLAUDE.md for why that
guard exists and what broke before it did.

---

## 🔍 Validation & Game Engine

### Input Validation (Zod Schemas)

All client inputs are validated server-side using Zod schemas before processing:

| Schema | Field | Constraints |
|--------|-------|-------------|
| `roomJoinSchema` | `playerName` | Required, 1-30 characters |
| | `roomName` | Optional, max 40 characters (covers UUID v4 invite-link codes, 36 chars) |
| | `searchForRoom` | Optional boolean — triggers Quick Play search |
| `chatMessageSchema` | `message` | Required, 1-500 characters |
| `submitDecisionsSchema` | `strategic`, `operational` | Arrays of `{ name, targetId? }`, max 20 entries each — structural sanity only; the real per-turn limits come from `game_config.json` via `DecisionEngine.canDeploy` |
| | `lawsuits` | Array of `{ targetId, decisionName, groundName }`, max 10 entries — structural cap only; the real limit (`maxLawsuitsPerPlayerPerTurn`, 3) and the "target actually deployed this" check happen in `LegalEngine.fileLawsuit` |
| `digDeeperSchema` | `attackId` | Required, 1-100 characters |
| `gameReadySchema` | `ready` | Required boolean |
| `roomSetInviteOnlySchema` | `inviteOnly` | Required boolean |
| `roomRejoinSchema` | `roomId`, `playerId` | Both required, 1-50 characters — no separate auth token; the id pair itself is the bearer credential, same trust model as every other player id already used throughout the app (no passwords anywhere) |
| `annualReportRequestSchema` | `rivalPlayerId` | Required, 1-100 characters |
| `decisionDefinitionSchema` | `decision`, `level`, `description`, `nature`, `offensiveAction`, `excludes`, `impacts` | Structural — mirrors `DecisionDefinition`; doesn't re-verify formula semantics, same philosophy as `submitDecisionsSchema` |
| | `legalRisks`, `competitorsView`, `variableAmount`, `requiresTarget`, `legalRiskConditions`, `cashFlowCategory` | All optional |
| `gameConfigSchema` | `gameSettings`, `playerStartingValues`, `adminVariables` | Strict, field-by-field (not a loose record) — every field is a fixed, known number/boolean driving a real formula, so a typo'd key is rejected, not silently ignored |
| `formulaUpdateSchema` | `expression`, `description` | `expression` is further checked by `parseFormula` (real syntax, not a regex) and against `FORMULA_VARIABLES`'s per-key whitelist — an expression that parses fine but references a variable the target `calcEngine.ts` call site never supplies is rejected here, not at evaluation time mid-turn |

### Game Engine Architecture

Two layers split room/lobby/persistence/broadcast concerns from turn-resolution math:

**`GameEngine`** (`server/src/socket/gameEngine.ts`) — room and phase lifecycle, and the
only place that touches Prisma or Socket.IO for turn resolution:

| Method | Description |
|--------|-------------|
| `createRoom(player)` | Creates a new room with the player as founder (max 4 players) |
| `joinRoom(roomId, player)` | Joins an existing room; throws if full, the name is already taken, or the name is in `RoomState.kickedNames` for this room |
| `markPlayerDisconnected(socketId)` | A socket disconnected — clears the player's live socket association but keeps them in the room and makes no DB write, starting their reconnect grace-period clock |
| `finalizePlayerRemoval(roomId, playerId)` *(private)* | Actually removes a player whose grace period expired without a `room:rejoin` — the DB cleanup `markPlayerDisconnected`'s predecessor (`removePlayer`) used to do immediately; broadcasts `room:playerLeft`; cleans up the room if it's now empty, otherwise promotes a new host if needed and broadcasts `room:updated` |
| `leaveRoom(roomId, playerId)` | Voluntary lobby departure — WAITING phase only. Same DB cleanup as a kick (player actually removed, not just marked bankrupt — there's no game in progress to forfeit), then either deletes the room (last player) or promotes a new host if needed and broadcasts `room:updated` |
| `promoteNewHostIfNeeded(roomState)` | No-ops if the room already has a host or is empty; otherwise promotes the longest-tenured remaining player (`roomState.players` is a `Map`, so the first entry is genuinely the earliest joiner still present) and persists it. Called after every removal path — kick, `leaveRoom`, `finalizePlayerRemoval` — since any of them could have removed the host. |
| `buildRoomSnapshot(roomState)` | Rebuilds a `Room` object fresh from `roomState.players` every time. The one thing to never do instead: broadcast `roomState.room` directly — its embedded `players` array is populated once at creation and nothing keeps it in sync afterward, which was the root cause of a real bug (a kick's "sync the roster" broadcast silently overwriting other players' own identity — see the `room:updated` handler above for the fix). |
| `rejoinRoom(roomId, playerId, socketId)` | Re-associates an existing (still-within-grace-period) player with a new socket; returns data for the caller to emit (`room:joined` always, plus `game:deck`/cached `turn:resolved` or `game:over` depending on room phase) rather than doing the emitting itself, mirroring `digDeeper`'s pattern |
| `buildRoomJoinedPayload(roomState, player)` | Builds the `room:joined` payload shape (via `buildRoomSnapshot` plus the recipient's own `player`) — shared by the fresh-join and rejoin paths |
| `digDeeper(roomId, playerId, attackId)` | "Dig Deeper" — pay to reveal the next tier of intel on one incoming attack, instantly, outside the turn-resolution cycle. Loads active players, calls `GameLoop.digDeeper` (pure), and on success does the one Prisma write (`cash` *and* `variables`, since `GameLoop` reads cash from the `variables` JSONB, not the column) |
| `getAnnualReport(roomId, rivalPlayerId)` | AI-narrated "annual report" text for one rival, on demand — loads active players, calls `GameLoop.getActiveDecisionSummaries` (pure, re-derives from the rival's own `Company.engineState`), then asks `services/llmService.ts` to narrate each active decision (network I/O, cached, falls back to static `competitorsView` text on any failure). Read-only — no Prisma write |
| `advancePhase(roomId)` | Linear phase advance (WAITING → GAME_PHASE); race-condition guarded |
| `resolveGameTurn(roomId)` | Loads active players from the DB, calls `GameLoop.resolveTurn` (pure), then persists the returned `companyUpdates`/`bankruptedPlayers` and broadcasts `player:bankrupt`/`turn:resolved` — then either loops into another GAME_PHASE round (clearing `readyPlayerIds` and broadcasting `game:readyUpdate` for it) or, once one player remains, transitions to AFTERMATH and emits `game:over`. Also caches the broadcast result (`lastTurnResults`) for `rejoinRoom` to re-send. Called either by the round timer, or early — by the `game:ready`/`game:leave` socket handlers, once `toggleReady`/`forfeitGame` report every active player is ready — never from inside `toggleReady`/`forfeitGame` themselves; see *Ready-up triggers `resolveGameTurn` early* in CLAUDE.md for why. |
| `forfeitGame(roomId, playerId)` | Voluntary forfeit — GAME_PHASE only. Marks the player bankrupt (same DB write + `player:bankrupt` broadcast shape as a natural elimination) and, if that leaves at most one active player, ends the game exactly like `resolveGameTurn`'s post-turn win check. Otherwise drops the forfeiting player's ready flag and returns `triggerImmediateResolution: true` if that alone now satisfies "every remaining active player is ready" — the caller, not this method, calls `resolveGameTurn` for that, since this method still holds the `advancingRooms` lock (see below) until it returns. |
| `toggleReady(roomId, playerId, ready)` | Adds/removes one player from `RoomState.readyPlayerIds` (GAME_PHASE only, `null` for an unknown/bankrupt player or a non-GAME_PHASE room) and returns the updated `{ readyPlayerIds, activePlayerCount }` for the caller to broadcast and, if everyone active is now ready, immediately call `resolveGameTurn` with. |
| `submitDecisions(roomId, playerId, decisions)` | Forwards a validated `game:submitDecisions` payload to `GameLoop` |
| `broadcastInitialSnapshot(roomId, round)` | Called once, right when `room:startGame` fires — loads active players, calls `GameLoop.getInitialSnapshot` (pure), and broadcasts the result immediately so the game room renders without delay. Also caches it for `rejoinRoom`. |
| `broadcastRoomState(roomId, event, data)` | Broadcasts state to all players in a room |
| `getAdminRoomsSnapshot()` | Synchronous, in-memory-only monitoring snapshot of every room in every phase (unlike `room:list`'s WAITING-only, non-full-only Quick Play view), with every player's host/bankrupt/connected status. Backs `GET /api/admin/rooms`. |
| `loadGameData()` | Reads the `Decision`/`GameConfigRow` tables, constructs `GameLoop`, and loads the decision library — called once at startup (awaited before the server accepts connections) and never again; every later change goes through `upsertDecision`/`deleteDecision`/`updateGameConfigData` below instead |
| `getDecisionsSnapshot()` / `getGameConfigSnapshot()` | In-memory reads backing `GET /api/admin/decisions` / `GET /api/admin/config` |
| `upsertDecision(def, isNew)` | Create or update one decision — writes the DB row, then calls `GameLoop.loadDecisions()` again so the change is live for the next turn resolved anywhere. `isNew` picks create-must-not-exist vs. update-must-exist. |
| `deleteDecision(name)` | Deletes a decision — but only after `isDecisionInUse` confirms no non-bankrupt player anywhere currently has it deployed (`{ reason: 'in_use' }` otherwise); `GameLoop.resolveTurn` assumes an active decision's definition always exists, so this guard is load-bearing, not a nicety |
| `updateGameConfigData(config)` | Writes the new `GameConfig` to the DB, then calls `GameLoop.updateConfig()` to live-reload it |
| `getFormulasSnapshot()` | In-memory read backing `GET /api/admin/formulas` |
| `updateFormula(key, expression, description)` | Writes one formula row (404 if the key is unknown — no create), then calls `GameLoop.loadFormulas()` again so the change is live for the next turn resolved anywhere. Validation (syntax + variable whitelist) happens in `validateFormulaUpdate` before this is ever called. |
| `loadActiveCompanyPlayers(roomId)` *(private)* | Shared DB fetch (`player.findMany` with `company` included, `bankrupt: false`) feeding `resolveGameTurn`, `broadcastInitialSnapshot`, and `digDeeper` |
| `startHeartbeatCleanup()` *(private)* | One 10s `setInterval` sweeping two things: rooms empty for over `STALE_ROOM_THRESHOLD` (60s), and disconnected players past `RECONNECT_GRACE_PERIOD_MS` (60s) → `finalizePlayerRemoval`. Extend this interval for new periodic sweeps rather than adding a second one. |

**`GameLoop`** (`server/src/engine/gameLoop.ts`) — the authoritative turn-resolution
engine, loaded via `GameEngine.loadGameData()` (decisions/config now come from the
database, not JSON — see *Decisions & Game Config* above) and live-reloaded on every
admin edit. It is a **pure computation engine**: no Prisma, no Socket.IO, no I/O of any
kind — it takes plain player data in and returns plain result data out, so it can be
unit-tested and reasoned about without mocking a database or a socket server:

| Method | Description |
|--------|-------------|
| `loadDecisions(definitions)` | Loads the decision library into `DecisionEngine`/`LegalEngine` — safe to call again any time, replacing the in-memory maps outright, which is how admin decision edits take effect on the next turn with no restart |
| `updateConfig(config)` | Replaces `gameSettings`/`playerStartingValues`/`adminVariables` in place — same mechanism as `loadDecisions`, used both for the initial DB load and every later admin config edit |
| `loadFormulas(rows)` | Compiles each row's expression into a `FormulaSet` and replaces the in-memory set outright — same live-reload mechanism as `loadDecisions`/`updateConfig`, used for the initial DB load and every later admin formula edit. Every calc-engine call in `resolveTurn`/`getInitialSnapshot` reads from this set; it defaults to an empty `Map`, so this must be called before any turn resolves. |
| `submitDecisions(roomId, playerId, decisions)` | Buffers one player's choices for the in-flight turn |
| `resolveTurn(roomId, round, players: EngineDataInput[])` | Runs the full per-turn calculation (see *Business Decisions* above) and returns a `TurnResolutionOutcome`: the `turn:resolved` broadcast payload (`result`), the `Company` rows still-active players need persisted (`companyUpdates`), and the players eliminated this turn (`bankruptedPlayers`) — it does not write to the DB or emit anything itself |
| `getInitialSnapshot(roomId, round, players: EngineDataInput[])` | Same formula pipeline as `resolveTurn`, but with zero decisions and nothing persisted — returns the `TurnResolutionResult` preview directly; the caller broadcasts it |
| `digDeeper(playerId, attackId, players: EngineDataInput[])` | A lighter-weight sibling to `resolveTurn` — no market/P&L pipeline, just cash + engine state. Validates funds and investigation level, bumps the target attack's tier, and returns a `DigDeeperOutcome` (new cash, the revealed `IncomingAttackInfo`, and the engine state to persist) for the caller to write and emit; never runs on the turn timer |
| `getActiveDecisionSummaries(playerId, players: EngineDataInput[])` | Read-only lookup of one player's active decisions (name, description, deployed/elapsed years) for `GameEngine.getAnnualReport` to narrate — mutates nothing, returns `null` if the player isn't found |

`GameEngine` owns the full read → compute → persist → broadcast cycle: it loads each
active player's `Company.variables`/`engineState` from the DB into `EngineDataInput[]`,
calls the relevant `GameLoop` method, then writes back `companyUpdates` (`Company.update`)
and `bankruptedPlayers` (`Player.update({ bankrupt: true })`) and emits `player:bankrupt`
and `turn:resolved` in that order — mirroring exactly the order `GameLoop` used to persist
and broadcast internally, just performed by the caller instead.

**Room Lifecycle:**
1. Room created in database with `WAITING` status
2. Players join via socket; room loaded into in-memory `Map`
3. Host starts the game: `WAITING` → `GAME_PHASE`, round 1, 120s timer starts, the
   decision library broadcasts once (`game:deck`), and `broadcastInitialSnapshot`
   immediately sends everyone their starting position — players land straight in the
   game room with a real, deployable Decision Deck, not a blank loading screen
4. Every time the GAME_PHASE timer expires, `resolveGameTurn` resolves the round and
   either loops (`currentPhaseRound` + 1, new 120s timer) or ends the game (`AFTERMATH`)
5. A socket disconnecting doesn't remove its player — see *Reconnection & Session Resume*
   above — so "room empties" now means every player's reconnect grace period has expired,
   not just every socket being momentarily gone; once that's true, both in-memory state
   and the database record are cleaned up

**Concurrency Safety:**
- Phase advancement and turn resolution share a `Set<string>` lock (`advancingRooms`) to
  prevent two concurrent resolutions of the same room
- Room joins handle the "TOCTOU" (time-of-check-time-of-use) gap by catching `Room is full` errors and falling back to room creation

---

## 🧪 Testing

```bash
# Type-check all packages
npm run type-check

# Lint all packages
npm run lint

# Run backend unit tests (Vitest) — engine, calcEngine, decisionEngine, legalEngine,
# formulaEngine (parser/evaluator correctness + rejection of dangerous-looking input
# like __proto__/constructor/arbitrary calls), gameLoop (incl. a regression test that
# a lawsuit persisted into both the plaintiff's and defendant's own engineState
# doesn't get double-counted when reconstructed on a later turn, and a regression test
# that a case forced to trial by the negotiation timeout resolves in the same turn it
# crosses the threshold), gameEngine (incl. toggleReady, forfeitGame's ready-interaction,
# promoteNewHostIfNeeded, leaveRoom, buildRoomSnapshot, and joinRoom's kickedNames
# rejection), validation schemas, llmService, adminAuth middleware. No DB or live LLM
# required (mocked Prisma, incl. mocked `formula` model; llmService's own network calls
# are mocked via global.fetch). Also covers predictFutureKpis (KPI history/prediction
# graphs) — incl. a regression test that a real room's queued decision still applies
# after a prediction runs, proving the prediction's sandboxed room id never touches
# real in-flight submissions.
npm test --workspace=server

# Run frontend unit tests (Vitest) — Zustand stores, GamePhase utilities (incl.
# detectNewlySuedCases and detectNewlyResolvedCases, the pure diffs behind the
# sued/lawsuit-verdict post-turn info windows)
npm --workspace=client exec vitest run

# Run API interface tests (Vitest + real PostgreSQL via testcontainers)
npm run test:api

# Run API tests in watch mode
npm run test:api:watch

# Run Playwright E2E tests (needs the client dev server + a running backend)
npm run test:e2e

# Run Playwright E2E tests in UI mode
npm run test:e2e:ui

# Run Playwright E2E tests headed (visible browser)
npm run test:e2e:headed

# Run all tests (API + E2E)
npm run test:all
```

> **Note**: `npm run test:api` (`tests/api/`) spins up a real, disposable PostgreSQL
> database via testcontainers and runs `prisma migrate deploy` against it — it needs
> Docker. It's the layer that verifies the actual Socket.IO event contracts (including
> `game:submitDecisions`, `turn:resolved`, `game:over`) and Prisma schema, as opposed to
> the mocked-Prisma unit tests in `server/src/**/*.test.ts`.

---

## 📦 Deployment

### Production Build (Local)

```bash
# Build both packages
npm run build

# The client will be in client/dist/
# The server will be in server/dist/
```

### Docker Deployment

The project includes a multi-stage Docker build (`Dockerfile`) that builds the entire stack in one image:

```dockerfile
# Build and run with the full-stack image
docker build -t suetheirasses:latest .
docker run -p 80:80 -p 3001:3001 suetheirasses:latest
```

Or use the provided `docker-compose.yml` for orchestrated deployment with PostgreSQL:

```bash
docker-compose up -d --build
```

### Recommended Hosting

| Service | Best For |
|---------|----------|
| **Railway** | Full-stack deployment with managed PostgreSQL |
| **Fly.io** | Socket.IO apps with sticky sessions |
| **Render** | Simple deployment with free tier |
| **AWS ECS** | Production-scale with auto-scaling |

---

## 🔒 Security

- **Server-authoritative validation**: All game actions validated with Zod schemas
- **CORS protection**: Configured per environment
- **Input sanitization**: All user inputs validated before processing
- **Rate limiting**: Recommended for production (add `express-rate-limit`)
- **Authentication**: Recommended for production (add JWT or session-based auth)

---

## 📝 API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/room/:roomId` | Get room details |
| GET | `/api/admin/rooms` | Every in-memory room (any phase), with per-player status. Requires `x-admin-token`. See *Admin Portal* below. |
| GET | `/api/admin/decisions` | The full decision library, from the DB. Requires `x-admin-token`. |
| POST | `/api/admin/decisions` | Create a new decision. Body validated by `decisionDefinitionSchema`; 409 if the name already exists. Requires `x-admin-token`. |
| PUT | `/api/admin/decisions/:name` | Update an existing decision's fields (not a rename — `body.decision` must equal `:name`); 404 if unknown. Requires `x-admin-token`. |
| DELETE | `/api/admin/decisions/:name` | Delete a decision; 409 (`reason: 'in_use'`) if it's currently deployed by an active player anywhere, 404 if unknown. Requires `x-admin-token`. |
| GET | `/api/admin/config` | The `GameConfig` (`gameSettings`/`playerStartingValues`/`adminVariables`), from the DB. Requires `x-admin-token`. |
| PUT | `/api/admin/config` | Replace the game config. Body validated by `gameConfigSchema`. Requires `x-admin-token`. |
| GET | `/api/admin/formulas` | All 23 pure-math formulas (FORMULAS.md §2-§7), from the DB. Requires `x-admin-token`. See *Formulas* above. |
| PUT | `/api/admin/formulas/:key` | Update one formula's expression/description. Body validated by `formulaUpdateSchema` — real syntax parse plus a per-key variable whitelist; 400 on either failure, 404 if the key is unknown. No create/delete — the key set is fixed. Requires `x-admin-token`. |

### WebSocket API

All real-time communication uses Socket.IO events (see [Real-Time Communication](#real-time-communication) section above).

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License.

---

## 🙏 Acknowledgments

- Built with [Socket.IO](https://socket.io/) for real-time communication
- Database powered by [PostgreSQL](https://www.postgresql.org/)
- ORM by [Prisma](https://prisma.io/)
- UI components from [Mantine](https://mantine.dev/)
