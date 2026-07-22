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

### Never broadcast `roomState.room` directly — its embedded `players` array goes stale the moment a second player joins

`RoomState.room` (`Room`, the shared type) carries its own embedded `players: Player[]`
array — but that array is only ever populated once, from the single founding player
Prisma's `room.create` returns in `GameEngine.createRoom`. Nothing keeps it in sync
afterward: `joinRoom`, kicks, `leaveRoom`, host reassignment all mutate the *separate*
live roster (`roomState.players`, a `Map`), never `roomState.room.players`. Any code that
broadcasts `{ room: roomState.room, ... }` straight from a `RoomState` is therefore
sending a snapshot frozen at room-creation time — this was a real, shipped bug (the kick
handler's "sync the roster for remaining players" step did exactly this, via a reused
`room:joined` broadcast) that surfaced as "the host is shown as a plain player to someone
else." `GameEngine.buildRoomSnapshot(roomState)` exists specifically to rebuild `players`
fresh from `roomState.players` every time — use it (or `buildRoomJoinedPayload`, which
calls it) for every outbound `Room`, never read `roomState.room.players` for anything a
client will see.

The `room:updated` broadcast (kick, `room:leave`, host reassignment, `room:setInviteOnly`)
compounds this: the old code also sent one shared `player: host` field to the *entire*
room via `room:joined`, silently overwriting every other recipient's own identity with
the kicking host's. `room:updated`'s payload deliberately carries no `player` field at
all — there's no single "the player" for a whole-room broadcast. Each client instead
matches its own id inside the fresh `room.players` array (see `socketStore.ts`'s
`room:updated` handler) to refresh its own `isHost`/etc. — the only way a newly-promoted
host's own view of themselves updates too, not just how others see them.

A third, purely client-side bug landed in the same "host shown as a plain player" family:
`Matchmaking.tsx`'s roster row rendered `p.isHost ? 'Host' : 'Player'` for each `Badge`,
but had a bug where it read the outer `isHost` (`const isHost = player.isHost` — *the
viewing player's own* host status) instead of `p.isHost` (the status of the player *that
row is for*). Every row rendered the viewer's own host-ness, so a non-host viewer saw
`Player` on the actual host's row too. When rendering a list of players and showing
per-player state, always double-check which variable a JSX expression is actually
closing over — `isHost` and `p.isHost` reading as interchangeable at a glance is exactly
how this slipped through.

### Kicked-player rejoin blocking is name-based, not a real ban — same trust model gap as everywhere else in this app

`RoomState.kickedNames` (a `Set<string>`, checked in `joinRoom`) blocks a fresh
`room:join` reusing a just-kicked name, whether via invite link or Quick Play. This is
deliberately simple and imperfect: since this app has no auth (see README's *Reconnection
& Session Resume* trust model — a player id pair is the only "credential" anywhere), a
kicked player's DB row is fully deleted, so there's no persistent identity left to ban
against — a name is the only signal available without adding real accounts. A determined
player can still rejoin under a different name; don't try to "fix" this with
fingerprinting/IP tracking/etc. without an explicit product decision to add real auth
first, since that would be a much bigger scope change than this mechanism is meant to be.

Quick Play's candidate loop (the `searchForRoom` branch of the `room:join` handler) must
treat a `joinRoom` rejection from *any* cause as "this room's not usable, try the next
one" — not just the `'Room is full'` race it originally special-cased. The first version
only tolerated that one message and re-threw everything else, so a kicked player whose
Quick Play search happened to consider the very room that kicked them got a hard
`KICKED_FROM_ROOM` error instead of the search quietly moving on — a real shipped bug.
Quick Play has no business surfacing a room-specific rejection reason at all; it means
"any room, or a new one," so the loop's catch block should stay a blanket `continue`
regardless of what future reasons `joinRoom` might grow to throw for.

### `Matchmaking` never unmounts across a room ↔ landing transition — local component state must be reset explicitly, or it leaks into whatever's next

`App.tsx` switches phases by re-rendering different JSX inside the *same* `Matchmaking`
component instance (`if (room && player) return <RoomLobby/>; return <LandingPage/>;`) —
there is no route change, no remount, nothing that would naturally reset local `useState`
between "in a room" and "back on the landing page." Two real bugs in this session came
from the same root cause, forgetting that:

- `isCreating`/`isSearching` (drive the landing page's `LoadingOverlay`) were only ever
  set `true`, never reset back to `false` on a *successful* join — invisible for as long
  as a successful join immediately swaps to the room-lobby render (which doesn't render
  the overlay at all), but the moment **Leave Room** made "go back to the landing page"
  a reachable transition, the stale `true` from however the player originally got into
  the room surfaced as a spinner stuck over an otherwise-unusable landing page.
- `chatMessages` (lobby chat history) persisted across `room:leave`/being kicked/rejoining
  a different room, since nothing ever cleared it — a room's chat log leaking into the
  next room's chat window.

Both are fixed the same way: a `useEffect` keyed on `room`/`room?.id` that resets the
relevant local state on every transition across the room/no-room boundary, rather than
relying on unmount. If you add more local state to `Matchmaking` that's conceptually
"scoped to the current room" (or "scoped to being on the landing page"), reset it the
same way — don't assume a phase change ever tears the component down for you.

### Everything per-round is client-full-replacement, not incremental

`game:submitDecisions` sends the player's *entire* pending selection every time
(strategic/operational decisions + lawsuit filings); the server always treats it as a
full replacement for that in-flight turn, never a delta. Keep this in mind when touching
either the client submission logic (`GamePhase.tsx`) or `GameLoop.submitDecisions`.

### Queued (not-yet-resolved) decisions and lawsuits render as lightweight stand-ins, not by reusing the resolved-state cards

"Active Strategies" and "Open Lawsuits" used to render only server-authoritative,
already-resolved state (`myData.activeDecisions` / `myData.legalCases`) — nothing queued
this turn (`pending.strategic`/`operational`/`lawsuits`, the exact same client-local state
the Decision Deck and Sue modal already read/write) showed up there at all, even though
both boxes are the natural place a player would look to confirm what they've picked. Both
now merge `pending`'s entries into the same list, marked with the same red `QUEUED`
`gpStyles.stamp` badge the Decision Deck already uses for consistency — but via two new,
deliberately lightweight components (`QueuedDecisionCard`, `QueuedLawsuitCard`), not by
stretching `ActiveDecisionCard`/`CaseCard` to accept a queued entry. A queued
`SubmittedDecisionEntry` (`{ name, targetId? }`) has no `id`/`deployedYear`/maturity data
yet — that only exists once a decision has actually been deployed by a turn resolving —
and a queued `SubmittedLawsuitEntry` (`{ targetId, decisionName, groundName }`) has no
`id`/`stakes`/`status`/`offers` yet either, since the real `LegalCaseData` isn't created
until `LegalEngine.fileLawsuit` runs at the next turn resolution (Step 8). Don't try to
paper over the shape mismatch with optional fields on the resolved-state components;
these are two different lifecycle stages of the same thing, not one type with some fields
sometimes missing.

Both queued-card types carry their own removal action (`onCancel`/`onRemove`), reusing the
exact same `pending` mutation the Decision Deck's toggle and the Sue modal's
`handleRemoveQueued` already perform — `submitPending({ ...pending, [bucket]:
pending[bucket].filter(...) })` — so cancelling from "Active Strategies"/"Open Lawsuits"
is not a separate code path, just the same state update triggered from a third location.
Since `game:submitDecisions` is full-replacement (see above), every one of these three
locations independently calling `submitPending` with a locally-filtered copy of `pending`
is exactly as correct as the two that already existed.

### Four exceptions to "everything happens in resolveTurn": Dig Deeper, reconnection, forfeit, and lawsuit filing fees

Almost every gameplay effect only ever happens inside the turn-timer-driven
`resolveTurn`/`resolveGameTurn` cycle. Four things deliberately don't: `GameLoop.digDeeper`
(pay $10k to reveal the next tier of intel on an incoming attack), `GameEngine.rejoinRoom`/
`markPlayerDisconnected`/`finalizePlayerRemoval` (session resume after a disconnect),
`GameEngine.forfeitGame` (the "Leave Game" button's voluntary instant bankruptcy), and
`GameLoop.chargeLawsuitFilingFee` (pay `gameSettings.lawsuitFilingCost` the instant a player
actually files via SueModal's "File" button). All four mutate `Company`/`Player` state
instantly, outside the turn cycle — `digDeeper` and `chargeLawsuitFilingFee` both keep
`GameLoop` pure (no Prisma/Socket.IO in either; `GameEngine.digDeeper`/`GameEngine.fileLawsuit`
do the one-off writes), and `forfeitGame` writes `bankrupt: true` directly rather than going
through a turn's normal bankruptcy-check step — but if you're looking for "why did this
player's cash/state change and I don't see it in `resolveTurn`," check these four paths
first. The disconnect-grace-period sweep (`GameEngine`'s heartbeat interval,
`RECONNECT_GRACE_PERIOD_MS`) mirrors the pre-existing stale-room cleanup
(`STALE_ROOM_THRESHOLD`) pattern rather than using a per-player `setTimeout` — extend that
same interval, don't add a second one.

`chargeLawsuitFilingFee` only ever moves cash — the lawsuit itself is still exclusively
created/validated later, inside `resolveTurn`'s Step 8 (`LegalEngine.fileLawsuit`), via the
normal `game:submitDecisions` full-replacement flow. The client calls `game:fileLawsuit`
first (SueModal's "File" button) and only queues the `{ targetId, decisionName, groundName }`
entry into its pending submission (which is what Step 8 actually reads) once that charge
succeeds. By product decision, a successfully-charged fee is **never refunded**, even if
Step 8 later rejects the case (e.g. the target no longer has the cited decision deployed
by the time the turn resolves) — filing is treated as a real, deliberate action the instant
it's paid for, not something contingent on the case surviving to be created. Capped at
`gameSettings.maxLawsuitsPerPlayerPerTurn` using `GameLoop`'s in-memory `submissions` map
(this player's currently-queued lawsuit count for the room) — the same limit Step 8's own
`.slice(0, maxLawsuits)` guard enforces on the case-creation side, so a client can't rack up
fee charges for filings that would be silently dropped anyway. `GamePhase.tsx`'s CASH KPI
doesn't pick this up until the *next* `turn:resolved` unless the client also patches it
locally — `gameStore.applyFileLawsuitResult`, driven by a `game:fileLawsuitResult` listener
in `socketStore.ts`, exists specifically for that (same "must patch the store or the UI
shows stale cash" requirement as `applyDigDeeperResult`; this was a real gap during this
feature's own manual verification — the DB write was correct but the KPI didn't move until
the fix).

`forfeitGame` is also the one place that calls `resolveGameTurn` *early* rather than
outside it — see *Ready-up triggers `resolveGameTurn` early* below for why that has to be
done via a returned flag (`triggerImmediateResolution`) rather than a direct call from
inside `forfeitGame` itself.

### Ready-up triggers `resolveGameTurn` early — and never calls it from inside a method still holding `advancingRooms`

The "Ready" toggle (`game:ready` → `GameEngine.toggleReady`) doesn't change what a turn
computes — it's purely a timing trigger. Once every active (non-bankrupt) player's id is
in `RoomState.readyPlayerIds`, the caller clears the round timer and calls
`resolveGameTurn` immediately instead of waiting out the rest of it. `readyPlayerIds` is
reset to empty at the start of every new round (inside `resolveGameTurn`'s "loop into next
round" branch, and once more when `room:startGame` first enters GAME_PHASE) — extend both
reset points if you add another way a round can start.

`resolveGameTurn` guards against concurrent turn resolution with the `advancingRooms` lock
(a room id in the set means a resolution is already in flight; a second call is a no-op).
`forfeitGame` also acquires this same lock for its own duration, since it mutates
overlapping room/player state. This means `forfeitGame` can never call `resolveGameTurn`
directly from inside itself — the lock it's still holding would make that inner call
silently no-op. Instead, when a forfeit happens to be the thing that makes every remaining
active player ready, `forfeitGame` returns `{ triggerImmediateResolution: true }` and the
*caller* — after `forfeitGame`'s `try/finally` has already released the lock — is the one
that calls `resolveGameTurn`. Follow this same "return a flag, let the caller trigger it"
shape for any other early-resolution path that itself needs to run inside `advancingRooms`.

### A bankrupted player's Company row needs its negative cash written explicitly — it's not in `companyUpdates`

`GameLoop.resolveTurn`'s Step 12 only builds a `CompanyPersistUpdate` for
`playersStillActive` — a player who just crossed `cash < 0` this turn is deliberately
excluded (`gameLoop.test.ts`'s "should not include a company update for a player it just
bankrupted" documents this), since their engine state (decisions, legal cases, etc.) is
done being touched for good. This was a real, shipped bug: nothing else ever persisted
their actual negative cash to the DB either, so their `Company.cash` column stayed frozen
at whatever positive value it had from their last still-active turn — including on the
Game Over / Final Standings screen, which reads `cash` straight from the DB via
`buildGameOverPayload`. A bankrupted player could show up with a *positive* final balance
despite having just lost on negative cash.

Fixed via `BankruptedPlayer.finalCash` — `resolveTurn` snapshots `ctx.vars.cash` (still the
real negative value; the bankruptcy waterfall in the same step only pays *out of* it to
plaintiffs, never overwrites it) onto each `bankruptedPlayers` entry, and
`GameEngine.resolveGameTurn` writes it to that player's `Company.cash` in the same loop
that flags `Player.bankrupt = true`. If you ever change what counts as "still active" in
Step 10, or add another path that can bankrupt a player outside `resolveTurn` (`digDeeper`
can't — cash only goes down there, never negative-eligible in a way that skips this step —
but any future one might), make sure it persists a real final cash figure the same way;
don't assume `bankrupt: true` alone is a complete write.

### KPI history + prediction graphs — the prediction reuses `resolveTurn` itself, sandboxed behind a fake room id

Every clickable stat in `GamePhase.tsx` — the 4 top KPI cards, Threat Level, and every
individual tracked-field row inside their breakdown views (`CashWaterfallView`,
`RevenueView`, `EquityView`, `ShareView`, `ThreatView`) — opens the same generic
`KpiHistoryGraph`, keyed by a dot-path into a `KpiSnapshotPoint` (`'variables.cash'`,
`'derived.equity'`, the bare `'riskGauge'`, etc.) rather than one bespoke component per
field. Deliberately generic: adding a new clickable field anywhere is a one-line change
(a `field` string on a row), not a new backend endpoint. Purely computed intermediate
rows in the waterfall breakdowns (COGS, gross profit, EBITDA, EBIT, profit before tax,
net profit, market equity, net demand) are **not** clickable — there's no single tracked
field for them in `KpiSnapshot`/the prediction output, since they're derived-of-derived
inside the view component itself, not persisted anywhere.

**History** is one `KpiSnapshot` row per player per round (`variables`/`derived`/
`riskGauge`, the same shape `turn:resolved` already carries per player), written by
`GameEngine.persistKpiSnapshots` from both `resolveGameTurn` and `broadcastInitialSnapshot`
(round 1) — `upsert`, not `create`, so a hypothetical double-write for the same round is
harmless rather than a unique-constraint crash. `GameLoop` itself never touches this table
— same read/write split as `Company`, `GameLoop` stays pure.

**Prediction** (`GameLoop.predictFutureKpis`) is the more interesting piece: rather than
reimplementing a subset of the 9-step turn math (risking drift from FORMULAS.md), it
calls `resolveTurn` **itself**, `turnsAhead` times in a row, sandboxed behind a synthetic
room id (`` `__predict__${playerId}` ``) that was never passed to `submitDecisions` — a
room id `this.submissions` has no entry for always reads back as "nobody submitted
anything" (the same lookup `resolveTurn` does for a real room), so Step 1
(`processNewDecisions`) and Step 8 (lawsuit filing) both no-op for every player in the
sandbox automatically. Nobody deploys anything new or sues anyone during the simulated
turns; only already-active decisions keep maturing (`advanceAndApply` increments
`elapsedYears` unconditionally, independent of any submission). The target player's own
snapshot evolves iteration to iteration (fed forward from each call's `companyUpdates`);
every rival is held **frozen** — the exact same original snapshot is re-fed on every
iteration, never advanced — which is the literal implementation of the product decision
that a prediction "assumes the player's own decisions apply but not other players'."
Competitiveness/market share still get recomputed each iteration (they're relative, so
the target's own growth can still shift the split against static rivals), but a rival's
decisions never mature and rivals never deploy, sue, or get sued by anyone further.

Two things worth knowing before touching this:
- `round` passed to each sandboxed `resolveTurn` call must be the room's real, current
  round plus an offset (**not** a small fabricated counter like 1, 2, 3) —
  `applyDepreciation` (calcEngine.ts) computes `currentYear - entry.purchaseYear` for
  every existing depreciation ledger entry, so a fake absolute round number desyncs
  every entry's remaining-years countdown even though `elapsedYears`-keyed schedule
  lookups (the decision impact math itself) don't care about the absolute value.
- Because this reuses the real engine wholesale rather than composing individual steps,
  the target's existing `negotiating` legal cases still run through the real
  negotiation-timeout/trial-resolution logic inside the sandbox — including its random
  verdict draw, if `turnsNegotiating` crosses `negotiationPeriodTurns` within the
  predicted window. This is accepted, not suppressed: it's a real mechanic driven by the
  player's own existing situation, and reusing the real engine (not an approximation)
  was the whole point. Two predictions requested back to back *can* differ if a case
  happens to resolve inside the window — expected, not a bug. Stops early
  (`bankruptAtRound` set, fewer than `turnsAhead` points) if the target would go bankrupt
  partway through — nothing meaningful to project past that.

`gameLoop.test.ts`'s `predictFutureKpis` suite includes a regression test that a queued
decision for the *real* room still applies after a prediction runs — the thing this
sandboxing approach exists to guarantee never breaks.

**Rivals get the same graph, history only, never a prediction.** Every mini-stat in a
rival's `RivalDossier` (CASH/REVENUE/EQUITY/STOCK VALUE/DEBT) and every row in their Full
Filing report (`RivalFullReportView`) is clickable the same way your own KPIs are, opening
the same `KpiHistoryGraph` — but by deliberate product decision (predicting a rival's
future from *their own* decisions was considered and explicitly rejected), a rival lookup
never calls `predictFutureKpis` at all; `GameEngine.getKpiHistory`'s third parameter,
`includePrediction`, is `false` for any target other than the requester's own id, and the
method returns early with `predicted: []` before touching `loadActiveCompanyPlayers` or
the sandboxed `resolveTurn` machinery. `game:getKpiHistory`'s payload (`GetKpiHistoryPayload
{ targetPlayerId? }`, validated by `validateKpiHistoryRequest`) carries which player's data
is being asked for — omitted or equal to the caller's own id means self; anything else is
treated as a rival lookup. The `kpiSnapshot.findMany` query itself is scoped to
`player: { roomId }` (the same distrust-the-client, scope-via-room pattern `getAnnualReport`
already uses) rather than a separate existence/membership check — a `targetPlayerId` for a
player who isn't actually in this room just comes back with an empty `history`, never an
error or another room's data.

`KpiHistoryResponse` carries a `playerId` field specifically so the client can tell two
concurrently-open graphs apart. `GamePhase.tsx` can have two `KpiHistoryGraph` instances
mounted at once (a top-level graph plus a stacked sub-field one, e.g. your own CASH card
open alongside a rival's Full Filing "Operating expenses" row) — each instance's response
handler checks `payload.playerId === targetPlayerId` before applying a response, so a
stale reply for a since-closed graph can never flash the wrong player's numbers into a
still-open one. If you add a third place `KpiHistoryGraph` can be nested, keep this check;
don't assume "the only listener for `game:kpiHistoryResult`" is safe to skip it.

### Trend arrows (up/down/no-change) are computed client-side, from whatever the client already has in memory — no new server data

Every KPI value on screen — the 4 top cards, Threat Level, every rival mini-stat, and
every individual row inside every breakdown view (`CashWaterfallView`, `RevenueView`,
`EquityView`, `ShareView`, `ThreatView`, `RivalFullReportView`) — shows a small up/down/
no-change icon next to its value. This is deliberately **not** built on the KPI history
feature above: it only ever diffs the current turn's snapshot against the *one* previous
turn's snapshot already sitting in client state (`prevData`/`prevCompetitors` in
`GamePhase.tsx`, populated by the existing turn-sync effect), via the pre-existing
`computeTrend(current, previous)` helper — no new socket round trip, no new server
endpoint. `computeTrend` returns `undefined` (nothing rendered) when there's no previous
turn to compare against (round 1, or a rival never seen before), `'same'` when the two
values are within `computeTrend`'s epsilon (a genuine "unchanged" reading, distinct from
"no data yet"), and `'up'`/`'down'` otherwise.

`TrendIcon` (`{ trend, invert, size }`) is the one component every one of the call sites
above renders through — `IconTrendingUp`/`IconTrendingDown`/`IconMinus`, colored green/
red/gray. `invert` flips which direction reads as "good": costs (Operating expenses,
Staff cost, Debt, Depreciation, Finance cost, Tax cost, COGS), Outrage, Scrutiny, legal
exposure ratio/Threat Level itself, and price/process-loss in the Share factor grid are
all `invert`; everything else defaults to "up is good." Get this wrong for a new field
and the arrow will be colored backwards, not merely mislabeled — check which direction is
actually favorable before wiring a new row in.

Two categories of row need a little more than "diff a persisted field":
- **Computed-only rows with no backing `KpiSnapshot` field** (COGS, gross profit, EBITDA,
  EBIT, profit before tax in `CashWaterfallView`; book/market equity totals in
  `EquityView`; the three weighted terms + total in `ThreatView`; net demand in
  `ShareView`) get their previous value by **recomputing the same formula against
  `prevData`** rather than a field lookup — see `computeCashWaterfall`, `computeEquity`,
  `computeThreatTerms`, each called once for the current turn and once (if `prevData`
  exists) for the previous one, so the two totals a trend arrow diffs always come from
  the exact same math. If you change one of these formulas, you're changing both calls at
  once (they're one shared function) — no risk of the live value and its trend silently
  drifting apart, but also no separate "trend formula" to keep in sync by hand.
- **Rows with a real dot-path field** reuse `getKpiFieldValue` (originally written only
  for `KpiSnapshotPoint` rows out of `KpiHistoryResponse`) — its parameter type was
  loosened to a structural `{ variables, derived, riskGauge }` shape so it also accepts a
  plain `PlayerTurnResult` (`prevData`/`prevRival`), which has the same three fields plus
  extras TypeScript ignores. This is *not* a call to `game:getKpiHistory` — it's a pure
  local read of whatever `PlayerTurnResult` object is already sitting in state.

Rival trend arrows for the 5 mini-stats and Full Filing rows work exactly like your own,
sourced from `prevCompetitors`/`prevRival` (only ever the *one* previous turn — not the
full `KpiSnapshot` history a rival's clicked-through graph fetches separately). The market
share bar in `ShareView` goes one step further: **every** player's row shows a trend arrow
(sourced from `prevData` for your own row, `prevRivals.get(playerId)` for each rival's),
even though only your own row is clickable — the arrow is a passive "who's gaining/losing
share" read, not a graph-opening affordance, so it doesn't need the click restriction the
history feature has (rival trend, unlike rival history, was never gated behind a decision
about predicting anyone's future).

### Local LLM for narrated "annual report" text — best-effort, never load-bearing

`GameEngine.getAnnualReport` (triggered by `game:getAnnualReport`, opened from a rival's
Full Filing modal in `GamePhase.tsx`) is a fifth out-of-band, on-demand path alongside
Dig Deeper, reconnection, forfeit, and lawsuit filing fees above — but unlike those, it's read-only (no `Company`
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
  logic, and room/phase lifecycle. `gameLoop.test.ts`'s "should not duplicate a case
  across turns" test and `gameEngine.test.ts`'s `toggleReady`/`forfeitGame`-ready-
  interaction tests are the regression coverage for the two gotchas documented above
  (`allCases` dedup, and the `advancingRooms`-lock-safe "return a flag" pattern for
  early turn resolution) — extend those, don't just re-verify the happy path, if you
  touch either area again. `gameEngine.test.ts`'s `buildRoomSnapshot` tests assert the
  rebuilt-fresh-every-time behavior directly (create a room, join a second player,
  confirm `roomState.room.players` is still stale at length 1 while the snapshot is
  correct at length 2) — that's the regression guard for the "host shown as a plain
  player" bug; its `promoteNewHostIfNeeded`/`leaveRoom` tests cover host reassignment.
  `gameLoop.test.ts` also has a regression test threading 3 sequential `resolveTurn`
  calls to prove a case forced to trial by the negotiation timeout (`turnsNegotiating`
  reaching `negotiationPeriodTurns`) resolves to a verdict the same turn it crosses the
  threshold — see *Deliberate deviations from the design spec* above for why this test
  exists (the trial-resolution loop was dead code before this fix).
- `client/src/**/*.test.ts` — Vitest, Zustand stores and pure UI utilities.
  `GamePhase.utils.test.ts` deliberately duplicates small pure functions out of
  `GamePhase.tsx` (`fmt`, `getGroundsAgainst`, `detectNewlySuedCases`,
  `detectNewlyResolvedCases`, etc.) rather than importing them, to keep this test file
  lightweight (no Mantine/tabler-icons import chain) — keep any duplicated copy in sync
  with the real implementation by hand if you change one side. `detectNewlyResolvedCases`
  is covered from both plaintiff and defendant perspectives, including the verdict-flip
  case (a `'lost'` verdict is a *win* for the defendant) — see *Post-turn info windows*
  above.
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

FORMULAS.md doesn't model a negotiation phase at all — a filed case just resolves via a
probability draw. This codebase's richer `'negotiating'` status, with a real settlement
negotiation flow on top (offer/counter/accept/go-to-court — see *"Settlement negotiation"*
below), is a further addition beyond spec.

### Settlement negotiation — a sixth exception to `resolveTurn`, plus a Step 8b fallback for whatever it doesn't resolve

A filed case starts `status: 'negotiating'`. Getting it out of that status is split
between two mechanisms, deliberately kept separate:

**Live negotiation** (`GameLoop.makeOffer`/`acceptOffer`/`goToCourt`, called from
`GameEngine.makeOffer`/`acceptOffer`/`goToCourt`) is instant and out-of-band — a sixth
member of the *"exceptions to resolveTurn"* family above (`digDeeper`, reconnection,
forfeit, lawsuit filing fees, and now this), fired over the socket the moment a player
clicks a button in `NegotiationPanel` (`GamePhase.tsx`), never gated by the turn timer.
Unlike every other exception, this one is **two-party**: a case is persisted into both
the plaintiff's and the defendant's own `Company.engineState.legalCases` (see the
`allCasesById` dedup section below), so every action here reads/writes *both* parties'
rows in one call, via `GameLoop.findCaseAndParties` and `LegalCaseActionOutcome`'s paired
`plaintiff`/`defendant` `LegalCaseSideUpdate`s. `GameEngine.persistLegalCaseAction` writes
both Company rows; `GameEngine.emitLegalCaseUpdate` sends the updated case to both
parties' sockets directly (via `roomState.players.get(playerId)?.socketId`) — **never a
room-wide broadcast**, since nobody but the two parties on a case has any business seeing
it. A disconnected party is silently skipped (their `socketId` is cleared by
`markPlayerDisconnected`); they pick up the persisted state on reconnect or the next
`turn:resolved` either way, same as every other instant action's disconnect handling.

The rules, enforced entirely server-side (never trust the client's idea of whose turn it
is): the **defendant always moves first** (`offers.length === 0`); after that, only the
role that did *not* make the most recent offer may respond — with a counter-offer
(`makeOffer` again) or by accepting it (`acceptOffer`, which settles the case immediately:
defendant pays plaintiff the offer's exact amount, `verdict: 'settled'`). **`goToCourt` is
never turn-gated** — either party can walk away and force a trial at any point, since
that's a unilateral decision in a way offering/accepting aren't. Crucially, `goToCourt`
only sets `status: 'awaiting_trial'` — it does **not** draw a verdict itself. The verdict
is drawn the next time this room's `resolveTurn` actually runs (whenever the round timer
or ready-up next triggers it), by the exact same trial-resolution loop that already
handles a case forced to `awaiting_trial` any other way — one verdict-drawing code path,
not two.

**Step 8b, inside `resolveTurn`**, is what catches everything live negotiation doesn't
resolve before a turn boundary — two distinct fallbacks for two distinct gaps:
- **A pending, unanswered offer** (`offers.length > 0` when the boundary hits — nobody
  accepted, countered, or went to court in time) is treated as accepted: the case settles
  right there for the last offer's amount, same cash-transfer shape as `acceptOffer`. This
  fires on the very *next* boundary after any offer is made — by construction, any
  exchange that never explicitly accepts or goes to court always has an unanswered offer
  sitting at the next check, so a case with active back-and-forth never reaches the second
  fallback below; it always settles this way first.
- **No offer ever made** (`offers` still empty) is the original gap this step was built to
  close before live negotiation existed at all: nothing else would ever move a case out of
  `'negotiating'` between two solvent players (the only other exit is the bankruptcy
  waterfall at Step 10b cancelling/settling it if a party falls), so it would sit forever.
  This keeps the original fixed-timeout fallback, unchanged: `turnsNegotiating` increments
  once per boundary the case is still negotiating (a case filed this same turn starts at 0,
  not 1 — see `negotiatingBeforeFiling`'s snapshot-before-filing ordering), and once it
  reaches `gameSettings.negotiationPeriodTurns` (2 by default), `status` is forced to
  `'awaiting_trial'` *in place*, before the existing trial-resolution loop runs later in
  the same `resolveTurn` call — so a case that crosses the threshold resolves to a verdict
  that same turn, not "starts waiting, resolves next turn." The client never observes an
  intermediate `awaiting_trial` snapshot for a case that timed out this way.

Both Step 8b branches write into `legalReceivedThisTurn` (declared up at Step 8b now,
not down at Step 9 where it used to live) exactly like a trial payout does, since a
same-turn settlement is just as real an income line for the §16 bankruptcy pool.
`gameLoop.test.ts`'s `"negotiation turn-boundary fallbacks (Step 8b)"` suite covers both
branches; the `makeOffer`/`acceptOffer`/`goToCourt` suites cover the live-negotiation
turn-taking rules directly.

### A `LegalCaseData` lives in two players' `engineState` at once — dedupe by id when reconstructing `allCases`

A filed case is persisted into **both** the plaintiff's and the defendant's own
`Company.engineState.legalCases` at the end of the turn it's active in (`resolveTurn`'s
Step 12) — each side needs it in their own persisted state to see it on their next turn.
`resolveTurn`'s Step 7 reconstructs `allCases` for the turn by reading every player's
`engineState.legalCases` back in — since the same case (same `id`) sits in two different
players' persisted lists, a naive concatenation double-counts it, and because Step 12
persists whatever it finds in `allCases` back into *both* parties' `engineState` again,
an undeduped list doubles again every subsequent turn (1 → 2 → 4 → …), eventually
surfacing as a React duplicate-key warning on the "Open Lawsuits" / "YOU'VE BEEN SUED"
lists client-side. `allCases` is built via a `Map<id, LegalCaseData>` specifically to
prevent this (`gameLoop.ts`'s Step 7) — keep that dedup if you ever touch how `allCases`
is assembled; `gameLoop.test.ts`'s "should not duplicate a case across turns" regression
test resolves 3 turns in a row and asserts the count stays at 1 the whole way.

### A case's probability chip is defendant-only — the plaintiff's side is a deliberately unclickable "Unknown", not a second data source

`CaseCard`'s header shows a colored percentage chip (`semaphoreLevel(displayProb)`,
`displayProb` = `adjustedProbability` if the case has one, else `baseProbability`) only
when `isDefendant` — a real number a defendant genuinely has visibility into, per
FORMULAS §6/§9. For the *plaintiff*'s own copy of the same `LegalCaseData` (remember,
per the section above, one case lives in both parties' `engineState`), there's
deliberately no equivalent number to show — a plaintiff has no special insight into their
own filed case's odds beyond what any rival's public filing already reveals, so showing
one would either fabricate false precision or (worse) leak the same `adjustedProbability`
math the defendant sees, which was never meant to be plaintiff-visible. The plaintiff
side renders a `semColors.gray`-styled chip reading "Unknown" instead, via
`gpStyles.semaphoreChip('gray', false)` — the second `clickable` argument (default
`true`, only ever passed `false` here) drops the `cursor: pointer` styling, since there's
no `RiskBreakdownView` to open for a probability that doesn't exist. This replaced an
earlier "Investigate" button that opened the target's Full Filing report — removed by
product decision as redundant (the identical Full Filing button already exists in the
Competitor Intel panel for every rival, case or no case) rather than fixed in place.

### React `setState` updater callbacks must be pure — StrictMode will call them twice in dev

`GamePhase.tsx`'s turn-sync `useEffect` used to call `setSuedCases((prev) => [...prev,
...newlySued])` — a non-idempotent append — from *inside* `setMyData`'s functional-updater
callback. React explicitly permits calling `setState` updater functions more than once
(this is a distinct behavior from StrictMode's separate double-invocation of whole effect
bodies, and happens even with an effect-level dedup guard in place) specifically to help
catch impure updaters in development — so the same lawsuit got appended into `suedCases`
twice, one becoming a genuine duplicate array entry, not just a wasted re-render. Fixed by
reading `myData`/`competitors` directly via closure (safe since the effect itself is
guarded by a `useRef` against StrictMode's dev-only double-invocation of the *effect*) and
moving the array-append `setState` call out of any updater entirely. If you add another
effect that accumulates into array state based on a diff against the previous value, do
the diffing and the accumulating `setState` call in the effect body directly — never
inside another `setState`'s updater callback. `suedCases` has since been generalized into
`eventQueue` (see the next section) but the same rule applies to every push into it.

### Post-turn info windows are one unified, dismiss-gated `PostTurnEvent` queue, not one modal per event type

Being sued, a lawsuit reaching a verdict, and a new round starting can all happen off the
same `resolveTurn` call, and each has its own art/copy (`sued.png`, `lawsuit-won.png` /
`lawsuit-lost.png`, `turn-change.png`). Rather than one boolean-gated `Modal` per event
type (which would either stack overlapping modals or silently clobber one with another in
the same render), `GamePhase.tsx` models all three as a single discriminated union,
`PostTurnEvent = { type: 'sued'; cases } | { type: 'verdict'; outcome; cases } | { type:
'turnChange'; round }`, appended to one `eventQueue` array. Exactly one `Modal` renders
`eventQueue[0]`; its "Got it" button calls `dismissCurrentEvent` (`setEventQueue((q) =>
q.slice(1))`) rather than closing anything — the next queued event, if any, is simply
whatever's now at index 0. Dismissal is manual-only (no auto-timeout, no click-outside-to-
dismiss) by product decision, uniformly across all three event types. If you add a fourth
post-turn event type, extend the `PostTurnEvent` union and the queue-population effect(s)
— don't give it its own separate `Modal`/boolean state, or it can stack on top of this one.

Two detector functions populate the queue, both pure and both unit-tested via duplicated
copies in `GamePhase.utils.test.ts` (see *Test layers* below): `detectNewlySuedCases`
(pre-existing) and `detectNewlyResolvedCases`, added alongside the negotiation-timeout fix
above since a case can now actually reach `'resolved'` in live play. `detectNewlyResolved
Cases` returns each case already flipped to the *querying player's own* perspective as an
`outcome: 'won' | 'lost'` — `LegalCaseData.verdict` itself is plaintiff-centric (`'won'`
means the plaintiff won), so a defendant's own win/loss is the verdict's logical inverse;
downstream UI (the verdict modal body's `outcomeLine` text) never re-derives this, it just
reads `outcome` directly. A separate `useEffect` keyed on `round` (from `gameStore`, not
part of the turn-sync effect above) enqueues `turnChange` events, skipping the very first
render via a `lastAnnouncedRoundRef` null-check — round 1 is the initial game start, not a
change from anything.

**Deliberately not a fourth `PostTurnEvent` type:** the "someone else went bankrupt"
takeover lives outside this queue entirely — in `gameStore.bankruptcyEvents` and
`App.tsx`'s `BankruptcyOverlay`, checked ahead of the `currentPhase` switch, the same
position as the existing `selfElimination`/`LostOverlay` check. `eventQueue` is local
`GamePhase` state, so it (correctly) disappears the moment `GamePhase` unmounts — fine for
sued/verdict/turnChange, since the game is still going whenever those fire. A bankruptcy
can end the game outright, in which case `currentPhase` flips to AFTERMATH and `GamePhase`
unmounts almost immediately (the `player:bankrupt` and `game:over`/`phase:changed`
broadcasts arrive back-to-back from the same turn resolution) — anything queued in
`GamePhase`'s own local state would vanish unseen right along with it. Promoting it to
`gameStore` (a top-level, phase-independent App.tsx check) instead of `eventQueue` is what
makes it survive that transition. If you add another post-turn notice that must be visible
even when it's the thing that ends the game, follow this same pattern, not the
`PostTurnEvent` one.
