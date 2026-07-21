# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Sue Their Asses" — a multiplayer, server-authoritative business strategy game. Players
run companies for 120s rounds, deploy decisions from a shared 45-decision library, sue
each other over risky moves, and get eliminated the instant their cash goes negative.
Last player standing wins. Real-time via Socket.IO; React/Vite client; Express/Prisma/
PostgreSQL server; npm workspaces monorepo (`client`, `server`, `shared`).

The full design spec — every game mechanic, phase flow, socket event, and Zustand store
method — is documented in `README.md`. Read it before making non-trivial changes; this
file only covers what the README doesn't (commands and architecture orientation).

**`definitionDocumentation/FORMULAS.md` is the source of truth for game math** — every
formula and the exact per-turn calculation order, referenced throughout the code as
`FORMULAS §N`. Never derive game math from the code alone — check FORMULAS.md first,
since the code documents known deliberate deviations from spec (see README's *Lawsuits*
section). Neither the decision library/config nor the pure-math half of FORMULAS.md
(§2-§7's scalar formulas — competitiveness, P&L, balance sheet, legal-risk/risk-gauge
math) are static files anymore — all three live in Postgres (`Decision`/`GameConfigRow`/
`Formula` tables) and are editable live from `/admin`. See *"Decisions/config are
DB-backed, not static JSON"* and *"Formulas are DB-backed"* below before assuming
`game_engine.json`/`game_config.json`/FORMULAS.md's prose reflect what's actually
running — FORMULAS.md's *procedural* half (execution order, depreciation ledger,
bankruptcy waterfall, FIFO tie-breaking) is still the one and only source, unchanged.

## Commands

```bash
# Install (run once, from repo root — this is an npm workspaces monorepo)
npm install

# Dev servers (client :5173, server :3001), both with hot reload
npm run dev
npm run dev:server   # server only
npm run dev:client   # client only

# Type-check / lint everything
npm run type-check
npm run lint

# Build
npm run build           # both packages
npm run build:client
npm run build:server

# Backend unit tests (Vitest, no DB needed — GameLoop is pure, other suites mock Prisma)
npm test --workspace=server
npm test --workspace=server -- calcEngine        # single file/pattern

# Frontend unit tests (Vitest — Zustand stores, GamePhase utils)
npm --workspace=client exec vitest run
npm --workspace=client exec vitest run gameStore  # single file/pattern

# API interface tests — needs Docker (spins up real Postgres via testcontainers,
# runs `prisma migrate deploy`); verifies actual socket event contracts + Prisma schema
npm run test:api
npm run test:api:watch

# E2E tests (Playwright; needs the client dev server + a running backend)
npm run test:e2e
npm run test:e2e:ui       # UI mode
npm run test:e2e:headed   # visible browser
npx playwright test tests/e2e/gamePhase.spec.ts   # single spec

# Everything (API + E2E)
npm run test:all

# Database (Prisma, from repo root — proxies to server workspace)
npm run db:generate   # after schema.prisma changes
npm run db:migrate
npm run db:studio
npm run db:seed
npx prisma migrate reset   # drop and recreate all tables

# Docker
docker-compose up -d postgres     # just the DB, for local dev
docker-compose up -d llm          # local LLM (llama.cpp) for AI-generated annual report text —
                                   # optional, requires ./models/Qwen3-1.7B-Q4_K_M.gguf (not committed)
docker-compose up -d --build      # full stack
docker-compose down               # stop
docker-compose down -v            # stop + wipe DB volume
```

No test script exists at the root that runs backend + frontend unit tests together —
run `npm test --workspace=server` and `npm --workspace=client exec vitest run`
separately, or use `test:all` for the Docker-dependent API+E2E suites.

## Architecture

### Two-layer server split: room/DB/broadcast lifecycle vs. pure turn math

- **`GameEngine`** (`server/src/socket/gameEngine.ts`) — Socket.IO room/phase lifecycle:
  create/join/kick, phase advancement (`WAITING → GAME_PHASE → AFTERMATH`), and *all*
  Prisma/Socket.IO I/O for turn resolution. Holds rooms in an in-memory `Map` in addition
  to Postgres, and guards concurrent turn resolution per-room with a `Set<string>` lock
  (`advancingRooms`). `resolveGameTurn`/`broadcastInitialSnapshot` load each active
  player's `Company` row into `GameLoop`'s input shape (`EngineDataInput[]`), call
  `GameLoop`, then persist the returned `companyUpdates`/`bankruptedPlayers` and emit
  `player:bankrupt`/`turn:resolved` themselves.
- **`GameLoop`** (`server/src/engine/gameLoop.ts`) — the authoritative turn-resolution
  engine, loaded via `GameEngine.loadGameData()` from the `Decision`/`GameConfigRow`
  tables (DB-backed and admin-editable — see *"Decisions/config are DB-backed, not
  static JSON"* below; `server/src/data/*.json` are seed-only now). **It is a pure
  computation engine** — no Prisma, no Socket.IO, no
  `async`/`await` anywhere in it. `resolveTurn(roomId, round, players)` and
  `getInitialSnapshot(roomId, round, players)` take plain `EngineDataInput[]` and return
  plain data (`TurnResolutionOutcome` / `TurnResolutionResult`); they never write to the
  DB or emit a socket event — the caller (`GameEngine`) does both. Delegates to
  `calcEngine.ts` (P&L, balance sheet, market share, risk gauge), `decisionEngine.ts`
  (deployment rules, maturity, mutual-exclusion checks), and `legalEngine.ts` (deliberate
  lawsuit filing/pricing). `resolveTurn` runs the full 9-step per-round calculation
  described in the README's *Business Decisions* section.

When changing turn-resolution logic, the engine files under `server/src/engine/` are
where it lives — `gameEngine.ts` never touches game math directly, it only calls into
`GameLoop` and applies the outcome it returns. This split makes `GameLoop`'s tests
(`server/src/engine/gameLoop.test.ts`) plain input-in/output-out assertions with no
mocking at all — if you need a test double for Prisma or `Server`, you're testing
`GameEngine` (`server/src/socket/gameEngine.test.ts`), not `GameLoop`.

`GameLoop` persists each active decision as a `PersistedDecisionInstance`
(`{ id, definitionName, deployedYear, elapsedYears, isMatured, targetId? }`) rather than
the full `DeployedDecision` (which embeds the whole `DecisionDefinition` object) —
`definitionName` is looked back up against the loaded decision library on read
(`readEngineState` → `DecisionEngine.getDef`), since definitions are static and already
loaded from `game_engine.json` at startup. Keep persisted decision instances in this
serialized, name-keyed form; don't reintroduce embedding the full definition object into
`Company.engineState`, or the write/read shapes drift apart again (this was a real bug
until fixed — `gameLoop.test.ts`'s "round-trip regression" test guards against it
recurring). `targetId` (set when a decision like Bot Attack is deployed against a chosen
opponent) round-trips the same way and drives two things downstream: `target.*` impacts
apply to that player each turn (`applyTargetImpacts` in `calcEngine.ts`, called from
`resolveTurn`'s Step 2), and `buildIncomingAttacks` uses it to surface the "somebody
attacked you" hint + progressive "Dig Deeper" reveal (see README's *Attack Awareness &
Dig Deeper* section) — never derive one of these without the other; they read the same
`targetId`.

### Everything per-round is client-full-replacement, not incremental

`game:submitDecisions` sends the player's *entire* pending selection every time
(strategic/operational decisions + lawsuit filings); the server always treats it as a
full replacement for that in-flight turn, never a delta. Keep this in mind when touching
either the client submission logic (`GamePhase.tsx`) or `GameLoop.submitDecisions`.

### Two exceptions to "everything happens in resolveTurn": Dig Deeper and reconnection

Almost every gameplay effect only ever happens inside the turn-timer-driven
`resolveTurn`/`resolveGameTurn` cycle. Two things deliberately don't: `GameLoop.digDeeper`
(pay $10k to reveal the next tier of intel on an incoming attack) and
`GameEngine.rejoinRoom`/`markPlayerDisconnected`/`finalizePlayerRemoval` (session
resume after a disconnect). Both mutate `Company` state instantly, outside the turn
cycle — `digDeeper` still keeps `GameLoop` pure (no Prisma/Socket.IO in it; `GameEngine`
does the one-off write), but if you're looking for "why did this player's cash/state
change and I don't see it in `resolveTurn`," check these two paths first. The
disconnect-grace-period sweep (`GameEngine`'s heartbeat interval, `RECONNECT_GRACE_PERIOD_MS`)
mirrors the pre-existing stale-room cleanup (`STALE_ROOM_THRESHOLD`) pattern rather than
using a per-player `setTimeout` — extend that same interval, don't add a second one.

### Local LLM for narrated "annual report" text — best-effort, never load-bearing

`GameEngine.getAnnualReport` (triggered by `game:getAnnualReport`, opened from a rival's
Full Filing modal in `GamePhase.tsx`) is a third out-of-band, on-demand path alongside
Dig Deeper and reconnection above — but unlike those two, it's read-only (no `Company`
row is ever written) and it does real network I/O, so it's the one place in the server
that talks to something other than Postgres/Socket.IO: `server/src/services/llmService.ts`
calls a local `llama.cpp` server (the `llm` service in `docker-compose.yml`, model
mounted read-only from `./models/`) via its OpenAI-compatible `/v1/chat/completions`
endpoint, asking it to narrate one sentence of corporate-PR flavor text per active
decision on the target player, in place of the old fixed 3-4 pre-written
`competitorsView` strings from `game_engine.json`. `GameLoop.getActiveDecisionSummaries`
is the pure lookup that supplies what to narrate (decision name, description, elapsed
years) — re-derived server-side from the rival's own `Company.engineState`, the same
distrust-the-client pattern `digDeeper` uses for attack data, never from anything the
requesting client sent about the rival. Responses are cached in-process, keyed by
`decisionName#elapsedYears` (not per-player — the flavor text doesn't depend on who's
asking, so one generation serves every viewer for that decision/age combo). The whole
feature must degrade invisibly: `llmService` catches every failure (unreachable host,
non-200, timeout, empty/unparseable response) and returns the caller-supplied
`competitorsView` fallback text instead — nothing upstream ever sees an error, and the
game is fully playable with the `llm` container never started. Don't add a hard
dependency on this service being up anywhere; if you need to gate something on it, use
the same fallback-on-failure shape this module already has.

### Client: no path-based routing for game phases — `/admin` is the one real URL

`App.tsx` does **not** use react-router `<Routes>`/`<Route>` to switch between
Matchmaking/GamePhase/GameOver. WAITING/GAME_PHASE/AFTERMATH are server-authoritative
`currentPhase` values with no deep-link value (no room id in the path, nothing
bookmarkable), so `App.tsx` renders the matching component directly off `currentPhase`
in a plain `switch`, with no URL change at all — the address bar stays wherever the
player landed (`/`, or `/?room=<id>` from an invite link) for the entire game. This
used to be routed (`navigate('/game', {replace:true})` etc.) with the URL kept in sync
via an effect; that layer was removed because it added indirection (a sync effect, a
dead-end redirect in `GamePhase.tsx` for a case that can't happen without routes, a
catch-all `Navigate`) without buying anything routing normally would — no bookmarking,
no independent back/forward semantics, no code-splitting by route. Don't reintroduce
phase-driven `navigate()` calls; if a phase needs to react to entering/leaving, do it
with a plain `useEffect` on `currentPhase`, not a route change.

`/admin` (`AdminPortal.tsx`) is the one genuine URL in the client — checked first in
`App.tsx` via `window.location.pathname.startsWith('/admin')`, ahead of both the
`isRejoining` gate and the phase switch, since it's a completely independent surface
that has no relationship to game state at all. `react-router`'s `BrowserRouter` still
wraps the app (kept in `main.tsx`) purely for `Matchmaking.tsx`'s `useSearchParams`
(reads the `?room=` invite-link query param) — not for its routing.

### Admin portal — env-var token, REST-only

`/admin` is gated by a single shared secret (`ADMIN_TOKEN`), checked by
`server/src/middleware/adminAuth.ts` on every `/api/admin/*` request via the
`x-admin-token` header (constant-time compare). There's no broader auth system in this
app (see the *Reconnection & Session Resume* trust model — player identity is just an
unauthenticated id pair), so this is deliberately the simplest thing that works: one
token, no users, no expiry, and it **fails closed** — if `ADMIN_TOKEN` isn't set, the
admin API returns 503 rather than silently accepting any request. The token is never
baked into the client bundle; `AdminPortal.tsx` prompts for it at runtime and keeps it
in `sessionStorage`, sending it as a header on each request — don't add an
`ADMIN_TOKEN`-shaped `VITE_*` env var, since anything under `VITE_*` ships in the public
client bundle. `GameEngine.getAdminRoomsSnapshot()` is a synchronous, in-memory-only
read (no Prisma) — it's a monitoring snapshot of every room in every phase, distinct
from the `room:list` Quick Play handler (WAITING-only, non-full rooms only).

The decision library and game config are now genuinely writable from here (see next
section) — `POST`/`PUT`/`DELETE /api/admin/decisions` and `PUT /api/admin/config`, each
validated by `decisionDefinitionSchema`/`gameConfigSchema` in `validation/schemas.ts`
before touching the DB. Room monitoring is polled every 5s in `AdminPortal.tsx`;
decisions/config are deliberately fetched once (on auth, and again after a successful
save) rather than polled, so a background poll can never silently clobber an admin's
in-progress edit — see the comment at the top of `AdminPortal.tsx`. Editing is raw-JSON
`Textarea` + server-side Zod validation, not a structured form per field — proportionate
given `DecisionDefinition.impacts` is an open-ended nested record; if you're tempted to
build a bespoke form for one field, prefer improving the Zod error messages instead.

### Decisions/config are DB-backed, not static JSON — live-reloaded on every admin edit

`game_engine.json`/`game_config.json` (`server/src/data/`) used to be loaded once at
server startup and held in memory for the life of the process. They're now **seed-only**
— `Decision`/`GameConfigRow` Prisma models are authoritative at runtime, populated by
`prisma/seed.ts` (`npm run db:seed`, idempotent — safe to re-run; also the disaster-
recovery path: `npx prisma migrate reset && npm run db:seed`). Editing the JSON files
directly has **no runtime effect** once the DB is seeded — don't "fix" a decision by
editing `game_engine.json`, use `/admin` (or edit the DB directly and re-run
`loadGameData`/restart).

`GameEngine.loadGameData()` (called once in `index.ts`'s `start()`, awaited *before*
`httpServer.listen()` so no socket can connect first) reads both tables and constructs
`GameLoop`. Every admin write (`upsertDecision`/`deleteDecision`/`updateGameConfigData`)
writes the DB row and then calls the exact same `GameLoop.loadDecisions()` /
`GameLoop.updateConfig()` used at startup — this is a deliberate reuse, not a separate
"hot reload" code path, and it takes effect on the very next turn resolved anywhere, no
restart needed. `GameEngine.decisionsByName`/`gameConfig` are the in-memory mirrors kept
in sync with every write; `getDecisionsSnapshot()`/`getGameConfigSnapshot()` read them
back out for the admin GET routes and the `game:deck` broadcast.

**Deleting a decision is guarded, not just validated.** Several places in
`GameLoop.resolveTurn`'s hot path dereference a decision instance's `.definition`
without a null check (e.g. `d.definition.decision`, `.description`, `.impacts` in
`gameLoop.ts`) — removing a definition still active in a live game would crash the next
turn resolution for whoever has it deployed. `GameEngine.deleteDecision` checks (via
`isDecisionInUse`, a full scan of every non-bankrupt company's
`engineState.activeDecisions`) whether the decision is currently deployed anywhere and
rejects with `{ reason: 'in_use' }` (409) if so, before touching the DB. If you add
another way to remove/rename a decision, keep this guard — don't assume the hot path
tolerates a missing definition, only one place (`getActiveDecisionSummaries`, for the AI
annual-report feature) was ever made to.

### Formulas are DB-backed — but only the pure-math half of FORMULAS.md

FORMULAS.md §2-§7 (competitiveness/market share, volume, P&L, balance sheet, legal-risk
probability, risk gauge) is a mix of two different kinds of content, and only one kind
is DB-backed:

- **Pure, scalar, named-input math** — e.g. `competitiveness_i = (1/price_i) * (1 +
  wq*processingLevel_i + ...)` — 23 named formulas, each a single arithmetic expression
  over fixed named inputs. **These live in the `Formula` table**
  (`key`/`expression`/`description`), seeded from `server/src/engine/defaultFormulas.ts`
  (the single source of truth both `prisma/seed.ts` and `calcEngine.test.ts`/
  `gameEngine.test.ts` build their fixtures from — never fork this list), and are
  editable live from `/admin`'s Formulas tab.
- **Everything procedural/order-dependent elsewhere in FORMULAS.md** (the VAIHE A-G
  execution order, depreciation ledger iteration §1, decision maturity/exclusion locking
  §9-10, bankruptcy waterfall distribution §11/§16, simultaneous-purchase FIFO §14) is
  **not** represented as data — it's control flow, loops over dynamic collections, and
  multi-player ordering guarantees, not "a formula" in the tunable-math sense. This stays
  as TypeScript, unchanged, and always will — don't try to make it data-driven too.

`server/src/engine/formulaEngine.ts` is a small hand-rolled recursive-descent
parser/evaluator — **deliberately not `eval`/`new Function`/`vm`**, since those can be
escaped for arbitrary code execution, a categorically worse risk than a math typo. The
grammar is fixed and tiny: number literals, identifiers, `+ - * /`, unary `-`,
parentheses, and exactly two whitelisted calls, `MIN`/`MAX` — nothing else (no member
access, no assignment, no string literals, no arbitrary function calls). If you ever
need a new builtin (e.g. `ABS`), add it to the whitelist in `formulaEngine.ts`
deliberately — never reach for `eval`/`Function`/`vm` instead, no matter how small the
shortcut seems.

`calcEngine.ts`'s 7 exported functions each take a `FormulaSet` (`Map<string,
CompiledFormula>`) and call `evalNamed(formulas, 'key', context)` instead of inline
arithmetic — a mechanical refactor, not a rebalancing; the seeded expressions match the
old hardcoded behavior exactly. `GameLoop.loadFormulas()` mirrors `loadDecisions()`'s
live-reload pattern (safe to call again any time, replaces the set outright) and
`GameEngine.updateFormula()` calls it after every write, same "no restart needed" story
as decisions/config.

**The formula key set is fixed — no create/delete via `/admin`, only `PUT`.** Each of
the 23 keys is referenced by name at a specific `calcEngine.ts` call site
(`evalNamed(formulas, 'competitiveness', ...)` etc.) that `GameLoop` hard-depends on;
there's no guard that could make "delete a formula" safe the way `isDecisionInUse` makes
decision deletion safe, so the option doesn't exist at all. **Every write is validated
twice before it reaches `GameLoop`**: `parseFormula` (real syntax check, not a regex)
and a fixed per-key variable whitelist (`FORMULA_VARIABLES` in `validation/schemas.ts`,
via `collectIdentifiers`) — an expression that parses fine but references a variable
`calcEngine.ts` never supplies at that call site would otherwise throw `FormulaEvalError`
mid-turn, for every active game, the next time it's evaluated. If you add a new formula
or change what a call site passes into `evalNamed`, update `FORMULA_VARIABLES` in the
same change — it must stay in sync with the actual `evalNamed` call sites or the
whitelist silently stops protecting anything.

### JSONB game state, typed columns only for what needs querying

`Company.variables`, `Company.engineState`, and `Company.lastTurnSnapshot` are JSON
columns so `GameLoop` can read/write the full per-player engine state atomically each
turn without a schema migration per new field. `cash`/`debt` are kept as separate typed
Decimal columns purely for fast queries (bankruptcy checks, standings). Don't promote
engine-state fields to typed columns unless they need to be queried outside the engine —
that defeats the point.

### Shared types live in `shared/src/`

`shared/src/index.ts` — room/player/socket-event types, enums, payloads (client +
server both import from `@suetheirasses/shared`). `shared/src/gameTypes.ts` — engine
types (`DecisionDefinition`, `PlayerVariables`, `LegalCaseData`, `TurnResolutionResult`,
`GameConfig`). When adding or changing a socket event payload or engine type, edit here
first — both workspaces resolve `@suetheirasses/shared` straight to `shared/src/index.ts`
via path alias (see `vite.config.ts` / `vitest.config.ts` in client and server), so no
build step is needed to see changes during dev, only for production builds.

### Test layers, and which one to reach for

- `server/src/**/*.test.ts` — Vitest, fast, no Docker. `engine/*.test.ts` (GameLoop,
  calcEngine, decisionEngine, legalEngine) needs no mocking at all — pure input/output.
  `formulaEngine.test.ts` is the security-relevant one — parser correctness plus
  explicit checks that dangerous-looking input (`__proto__`, `constructor`, arbitrary
  function calls) is rejected as invalid syntax, never silently evaluated. `GameLoop`
  requires `loadFormulas()` to have been called before any turn resolves (its
  `formulas` field defaults to an empty `Map`) — `gameLoop.test.ts`'s `beforeEach`
  calls `gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS)` right after construction, and
  `calcEngine.test.ts` builds one shared `DEFAULT_FORMULAS` `FormulaSet` from the same
  seeds and passes it to every call — both exercise the *real* production formulas,
  not a stand-in, so a bug in the seeded expressions would show up as real test
  failures. `socket/gameEngine.test.ts` mocks Prisma + `Server` since that's where the
  actual DB writes and socket emits happen; it also mocks `services/llmService.js` (via
  `vi.mock`) so `getAnnualReport` tests don't hit a real network —
  `services/llmService.test.ts` covers the actual fetch/fallback/caching logic
  separately, with `global.fetch` mocked (no live `llm` container needed to run the
  suite). Its `beforeEach` is `async` and calls `await engine.loadGameData()` right
  after construction (decisions/config/formulas load from the mocked
  `decision`/`gameConfigRow`/`formula` Prisma models, seeded from the real
  `game_engine.json`/`game_config.json`/`defaultFormulas.ts` so existing content-
  dependent assertions — e.g. the `getAnnualReport` "Bot Attack" tests — keep passing
  unchanged). Use this layer for engine math, decision/legal rules, validation schema
  logic, and room/phase lifecycle.
- `client/src/**/*.test.ts` — Vitest, Zustand stores and pure UI utilities.
- `tests/api/*.test.ts` — Vitest + real Postgres via testcontainers (needs Docker).
  The only layer that actually verifies socket event contracts end-to-end
  (`game:submitDecisions`, `turn:resolved`, `game:over`) against a real Prisma schema.
  Reach for this when a change touches the room/DB/socket boundary, not engine-internal
  math.
- `tests/e2e/*.spec.ts` — Playwright, full browser + live client dev server + backend.
  Use for lobby/matchmaking flows and phase transitions a user would actually click
  through.

### Deliberate deviations from the design spec

`FORMULAS.md` (§6/§13) specifies that every decision with `legalRisks` automatically
generates a lawsuit from every other player the instant it's deployed. The implemented
behavior is different by explicit product decision: lawsuits are filed deliberately by
players via `game:submitDecisions`'s `lawsuits` array, priced by `LegalEngine.fileLawsuit`
against the ground's probability schedule at the target decision's elapsed time. If a
task asks you to "match FORMULAS.md exactly" on this point, flag the conflict rather than
silently reverting the deliberate-filing design — see README's *Lawsuits* section and
`GameLoop`'s Step 8 / `LegalEngine.fileLawsuit` for context.
