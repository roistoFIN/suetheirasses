# ⚖️ Sue Their Asses

A multiplayer web-based business strategy game where players manage companies, make strategic decisions, engage in litigation, and eliminate opponents through bankruptcy.

## 🎮 Game Overview

### Game Flow

The game progresses through 5 phases in a continuous loop until only one player remains solvent:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5     │
│  Matchmaking   Strategy    Results    Legal Suits   Resolution  │
│   (Lobby)      Choices              (Offense)     (Defense)     │
│       ▲                                          │              │
│       │                                          ▼              │
│       └──────────────────────── Bankruptcy Check ───────────────┘
│                                              │
│                                    ┌─────────┴──────────┐
│                                    │                    │
│                              1 player                 >1 players
│                              remains                   │
│                                    │                    │
│                                    ▼                    │
│                               GAME OVER              Loop to
│                              (Winner!)              Phase 2
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Phase Details

| Phase | Name | Description | Timer |
|-------|------|-------------|-------|
| 1 | **Matchmaking** | Players join/create rooms, ready up, or use Quick Play | No timer |
| 2 | **Strategic Choices** | Players submit business decisions (invest, expand, layoff, etc.) | 120s |
| 3 | **Results** | Server resolves outcomes, applies financial changes | 15s |
| 4 | **Legal Suits** | Players file lawsuits against opponents | 90s |
| 5 | **Resolution** | Defendants respond to lawsuits, verdicts are determined | 90s |

After Phase 5, bankrupt players (cash ≤ $0 or debt > $10,000) are eliminated. If only one player remains, the game ends. Otherwise, the loop returns to Phase 2.

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
              │  • Player Data      │     │    Actions,       │
              │  • Action Log       │     │    Lawsuits)      │
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

### Frontend

| Technology | Version | Purpose |
|-----------|---------|---------|
| **React 18** | 18.2+ | UI component library |
| **TypeScript** | 5.3+ | Type safety across the stack |
| **Vite** | 5.0+ | Build tool with HMR |
| **Zustand** | 4.4+ | Lightweight state management |
| **Socket.IO Client** | 4.7+ | Real-time WebSocket communication |
| **Mantine** | 7.3+ | UI component library with theming |
| **Framer Motion** | 10.16+ | Animations and transitions |
| **React Router** | 6.21+ | Client-side routing |

### Backend

| Technology | Version | Purpose |
|-----------|---------|---------|
| **Node.js** | 20+ | Runtime environment |
| **TypeScript** | 5.3+ | Type-safe server code |
| **Express** | 4.18+ | HTTP server for REST endpoints |
| **Socket.IO** | 4.7+ | Real-time bidirectional communication |
| **Prisma** | 5.7+ | Type-safe ORM for PostgreSQL |
| **Zod** | 3.22+ | Runtime schema validation |

### Infrastructure

| Technology | Version | Purpose |
|-----------|---------|---------|
| **PostgreSQL** | 16+ | Primary database (ACID compliance) |
| **Docker** | Latest | Container orchestration |

---

## 📁 Project Structure

```
suetheirasses/
├── client/                          # React frontend application
│   ├── src/
│   │   ├── components/              # Reusable UI components
│   │   │   ├── Timer.tsx            # Phase countdown timer
│   │   │   └── ...
│   │   ├── pages/                   # Phase-specific pages
│   │   │   ├── Matchmaking.tsx      # Phase 1: Room lobby
│   │   │   ├── Strategy.tsx         # Phase 2: Submit choices
│   │   │   ├── Results.tsx          # Phase 3: View outcomes
│   │   │   ├── Lawsuits.tsx         # Phase 4: File lawsuits
│   │   │   ├── Resolution.tsx       # Phase 5: Respond to suits
│   │   │   └── GameOver.tsx         # Winner screen
│   │   ├── stores/                  # Zustand state stores
│   │   │   ├── gameStore.ts         # Game state (room, phase, timer)
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
│   │   │   ├── gameEngine.ts        # Main game engine + event routing
│   │   │   └── phases/              # Phase-specific handlers
│   │   │       ├── strategyPhase.ts # Phase 2 resolution
│   │   │       ├── resultsPhase.ts  # Phase 3 display
│   │   │       ├── lawsuitsPhase.ts # Phase 4 filing
│   │   │       └── resolutionPhase.ts # Phase 5 resolution
│   │   ├── services/                # Business logic
│   │   │   ├── companyService.ts    # Company strategy execution
│   │   │   ├── lawsuitService.ts    # Lawsuit resolution logic
│   │   │   └── bankruptcyService.ts # Bankruptcy detection
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
│   │   └── index.ts                 # All game types, enums, payloads
│   ├── tsconfig.json
│   └── package.json
│
├── tests/                           # Integration & E2E Tests
│   ├── api/                         # Supertest API tests
│   │   ├── health.test.ts
│   │   ├── room.test.ts
│   │   ├── socket.test.ts
│   │   └── validation.test.ts
│   ├── e2e/                         # Playwright E2E tests
│   │   ├── matchmaking.spec.ts
│   │   ├── strategyPhase.spec.ts
│   │   ├── resultsPhase.spec.ts
│   │   ├── lawsuitsPhase.spec.ts
│   │   ├── resolutionPhase.spec.ts
│   │   ├── gameOver.spec.ts
│   │   └── navigation.spec.ts
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
│ round    │       │ isReady  │       │ debt     │
│ createdAt│       │ socketId │       └────┬─────┘
└──────────┘       │ bankrupt │            │
                   │ createdAt│            │
                   │          │            │
                   │          │ 1    *  ┌──▼────┐
                   │          │       │  │ Asset │
                   │          │       │  └───────┘
                   │          │
                   │ 1    *  ┌──────────┐ 1  *
                   └────────▶│  Lawsuit │◀──────┘
                               ├──────────┤
                               │ id       │
                               │ plaintiff│
                               │ defendant│
                               │ claim    │
                               │ grounds  │
                               │ resolved │
                               │ verdict  │
                               │ createdAt│
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
  isReady      Boolean    @default(false)
  bankrupt     Boolean    @default(false)
  socketId     String?
  createdAt    DateTime   @default(now())
  companyId    String?    @unique
  company      Company?
  lawsuitsFiled    Lawsuit[] @relation("FiledLawsuit")
  lawsuitsReceived Lawsuit[] @relation("ReceivedLawsuit")

  @@index([roomId])
  @@index([roomId, bankrupt])
}

model Company {
  id       String  @id @default(cuid())
  playerId String  @unique
  player   Player  @relation(fields: [playerId], references: [id], onDelete: Cascade)
  cash     Decimal @default(100000) @db.Decimal(15, 2)
  debt     Decimal @default(0)      @db.Decimal(15, 2)
  assets   Asset[]

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

model Lawsuit {
  id          String   @id @default(cuid())
  plaintiffId String
  plaintiff   Player   @relation("FiledLawsuit", fields: [plaintiffId], references: [id], onDelete: Cascade)
  defendantId String
  defendant   Player   @relation("ReceivedLawsuit", fields: [defendantId], references: [id], onDelete: Cascade)
  claimAmount Decimal  @db.Decimal(15, 2)
  grounds     String
  resolved    Boolean  @default(false)
  verdict     Verdict?
  resolution  String?  @default("")
  createdAt   DateTime @default(now())

  @@index([plaintiffId, resolved])
  @@index([defendantId, resolved])
  @@index([resolved])
}
```

---

## 🔌 Real-Time Communication

### Socket.IO Events

#### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:join` | `{ playerName, roomName?, searchForRoom? }` | Join a specific room, create one, or search for an available room |
| `room:list` | — | Request list of available rooms |
| `strategy:submit` | `{ actions: GameAction[] }` | Submit strategic choices |
| `lawsuit:file` | `{ defendantId, claimAmount, grounds }` | File a lawsuit |
| `lawsuit:respond` | `{ lawsuitId, defense, settlementOffer? }` | Respond to a lawsuit |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ room, player, companies }` | Successfully joined a room |
| `room:playerJoined` | `{ playerId, playerName, isReady, roomId }` | New player joined the room |
| `room:playerReady` | `{ playerId, isReady }` | Player toggled ready |
| `rooms:list` | `{ rooms: RoomInfo[] }` | List of available rooms (Quick Play) |
| `phase:changed` | `{ phase, round, timeLimit }` | Game advanced to new phase |
| `timer:update` | `{ timeLeft }` | Countdown tick |
| `results:reveal` | `{ outcomes }` | Phase 3 outcomes |
| `lawsuits:open` | — | Phase 4: filing window open |
| `lawsuits:resolve` | — | Phase 5: resolution window open |
| `player:bankrupt` | `{ playerId, playerName }` | Player eliminated |
| `game:over` | `{ winner, standings }` | Game ended |
| `error` | `{ code, message }` | Error occurred |

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
| `updatePlayer(player)` | Replace the current player object with updated DB-generated ID |
| `updatePlayerReady(data)` | Update a player's ready state from server event |
| `addPlayer(player)` | Add a new player to the room when they join dynamically |
| `markPlayerBankrupt(playerId)` | Mark a player as bankrupt and remove them from active play |
| `updatePhase(data)` | Update the current game phase, round, and timer |
| `updateBoard(data)` | Apply full board state update from server |
| `submitStrategy(actions)` | Store submitted strategy actions locally |
| `clearGame()` | Reset all game state (used on disconnect/reconnect) |

#### `socketStore.ts`

Manages the Socket.IO connection and event routing:

| Method | Description |
|--------|-------------|
| `send(event, payload)` | Emit a socket event to the server |
| `on(event, handler)` | Subscribe to a server event, returns unsubscribe function |
| `disconnect()` | Close the socket connection |

**Key event handlers:**
- `room:playerJoined` → Calls `gameStore.addPlayer()` with deduplication guard
- `room:playerReady` → Calls `gameStore.updatePlayerReady()`
- `phase:changed` → Calls `gameStore.updatePhase()`
- `board:update` → Calls `gameStore.updateBoard()`

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

### Strategic Actions (Phase 2)

| Action | Cost | Effect |
|--------|------|--------|
| 💰 Invest | Variable | Deploy capital into new ventures |
| 🏗️ Expand | Variable | Grow operations, increase overhead |
| 👥 Layoffs | Savings | Reduce costs, risk reputation |
| 🤝 Merger | Variable | Combine with another company |
| 📢 Ad Campaign | Variable | Boost revenue potential |
| 🔬 R&D | Variable | Invest in innovation |
| 🌍 Outsource | Savings | Cut costs, risk quality |
| 🏢 Acquisition | Variable | Buy out a competitor |

### Lawsuit System (Phases 4-5)

1. **Filing (Phase 4)**: Players file lawsuits against opponents
   - Filing fee: $1,000
   - Claim amount: $1,000 - $1,000,000
   - Grounds: Minimum 10 characters required

2. **Resolution (Phase 5)**: Defendants respond
   - Defense statement: Minimum 10 characters
   - Settlement offer: Optional, reduces penalty if accepted

3. **Verdicts**:
   - **WON**: Defendant pays claim amount to plaintiff
   - **LOST**: Case dismissed, plaintiff loses filing fee
   - **SETTLED**: Parties agree on reduced amount

### Bankruptcy (After Phase 5)

A player is declared bankrupt when:
- Cash balance drops to $0 or below, OR
- Debt exceeds $10,000

Bankrupt players are eliminated immediately. The game continues until only one player remains.

---

## 🔍 Validation & Game Engine

### Input Validation (Zod Schemas)

All client inputs are validated server-side using Zod schemas before processing:

| Schema | Field | Constraints |
|--------|-------|-------------|
| `roomJoinSchema` | `playerName` | Required, 1-30 characters |
| | `roomName` | Optional, max 30 characters |
| | `searchForRoom` | Optional boolean — triggers Quick Play search |
| `strategySubmitSchema` | `actions` | Array of 1-5 `GameAction` objects |
| `gameActionSchema` | `type` | Must be a valid `StrategyActionType` enum |
| | `amount` | Optional, must be ≥ 0 |
| `lawsuitFileSchema` | `defendantId` | Required, non-empty string |
| | `claimAmount` | $1,000 - $1,000,000 |
| | `grounds` | 10-500 characters |
| `lawsuitRespondSchema` | `lawsuitId` | Required, non-empty string |

### Game Engine Architecture

The `GameEngine` class (`server/src/socket/gameEngine.ts`) manages all room and phase logic:

| Method | Description |
|--------|-------------|
| `createRoom(player)` | Creates a new room with the player as founder (max 4 players) |
| `joinRoom(roomId, player)` | Joins an existing room; throws if full |
| `leaveRoom(socketId)` | Removes player from room; cleans up DB if room becomes empty |
| `advancePhase(roomId)` | Advances to next phase with race condition guard |
| `broadcastRoomState(roomId, event, data)` | Broadcasts state to all players in a room |

**Room Lifecycle:**
1. Room created in database with `WAITING` status
2. Players join via socket; room loaded into in-memory `Map`
3. When all players ready, phase advances to `STRATEGY`
4. After Phase 5, bankruptcy check runs; eliminated players removed
5. If room empties, both in-memory state and database record are cleaned up

**Concurrency Safety:**
- Phase advancement uses a `Set<string>` lock (`advancingRooms`) to prevent race conditions
- Room joins handle the "TOCTOU" (time-of-check-time-of-use) gap by catching `Room is full` errors and falling back to room creation

---

## 🧪 Testing

```bash
# Type-check all packages
npm run type-check

# Lint all packages
npm run lint

# Run backend unit tests (Vitest)
npm test --workspace=server

# Run API integration tests (Supertest + Vitest)
npm run test:api

# Run API tests in watch mode
npm run test:api:watch

# Run Playwright E2E tests
npm run test:e2e

# Run Playwright E2E tests in UI mode
npm run test:e2e:ui

# Run Playwright E2E tests headed (visible browser)
npm run test:e2e:headed

# Run all tests (API + E2E)
npm run test:all
```

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
