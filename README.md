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
├── .github/                         # GitHub Actions CI/CD
├── .dockerignore
├── Dockerfile                       # Full-stack multi-stage build
├── docker-compose.yml               # Docker orchestration (PostgreSQL, server, client)
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
  // activeDecisions, depreciationLedger, legalCases (GameLoop's CompanyEngineState)
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
| `room:list` | — | Request list of available rooms |
| `room:kick` | `{ playerId }` | Host removes a player from the room |
| `room:startGame` | — | Host starts the game (WAITING → GAME_PHASE, round 1) |
| `game:submitDecisions` | `{ strategic: DecisionEntry[], operational: DecisionEntry[], lawsuits: LawsuitEntry[] }` | Full replacement of this turn's pending decisions (`{ name, targetId? }` each) *and* deliberate lawsuit filings (`{ targetId, decisionName, groundName }` each — see *Lawsuits* below). Structural validation only — per-turn limits (max 1 strategic / 2 operational / 3 lawsuits) come from `game_config.json` and are enforced by `DecisionEngine.canDeploy` / `GameLoop`'s lawsuit-filing step. |
| `chat:message` | `{ message }` | Send a chat message to the room |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ room, player, companies }` | Successfully joined a room |
| `room:playerJoined` | `{ playerId, playerName, isHost, roomId }` | New player joined the room |
| `room:playerKicked` | `{ kickedPlayerId, kickedPlayerName }` | Player was kicked from room |
| `rooms:list` | `{ rooms: RoomInfo[] }` | List of available rooms (Quick Play) |
| `phase:changed` | `{ phase, round, timeLimit }` | Room advanced phase, or looped into another GAME_PHASE round |
| `timer:update` | `{ timeLeft }` | Countdown tick |
| `game:deck` | `{ decisions: DecisionDefinition[], gameSettings: GameSettings }` | Sent once, right when GAME_PHASE starts — the full 45-decision library and per-turn limits, static for the whole game |
| `turn:resolved` | `TurnResolutionResult` (`{ round, players: PlayerTurnResult[], gameOver, winnerId? }`) | Sent twice per round-1: once immediately when the game starts (starting-position preview, `GameLoop.getInitialSnapshot`), and again whenever a GAME_PHASE turn actually finishes resolving (`GameLoop.resolveTurn`) — full per-player state either way |
| `player:bankrupt` | `{ playerId, playerName }` | Player's cash went below $0 this turn — eliminated immediately (FORMULAS §12) |
| `game:over` | `{ winner, finalStandings }` | Only one player remains; room moved to AFTERMATH |
| `error` | `{ code, message }` | Error occurred (e.g. `NOT_HOST`, `INVALID_DECISIONS`) |

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
```

### Zustand State Stores

The client uses Zustand for lightweight, TypeScript-safe state management:

#### `gameStore.ts`

Manages all game-related state including room state, player data, phase tracking, and timer.

| Method | Description |
|--------|-------------|
| `updateRoom(room)` | Replace the current room state |
| `updatePlayer(player)` | Replace the current player object with updated DB-generated ID |
| `kickPlayer(playerId)` | Remove a player from the room |
| `addPlayer(player)` | Add a new player to the room when they join dynamically |
| `markPlayerBankrupt(playerId)` | Mark a player as bankrupt and remove them from active play |
| `updatePhase(data)` | Update the current game phase, round, and timer |
| `updateTimer(timeLeft)` | Update the countdown timer value |
| `setGameOver(data)` | Set game over state with winner and standings |
| `setError(error)` | Set error state |
| `setNotification(message)` | Set UI notification message |
| `setCompanies(companies)` | Update company data for all players |

#### `socketStore.ts`

Manages the Socket.IO connection and event routing:

| Method | Description |
|--------|-------------|
| `send(event, payload)` | Emit a socket event to the server |
| `on(event, handler)` | Subscribe to a server event, returns unsubscribe function |
| `disconnect()` | Close the socket connection |

**Key event handlers:**
- `room:playerJoined` → Calls `gameStore.addPlayer()` with deduplication guard
- `phase:changed` → Calls `gameStore.updatePhase()`
- `timer:update` → Calls `gameStore.updateTimer()`
- `game:over` → Calls `gameStore.setGameOver()`
- `error` → Calls `gameStore.setError()`

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

> **Known gap:** `target.*` impact fields (FORMULAS §0 — the 9 fields like `target.cash`,
> `target.outrage` that route a decision's effect to the chosen target rather than the
> decision-maker, used by Buy Shares/Sell Shares and the offensive-sabotage decisions)
> are extracted and stored (`calcEngine.extractTargetImpacts`/`applyTargetImpacts`,
> `DecisionEngine.getTargetImpacts`) but never actually applied to the target player in
> `GameLoop.resolveTurn` — deploying a targeted decision currently only applies its
> self-effects. The Decision Deck UI lets players pick a target and submits `targetId`
> correctly; the server-side application is the missing piece.

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

### Game Engine Architecture

Two layers split room/lobby/persistence/broadcast concerns from turn-resolution math:

**`GameEngine`** (`server/src/socket/gameEngine.ts`) — room and phase lifecycle, and the
only place that touches Prisma or Socket.IO for turn resolution:

| Method | Description |
|--------|-------------|
| `createRoom(player)` | Creates a new room with the player as founder (max 4 players) |
| `joinRoom(roomId, player)` | Joins an existing room; throws if full |
| `removePlayer(socketId)` | Removes player from room; cleans up DB if room becomes empty |
| `advancePhase(roomId)` | Linear phase advance (WAITING → GAME_PHASE); race-condition guarded |
| `resolveGameTurn(roomId)` | Loads active players from the DB, calls `GameLoop.resolveTurn` (pure), then persists the returned `companyUpdates`/`bankruptedPlayers` and broadcasts `player:bankrupt`/`turn:resolved` — then either loops into another GAME_PHASE round or, once one player remains, transitions to AFTERMATH and emits `game:over` |
| `submitDecisions(roomId, playerId, decisions)` | Forwards a validated `game:submitDecisions` payload to `GameLoop` |
| `broadcastInitialSnapshot(roomId, round)` | Called once, right when `room:startGame` fires — loads active players, calls `GameLoop.getInitialSnapshot` (pure), and broadcasts the result immediately so the game room renders without delay |
| `broadcastRoomState(roomId, event, data)` | Broadcasts state to all players in a room |
| `loadActiveCompanyPlayers(roomId)` *(private)* | Shared DB fetch (`player.findMany` with `company` included, `bankrupt: false`) feeding both `resolveGameTurn` and `broadcastInitialSnapshot` |

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
5. If room empties, both in-memory state and database record are cleaned up

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
# gameLoop, gameEngine, validation schemas. No DB required (mocked Prisma).
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
