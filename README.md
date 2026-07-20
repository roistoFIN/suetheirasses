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
3. **Auto-Join**: Server finds the room with the fewest players (< 4) and joins the player
4. **Fallback**: If no rooms available, a new room is created automatically
5. **Live Updates**: Other players receive `room:playerJoined` events when someone joins

The room list is dynamically updated via the `rooms:list` server event, showing:
- Room ID (truncated)
- Current player count (e.g., 2/4)
- Room status and phase round

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
│   ├── src/
│   │   ├── components/              # Reusable UI components
│   │   │   ├── Timer.tsx            # Phase countdown timer
│   │   │   └── ...
│   │   ├── pages/                   # Page components
│   │   │   ├── Matchmaking.tsx      # Lobby: create/join/quick-play, invite links
│   │   │   ├── GamePhase.tsx        # The GAME_PHASE loop UI (KPIs, decisions, lawsuits)
│   │   │   └── GameOver.tsx         # AFTERMATH: winner + final standings
│   │   ├── stores/                  # Zustand state stores
│   │   │   ├── gameStore.ts         # Game state (room, phase, timer, turn results)
│   │   │   └── socketStore.ts       # Socket.IO connection & events
│   │   ├── App.tsx                  # Root component + routing
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
│   │   │   └── legalEngine.ts       # Deliberate lawsuit filing (see Lawsuits below)
│   │   ├── data/                    # Runtime copies of the game's source-of-truth data
│   │   │   ├── game_engine.json     # 45 decisions: impacts, legal risks, exclusions
│   │   │   └── game_config.json     # Starting values + admin-tunable variables
│   │   ├── validation/              # Zod schemas
│   │   │   └── schemas.ts           # All input validation
│   │   ├── services/                # External service clients (real network I/O, no game math)
│   │   │   └── llmService.ts        # Local llama.cpp client — AI-narrated annual report text
│   │   └── index.ts                 # Server entry point
│   ├── prisma/
│   │   ├── schema.prisma            # Database schema
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
├── definitionDocumentation/         # Source of truth for game design — never derive
│   ├── FORMULAS.md                  # every formula + the per-turn calculation order
│   ├── game_engine.json             # canonical copy of the 45-decision library
│   ├── game_config.json             # canonical copy of starting/admin values
│   └── WarRoomDashboard.jsx         # UI prototype (layout/interaction reference only)
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
│   │   ├── gamePhase.spec.ts        # Starting a game reaches GAME_PHASE cleanly
│   │   └── gameOver.spec.ts         # AFTERMATH page's no-data behavior
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
| `room:startGame` | — | Host starts the game (WAITING → GAME_PHASE, round 1) |
| `game:submitDecisions` | `{ strategic: DecisionEntry[], operational: DecisionEntry[], lawsuits: LawsuitEntry[] }` | Full replacement of this turn's pending decisions (`{ name, targetId? }` each) *and* deliberate lawsuit filings (`{ targetId, decisionName, groundName }` each — see *Lawsuits* below). Structural validation only — per-turn limits (max 1 strategic / 2 operational / 3 lawsuits) come from `game_config.json` and are enforced by `DecisionEngine.canDeploy` / `GameLoop`'s lawsuit-filing step. |
| `game:digDeeper` | `{ attackId }` | Pay `gameSettings.digDeeperCost` ($10,000 by default) to reveal the next tier of intel on one incoming attack — instant, outside the turn-resolution cycle. See *Attack Awareness & Dig Deeper* below. |
| `game:getAnnualReport` | `{ rivalPlayerId }` | Request AI-narrated "annual report" text for one rival's active decisions — on demand, outside the turn-resolution cycle. See *AI-Narrated Annual Reports* below. |
| `chat:message` | `{ message }` | Send a chat message to the room |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ room, player, companies }` | Successfully joined a room — also the response to a successful `room:rejoin` |
| `room:playerJoined` | `{ playerId, playerName, isHost, roomId }` | New player joined the room |
| `room:playerKicked` | `{ kickedPlayerId, kickedPlayerName }` | Player was kicked from room |
| `room:playerLeft` | `{ playerId, playerName, roomId }` | A disconnected player's reconnect grace period expired without them coming back — they're now actually removed. Never fires for a disconnect that reconnects in time; the rest of the room isn't told about those at all. |
| `rooms:list` | `{ rooms: RoomInfo[] }` | List of available rooms (Quick Play) |
| `phase:changed` | `{ phase, round, timeLimit }` | Room advanced phase, or looped into another GAME_PHASE round |
| `timer:update` | `{ timeLeft }` | Countdown tick |
| `game:deck` | `{ decisions: DecisionDefinition[], gameSettings: GameSettings }` | Sent once, right when GAME_PHASE starts — the full 45-decision library and per-turn limits, static for the whole game. Also re-sent on a successful `room:rejoin` during GAME_PHASE. |
| `turn:resolved` | `TurnResolutionResult` (`{ round, players: PlayerTurnResult[], gameOver, winnerId? }`) | Sent twice per round-1: once immediately when the game starts (starting-position preview, `GameLoop.getInitialSnapshot`), and again whenever a GAME_PHASE turn actually finishes resolving (`GameLoop.resolveTurn`) — full per-player state either way. `GameEngine` caches the most recent one per room and re-sends it on a successful `room:rejoin` during GAME_PHASE, so a reconnecting player doesn't wait for the next turn to see where things stand. |
| `player:bankrupt` | `{ playerId, playerName }` | Player's cash went below $0 this turn — eliminated immediately (FORMULAS §12) |
| `game:over` | `{ winner, finalStandings }` | Only one player remains; room moved to AFTERMATH. Also re-sent on a successful `room:rejoin` during AFTERMATH. |
| `game:digDeeperResult` | `{ attackId, cost, newCash, attack: IncomingAttackInfo }` | Sent only to the requesting socket, never broadcast — the newly-unlocked intel tier for one attack |
| `game:annualReportResult` | `{ rivalPlayerId, entries: AnnualReportEntry[] }` | Sent only to the requesting socket, never broadcast — AI-narrated (or static-fallback) flavor text for the rival's active decisions |
| `error` | `{ code, message }` | Error occurred (e.g. `NOT_HOST`, `INVALID_DECISIONS`, `REJOIN_FAILED`, `ANNUAL_REPORT_FAILED`) |

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

/** One rival's active decision, narrated for their "annual report" — see `game:getAnnualReport`. */
export interface AnnualReportEntry {
  decisionName: string;
  text: string;   // AI-generated (or static-fallback) flavor text — never the real numbers
  year: number;   // deployedYear + 1
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
| `setAnnualReportLoading(rivalPlayerId)` | Marks one rival's AI annual report as in-flight, so `RivalFullReportView` doesn't fire a duplicate `game:getAnnualReport` while waiting |
| `applyAnnualReportResult(rivalPlayerId, entries)` | Caches the AI-narrated entries for one rival, keyed by id — the response to `game:getAnnualReport` |
| `setGameDeck(data)` | Store the decision library + per-turn limits |
| `setGameOver(data)` | Set game over state with winner and standings |
| `clearGameOver()` | Clear game over state |
| `setError(error)` | Set error state |
| `setNotification(message)` | Set UI notification message |
| `setCompanies(companies)` | Update company data for all players |
| `setIsRejoining(isRejoining)` | Toggle the "attempting to resume a saved session" flag — gates `App.tsx`'s first paint so Matchmaking doesn't flash before a `room:rejoin` attempt resolves |

#### `socketStore.ts`

Manages the Socket.IO connection and event routing, plus session persistence for
reconnection (see *Reconnection & Session Resume* below):

| Method | Description |
|--------|-------------|
| `send(event, payload)` | Emit a socket event to the server |
| `on(event, handler)` | Subscribe to a server event, returns unsubscribe function |
| `disconnect()` | Close the socket connection |

**Key event handlers:**
- `connect` → If a session (`{ roomId, playerId }`) is saved in `localStorage`, sets
  `isRejoining` and emits `room:rejoin`. Fires on the first connect *and* on every
  Socket.IO-driven auto-reconnect after a transient drop — so a brief network blip with
  the tab still open self-heals here too, not just a full page reload.
- `room:joined` → Calls `gameStore.updateRoom()`/`updatePlayer()`, and saves the session
  to `localStorage` — covers both a fresh join and a successful rejoin, since the server
  reuses this same event for both
- `room:playerJoined` → Calls `gameStore.addPlayer()` with deduplication guard
- `room:playerKicked` → Calls `gameStore.kickPlayer()`; clears the saved session if *I'm*
  the one who got kicked
- `room:playerLeft` → Calls `gameStore.kickPlayer()` (same roster-removal logic) plus a
  distinguishing notification ("…connection timed out")
- `phase:changed` → Calls `gameStore.updatePhase()`
- `timer:update` → Calls `gameStore.updateTimer()`
- `game:over` → Calls `gameStore.setGameOver()`; clears the saved session (nothing left
  to reconnect to)
- `game:digDeeperResult` → Calls `gameStore.applyDigDeeperResult()`
- `game:annualReportResult` → Calls `gameStore.applyAnnualReportResult()`
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

# Seed the database with test data
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
```

**Client** (`client/.env` — copy from `client/.env.example`):

```env
VITE_SERVER_URL=http://localhost:3001
```

> **Note**: When running via Docker Compose, environment variables are injected automatically. The client uses `http://server:3001` internally, and the server uses the PostgreSQL service name `postgres`.

---

## 🎯 Game Mechanics

Full detail lives in `definitionDocumentation/FORMULAS.md` (every formula and the exact
per-turn calculation order) and `definitionDocumentation/game_engine.json` (the 45
decisions). This section is a summary of what the server's `engine/` actually does.

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

`target.*` impact fields (FORMULAS §0 — the 9 fields like `target.cash`, `target.outrage`
that route a decision's effect to the chosen target rather than the decision-maker, used
by Buy Shares/Sell Shares and the offensive-sabotage decisions) route to the chosen
opponent every turn the decision stays active, applied in `resolveTurn`'s Step 2 right
alongside the decision's own self-effects (`calcEngine.extractTargetImpacts`/
`applyTargetImpacts`, `DecisionEngine.getTargetImpacts`, `GameLoop.buildIncomingAttacks`)
— see *Attack Awareness & Dig Deeper* below for how a targeted player finds out.

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

### Bankruptcy & Game Over (Aftermath)

A player is eliminated the instant their cash goes below $0 on any turn — strictly
`cash < 0`, no debt-based rule. When a player falls, their still-unresolved lawsuits
(as both plaintiff and defendant) lapse; cases against them are paid out from a pool of
that turn's positive income-side cash flow, oldest filing first, until the pool runs out
(FORMULAS §16). The game continues, looping GAME_PHASE rounds, until only one player
remains — there is no fixed round limit and no score-based win condition.

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
| `roomRejoinSchema` | `roomId`, `playerId` | Both required, 1-50 characters — no separate auth token; the id pair itself is the bearer credential, same trust model as every other player id already used throughout the app (no passwords anywhere) |
| `annualReportRequestSchema` | `rivalPlayerId` | Required, 1-100 characters |

### Game Engine Architecture

Two layers split room/lobby/persistence/broadcast concerns from turn-resolution math:

**`GameEngine`** (`server/src/socket/gameEngine.ts`) — room and phase lifecycle, and the
only place that touches Prisma or Socket.IO for turn resolution:

| Method | Description |
|--------|-------------|
| `createRoom(player)` | Creates a new room with the player as founder (max 4 players) |
| `joinRoom(roomId, player)` | Joins an existing room; throws if full or the name is already taken |
| `markPlayerDisconnected(socketId)` | A socket disconnected — clears the player's live socket association but keeps them in the room and makes no DB write, starting their reconnect grace-period clock |
| `finalizePlayerRemoval(roomId, playerId)` *(private)* | Actually removes a player whose grace period expired without a `room:rejoin` — the DB cleanup `markPlayerDisconnected`'s predecessor (`removePlayer`) used to do immediately; broadcasts `room:playerLeft`; cleans up the room too if it's now empty |
| `rejoinRoom(roomId, playerId, socketId)` | Re-associates an existing (still-within-grace-period) player with a new socket; returns data for the caller to emit (`room:joined` always, plus `game:deck`/cached `turn:resolved` or `game:over` depending on room phase) rather than doing the emitting itself, mirroring `digDeeper`'s pattern |
| `buildRoomJoinedPayload(roomState, player)` | Builds the `room:joined` payload shape — shared by the fresh-join and rejoin paths |
| `digDeeper(roomId, playerId, attackId)` | "Dig Deeper" — pay to reveal the next tier of intel on one incoming attack, instantly, outside the turn-resolution cycle. Loads active players, calls `GameLoop.digDeeper` (pure), and on success does the one Prisma write (`cash` *and* `variables`, since `GameLoop` reads cash from the `variables` JSONB, not the column) |
| `getAnnualReport(roomId, rivalPlayerId)` | AI-narrated "annual report" text for one rival, on demand — loads active players, calls `GameLoop.getActiveDecisionSummaries` (pure, re-derives from the rival's own `Company.engineState`), then asks `services/llmService.ts` to narrate each active decision (network I/O, cached, falls back to static `competitorsView` text on any failure). Read-only — no Prisma write |
| `advancePhase(roomId)` | Linear phase advance (WAITING → GAME_PHASE); race-condition guarded |
| `resolveGameTurn(roomId)` | Loads active players from the DB, calls `GameLoop.resolveTurn` (pure), then persists the returned `companyUpdates`/`bankruptedPlayers` and broadcasts `player:bankrupt`/`turn:resolved` — then either loops into another GAME_PHASE round or, once one player remains, transitions to AFTERMATH and emits `game:over`. Also caches the broadcast result (`lastTurnResults`) for `rejoinRoom` to re-send. |
| `submitDecisions(roomId, playerId, decisions)` | Forwards a validated `game:submitDecisions` payload to `GameLoop` |
| `broadcastInitialSnapshot(roomId, round)` | Called once, right when `room:startGame` fires — loads active players, calls `GameLoop.getInitialSnapshot` (pure), and broadcasts the result immediately so the game room renders without delay. Also caches it for `rejoinRoom`. |
| `broadcastRoomState(roomId, event, data)` | Broadcasts state to all players in a room |
| `loadActiveCompanyPlayers(roomId)` *(private)* | Shared DB fetch (`player.findMany` with `company` included, `bankrupt: false`) feeding `resolveGameTurn`, `broadcastInitialSnapshot`, and `digDeeper` |
| `startHeartbeatCleanup()` *(private)* | One 10s `setInterval` sweeping two things: rooms empty for over `STALE_ROOM_THRESHOLD` (60s), and disconnected players past `RECONNECT_GRACE_PERIOD_MS` (60s) → `finalizePlayerRemoval`. Extend this interval for new periodic sweeps rather than adding a second one. |

**`GameLoop`** (`server/src/engine/gameLoop.ts`) — the authoritative turn-resolution
engine, loaded with `game_engine.json`/`game_config.json` at startup. It is a **pure
computation engine**: no Prisma, no Socket.IO, no I/O of any kind — it takes plain player
data in and returns plain result data out, so it can be unit-tested and reasoned about
without mocking a database or a socket server:

| Method | Description |
|--------|-------------|
| `loadDecisions(definitions)` | Loads the 45-decision library into `DecisionEngine`/`LegalEngine` |
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
# gameLoop, gameEngine, validation schemas, llmService. No DB or live LLM required
# (mocked Prisma; llmService's own network calls are mocked via global.fetch).
npm test --workspace=server

# Run frontend unit tests (Vitest) — Zustand stores, GamePhase utilities
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
