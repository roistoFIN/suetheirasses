# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Sue Their Asses" — a multiplayer, server-authoritative business strategy game. Players
run companies for 120s rounds, deploy decisions from a shared, admin-editable decision library, sue
each other over risky moves, buy up rivals' shares to force a hostile takeover, and get
eliminated the instant their cash goes negative or another player crosses 50% ownership of
their company. Last player standing wins. Real-time via Socket.IO; React/Vite client;
Express/Prisma/PostgreSQL server; npm workspaces monorepo (`client`, `server`, `shared`).

The full design spec — every game mechanic, phase flow, socket event, and Zustand store
method — is documented in `README.md`. Read it before making non-trivial changes; this
file only covers what the README doesn't (commands and architecture orientation).

**There is no separate design-spec document for game math anymore.** A
`definitionDocumentation/FORMULAS.md` used to be the source of truth but has been retired:
the pure, scalar, named-input math it described (competitiveness, P&L, balance sheet,
legal-risk/risk-gauge formulas) now lives in Postgres (`Formula` table, seeded from
`server/src/engine/defaultFormulas.ts` — that file is the closest thing to a fixed
reference for the *default* expressions, though `/admin` can change what's actually
running) and is editable live from `/admin`; the *procedural* half (execution order,
depreciation ledger, bankruptcy/merger waterfall, FIFO tie-breaking) was never
data-driven and lives directly in the code that implements it — `gameLoop.ts`'s
`resolveTurn` (the numbered `// ── Step N ──` comments are the current, accurate
execution order) and `calcEngine.ts`/`decisionEngine.ts`/`legalEngine.ts`'s own doc
comments. Trust those inline comments and this file over any memory of the old
document — the decision library/config are similarly DB-backed, not static files; see
*"Decisions/config are DB-backed"* and *"Formulas are DB-backed"* below.

## Working conventions

**If a prompt leaves anything open or underspecified, ask for the details — do not
guess.** This includes ambiguous scope ("fix the modal" when there are several modals),
unclear intent (does "remove X" mean delete the code or just hide it in the UI?),
unstated defaults (a new admin-editable number with no default given), or a request that
could reasonably be implemented two different ways with materially different behavior.
Guessing and building the wrong thing costs more of the user's time than asking up front;
a wrong assumption silently shipped is worse than a clarifying question. Use judgment for
trivial details with an obvious answer from context/convention, but default to asking
when genuinely unsure.

**After every change, write tests for it and update documentation** — README.md and/or
this file, whichever actually describes the area touched — **except `REQUIREMENTS.md`**,
which is the user's own tracking file and must never be edited by Claude.

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

**`npm run dev:server` uses `nodemon` (polling), not bare `tsx watch`.** Native-OS-
file-event watching (both `tsx watch` and Vite's default chokidar watcher) was found to
silently go stale after the dev server had been running a while — no restart/HMR on
further edits, no error, no indication anything was wrong. Root cause was never pinned to
one deterministic trigger, so the fix is to stop depending on native file-change events at
all: `server/nodemon.json` runs `nodemon` with `legacyWatch: true` (polling), watching
both `src` and `../shared/src`; `client/vite.config.ts`'s `server.watch: { usePolling:
true, interval: 300 }` is the client-side equivalent. If you're ever tempted to simplify
back to plain `tsx watch`, know this is exactly the failure mode that reintroduces.

## Architecture

### Two-layer server split: room/DB/broadcast lifecycle vs. pure turn math

- **`GameEngine`** (`server/src/socket/gameEngine.ts`) — Socket.IO room/phase lifecycle:
  create/join/kick, phase advancement (`WAITING → GAME_PHASE → AFTERMATH`), and *all*
  Prisma/Socket.IO I/O for turn resolution. Holds rooms in an in-memory `Map` in addition
  to Postgres, and guards concurrent turn resolution per-room with a `Set<string>` lock
  (`advancingRooms`). `resolveGameTurn`/`broadcastInitialSnapshot` load each active
  player's `Company` row into `GameLoop`'s input shape, call `GameLoop`, then persist the
  returned updates and emit `player:bankrupt`/`turn:resolved` themselves.
- **`GameLoop`** (`server/src/engine/gameLoop.ts`) — the authoritative turn-resolution
  engine, loaded via `GameEngine.loadGameData()` from the `Decision`/`GameConfigRow`
  tables. **It is a pure computation engine** — no Prisma, no Socket.IO, no
  `async`/`await` anywhere in it. `resolveTurn(roomId, round, players)` and
  `getInitialSnapshot(...)` take plain input and return plain data; they never write to
  the DB or emit a socket event — the caller (`GameEngine`) does both. Delegates to
  `calcEngine.ts` (P&L, balance sheet, market share, risk gauge), `decisionEngine.ts`
  (deployment rules, maturity, mutual-exclusion), and `legalEngine.ts` (lawsuit
  filing/pricing). `resolveTurn` runs the full per-round calculation described in the
  README's *Business Decisions* section; the numbered `// ── Step N ──` comments in it
  are the current, accurate execution order.

When changing turn-resolution logic, the engine files under `server/src/engine/` are
where it lives — `gameEngine.ts` never touches game math directly. This split makes
`GameLoop`'s tests (`gameLoop.test.ts`) plain input-in/output-out assertions with no
mocking — a test needing a Prisma/`Server` double is testing `GameEngine`, not `GameLoop`.

`GameLoop` persists each active decision as a `PersistedDecisionInstance`
(`{ id, definitionName, deployedYear, elapsedYears, isMatured, targetId?, everSued?,
voidedByLawsuit? }`) rather than the full `DeployedDecision` — `definitionName` is looked
back up against the loaded decision library on read. Keep persisted instances in this
serialized, name-keyed form; don't reintroduce embedding the full definition into
`Company.engineState`. `targetId` (set when a decision like Bot Attack is deployed
against a chosen opponent) drives `target.*` impacts each turn and `buildIncomingAttacks`'s
attack-hint surfacing — never derive one without the other; they read the same `targetId`.

### Incoming attacks — hints, dismissal, indirect effects, heads-up shortcut

`buildIncomingAttacks` rebuilds the incoming-attacks list fresh every turn from "is there
still another active player whose active `target.*`-bearing decision targets me" — it has
no memory of past state. `GamePhase.tsx`'s `isAttackAlreadySuedOver` filters the list
client-side, hiding a hint once a real case exists against that exact attacking instance —
matched by `c.defendantDecisionInstanceId === attack.attackId` (the specific instance, any
ground, regardless of investigation level), not by requiring the ground to match a
suggested one. `dismissedAttackIds: Set<string>` (plain `useState` in `GamePhase`, keyed
by the same `attackId`, reset on reload) is a third, purely client-side way a hint stops
showing — a player can dismiss a hint they don't want to act on.

**Indirect effects**: a decision with no `target.*` impacts but with `legalRisks` (roughly
two-thirds of the library — New Factory, Water Pumping, etc.) still generates a hint,
broadcast to *every* other active player rather than one target — `GameLoop.
isIndirectEffect(def, targetImpacts, targetId)` is the classifier (`targetImpacts.size ===
0 && legalRisks.length > 0 && targetId === undefined`; Buy Shares is excluded from this
despite having no `target.*` impacts, since it has a real `targetId`). Deliberately not
based on the `offensiveAction` flag, which is unreliable/narrative-only. The headline reads
"indirectly affects you" (calm blue) vs. "did something to you" (alarmed orange); `digDeeper`
and the plaintiff-investigation stamp both drop their "must literally target me" gate for
the indirect case. This was a deliberate, discussed scope decision (mirroring direct-attack
detection inverted) — expect several hint cards per turn in a 3-4 player game; that's by
design, not a bug to throttle without a further product decision.

**Heads-up shortcut**: `GameLoop.effectiveInvestigationLevel(rawLevel, activePlayerCount)`
adds +1 (capped) to every raw investigation level whenever exactly 2 active players
remain, since "who attacked me" is never actually in question with one possible attacker —
the persisted level is still a plain per-dig counter; only what a given level *reveals*
shifts. `activePlayerCount` must always include the investigating player themselves.

### Four exceptions to "everything happens in resolveTurn" — plus settlement negotiation as a fifth/sixth

Almost every gameplay effect only happens inside the turn-timer-driven `resolveTurn`/
`resolveGameTurn` cycle. Five things deliberately don't, each mutating `Company`/`Player`
state instantly, outside the turn cycle: `GameLoop.digDeeper` (pay `digDeeperCost` to
reveal the next investigation tier), `GameEngine.rejoinRoom`/`markPlayerDisconnected`/
`finalizePlayerRemoval` (reconnection), `GameEngine.forfeitGame` (voluntary instant
bankruptcy — writes `bankrupt: true` directly, not via a turn's normal check),
`GameLoop.chargeLawsuitFilingFee` (pay `lawsuitFilingCost` the instant a player files via
SueModal — never refunded even if Step 8 later rejects the case; capped by
`maxLawsuitsPerPlayerPerTurn` against `GameLoop`'s in-memory submission map, same cap
Step 8 itself enforces), and **live settlement negotiation** (`GameLoop.makeOffer`/
`acceptOffer`/`goToCourt` — see below). `digDeeper`/`chargeLawsuitFilingFee`/negotiation
keep `GameLoop` pure; `GameEngine` does the one-off Prisma writes.

`forfeitGame` can't call `resolveGameTurn` directly from inside itself (it's still holding
`advancingRooms`, which would make the inner call silently no-op) — when a forfeit makes
every remaining active player ready, it returns `{ triggerImmediateResolution: true }` and
the *caller*, after `forfeitGame`'s lock is released, triggers resolution. Follow this
"return a flag, let the caller trigger it" shape for any other early-resolution path that
itself needs `advancingRooms`.

`finalizePlayerRemoval` (the heartbeat sweep's grace-period cleanup) must never run
concurrently with `resolveGameTurn` for the same room — both mutate overlapping
room/player state (a previously-reported bug: deleting a player mid-resolution crashed the
persistence loop for the whole room, requiring a manual refresh to recover). Fixed two
ways: the sweep skips finalizing a player whose room is in `advancingRooms` (retried next
tick), and `resolveGameTurn`'s per-player persistence loops each wrap their own writes in
try/catch so one missing row can't abort the room's turn. Keep both if you touch
`advancingRooms` or either persistence loop again.

### Settlement negotiation

A filed case starts `status: 'negotiating'`. **Live negotiation** (`makeOffer`/
`acceptOffer`/`goToCourt`, via `game:makeOffer` etc.) is instant and two-party — a case is
persisted into *both* plaintiff's and defendant's `Company.engineState.legalCases`, so
every action reads/writes both parties' rows and `GameEngine.emitLegalCaseUpdate` sends
the result directly to both parties' sockets, never a room-wide broadcast. The defendant
always moves first; after that, only the role that did *not* make the most recent offer
may counter or accept. `goToCourt` is never turn-gated (either party can force a trial any
time) but only sets `status: 'awaiting_trial'` — the verdict is drawn later, by the normal
trial-resolution loop inside the next `resolveTurn`. The valid offer range narrows inward
with every move (`GameLoop.computeOfferBracket` — a new offer can only tighten its own
side of the bracket, mirrored client-side in `NegotiationPanel` for slider bounds only;
server is authoritative).

**Step 8b** inside `resolveTurn` catches whatever live negotiation doesn't resolve by a
turn boundary: a pending unanswered offer is treated as accepted (settles at that amount);
if no offer was ever made, `turnsNegotiating` increments each boundary and forces
`status: 'awaiting_trial'` once it reaches `gameSettings.negotiationPeriodTurns` (default
2), resolving to a verdict that same turn via the normal trial loop.

**Dig deeper on an open lawsuit** (`digDeeperOnCase`, `game:digDeeperCase`) reuses this
same two-party persist/emit shape: the defendant pays `digDeeperCost` to flip
`LegalCaseData.defendantInvestigated`, a one-shot (not tiered) reveal of that case's odds.

### A `LegalCaseData` lives in two players' `engineState` at once — dedupe by id

Since a filed case is persisted into both parties' `engineState.legalCases`, `resolveTurn`'s
Step 7 reconstructs `allCases` via a `Map<id, LegalCaseData>` — a naive concatenation
double-counts every case, and since Step 12 re-persists whatever's in `allCases` back into
both parties, an undeduped list doubles again every subsequent turn. Keep the dedup if you
touch how `allCases` is assembled. A resolved case is only re-persisted for the one turn it
resolves in — Step 7's `c.status !== 'resolved'` filter drops it from persisted history the
turn after, so anything wanting to remember "this case existed" longer than that can't scan
`engineState.legalCases` for it (see `everSued`, below, for why this matters).

### Only one lawsuit per decision instance, ever

By product decision, a specific decision *instance* can be sued at most once, for its
entire lifetime — the instant a genuine case (not a wrong guess, not time-barred) is filed
against it, `DeployedDecision.everSued` is set `true` permanently, and every later filing
against that same instance (this turn or any future one) gets the same "real but hopeless"
0%-probability shape a wrong guess gets. Scoped to the *instance*, not the decision name —
a redeployed instance after voiding/expiry is independent and cleanly un-sued. Deliberately
a flag on the instance, not derived from scanning case history, since resolved cases don't
survive in persisted state long enough to answer "was this ever sued" reliably (see above).
First-come-first-served falls out of Step 8's iteration order for free: `targetActiveDecisions`
is rebuilt fresh from the target's current state on every filing processed in the loop.

### Winning a case voids the sued decision instance; a permanent effect also naturally expires

Whenever the defendant pays out on a case (trial loss, or any settlement where they pay —
not the bankruptcy-waterfall forced settle/cancel), `GameLoop.voidSuedDecisionInstance`
cancels the instance's *forthcoming* effects, forces `isMatured: true` (freeing it for
redeployment via `canDeploy`'s existing maturity rule), and flags `voidedByLawsuit: true`
(shown as a gray **VOIDED — SUED** badge). Matched by instance id
(`LegalCaseData.defendantDecisionInstanceId`, stamped at filing time), not by name, since a
voided decision can be redeployed and both the old and new instance can coexist.

Separately, any decision whose impacts fall through to a non-zero `'default'` schedule
value forever (`DecisionEngine.hasPermanentEffect`) stops re-applying its own effects (and
`target.*` effects, via `hasPermanentImpactMap`) once an instance has been active
`gameSettings.statuteOfLimitationsYears` (default 10) — the same age past which it can no
longer be sued. Forces `isMatured: true` on expiry too. Not flagged `voidedByLawsuit`; the
client recomputes "expired" purely from data (`hasPermanentEffect(def) && elapsedYears >=
statuteOfLimitationsYears`) and shows a gray **EXPIRED** badge instead.

**`canDeploy`'s permanent-effect redeploy lock uses a separate, shorter clock**:
`gameSettings.permanentEffectCooldownYears` (default 3), not `statuteOfLimitationsYears`.
They used to share the statute, which made a permanent-effect decision (New Factory,
Venture Capital Shadow Money, Bot Attack, etc.) effectively one-time-per-game given typical
game lengths of 12-14 rounds — the statute still governs suability/natural-expiry
unchanged; the cooldown governs only "how soon can I redeploy this," tunable independently.

**Root historical bug, worth remembering the shape of**: `advanceAndApply` used to
re-apply a matured decision's `'default'` schedule value *every turn forever* (no memory
of "already applied this instance's final value"), compounding a `relative` field's
multiplier against itself indefinitely and accumulating an `absolute` field's addend on
top of itself every turn — this was the real root cause of runaway exponential growth and
"certain doom" death spirals in random-play testing (single `New Factory`'s
`installedCapacity` went 350→2635 over 7 turns from one instance alone). Fixed by applying
a decision's own (non-`target.*`) impacts only through its maturity threshold, then
skipping it — `target.*` effects on the *victim* deliberately keep re-applying every turn
until the statute, unchanged (that's attack/defense balance, not the same bug). If you
touch `advanceAndApply`/`collectTargetImpacts`, this invariant — a matured decision's own
effect is applied once, not compounded — is the one most likely to silently regress.

### Statute of limitations & relative-type legal-risk stakes

Beyond spec: a decision can be sued over only within `gameSettings.statuteOfLimitationsYears`
of deployment (`targetInstance.elapsedYears >= statuteOfLimitationsYears` forces
`baseProbability` to 0 in both `LegalEngine.fileLawsuit` and `pickBestGround`'s pre-filing
estimate, so a suggestion never quotes odds a real filing would immediately zero out).
Independent of `isMatured` — governs legal liability, not schedule-locking.

A legal risk's `impact.type` matters for stakes, not just for the defendant's effect: an
`absolute` ground's stakes are the raw schedule value; a `relative` ground's stakes must
be scaled against the defendant's *own current* value of `impact.target` (read generically
off `PlayerVariables`, e.g. `equity`/`revenue` — never hardcoded to one field). Reading a
relative schedule value directly as dollars was a real, reported bug (near-zero stakes,
"You paid $0"). `fileLawsuit` takes the defendant's `PlayerVariables` for this reason; at
the Step 8 call site, `revenue` specifically has to be read from that turn's freshly
computed P&L map (`plMap`), not `ctx.vars.revenue`, since revenue is never written back
onto `PlayerVariables` the way `equity` is.

### A case's probability is earned separately by each side, and displayed as a 5-band verbal likelihood

`CaseCard`'s probability chip only renders once `knowsOdds` is true: for the *plaintiff*,
`LegalCaseData.plaintiffFullyInvestigated` (stamped once, at filing time, by matching a
fully-dug-in — level 3 — attack against the exact ground sued over; not recomputed later,
so it survives the attacking instance later disappearing from `incomingAttacks`); for the
*defendant*, `defendantInvestigated` (earned via the dig-deeper-on-case flow above).
Otherwise shows a gray "Unknown" chip.

Displayed probability is a fixed 5-band verbal label (`likelihoodLabel` in `GamePhase.tsx`:
0–20% Highly Unlikely, 20–40% Unlikely, 40–60% Moderate, 60–80% Likely, 80–100% Highly
Likely), not a raw percentage — deliberate, since the pre-filing estimate is a snapshot
that reliably drifts *upward* by trial time (the case itself joins the defendant's own
`legalExposureRatio` the moment it's filed, and other plaintiffs can pile on before trial),
so an exact-looking number overstates precision. `semaphoreLevel`'s green/yellow/red dot
color is unaffected and still config-driven. `RiskBreakdownView` (opened by clicking the
chip) deliberately stays numeric — it recomputes live from current state every time it
opens, so it isn't stale the way the snapshot is.

### `SUE THEIR ASSES` offers the whole decision library's grounds, not just a target's actual ones

`getGroundsAgainst` returns every `legalRisks` entry across the *entire* library,
regardless of who has actually deployed it — a player can sue on a hunch. `LegalEngine.
fileLawsuit` still creates a real case for a wrong guess, just with `baseProbability`
forced to 0 (never `null`/no-case) — a wrong guess is real but hopeless, same shape as a
time-barred ground. `fileLawsuit` still returns `null` only for a genuinely malformed
request (unknown decision/ground name). `chargeLawsuitFilingFee`/`digDeeper` both need the
same "first turn hasn't resolved yet" `readVariables` fallback `resolveTurn` already has
(`Company.variables` is `{}` until round 1 resolves) — filing/digging in round 1 is now a
realistic, encouraged action, so this fallback is load-bearing, not defensive-only.

### Share ownership & majority-ownership takeover

`shareOwnership: Record<string, number>` (fractions summing to 1.0) uses two sentinel keys
— `SELF_OWNERSHIP_KEY` ('self', the founder's own stake) and `EXTERNAL_MARKET_KEY`
('EXTERNAL_MARKET', the public float); any other key is a real player id who bought in via
Buy Shares. `GameLoop.startingVars()` must spread a fresh copy of the seeded
`shareOwnership` object per player — an earlier version shared one object reference across
every player's starting snapshot, harmless until something started mutating it.

**Trades execute in a new Step 1b**, between `processNewDecisions` and `advanceAndApply`,
priced off `stockValue` as it stood at the *start* of the turn (recomputed later in the
balance-sheet step; using last turn's closing price avoids a circular dependency). A
purchase of `fractionBought = min(1, spend / stockValue / totalSharesOutstanding)` dilutes
*every* existing `shareOwnership` key by `(1 - fractionBought)` uniformly, then credits the
buyer's key with the full `fractionBought` — self-buyback and stacking multiple same-turn
buyers both fall out of this one formula with no special-casing (two sequential 50%
purchases land at 25%/50%, not 50/50 — being first only protects you from purchases
*before* yours). Every diluted key that maps to a real player (never `EXTERNAL_MARKET`,
never the buyer) receives `fraction * spend` in cash (not `fraction * fractionBought *
spend` — that extra factor was a real, reported payout bug, fixed).

**FIFO ordering for same-turn stacked trades** needs a real arrival timestamp, not
`Date.now()` at submission time — `game:submitDecisions` is full-replacement (see below),
so a per-call stamp would reflect whenever the player last touched *anything*.
`GameLoop.submissionTimestamps` (room → player → `${bucket}:${name}:${targetId}` → first-
seen time) only stamps a key the first time it appears in a turn's submissions.

**Majority-ownership elimination** reuses the bankruptcy case-payout waterfall verbatim
(`distributeCaseWaterfall`) for either reason. A merger's acquirer additionally inherits
the eliminated company's cash/assets/intangibleAssets (not debt, not decisions, not legal
cases). A prospective acquirer who is themselves bankrupting the same turn is excluded from
`playersToMerge` — their pending stake just gets swept to `EXTERNAL_MARKET` like anyone
else's. Any player eliminated this turn (either reason) has their stake in every *other*
company's `shareOwnership` swept to `EXTERNAL_MARKET` — without this a departed player's
stake would sit forever, un-payable and un-reclaimable.

`legalRiskConditions.minPercentAcquiredInSingleTransaction` is wired generically via
`DecisionEngine.meetsLegalRiskConditions(def, instance)`, reading the instance's own
`acquisitionFraction` — keyed off the data field, never a hardcoded decision name (see the
`DEPRECIATING_ASSETS` cautionary note under *Decisions/config are DB-backed* below for why
name-based special-casing in this engine is a recurring bug class to avoid). The takeover
threshold itself (`admin.ownership.takeoverThresholdPercent`, default 0.5) is also read
generically in `gameLoop.ts`'s Step 10 merger check now, not hardcoded to `0.5`.

Buy Shares/Sell Shares are their own `level: 'Financial'` decision-type category (not
Strategic), with an independent per-turn cap, `gameSettings.maxFinancialDecisionsPerTurn`
(default 2) — a third bucket alongside Strategic/Operational, tracked via a shared
`DECISION_BUCKETS = ['strategic','operational','financial']` tuple everywhere a bucket is
iterated (client and server), specifically so a third bucket never gets silently dropped by
a hardcoded two-item check the way earlier bugs in this codebase did. Neither carries
`impacts` — both are identified generically by `shareTransactionType: 'buy' | 'sell'` on
the `DecisionDefinition`, never by name. The target picker for these two is labeled
"COMPANY" not "TARGET" in the UI, since it's "whose cap table," not "who gets hurt."

The cap table (who owns how much of a company, not just its price) is shown via
`buildCapTable`/`CapTableSection` in the STOCK VALUE drill-down and a rival's Full Filing
report — a pure function resolving each `shareOwnership` key to a name/color (self,
`EXTERNAL_MARKET`, a real other-player id, or a "Former Shareholder" fallback for an
eliminated holder's stale key) and sorting largest stake first.

### Financial decision level, `room:startGame` ordering, and per-game decision subset

**`room:startGame` must broadcast the round-1 initial-snapshot `TURN_RESOLVED` before
`PHASE_CHANGED`/`GAME_READY_UPDATE`/`GAME_DECK`.** A client can't act (submit/ready) until
told the phase changed, so awaiting the initial snapshot first means no client can race a
ready-triggered real turn-1 resolution ahead of the (always-empty) initial one and have it
silently overwritten. `GameEngine.startGame(roomId)` is the extracted method with real
regression coverage for this exact broadcast order — found via a live two-socket Docker
repro, not code review; mocked-only tests have no relative timing between concurrent async
paths and won't catch an ordering bug like this on their own.

**Every new game draws its own fixed, random decision subset.** `RoomState.decisionSubset`
(decision names only) is picked once, in `startGame`, via `GameEngine.
pickRandomDecisionSubset()`: `RANDOM_DECISION_COUNT` (48) random decisions, **plus every
decision with `shareTransactionType` set, unconditionally** — selected by that field, never
by name, so an admin renaming/adding a share-transaction decision can't silently drop the
takeover mechanic from every future game. `GameEngine.getRoomDeck(roomId)` resolves the
subset back to full definitions for both `startGame`'s and `rejoinRoom`'s `game:deck`
broadcast (falls back to the full library if the subset is still empty — a test-only path).
Enforcement lives in `GameEngine.submitDecisions`, which filters incoming decision/lawsuit
entries against the room's subset *before* calling into `GameLoop` — `GameLoop` itself
stays unaware any per-room restriction exists (it still needs the whole library in memory
to look up already-deployed instances by name regardless of room).

### KPI history + prediction graphs

Every clickable KPI in `GamePhase.tsx` opens a generic `KpiHistoryGraph`, keyed by a
dot-path into `KpiSnapshotPoint` — adding a new clickable field is a one-line change, not a
new endpoint. Purely-computed intermediate rows (COGS, EBITDA, etc.) aren't clickable —
there's no single tracked field for them.

**History**: one `KpiSnapshot` row per player per round, `upsert`-written by `GameEngine.
persistKpiSnapshots` from both `resolveGameTurn` and the round-1 initial broadcast.

**Prediction** (`GameLoop.predictFutureKpis`) calls `resolveTurn` itself, `turnsAhead`
times, sandboxed behind a synthetic room id (`__predict__${playerId}`) that was never
submitted to — so Step 1 (new decisions) and Step 8 (lawsuits) both no-op automatically for
everyone in the sandbox; only already-active decisions keep maturing. The target player's
own snapshot evolves iteration to iteration; every rival is held frozen (re-fed unchanged
each iteration) — the literal implementation of "predicts your own decisions, not
others'." `round` passed to each sandboxed call must be the room's real current round plus
an offset, not a small fabricated counter, or depreciation-ledger math desyncs. A target's
own negotiating legal cases still run through real negotiation-timeout/trial logic inside
the sandbox (including its random verdict draw) — accepted, since reusing the real engine
wholesale (not an approximation) was the point; two predictions can legitimately differ if
a case resolves inside the window. Rivals never get a prediction, only history —
`GameEngine.getKpiHistory`'s `includePrediction` is `false` for any target other than the
requester's own id, a deliberate product decision (not a missing feature).

Trend arrows (up/down/no-change) next to every KPI are computed purely client-side by
diffing the current turn's snapshot against the one previous turn already in memory
(`computeTrend`) — no new server round trip. A handful of computed-only rows recompute
their whole formula against the previous snapshot rather than diffing a field (same
function, called twice) so the live value and its trend arrow can never drift apart.

### Local LLM annual-report blurbs & AI decision generation (admin-only, experimental)

`GameEngine.getAnnualReport` narrates one sentence of flavor text per active decision via
a local `llama.cpp` server (`llmService.ts`, OpenAI-compatible `/v1/chat/completions`),
replacing old fixed `competitorsView` strings. **Must degrade invisibly**: every failure
(unreachable host, timeout, bad response) falls back to the decision's own
`competitorsView` text — never propagates an error, and the game is fully playable with
the `llm` container never started. Responses are cached in-process by
`decisionName#elapsedYears` (not per-player). A tier-1 incoming-attack hint (attacker
identity known, decision itself not yet) reuses this same generation as flavor — computed
in `GameEngine`, not `GameLoop`, since `resolveTurn` must stay synchronous/I/O-free; both
`digDeeper` and every subsequent `turn:resolved` broadcast re-attach it via a shared
`annualReportBlurbForInstance` helper.

**AI decision generation** (`decisionGenService.ts` + `decisionGenGuardrails.ts`, admin
portal only) can invent a whole draft decision + lawsuits from the same local model, but
**only ever produces a human-reviewed draft** — `POST /api/admin/decisions/generate`
returns the candidate, never saves it; an admin must review and submit it through the
normal decision-creation form. The guardrail pass does the real safety work (confirmed by
a live eval, not assumed): filters `impacts` to a field whitelist, clamps every schedule
value into real-data-derived ranges, coerces a field to whichever of `absolute`/`relative`
the real library actually uses for it (a magnitude clamp alone doesn't catch a
categorically-wrong type), forces `legalRisks[].impact.target` into `cash`/`equity`/
`revenue`, and derives `offensiveAction`/`requiresTarget` from what actually survived
clamping rather than trusting the model's own flags. Eval found the model reliably good at
prose (names, descriptions, legal-jargon grounds) and reliably unreliable at exact
numbers/type conventions — guardrails fired on nearly every generation (~3.2 warnings
each), including one case that would have handed a player 5-6x starting cash in fresh debt
unclamped. This is why the tool stays "AI proposes, human disposes," not wired into any
live game.

### EventLog + admin Analytics — durable, cross-game telemetry

`EventLog` (Prisma model) deliberately has **no FK to `Room`/`Player`** — both are
hard-deleted routinely (stale-room sweep, grace-period cleanup), so ids are plain
unconstrained strings; anything worth showing alongside one (names, reasons) is
denormalized into a JSONB `payload` at write time. `eventLogService.logEvent`/`logEvents`
are best-effort — same "must degrade invisibly" convention as `llmService` — a DB hiccup
writing telemetry must never abort a turn or surface to a player. `EVENT_TYPES` is a fixed
vocabulary (`turn.resolved`, `decision.deployed`/`rejected`, `player.eliminated`/
`disconnected`/`reconnected`/`kicked`, `room.stale_cleanup`, `game.completed`, `llm.call`,
`error.persistence`). `game.completed` is logged from exactly the two real game-ending call
sites (`resolveGameTurn`, `forfeitGame`), never from the payload-building helper itself
(which has a third, non-completion caller: reconnect re-fetch).

Three aggregate dashboards live in `analyticsService.ts` as pure functions over plain row
arrays (unit-testable without a DB): decision win/loss correlation (cross-references
deploy/reject events against `game.completed`'s winner), lawsuit win rates (reads
`LegalCaseHistory` directly, not `EventLog`), and performance (turn-resolution duration,
LLM latency/success by kind, error-context breakdown). Admin portal polls only the raw
Event Feed sub-view every 5s; the three dashboards fetch once on tab-mount plus a manual
refresh, since nothing there is ever edited (no clobber risk to guard against).

### Decisions/config are DB-backed, not static JSON — live-reloaded on every admin edit

`game_engine.json`/`game_config.json` (`server/src/data/`) are **seed-only** now —
`Decision`/`GameConfigRow` Prisma tables are authoritative at runtime, populated by
`prisma/seed.ts` (idempotent; also the disaster-recovery path: `npx prisma migrate reset
&& npm run db:seed`). Editing the JSON files directly has **no runtime effect** once the
DB is seeded — use `/admin`. `GameEngine.loadGameData()` reads both tables at startup;
every admin write calls the same `GameLoop.loadDecisions()`/`updateConfig()` used at
startup, taking effect on the very next turn resolved anywhere, no restart needed.

**Deleting a decision is guarded, not just validated** — several hot-path spots
dereference an active instance's `.definition` without a null check, so removing a
definition still deployed somewhere would crash the next turn resolution. `deleteDecision`
scans every non-bankrupt company's `activeDecisions` (`isDecisionInUse`) and rejects (409)
if still deployed.

**Cautionary precedent — don't special-case by decision name.** `calcEngine.ts` used to
hardcode a `DEPRECIATING_ASSETS` name allowlist gating which decisions created a
depreciation-ledger entry; auditing the real seeded library found an existing decision
already silently missing from it (never depreciating, no error). Fixed by trusting the
structural signal alone (`field === 'assets'/'intangibleAssets' && value > 0` on the
deployment year) instead of a name list. Whenever you're tempted to special-case by
decision *name* anywhere in the engine (vs. by a `DecisionDefinition` *field* like
`impacts`, `legalRisks`, `nature`, `shareTransactionType`), this is the failure mode to
remember — it silently drifts from the DB with no error, and ordinary tests against the
seeded library won't catch it.

`processingLevel`/`capacityUtilization`/`installedCapacity`/`price` are floored at 0 (no
ceiling) — `calcEngine.ts`'s `clampFloorZeroFields` helper, shared between
`applyDecisionImpacts` and `applyTargetImpacts` so a decision's own effects and its
`target.*`-routed effects agree on the floor.

### Randomized-simulation testing — a standing methodology, not a one-off

`server/src/engine/gameLoop.simulation.test.ts` (and `.simulation.smart.test.ts`, a
Dig-Deeper-informed suing strategy variant) are **permanent regression suites**: they play
full multi-player games against the real seeded decision/config data across fixed seeds,
asserting basic invariants every turn (every number finite, `riskGauge` in `[0,100]`,
ownership fractions sum to ~1). This is the project's standing tool for two purposes —
catching invariant violations a hand-written fixture wouldn't think to test (it already
found and fixed a real bug: absolute-type impact writes on an *undefined* derived field
like `revenue`/`financeCost`/`taxCost` produced permanent `NaN` corruption, fixed via `??
0` guards; and a `riskGauge` scrutiny term with no lower clamp, fixed by clamping both
ends), and checking decision-balance changes empirically (win-rate/elimination-rate
association per decision) rather than by assertion alone — every "data-only" balance edit
described elsewhere in this file was verified this way. **Any data-only change to
`game_engine.json`/`game_config.json` needs `npm run db:seed` re-run** on an
already-seeded dev database to take effect — this applies uniformly and is not repeated
per-section below.

Known, deliberately un-fixed balance findings from this methodology (product/design
questions, not bugs): `New Factory`'s cash cost and `capacityUtilization` ramp-down penalty
were reduced twice across two tuning rounds; `Venture Capital Shadow Money` gained a real
`financeCost` repayment cost (it used to be pure free cash); `Vertical Integration`/`Raw
Material Monopoly` had their upfront costs cut and, for the latter, a genuine sign error
fixed (its own `materialCostPerTon` impact was permanently *raising* the deployer's own
costs — flipped to lowering, matching its description); `Excess Dividend` had its cost/risk
roughly halved but remains a strictly weak pick with no offsetting benefit — a real "give
it an actual purpose" fix was explicitly not invented unprompted. `price`/
`operatingExpenses` in `playerStartingValues` were tuned so an idle player (never submits a
decision) nets exactly $0/turn — previously netted +$14k/turn purely from a
capacity-bound-regardless-of-market-share structural quirk; covered by a dedicated
5-turn-idle regression test. Dig-Deeper-informed suing measured ~8x the win rate of blind
guessing (~50.7% vs ~6.1%) at ~4.5x lower filing volume — validates that the pre-filing
probability estimate is a genuinely reliable signal, not just flavor text.

### Risk Gauge — 5 weighted terms, all DB-backed and admin-editable

`calculateRiskGauge` blends 5 terms (`w1..w5`, `RiskGaugeConfig` in `game_config.json`):
legal exposure ratio, scrutiny, outrage, **ownership risk**, and **solvency risk** — the
last two are additions beyond the original 3-term design, added because the gauge (this
game's one "am I in danger" glance) was silent about two entire independent loss
conditions.

**Ownership risk** (`calculateOwnershipRisk`) is the single largest real-player stake,
scaled linearly against `admin.ownership.takeoverThresholdPercent` (0 at 0% held, 1.0 at
the threshold) — deliberately not `1 - selfOwnership`, so dilution spread across several
minority holders reads as low risk while one concentrated buyer closing in reads as high
risk. Fixed a related dead-config bug along the way: the actual merger-elimination check in
`gameLoop.ts` used to hardcode `fraction > 0.5` instead of reading this same threshold.

**Solvency risk** (`calculateSolvencyRisk`) asks "could my open lawsuits bankrupt me next
turn": a cheap linear extrapolation, `predictNextTurnCashLinear(cashAfter, cashBefore) =
cashAfter + (cashAfter - cashBefore)` (deliberately not the real `predictFutureKpis`
sandbox — that would mean `resolveTurn` recursively re-running itself per player, per
turn), divided into the same probability-weighted open-case exposure `legalExposureRatio`
already computes, floored to avoid a divide-by-zero/sign-flip once cash is near zero.
`cashBeforeThisTurn` reuses `PlayerTurnContext.prevCash`, already snapshotted for the
bankruptcy waterfall.

Both terms are mirrored client-side in `ThreatView`'s `computeThreatTerms` (same
"duplicate small pure logic, keep in sync by hand" convention used elsewhere) — non-
clickable rows, since neither has a single persisted field to chart.

### Formulas are DB-backed — but only the pure-math half

Turn-resolution math splits into two kinds. **Pure, scalar, named-input formulas**
(competitiveness, P&L, balance sheet, legal-risk probability, risk gauge — 23 named
expressions) live in the `Formula` table, seeded from `defaultFormulas.ts`, editable live
from `/admin`'s Formulas tab. **Everything procedural/order-dependent** (execution order,
depreciation-ledger iteration, bankruptcy/merger waterfall, FIFO tie-breaking) stays plain
TypeScript control flow and always will — don't try to make it data-driven too.

`server/src/engine/formulaEngine.ts` is a small hand-rolled recursive-descent parser/
evaluator — **deliberately not `eval`/`new Function`/`vm`** (arbitrary-code-execution
risk). Grammar: numbers, identifiers, `+ - * /`, unary `-`, parens, and exactly `MIN`/`MAX`
as whitelisted calls — nothing else. Add new builtins to this whitelist deliberately;
never reach for `eval`/`Function`/`vm` as a shortcut.

The formula key set is fixed — no create/delete via `/admin`, only `PUT`, since each key is
hard-referenced at a specific `calcEngine.ts` call site with no safe-deletion guard
possible. Every write is validated twice: real syntax parsing, and a fixed per-key variable
whitelist (`FORMULA_VARIABLES` in `validation/schemas.ts`) — keep this in sync with actual
`evalNamed` call sites or it stops protecting anything.

### JSONB game state, typed columns only for what needs querying

`Company.variables`, `Company.engineState`, and `Company.lastTurnSnapshot` are JSON columns
so `GameLoop` can read/write full per-player engine state atomically without a migration
per new field. `cash`/`debt` are separate typed Decimal columns purely for fast queries
(bankruptcy checks, standings). Don't promote engine-state fields to typed columns unless
they need to be queried outside the engine.

### Shared types live in `shared/src/`

`shared/src/index.ts` — room/player/socket-event types, enums, payloads. `shared/src/
gameTypes.ts` — engine types (`DecisionDefinition`, `PlayerVariables`, `LegalCaseData`,
`TurnResolutionResult`, `GameConfig`). Both workspaces resolve `@suetheirasses/shared`
straight to source via path alias — no build step needed to see changes during dev.

### Client: no path-based routing for game phases — `/admin` is the one real URL

`App.tsx` renders WAITING/GAME_PHASE/AFTERMATH directly off server-authoritative
`currentPhase` in a plain `switch`, no `<Routes>`, no URL change — these have no deep-link
value (no room id in the path, nothing bookmarkable). Don't reintroduce phase-driven
`navigate()` calls; react to phase changes with a plain `useEffect` instead. `/admin`
(`AdminPortal.tsx`) is the one genuine URL, checked first via `window.location.pathname`,
ahead of the phase switch entirely, since it has no relationship to game state.
`BrowserRouter` still wraps the app purely for `Matchmaking.tsx`'s `useSearchParams`
(`?room=` invite links).

### Admin portal — env-var token, REST-only

Gated by a single shared secret (`ADMIN_TOKEN`), checked via constant-time compare on
every `/api/admin/*` request's `x-admin-token` header — no broader auth system exists in
this app (see *Reconnection & Session Resume* in the README for the general unauthenticated-
id-pair trust model). **Fails closed**: if `ADMIN_TOKEN` isn't set, the admin API returns
503. The token is never baked into the client bundle (don't add an `ADMIN_TOKEN`-shaped
`VITE_*` var — anything under `VITE_*` ships publicly); `AdminPortal.tsx` prompts for it
at runtime and keeps it in `sessionStorage`. Decisions/config/formulas are fetched once
(on auth, and again after a successful save), never polled — a background poll could
otherwise silently clobber an admin's in-progress edit. Rooms and the Analytics raw feed
poll every 5s, since those are genuinely live, read-only data.

### `Matchmaking` never unmounts across a room ↔ landing transition

`App.tsx` swaps phases by re-rendering different JSX inside the *same* component instance
— no route change, nothing that naturally resets local `useState` between "in a room" and
"back on landing." Any local state conceptually "scoped to the current room" needs an
explicit `useEffect` reset keyed on `room`/`room?.id`, not reliance on unmount — this bit
`isCreating`/`isSearching` (a stuck spinner after Leave Room) and lobby `chatMessages`
(leaking into the next room) before being fixed this way.

### Everything per-round is client-full-replacement, not incremental

`game:submitDecisions` sends the player's *entire* pending selection every time (strategic/
operational/financial + lawsuits); the server always treats it as a full replacement for
that in-flight turn, never a delta. Keep this in mind touching either the client
submission logic (`GamePhase.tsx`) or `GameLoop.submitDecisions`.

### Client-side duplicated pure logic — a deliberate, hand-synced convention

Several small pure functions exist in two places by design: server-authoritative math
(`GameLoop`/`calcEngine`) has a lightweight client-side mirror purely for instant UI
feedback (deployability checks, KPI trend arrows, threat-gauge breakdown rows, offer
brackets) — never for anything actually authoritative. `GamePhase.utils.test.ts`
deliberately duplicates the pure functions themselves (not imports) to keep that test file
free of the Mantine/tabler-icons import chain. If you change one side of a mirrored pair,
update the other by hand — there's no shared-module mechanism enforcing sync, on purpose,
to keep each side lightweight.

### Post-turn events are a passive, clickable News feed

Being sued, a lawsuit resolving/settling, a share purchase, and a new round starting are
modeled as a discriminated union `PostTurnEvent`, appended to `newsItems` (`{ id, round,
event }`) and rendered as a scrollable **News** box — nothing auto-pops a modal. Clicking a
row opens the same per-type info-window `Modal` this used to auto-open. **One case/purchase
per event, always** — an earlier version batched every same-kind event in a turn into one
News row (`{ cases: LegalCaseData[] }`), which read exactly like data loss to a player
skimming for "how many things happened"; fixed by flattening to one event per case.
`sharesBought` needs no diff against previous state — `GameLoop` already knows exactly who
bought what in `PlayerTurnResult.sharesBoughtThisTurn`, scoped to that turn's trades and
never emitted for a self-buyback.

**Deliberately not a News item**: the "someone else went bankrupt" notice lives in
top-level `gameStore.bankruptcyEvents`/`App.tsx`'s `BankruptcyModal`, not `GamePhase`'s
local `newsItems` — a bankruptcy can end the game and unmount `GamePhase` almost
immediately, which would silently drop anything queued in its local state. `BankruptcyModal`
renders as a `Modal` overlay *alongside* whatever phase is showing (not an early return
replacing it) — an earlier version fully replaced the page, freezing every surviving
player's view the instant anyone else went bankrupt. A forfeit's `player:bankrupt`
broadcast carries `reason: 'forfeit'` (alongside `'bankruptcy'`/`'merger'`), rendered with
distinct "🐔 CHICKENED OUT" copy/art rather than the generic bankruptcy notice.

**React `setState` updater callbacks must stay pure** — StrictMode calls them more than
once in dev specifically to catch impurity. Do array-diffing and the resulting
accumulating `setState` call in the effect body directly; never nest a non-idempotent
`setState` call inside another `setState`'s functional updater.

### Game Timeline — Civilization-style game-over replay, also the live spectator view

`GameTimelineView` (`'live'` mode for an eliminated player who chooses to keep watching,
`'finished'` mode for Game Over) replaces the old dead-end "Return to Start" + static
standings table with a KPI race chart, happenings log, and ranked standings. Two new
persisted pieces made this possible: `Player.eliminatedRound` (set alongside `bankrupt:
true` at both write sites, and **synced onto the in-memory roster too**, not just the DB
row — the natural-bankruptcy loop previously only wrote the DB, leaving the live roster
stale) and `LegalCaseHistory` (one row per case, filed→resolved lifecycle, **no FK to
`Player`** — same reasoning as `EventLog`). A bankrupted player's final KPI snapshot
(`BankruptedPlayer.finalVariables/finalDerived/finalRiskGauge`) is now captured too — it
used to stop one round early, so Game Over could show a stale positive balance.

**Eliminated players are exempt from the disconnect grace-period sweep** (they can
`room:rejoin`/spectate indefinitely) — which required the stale-room cleanup check to
change from "every socket disconnected" to "every remaining player is *both* eliminated
and disconnected," or a normal player's ordinary reconnect grace period (also briefly
socket-less) would race the sweep into deleting the whole room out from under them.

`GameEngine.getGameTimeline` is pure serialization (no `GameLoop` involvement), reachable
in both `GAME_PHASE` and `AFTERMATH` — the first payload-less client→server request in the
codebase, and the first on-demand handler allowed in both phases.

### Chat spans all three phases via a client-side `chatStore`, continuous history

`GameEngine.sendChatMessage` dropped its old `status === WAITING` gate entirely — chat
works in the lobby, mid-game, and post-game alike. Client-side, history moved out of any
one page component into a standalone Zustand `chatStore` (`resetForRoom(roomId)` only
clears on an actual room change, never a phase change, so lobby→game→gameover is one
continuous conversation) with a floating `ChatWidget` fab+popup on the game and
finished-game screens, plus the lobby's existing inline box reading/writing the same
store. Gotcha worth remembering: `position: fixed` on the element a Mantine `Indicator`
badge wraps breaks the badge's positioning (the fixed element collapses out of normal
flow) — put the fixed positioning on a wrapping `Box` instead, badge/`ActionIcon` inside it
positioned normally.

### Player Feedback — anonymous REST endpoint, not a socket event

`POST /api/feedback` (public, unauthenticated, validated by `feedbackSubmitSchema`) is
plain REST specifically because the landing page (one of two entry points) has no
room/socket context to piggyback on — using a different mechanism just for the game-over
entry point would make the two forms behave differently for no reason. `Feedback` has **no
FK to `Player`/`Room`** at all, by explicit product decision (fully anonymous everywhere,
even at game-over where context would technically be available). One shared `FeedbackForm`
component, embedded in two shells (`Matchmaking.tsx`'s inline button+Modal,
`FeedbackWidget.tsx`'s floating fab mirroring `ChatWidget`'s shape at bottom-left). Admin
portal's Feedback tab is read-only, polled alongside Rooms.

### Test layers, and which one to reach for

- **`server/src/**/*.test.ts`** — Vitest, no Docker. `engine/*.test.ts` (GameLoop,
  calcEngine, decisionEngine, legalEngine) needs no mocking — pure input/output.
  `formulaEngine.test.ts` is security-relevant: checks dangerous-looking input
  (`__proto__`, arbitrary function calls) is rejected as invalid syntax, never evaluated.
  `GameLoop` requires `loadFormulas()` before any turn resolves. `socket/gameEngine.test.ts`
  mocks Prisma + `Server` (and `llmService`) since that's where real I/O happens — use this
  layer for room/phase lifecycle, not engine math.
- **`client/src/**/*.test.ts`** — Vitest, Zustand stores and pure UI utilities.
  `GamePhase.utils.test.ts` duplicates small pure functions out of `GamePhase.tsx` rather
  than importing them (see *Client-side duplicated pure logic* above) — keep any
  duplicated copy in sync by hand.
- **`tests/api/*.test.ts`** — Vitest + real Postgres via testcontainers (needs Docker).
  The only layer verifying socket event contracts end-to-end against a real Prisma schema.
  Reach for this when a change touches the room/DB/socket boundary, not engine-internal math.
- **`tests/e2e/*.spec.ts`** — Playwright, full browser + live client + backend. Use for
  lobby/matchmaking flows and phase transitions a user would actually click through.
- **`gameLoop.simulation.test.ts`/`.simulation.smart.test.ts`** — see *Randomized-
  simulation testing* above; the go-to for "does this change destabilize the engine
  against the real, full decision library" rather than a hand-written fixture.

When you touch a mechanic documented above, its own section names the specific
test file/describe block that exists to guard the invariant — extend that, not just
the happy path, rather than writing a parallel test from scratch.

### Deliberate deviations from the design spec

The original design specified every decision with `legalRisks` auto-generates a lawsuit
from every other player the instant it's deployed. Implemented behavior differs by
explicit product decision: lawsuits are filed deliberately via `game:submitDecisions`'s
`lawsuits` array, priced by `LegalEngine.fileLawsuit` against the ground's probability
schedule at the target's elapsed time. The original design also never modeled a
negotiation phase at all (a filed case just resolved via a probability draw) — this
codebase's `'negotiating'` status and full offer/counter/accept/go-to-court flow is a
further addition beyond spec. If a task asks you to "match the original spec exactly" on
either point, flag the conflict rather than silently reverting these deliberate designs —
see README's *Lawsuits* section and `GameLoop`'s Step 8 for context.

### Decision content — data, not code

The decision library has grown well past the original seed set (200+ entries as of this
writing, spanning every `level`/`nature` combination, all chicken-manure/fertilizer-
industry flavored, every one except `Sell Shares` carrying at least one `legalRisks`
entry) via `server/src/data/game_engine.json` — pure data, admin-editable, balanced and
verified using the randomized-simulation methodology described above rather than unit-
tested per decision. **Any edit to this file requires `npm run db:seed` re-run** on an
already-seeded dev database to take effect (see *Decisions/config are DB-backed* above).
