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
| 1 | **Matchmaking** | Players join/create rooms, ready up | No timer |
| 2 | **Strategic Choices** | Players submit business decisions (invest, expand, layoff, etc.) | 120s |
| 3 | **Results** | Server resolves outcomes, applies financial changes | 15s |
| 4 | **Legal Suits** | Players file lawsuits against opponents | 90s |
| 5 | **Resolution** | Defendants respond to lawsuits, verdicts are determined | 90s |

After Phase 5, bankrupt players (cash ≤ $0 or debt > $10,000) are eliminated. If only one player remains, the game ends. Otherwise, the loop returns to Phase 2.

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
              ┌──────────▼──────────┐
              │       REDIS         │
              │  • Matchmaking Q    │
              │  • Room Cache       │
              │  • Pub/Sub          │
              └─────────────────────┘
```

### Design Principles

1. **Server-Authoritative**: The server is the single source of truth. Clients send intentions; the server validates and resolves.
2. **Phase-Based State Machine**: Each game phase is an isolated handler, making the system testable and extensible.
3. **Action Logging**: Every action is persisted, enabling replay, debugging, and dispute resolution.
4. **Optimistic UI**: Clients show immediate feedback; the server reconciles authoritative state.

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
| **Node.js** | 18+ | Runtime environment |
| **TypeScript** | 5.3+ | Type-safe server code |
| **Express** | 4.18+ | HTTP server for REST endpoints |
| **Socket.IO** | 4.7+ | Real-time bidirectional communication |
| **Prisma** | 5.7+ | Type-safe ORM for PostgreSQL |
| **Zod** | 3.22+ | Runtime schema validation |

### Infrastructure

| Technology | Version | Purpose |
|-----------|---------|---------|
| **PostgreSQL** | 16+ | Primary database (ACID compliance) |
| **Redis** | 7+ | Caching, matchmaking, pub/sub |
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
│   └── package.json
│
├── server/                          # Node.js backend application
│   ├── src/
│   │   ├── socket/                  # Socket.IO handlers
│   │   │   ├── gameEngine.ts        # Main game engine + event routing
│   │   │   ├── matchmaking.ts       # Room creation/joining
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
│   │   └── schema.prisma            # Database schema
│   ├── .env.example
│   ├── tsconfig.json
│   └── package.json
│
├── shared/                          # Shared types between client/server
│   ├── src/
│   │   └── types.ts                 # All game types, enums, payloads
│   ├── tsconfig.json
│   └── package.json
│
├── docker-compose.yml               # PostgreSQL + Redis services
├── package.json                     # Monorepo root
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
│ round    │       │ isReady  │       └────┬─────┘
│ createdAt│       │ bankrupt │            │
└──────────┘       └──────────┘            │
                 1    *  ┌──────────┐      │
                 │       │  Asset   │◀─────┘
                 │       ├──────────┤
                 │       │ id       │
                 │       │ companyId│
                 │       │ type     │
                 │       │ value    │
                 │       └──────────┘
                 │
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
```

### Database Schema (Prisma)

```prisma
model Room {
  id                String       @id @default(cuid())
  status            RoomStatus   @default(WAITING)
  maxPlayers        Int          @default(6)
  currentPhaseRound Int          @default(1)
  createdAt         DateTime     @default(now())
  players           Player[]
}

model Player {
  id          String     @id @default(cuid())
  name        String
  roomId      String
  room        Room       @relation(fields: [roomId], references: [id])
  isReady     Boolean    @default(false)
  bankrupt    Boolean    @default(false)
  companyId   String?    @unique
  company     Company?
}

model Company {
  id             String    @id @default(cuid())
  playerId       String    @unique
  player         Player    @relation(fields: [playerId], references: [id])
  cash           Float     @default(100000)
  assets         Asset[]
  lawsuitsFiled  Lawsuit[] @relation("FiledLawsuit")
  lawsuitsReceived Lawsuit[] @relation("ReceivedLawsuit")
}

model Asset {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id])
  type      String
  value     Float
}

model Lawsuit {
  id          String   @id @default(cuid())
  plaintiffId String
  plaintiff   Player   @relation("FiledLawsuit")
  defendantId String
  defendant   Player   @relation("ReceivedLawsuit")
  claimAmount Float
  grounds     String
  resolved    Boolean  @default(false)
  verdict     Verdict?
  resolution  String?
}
```

---

## 🔌 Real-Time Communication

### Socket.IO Events

#### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:join` | `{ playerName, roomName? }` | Join or create a room |
| `room:ready` | — | Toggle ready state |
| `strategy:submit` | `{ actions: GameAction[] }` | Submit strategic choices |
| `lawsuit:file` | `{ defendantId, claimAmount, grounds }` | File a lawsuit |
| `lawsuit:respond` | `{ lawsuitId, defense, settlementOffer? }` | Respond to a lawsuit |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ room, player, companies }` | Successfully joined a room |
| `room:playerReady` | `{ playerId, isReady }` | Player toggled ready |
| `phase:changed` | `{ phase, round, timeLimit }` | Game advanced to new phase |
| `timer:update` | `{ timeLeft }` | Countdown tick |
| `results:reveal` | `{ outcomes }` | Phase 3 outcomes |
| `lawsuits:open` | — | Phase 4: filing window open |
| `lawsuits:resolve` | — | Phase 5: resolution window open |
| `player:bankrupt` | `{ playerId, playerName }` | Player eliminated |
| `game:over` | `{ winner, standings }` | Game ended |
| `error` | `{ code, message }` | Error occurred |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and npm 9+
- **Docker** and **Docker Compose** (for database services)

### Quick Start

```bash
# 1. Clone and enter the project
cd suetheirasses

# 2. Start PostgreSQL and Redis
docker-compose up -d

# 3. Install all dependencies
npm install

# 4. Set up the database
cp server/.env.example server/.env
npm run db:generate
npm run db:migrate

# 5. Start development servers (client + server)
npm run dev
```

The application will be available at:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001

### Individual Service Commands

```bash
# Start only the backend server
npm run dev:server

# Start only the frontend client
npm run dev:client

# Open Prisma Studio (database GUI)
npm run db:studio

# Run database migrations
npm run db:migrate

# Seed the database with test data
npm run db:seed

# Build for production
npm run build

# Stop Docker services
npm run docker:down
```

### Environment Variables

**Server** (`server/.env`):

```env
DATABASE_URL="postgresql://stita:stita_password@localhost:5432/stita_db"
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:5173
REDIS_URL="redis://localhost:6379"
```

**Client** (`client/.env`):

```env
VITE_SERVER_URL=http://localhost:3001
```

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

## 🧪 Testing

```bash
# Type-check all packages
npm run type-check

# Lint all packages
npm run lint

# Run backend tests (when implemented)
npm test --workspace=server

# Run frontend tests (when implemented)
npm test --workspace=client
```

---

## 📦 Deployment

### Production Build

```bash
# Build both packages
npm run build

# The client will be in client/dist/
# The server will be in server/dist/
```

### Docker Deployment

```dockerfile
# Multi-stage build example for the server
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY shared ./shared
COPY server ./server
RUN npm install && npm run build --workspace=shared --workspace=server

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server
RUN npm install --production --workspace=server
CMD ["node", "server/dist/index.js"]
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

## 🧭 Development Roadmap

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| **Foundation** | Week 1-2 | Monorepo, DB, Socket.IO, rooms |
| **Core Gameplay** | Week 3-4 | All 5 phases, strategy engine |
| **Polish** | Week 5 | Animations, timers, bankruptcy |
| **Hardening** | Week 6 | Validation, reconnection, deploy |

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
- ORM by [Prisma](https://www.prisma.io/)
- UI components from [Mantine](https://mantine.dev/)
