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

### An incoming-attack hint disappears once sued over — but only for its own suggested ground, never a manually-picked one

`server/src/engine/gameLoop.ts`'s `buildIncomingAttacks` rebuilds the incoming-attacks
list fresh every turn purely from "is there still another active player whose still-active
`target.*`-bearing decision targets me" — it has no concept of "already sued," and doesn't
need one. Instead, `GamePhase.tsx`'s `isAttackAlreadySuedOver` filters the list
client-side, hiding an attack's hint card once the player has sued the attacker over
*exactly* the ground the card itself suggested (`attack.suggestedGroundName`, only
populated at `investigationLevel >= 3`), with a "correct" (win probability `> 0`,
`attack.successProbability`) case — checking both `pending.lawsuits` (queued this turn,
not yet a real case) and `myData.legalCases` (a real case from a prior turn's filing, any
status), since `pending.lawsuits` for it is cleared the moment the real case exists.

Deliberately **not** "any lawsuit against this attacker over this decision" — a manually
picked *different* ground for the same attacking decision (via `SueModal`'s own ground
picker, not the "SUE NOW" shortcut) doesn't hide the card, because that ground's own win
probability isn't known client-side without re-implementing the admin-editable, DB-backed
formula evaluation (`adjustedProbability`, `pickBestGround`) this app deliberately keeps
server-only — see *"Formulas are DB-backed"* below. If you ever want manually-picked
grounds to count too, that means either sending the client every ground's probability (not
just the suggested one) or accepting a look-alike client-side approximation; don't
silently assume "any matching decisionName" is equivalent to "a correct lawsuit" the way
`attack.suggestedGroundName` specifically is.

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

"Active Decisions" (originally "Active Strategies" — renamed once it started showing
queued picks too, not just already-active ones) and "Open Lawsuits" used to render only
server-authoritative, already-resolved state (`myData.activeDecisions` /
`myData.legalCases`) — nothing queued this turn (`pending.strategic`/`operational`/
`lawsuits`, the exact same client-local state the Decision Deck and Sue modal already
read/write) showed up there at all, even though both boxes are the natural place a player
would look to confirm what they've picked. Both now merge `pending`'s entries into the
same list, marked with the same red `QUEUED` `gpStyles.stamp` badge the Decision Deck
already uses for consistency — but via two new, deliberately lightweight components
(`QueuedDecisionCard`, `QueuedLawsuitCard`), not by stretching `ActiveDecisionCard`/
`CaseCard` to accept a queued entry. A queued `SubmittedDecisionEntry` (`{ name,
targetId? }`) has no `id`/`deployedYear`/maturity data yet — that only exists once a
decision has actually been deployed by a turn resolving — and a queued
`SubmittedLawsuitEntry` (`{ targetId, decisionName, groundName }`) has no
`id`/`stakes`/`status`/`offers` yet either, since the real `LegalCaseData` isn't created
until `LegalEngine.fileLawsuit` runs at the next turn resolution (Step 8). Don't try to
paper over the shape mismatch with optional fields on the resolved-state components;
these are two different lifecycle stages of the same thing, not one type with some fields
sometimes missing.

Both queued-card types carry their own removal action (`onCancel`/`onRemove`), reusing the
exact same `pending` mutation the Decision Deck's toggle and the Sue modal's
`handleRemoveQueued` already perform — `submitPending({ ...pending, [bucket]:
pending[bucket].filter(...) })` — so cancelling from "Active Decisions"/"Open Lawsuits"
is not a separate code path, just the same state update triggered from a third location.

`Active Decisions`' header count (`"{N} strategic and {M} operational"`) deliberately
counts everything the box actually shows — active *and* still-queued, per bucket — the
same "the number always equals how many cards are visible" convention `Open Lawsuits
(N)` already established. Since `ActiveDecisionInstance` carries no `level` field of its
own (only `DecisionDefinition` does), each active instance has to be looked back up by
`decisionName` against the loaded `decisions` deck to bucket it; queued entries don't need
this lookup at all, since `pending.strategic`/`pending.operational` are already
bucket-keyed by construction.

**The `pending`-reset effect must be keyed on `round`, not `turnResults?.round`** — a real,
reproduced bug (not just theoretical) where a decision made exactly once showed up twice
in "Active Decisions" for one extra turn after it resolved, looking like duplication that
compounded turn after turn. Root cause: `turn:resolved`'s `round` field is the round that
*just finished* (`GameEngine.resolveGameTurn` captures `round` from
`roomState.room.currentPhaseRound` *before* incrementing it, then stamps that pre-increment
value onto `outcome.result`), while the *separate* `phase:changed` broadcast — sent right
after, once the round is actually incremented — carries the *new* round. Both events write
into the same `gameStore.round` field, but `handleTurnResolved` also stores the whole
payload as `turnResults`, so `turnResults.round` freezes at the just-finished round until
the *next* turn resolves — always one round behind whatever `round` (kept current by
`phase:changed`) actually shows. Gating the reset effect on `turnResults?.round` meant it
only ever cleared stale `pending` entries one full round late: right after a decision
resolved into `myData.activeDecisions`, its `QueuedDecisionCard` was still sitting there
too, since the dependency hadn't changed yet from the client's point of view. Fixed by
keying the effect on `round` instead — the same value the pre-existing "turn changed" event
announcer effect right above it already correctly uses for exactly this reason. If you add
another effect that needs to react to "a new round has started," use `round`, never
`turnResults?.round` — the latter is one turn stale by design (it's *whatever last turn's
snapshot said*, not "now").

### `SueModal` no longer keeps its own queued-lawsuits list, and closes itself the instant a filing succeeds

`SueModal` used to render its own itemized list of `pending.lawsuits` (target + ground,
each with a "Remove" link) directly inside the modal, on top of the identical
`QueuedLawsuitCard` list already rendered in the "Open Lawsuits" box behind it — the same
`pending.lawsuits` array shown twice, in two different components, at the same time.
Removed as redundant, the same call already made for `ActiveDecisionCard`/`CaseCard`'s
one-line empty-state text (see *"Active Decisions"/"Open Lawsuits" have no empty-state
text* above): once a lawsuit is filed, the Open Lawsuits box is where a player actually
sees and manages it, so the modal doesn't need its own copy. The `X/Y LAWSUITS QUEUED
THIS TURN` counter line stays (it's a limit reminder relevant to the modal's own `FILE
LAWSUIT` button, not a duplicate listing), and `handleRemoveQueued` was deleted outright
rather than left dead — nothing else in `SueModal` referenced it once its one caller (the
removed list's "Remove" link) was gone.

`SueModal` also now closes itself automatically the moment a lawsuit files successfully
— a new required `onClose: () => void` prop, called from `handleFile`'s `onResult`
callback right after the successful charge is folded into `pending`. The call site passes
the exact same closing logic (`setSueModalOpen(false)` + clearing `sueSuggestion`) through
a shared `closeSueModal` function used by both the wrapping `<Modal onClose=...>` and
`SueModal`'s own `onClose` prop, so there's one place that defines "what closing this
modal means," not two independent closures that could drift. A player who wants to file a
second lawsuit the same turn re-opens the modal via the **SUE THEIR ASSES** button, the
same as opening it the first time — this was a deliberate simplification, not an
oversight: staying open only made sense when the modal needed to keep showing its own
queued list, and that list is gone now.

### The Decision Deck lives in its own modal (MAKE IMPORTANT DECISIONS), not a standalone panel

`DecisionDeckView` (filter chips, the queued-count line, every `DecisionCard`) used to
render inline as its own `SectionCard` next to "Active Decisions." It's now opened from a
**MAKE IMPORTANT DECISIONS** button inside the "Active Decisions" box itself — same
"button opens a `Modal` wrapping the existing view component" shape `SueModal`/"SUE THEIR
ASSES" already established, right down to reusing the same modal `size="lg"`/title
styling. `DecisionDeckView` itself is unchanged — same props (`decisions`, `gameSettings`,
`myData`, `competitors`, `pending`, `onSubmitPending`), same internal filter/toggle logic
— only *where* it renders moved. If you add a similar "pick from a big list" flow later,
follow this shape (a triggering button + `Modal` + the existing view component
unmodified) rather than inventing a new panel-vs-modal pattern.
Since `game:submitDecisions` is full-replacement (see above), every one of these three
locations independently calling `submitPending` with a locally-filtered copy of `pending`
is exactly as correct as the two that already existed.

`DecisionDeckView`'s filter chips are two independent filters — level (`All`/`Strategic`/
`Operational`, driving `filterLevel`) and nature (`All`/`Traditional`/`Grey Area`/`Dirty`,
driving `filterNature`) — and are rendered as two separate `Flex wrap="wrap"` rows inside
a `Stack`, not one combined row. They used to be siblings inside a single `Flex`, which
only visually read as two clusters because of array order; at narrow widths the level
group's own wrap could land a nature chip on the same line as a level chip, reading as one
undifferentiated set of pills. Keep them in separate row containers if you add a third
filter dimension later — one `Flex` per filter, not one `Flex` per screen.

### "Active Decisions"' already-active and queued cards show the same description + SHOW DETAILS panel as the Decision Deck — via a shared `DecisionDetails` sub-component, not by duplicating `DecisionCard`

`ActiveDecisionCard` and `QueuedDecisionCard` used to show only a decision's name and
maturity/queued status — confirming *what a still-maturing or queued pick actually does*
required reopening the Decision Deck modal and finding the same card again. Neither
`ActiveDecisionInstance` (`{ id, decisionName, deployedYear, elapsedYears, isMatured }`)
nor a queued `SubmittedDecisionEntry` (`{ name, targetId? }`) carries the decision's own
`description`/`impacts`/`legalRisks` — only a name — so both `ActiveDecisionCard` and
`QueuedDecisionCard`'s call sites (`GamePhase.tsx`'s "Active Decisions" box) now look the
full `DecisionDefinition` back up by name against the loaded `decisions` library
(`decisions.find((def) => def.decision === d.decisionName)`, the same pattern the box's
header-count bucketing already used) and pass it down as an optional `def` prop.

`DecisionDetails({ def })` is the shared component both cards render: the description
text unconditionally, then — reusing `summarizeEffects`/`getMaturityYears`'s sibling
logic exactly as `DecisionCard` does — a collapsible **SHOW DETAILS**/**HIDE DETAILS**
toggle (`useState` + `IconChevronDown` rotation) gating an **EFFECTS** timeline panel and
a `⚖ Legal risk: …` line. `def` is optional and the component renders nothing if it's
undefined (a defensive fallback for a lookup miss, not expected in practice — see
*"Deleting a decision is guarded"* above for why an in-use decision can't vanish from the
library mid-game). Deliberately a new shared component rather than either (a) inlining
the same JSX twice into both cards, or (b) making `DecisionCard` itself accept an
"already-active" mode — `DecisionCard` also renders deploy/target-picker/exclusion-reason
UI that has no equivalent for an already-deployed or queued instance, so folding this into
it would mean threading a bunch of not-applicable props through one component instead of
composing a small shared piece into two simpler ones.

### Indirect effects — decisions with no `target.*` impacts still generate an incoming-attack-style hint, broadcast to everyone

`buildIncomingAttacks` used to only ever surface a decision with real `target.*`
impacts (`getTargetImpacts(...).size > 0`) — a genuine "attack" aimed at exactly one
other player. That left the majority of the decision library completely invisible to
everyone but its deployer: ~30 of 45 decisions (New Factory, Water Pumping, Night
Dumping, Maintenance Neglect, Artificial Greenwashing, and more) have no `target.*`
concept at all but still carry `legalRisks` — any player could already sue over one
"blind" via SUE THEIR ASSES' whole-library ground list (see *SUE THEIR ASSES offers the
whole decision library's grounds* below), but had zero signal that a rival had even
deployed one, short of manually checking Competitor Intel every turn.

`GameLoop.isIndirectEffect(def, targetImpacts)` is the classifier: `true` whenever
`targetImpacts.size === 0 && def.legalRisks?.length > 0`. Deliberately mechanical (no
`target.*` impacts), not based on the `offensiveAction` data flag — that flag turns out
to be an unreliable, narrative-only label already: 3 decisions in the real library
(Aggressive Sale, Channel Stuffing, Laxatives in Feed) are marked `offensiveAction: true`
despite having no `target.*` impacts at all, so it doesn't cleanly separate "aimed at one
player" from "not." A decision with neither `target.*` impacts nor `legalRisks` (only
Sell Shares, in the real library) is neither direct nor indirect — nothing to reveal or
sue over, so `buildIncomingAttacks` skips it entirely, generating no hint.

Since an indirect decision has no single target, `buildIncomingAttacks` surfaces it to
**every other active player**, not just one — the loop's existing `if (d.targetId !==
pid) continue` guard only applies to the direct case now; an indirect instance is pushed
for every `pid` other than the deployer. `IncomingAttackInfo.isIndirect` carries this
through to the client, which is the only thing that changes client-side: the headline
reads *"Somebody did something that indirectly affects you"* (a calmer blue card)
instead of *"...did something to you"* (the alarmed orange one), everything else
(investigation tiers, Dig Deeper, SUE NOW) renders identically. `revealAttack` picks
between `decisionEngine.summarizeTargetImpacts` (the routed cross-player effect, for a
direct attack) and the new `decisionEngine.summarizeOwnImpacts` (the decision's effect on
its own deployer, since there's no `target.*` effect to describe for an indirect one) for
tier 2's `effectSummary` based on the same `isIndirect` flag — both share a private
`summarizeImpacts` formatting core in `decisionEngine.ts` so the "+X field" rendering
stays in exactly one place.

`digDeeper` and Step 8's `plaintiffFullyInvestigated` stamp both had to drop their
"the attack must literally target me" gate for the indirect case — an indirect decision's
`targetId` is always `undefined` (never set at deployment, since there's no target to
pick), so the old `d.targetId === playerId` check could never match one at all. Both now
branch on `isIndirectEffect` first: if indirect, any other active player may dig into it
(matching that it was broadcast to all of them) and a `plaintiffFullyInvestigated` lookup
matches by decision name alone within the defendant's own `activeDecisions` (no targeting
relationship left to disambiguate by — the plaintiff/defendant pairing already scopes the
search to the right company). If direct, both keep the original `targetId === playerId`
requirement, unchanged. The heads-up shortcut (`effectiveInvestigationLevel`, above)
applies identically to indirect effects — with only one other active player, "who
deployed this" isn't ambiguous there either.

This was a deliberate, discussed scope decision, not an unconstrained "notify on
literally everything": mirroring the existing direct-attack detection (target.* presence)
inverted, rather than either a hand-curated subset of "narratively harmful" decisions or
a broader "anything that shifts market share/competitiveness" interpretation (which would
have applied to nearly the entire deck, including routine self-investment decisions with
no legal angle at all). The accepted tradeoff: since roughly two-thirds of the deck
qualifies, a 3-4 player game can show several hint cards most turns — by design, not a
bug to "fix" by capping or throttling later without a further product decision to do so.

### Dig Deeper's investigation ladder skips the free "who did this" tier in a heads-up (2-active-player) game

`GameLoop.revealAttack`'s three investigation tiers (level 1: attacker identity, level 2:
decision name/description/effect, level 3: suggested ground + win probability) assume the
attacker's identity is genuinely unknown at level 0. That's false the moment only 2 active
players remain — there is exactly one other player left, so "who attacked me" was never
actually in question, and making the player spend a real dig to learn it is a wasted step,
not real investigation. `GameLoop.effectiveInvestigationLevel(rawLevel, activePlayerCount)`
is the fix: whenever `activePlayerCount === 2`, it returns `rawLevel + 1` (capped at
`MAX_INVESTIGATION_LEVEL`) instead of `rawLevel` unchanged — every caller that turns a
persisted investigation level into revealed content or a "fully investigated" check
(`buildIncomingAttacks`, `digDeeper`, and Step 8's `plaintiffFullyInvestigated` stamp) runs
the raw, persisted level through this first. The **persisted** level in
`engineState.investigations` is still a plain `+1`-per-dig counter, identical to the
non-heads-up case — only what a given raw level *reveals* shifts. Concretely, in a heads-up
game: level-1 content (attacker identity) is visible with zero digs and zero raw level; the
first paid dig jumps straight to level-2 content (what the decision is/does); the second
paid dig reaches level-3 content (suggested ground + probability) and is the last one
needed — a raw level of 2 is already "fully investigated" in a heads-up game, not 3.
`activePlayerCount` must always count every still-active player, the investigating player
included (i.e. "2" means "just me and one attacker") — `playersStillActive.length` /
`byId.size` / `ctxs.size` at each of this method's three call sites, matching how
`loadActiveCompanyPlayers` counts elsewhere. If the game later drops back above 2 active
players (not currently possible — eliminations only ever reduce the count), nothing needs
to change: the shortcut is evaluated fresh from the current active count on every call, not
latched once.

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

### `finalizePlayerRemoval` used to be the one room/player mutation that ignored `advancingRooms` entirely — a real, reported bug that froze the whole room and needed a manual refresh

`resolveGameTurn` and `forfeitGame` both hold `advancingRooms` for their entire duration
specifically because they mutate overlapping room/player state and must never interleave
(see above). `finalizePlayerRemoval` — the heartbeat sweep's "a disconnected player's grace
period expired, actually delete their `Company`/`Player` rows now" cleanup — mutates the
exact same state (it deletes a player wholesale) but used to run on its own fixed 10s
`setInterval` tick with **no relationship to that lock at all**. The round timer that drives
`resolveGameTurn` runs on a completely independent clock, so nothing prevented a player's
60s grace-period deadline from landing within moments of an already-in-flight turn
resolution for that same room — not a rare edge case, just "whichever round happens to have
somewhere around a round's worth of time left when the disconnect occurs," reported as
happening "sometimes" during real two-tab local testing (background-tab throttling in one
browser window is exactly the kind of thing that produces a real disconnect at an
unpredictable point in the round).

When the two landed together, `finalizePlayerRemoval` would delete the disconnected
player's DB rows out from under `resolveGameTurn`'s own persistence loop for that same
player (its `dbPlayers` snapshot was read moments earlier, before the deletion, so
`GameLoop.resolveTurn` still produced a `companyUpdates`/`bankruptedPlayers` entry for
them). The subsequent `prisma.company.update({ where: { playerId } })` for a row that no
longer existed threw (Prisma `P2025`, record not found) — uncaught, since neither
persistence loop wrapped individual players in their own try/catch — which aborted the
*entire* loop and propagated up to `resolveGameTurn`'s outer `catch (error) {
console.error(...) }`. That catch swallows the error without emitting `turn:resolved` or
`phase:changed` and without restarting the round timer (already cleared by the timer's own
tick handler *before* calling `resolveGameTurn`) — the room was left with no running timer
and no way to progress, for every player in it, until someone manually refreshed (which
forces a fresh `room:rejoin` re-sync, the only reason a refresh appeared to "fix" it). The
survivor would see this happen at almost the same moment as the entirely-correct
`ROOM_PLAYER_LEFT` "X's connection timed out" notification, since both stem from the same
grace-period-expiry event landing during resolution — hence "empty window + a disconnect
notification" reading as one single broken moment.

Fixed two ways, deliberately not just one:
- **`startHeartbeatCleanup`'s sweep loop now skips finalizing a player whose room is
  currently in `advancingRooms`**, leaving their `disconnectedPlayers` entry untouched so
  the very next 10s tick retries once the in-flight resolution has released the lock — the
  same "defer, don't fight over it" instinct `forfeitGame`'s "return a flag" pattern above
  already established for this exact lock, just applied to the sweep's caller instead of a
  socket handler. This closes the dominant direction of the race (a resolution already
  running when the sweep fires), which is by far the likelier ordering — a turn resolution
  can hold the lock for a non-trivial stretch (sequential per-player DB writes, KPI
  snapshot persistence), while `finalizePlayerRemoval`'s own work is a single small
  transaction.
- **`resolveGameTurn`'s per-player persistence loops (`bankruptedPlayers`, `companyUpdates`)
  and `persistKpiSnapshots` now wrap each player's writes in their own try/catch**, logging
  and moving on rather than letting one player's missing row abort the turn for the entire
  room. This is the belt-and-suspenders half: even if some *other* cause ever makes a
  player's row disappear mid-resolution (not just this specific race — any future one), the
  turn still fully resolves and broadcasts for everyone else. Don't reintroduce a bare
  `await this.prisma.company.update(...)` in either loop without this isolation — a single
  missing row must never be able to take the rest of the room down with it.

`gameEngine.test.ts` has regression coverage for both halves: one test in the
`finalizePlayerRemoval` heartbeat-sweep describe block blocks a `resolveGameTurn` call
mid-flight (a controlled promise held open across `advanceTimersByTimeAsync`), asserts
`player.delete` is *not* called while the lock is held even past the grace-period deadline,
then asserts it *is* called on the very next tick once the lock is released; another in the
`resolveGameTurn` describe block makes `company.update` reject for one specific player
mid-turn and asserts the turn still fully resolves and broadcasts `turn:resolved` for the
room regardless.

### A decision deployed this turn must not also be advanced this same turn — Step 1 and Step 2 need to agree on "which decisions existed before this turn started"

A real, reported bug (not hypothetical): deploying a decision and looking at its effect on
the turn it resolved showed roughly double the expected cash/asset movement. Root cause —
Step 1 (`processNewDecisions`) and Step 2 (`advanceAndApply`) both touch
`ctx.engineState.activeDecisions`, and used to disagree about which instances Step 2 was
allowed to touch:

- **Step 1** deploys each newly submitted decision (`DecisionEngine.deploy`, which starts
  it at `elapsedYears: 0`), pushes the new instance into `ctx.engineState.activeDecisions`,
  and immediately applies its deployment-year impact (`applyImpactsForYear(ctx.vars, ...,
  elapsedYears=0, ...)` — the schedule's `"1"` key, e.g. `cash: { 1: -30000, ... }`).
- **Step 2** advances *every* decision in `ctx.engineState.activeDecisions` by one year
  (`elapsedYears++`) and re-applies its impact at the new `elapsedYears`. Since Step 1 had
  already pushed the brand-new instance into that same array, Step 2 picked it up too —
  incrementing its `elapsedYears` from 0 to 1 and applying the `"2"` (or `"default"`)
  schedule key *again*, all within the turn it was just deployed. A decision selected
  exactly once ended up with its impact applied twice in that turn: once via Step 1's
  deployment-year application, once via Step 2 treating it as "already active, advance it."

Fixed by snapshotting `ctx.engineState.activeDecisions.length` for every player **before**
Step 1 runs, then in Step 2 splitting each player's array into the pre-existing prefix
(passed to `advanceAndApply`, which is the only portion allowed to advance/re-apply) and
the just-deployed suffix (appended back, untouched, still at `elapsedYears: 0`) — see the
`preTurnActiveCount` map in `resolveTurn`. A decision's `elapsedYears` is now `0` for the
whole turn it's deployed (its one Step 1 application is everything that turn), and only
becomes `1` at the *next* turn's Step 2, the first time it's genuinely "already active
coming into the turn." `gameLoop.test.ts`'s `"does not double-apply a decision's own
impact in the same turn it is deployed (regression)"` test guards this directly (isolates
Bot Attack's flat `-12000` self-cash effect against a submission-free baseline room,
diffing out everything else a turn's P&L also moves — same isolation technique the
negotiation Step 8b tests use); `"should advance active decisions across turns"` and the
persistence round-trip test both had their `elapsedYears` expectations corrected from the
old (buggy) `1`/`2` to the now-correct `0`/`1`. If you touch Step 1/Step 2 again, keep this
invariant: Step 2 must only ever advance decisions that existed *before* Step 1 ran this
same call.

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

### "Active Decisions"/"Open Lawsuits" have no empty-state text — the header count already says zero

Both boxes used to render a `<Text c="dimmed">No active decisions</Text>` / `No open
lawsuits` line when their combined active+queued list was empty. Removed as redundant:
the section title itself (`"Active Decisions (0 strategic and 0 operational)"`,
`"Open Lawsuits (0)"`) already states the count, so an empty-state line under an
already-zeroed header said the same thing twice. Both `SectionCard` bodies now always
render their `Stack` unconditionally — when nothing's active or queued it just renders
empty, no separate branch needed. If you add another list-in-a-box that already has a
counted title, don't add a redundant "no items" placeholder underneath it either.

### `gpStyles.stamp` badges (QUEUED, INSTANT, xT, MATURED, PLAINTIFF/DEFENDANT) — overriding a Mantine `Badge`'s border without also taking over its centering breaks vertical centering

`gpStyles.stamp(tone)` is the shared inline-style object behind every small bordered
label-badge in `GamePhase.tsx` — decision cards' `QUEUED`/`INSTANT`/`xT`/`✓ MATURED`, and
`CaseCard`'s `PLAINTIFF`/`DEFENDANT` — always rendered through Mantine's `<Badge
style={gpStyles.stamp(...)}>`. It used to just set `display: 'inline-block'` plus its own
`border`/`padding`/`fontSize` — a real, reported bug where the label text visually
overlapped the bottom border, on every one of these badges at once (they all share this
one style function). Root cause: Mantine's `Badge` sets its own fixed `height`/
`line-height` from its own stylesheet, sized for Mantine's *default*, much thinner border —
our custom 3px border plus 2px padding eats into that fixed height without adjusting it,
and once `display` isn't a flex/grid value, leftover vertical space collects unevenly above
the text (block-layout text is top-anchored within its line box) rather than splitting
evenly — measured live as an 8px gap above the label vs. a 1px gap below, i.e. the label's
own bottom edge sitting inside the 3px border stroke. Fixed by making `stamp()` take over
centering explicitly rather than trying to rebalance the height/line-height/padding math by
hand: `display: 'inline-flex'`, `alignItems: 'center'`, `justifyContent: 'center'`,
`height: 'auto'`, `lineHeight: 1` — flexbox centers the label regardless of whatever fixed
height Mantine's own stylesheet still applies underneath. If you add another `gpStyles.*`
helper that overrides a Mantine component's border/padding, check whether it also needs to
take over that component's centering the same way — a thicker border is exactly the kind
of change that silently breaks Mantine's own default vertical centering.
`gpStyles.filterChip` (the ALL/STRATEGIC/OPERATIONAL filter pills) and
`gpStyles.semaphoreChip` (the case-probability chip) weren't affected — neither overrides
`display` or uses as thick a border, so neither fights Mantine's own centering (or, for
`semaphoreChip`, isn't a `Badge` in the first place — it's a plain `Box` with its own
`display: 'flex'` from the start).

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
  Its `finalizePlayerRemoval` heartbeat-sweep describe block and its own
  `resolveGameTurn` describe block each have a regression test for the two-part fix to
  the grace-period/turn-resolution race documented above (a blocked-mid-flight
  `resolveGameTurn` defers the sweep's finalization until the lock is free; a rejected
  `company.update` for one player doesn't abort the rest of the room's turn) — extend
  those, not just the happy path, if you touch `advancingRooms` or either persistence
  loop again. `gameLoop.test.ts` also has a regression test threading 3 sequential `resolveTurn`
  calls to prove a case forced to trial by the negotiation timeout (`turnsNegotiating`
  reaching `negotiationPeriodTurns`) resolves to a verdict the same turn it crosses the
  threshold — see *Deliberate deviations from the design spec* above for why this test
  exists (the trial-resolution loop was dead code before this fix). Its
  `plaintiffFullyInvestigated` describe block covers all four branches of that stamped-
  at-filing-time flag (fully dug in + correct ground → true; never dug → false; dug but
  not to level 3 → false; fully dug on one decision instance but suing over an unrelated,
  non-targeting one → false) — see *A case's probability chip is defendant-only, unless
  the plaintiff earned it* above. `legalEngine.test.ts`'s `fileLawsuit` describe block and
  `gameLoop.test.ts`'s "should still create a case ... when the cited decision was never
  deployed by the target (a guess)" test are the regression coverage for the wrong-guess-
  still-creates-a-0%-case behavior described in *SUE THEIR ASSES offers the whole decision
  library's grounds* above — extend those, not just the "target actually did it" happy
  path, if you touch `fileLawsuit` again.
- `client/src/**/*.test.ts` — Vitest, Zustand stores and pure UI utilities.
  `GamePhase.utils.test.ts` deliberately duplicates small pure functions out of
  `GamePhase.tsx` (`fmt`, `getGroundsAgainst`, `detectNewlySuedCases`,
  `detectNewlyResolvedCases`, `detectNewlySettledCases`, etc.) rather than importing them,
  to keep this test file lightweight (no Mantine/tabler-icons import chain) — keep any
  duplicated copy in sync with the real implementation by hand if you change one side.
  `detectNewlyResolvedCases`/`detectNewlySettledCases` are each covered from both
  plaintiff and defendant perspectives, including the verdict-flip case (a `'lost'`
  verdict is a *win* for the defendant) — see *Post-turn events are a passive, clickable
  News feed* above.
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

### SUE THEIR ASSES offers the whole decision library's grounds, not just a target's actual ones — guessing wrong still creates a real (hopeless) case

`GamePhase.tsx`'s `getGroundsAgainst` used to derive the ground list from the *target's*
own `activeDecisions` — a player could only ever select something the target had
genuinely, verifiably done. By explicit product decision this is deliberately no longer
scoped to a target at all: it now returns every `legalRisks` entry across the *entire*
decision library, for every decision in the game, regardless of who (if anyone) has
actually deployed it. A player can knowingly gamble on a ground the target may or may not
have actually pursued — sue on a hunch, not just on confirmed intel.

`LegalEngine.fileLawsuit` had to change to make this meaningful rather than a trap: it used
to `return null` (no case at all) when the target never deployed the cited decision — that
behavior is what a wrong guess would have silently hit before, wasting the filing fee for
literally nothing. Now, when `targetActiveDecisions` has no matching instance,
`fileLawsuit` still creates a real `LegalCaseData`, just with `baseProbability` forced to
`0` instead of priced off a real schedule — there's no genuine ground to argue, so it's a
hopeless case, not a nonexistent one. `resolveProbability`'s multiplication
(`baseProbability * (1 + ...)`) means `adjustedProbability` stays `0` at trial time too,
regardless of the defendant's own scrutiny/legal exposure — a wrong guess can never
accidentally win. `fileLawsuit` still returns `null` for a genuinely malformed request (an
unknown decision or ground name entirely outside the library) — that's tampering, not
guessing; the real client only ever offers real decision+ground pairs.

The existing `plaintiffFullyInvestigated` mechanism (see *A case's probability chip is
defendant-only, unless the plaintiff earned it* above) already does exactly the right
thing here with zero further changes needed: a wrong guess can never satisfy
`plaintiffFullyInvestigated` (there's no real attacking decision instance targeting the
plaintiff to have investigated in the first place), so the plaintiff's own card shows
"Unknown" — they don't know it's hopeless. The **defendant** always sees the real number
(here, a plain `0%`), since they know perfectly well whether they actually did the thing
being alleged. This is the literal mechanic the user described: *"the one who sued doesn't
know this, but the defendant does."*

The `SueModal`'s "SUE NOW" shortcut (pre-fills a suggested ground from a fully-investigated
attack) now needs a `decisionName` alongside the `groundName` it already passed, purely to
disambiguate the prefill match against this now-target-independent, whole-library catalog
— two different decisions could in principle share an identically-named ground, since the
admin-editable decision library has no uniqueness constraint on legal-risk names (`onSueNow`'s
signature gained a `decisionName` parameter; `sueSuggestion` state gained a `decisionName`
field alongside `targetId`/`groundName`).

**A separate, previously-latent bug surfaced by this change, fixed alongside it:**
`chargeLawsuitFilingFee` (and `digDeeper`) read `Company.variables` directly via
`readVariables` without the same "first turn hasn't resolved yet" fallback `resolveTurn`
and `getInitialSnapshot` already apply (`if (!vars.cash && !vars.assets) vars =
this.startingVars();` — `Company.variables` defaults to `{}` in the DB until the very
first turn actually resolves and populates it). Filing a lawsuit during round 1, before
any turn has ever resolved, used to read `vars.cash` as `undefined`, compute `newCash =
undefined - cost` = `NaN`, and crash the subsequent `prisma.company.update()` call with an
invalid-argument error (surfaced client-side as `INVALID_FILE_LAWSUIT`). This was
essentially unreachable before — the old target-scoped ground list was always empty in
round 1 anyway, since nobody has deployed anything yet, so "file a lawsuit before round 1
resolves" was never a realistic thing to do. The whole-library catalog makes guessing in
round 1 an explicitly encouraged, realistic action, so this fallback had to be added to
`chargeLawsuitFilingFee` (and, defensively, to `digDeeper`, which has the identical
`readVariables` pattern even though it's not independently reachable pre-round-1, since an
attack can't exist to dig into before a turn has deployed one) to match `resolveTurn`'s.
`findCaseAndParties` (used by `makeOffer`/`acceptOffer`/`goToCourt`) was deliberately left
alone — a case can only exist after a turn has already resolved at least once, so its
identical `readVariables` call is provably never reachable with unpopulated variables.

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

**The valid offer range narrows inward with every move — it's not a fixed `(0, stakes]`
for the whole negotiation.** `GameLoop.computeOfferBracket(case_)` (private, called from
`makeOffer`'s validation) returns `{ min, max }`: `min` is the *defendant's* own most
recent offer (0 if they haven't offered yet), `max` is the *plaintiff's* own most recent
offer (the full `stakes` if they haven't offered yet). Concretely, across a negotiation:
the defendant's opening offer is bounded `[0, stakes]`; the plaintiff's first counter is
bounded `[defendant's offer, stakes]`; the defendant's next offer is bounded
`[their own previous offer, the plaintiff's latest offer]`; and so on, alternating —
each side's new offer can only ever tighten *its own* end of the bracket (a defendant
offer raises `min`, a plaintiff offer lowers `max`), never the other side's, so the range
only ever narrows or holds, never widens, and `min <= max` always holds as an invariant
as long as every accepted offer was itself validated against this same bracket. This
was a real, reported bug before the bracket existed: `makeOffer` only ever checked
`0 < amount <= stakes` for every offer regardless of negotiation history, so a player
could counter-offer *outside* what had already been offered/asked (e.g. the defendant
lowballing back below their own prior offer, or the plaintiff asking for more than they'd
already said they'd accept) — the whole point of a converging negotiation. The client's
`NegotiationPanel` mirrors this exact bracket in a same-named `computeOfferBracket`
function (hand-kept in sync, same "duplicate small pure logic client-side" convention
`GamePhase.utils.test.ts` already uses) purely to set the slider's bounds and the visible
"Range: $X – $Y" caption — the server is still the actual authority; a stale client-side
bracket (e.g. the other party just moved) just surfaces as an `invalid_amount` rejection,
handled the same way any other `makeOffer` failure is. `gameLoop.test.ts`'s `"offer
bracket narrows with each move (regression)"` suite walks the bracket through four
consecutive moves, asserting both the accepted boundary values and the values just
outside them are rejected at each step.

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

### A case's probability chip is defendant-only, unless the plaintiff earned it by fully investigating before filing

`CaseCard`'s header shows a colored percentage chip (`semaphoreLevel(displayProb)`,
`displayProb` = `adjustedProbability` if the case has one, else `baseProbability`) when
`knowsOdds` is true — a real number the defendant always genuinely has visibility into,
per FORMULAS §6/§9, and one the *plaintiff* only earns by having fully "Dig Deeper"-
investigated (investigation level `MAX_INVESTIGATION_LEVEL`, i.e. 3) the underlying
attack before suing over its exact suggested ground (see the *Attack Awareness & Dig
Deeper* section — the same suggested-ground concept `pickBestGround` computes there).
Otherwise the plaintiff side renders a `semColors.gray`-styled chip reading "Unknown"
instead, via `gpStyles.semaphoreChip('gray', false)` — the second `clickable` argument
(default `true`, only ever passed `false` here) drops the `cursor: pointer` styling,
since there's no `RiskBreakdownView` to open for a probability the player hasn't earned.
This replaced an earlier "Investigate" button that opened the target's Full Filing
report — removed by product decision as redundant (the identical Full Filing button
already exists in the Competitor Intel panel for every rival, case or no case) rather
than fixed in place; suing over a decision that never targeted the plaintiff at all (no
"attack" concept applies, e.g. a general risky decision like Water Pumping) always stays
"Unknown", since there's nothing to have investigated.

**Why this is stamped server-side (`LegalCaseData.plaintiffFullyInvestigated`) at filing
time, not recomputed client-side from `incomingAttacks` on every render:** a purely
client-side check ("does an attack in my current `incomingAttacks` list match this case's
decision/ground at investigation level 3") would regress back to "Unknown" mid-case if the
underlying attacking decision instance later disappeared from that list — it matures out,
or its deployer goes bankrupt — even though the plaintiff genuinely knew the odds at the
moment they filed. `GameLoop.resolveTurn`'s Step 8 filing loop computes this once, at the
exact moment a case is created (it has both the filing player's own
`ctx.engineState.investigations` and the target's `activeDecisions` in scope there), via
the same `pickBestGround` computation `revealAttack` already uses for the live hint —
looking up the target's active decision instance matching `filing.decisionName` **and**
`targetId === ` the filing player (so an unrelated, non-targeting decision never
qualifies), requiring investigation level `>= MAX_INVESTIGATION_LEVEL` on that exact
instance id, and requiring `pickBestGround`'s pick to match `filing.groundName` exactly (a
manually-chosen alternate ground on a multi-ground decision doesn't count, mirroring the
same scoping decision in *An incoming-attack hint disappears once sued over*). The
resulting boolean is then persisted into the case exactly like every other
`LegalCaseData` field (both parties' `engineState.legalCases`) and never recomputed —
permanent for the life of the case, immune to the attack info disappearing later.

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
inside another `setState`'s updater callback. `suedCases` has since been generalized first
into `eventQueue`, now into `newsItems` (see the next section) but the same rule applies
to every push into it.

### Post-turn events are a passive, clickable News feed — nothing auto-pops a modal anymore

Being sued, a lawsuit reaching a verdict (or settling by negotiation), and a new round
starting can all happen off the same `resolveTurn` call, and each has its own art/copy
(`sued.png`, `lawsuit-won.png`/`lawsuit-lost.png`/`defender-won.png`,
`settlement-proposal.png`, `turn-change.png`). `GamePhase.tsx` models all four as a single discriminated
union, `PostTurnEvent = { type: 'sued'; cases } | { type: 'verdict'; outcome; cases } |
{ type: 'settlement'; cases } | { type: 'turnChange'; round }`. This **used to** drive a
single auto-opening `Modal` off the front of a dismiss-to-advance `eventQueue` (each
event interrupted play the instant it happened); it now instead wraps every event into a
`NewsItem { id, round, event }` and appends it to `newsItems`, rendered as a scrollable
**News** box (`NewsBox`/`NewsRow`, right under the KPI cards) — nothing pops up
automatically anymore. The same info-window `Modal` still exists and still renders the
exact same per-type content it always did, but it's now driven by `newsModalItem` (which
row, if any, the player clicked) rather than the queue's front — clicking a `NewsRow`
opens it, closing just clears `newsModalItem`, and there's no more "pop the queue and
reveal what's next" dismissal chain since nothing needs to auto-advance. If you add a
fifth post-turn event type, extend the `PostTurnEvent` union and give it a `newsTopic`
case and a modal-content branch — don't reintroduce a separate auto-popping `Modal`/
boolean for it, or you've reintroduced the exact interruption this replaced.

`NewsItem.round` is `turnResults.round` for sued/verdict/settlement (the round that
*just* resolved, when the event actually happened — not the `round` state variable, which
by the time this effect runs may already reflect the round `phase:changed` just advanced
to; see the "must be keyed on `round`, not `turnResults?.round`" fix elsewhere in this
file for the general version of this same gotcha) — but `round` itself (the new round) for
`turnChange`, since that event is literally *about* the round changing. `NewsRow` flashes
red a few times (`news-flash` keyframes, alongside the pre-existing `pulse` one) purely by
relying on normal React/CSS semantics, not JS-tracked "is this new" state: `NewsBox` only
ever *appends* to `newsItems` (existing rows are never reordered or removed), so with a
stable `key={item.id}` React never remounts an existing row's DOM node — the animation
naturally only ever plays once, right when a row is first mounted, and never replays on a
later re-render of the same row. The list auto-scrolls to the newest item on append, but
only if the player was already scrolled at (or very near) the bottom — `NewsBox`'s
`stickToBottomRef` + a scroll-distance check is the whole mechanism, so a player who's
scrolled up to reread older news doesn't get yanked back down by a new arrival.

Three detector functions populate the feed, all pure and all unit-tested via duplicated
copies in `GamePhase.utils.test.ts` (see *Test layers* below): `detectNewlySuedCases`
(pre-existing), `detectNewlyResolvedCases` (added alongside the negotiation-timeout fix,
since a case can actually reach `'resolved'` with a trial `verdict` in live play), and
`detectNewlySettledCases` (added alongside the News feed, for a case resolved by
negotiation instead — `verdict: 'settled'`; deliberately still excludes `'cancelled'`, the
bankruptcy-waterfall outcome, which isn't a settlement the player negotiated). Both
`detectNewlyResolvedCases` and `detectNewlySettledCases` return each case already flipped
to the *querying player's own* perspective (`outcome: 'won' | 'lost'`, or `role:
'plaintiff' | 'defendant'`) — `LegalCaseData.verdict` itself is plaintiff-centric, so a
defendant's own win/loss (or which side paid whom in a settlement) is the logical inverse;
downstream UI never re-derives this, it just reads the already-flipped field.

**The 'verdict' modal's art distinguishes a plaintiff's payout from a defendant's
dismissal, not just win/lose.** `lawsuit-won.png` depicts collecting a large payout — right
for winning *as plaintiff*, but wrong for winning *as defendant* (a dismissal, no money
changes hands). `defender-won.png` was added specifically for that second case. Since one
'verdict' `PostTurnEvent` bundles every case that resolved `'won'` for me this *same* turn
(`won`/`lost` are split into separate events by `detectNewlyResolvedCases`'s grouping, but
not further split by role), the image is chosen by checking whether *every* case in the
bundle has me as defendant (`currentEvent.cases.every((c) => c.plaintiffId !== player?.id)`)
— the overwhelmingly common case, since winning as both plaintiff and defendant in the same
turn is a rare coincidence. A hypothetical mixed bundle falls back to the plaintiff-payout
art rather than picking arbitrarily; this hasn't needed anything more precise in practice.
`lawsuit-lost.png` is unaffected — no equivalent role split exists for a *loss*, since no
second art asset was ever commissioned for it. The 'settlement' modal (previously
text-only) now leads with `settlement-proposal.png` the same way every other News modal
does — no role split there, since a settlement is a mutual, negotiated event rather than
one side unilaterally winning or losing.

**Deliberately not a `PostTurnEvent`/News item:** the "someone else went bankrupt" notice
lives outside this feed entirely — in `gameStore.bankruptcyEvents` and `App.tsx`'s
`BankruptcyModal`, rendered as an overlay alongside whatever `page` the `currentPhase`
switch produces, not folded into `GamePhase`'s local `newsItems`. `newsItems` is local
`GamePhase` state, so it (correctly) disappears the moment `GamePhase` unmounts — fine for
sued/verdict/settlement/turnChange, since the game is still going whenever those fire. A
bankruptcy can end the game outright, in which case `currentPhase` flips to AFTERMATH and
`GamePhase` unmounts almost immediately (the `player:bankrupt` and `game:over`/
`phase:changed` broadcasts arrive back-to-back from the same turn resolution) — anything
queued in `GamePhase`'s own local state would vanish unseen right along with it. Promoting
it to `gameStore` (top-level, phase-independent state read directly in `App.tsx`) instead
of the News feed is what makes it survive that transition — `BankruptcyModal` renders
whether `page` is `GamePhase` or the `GameOver` screen that same elimination may have just
swapped in underneath. If you add another post-turn notice that must be visible even when
it's the thing that ends the game, follow this same pattern, not the News-feed one.

**`BankruptcyModal` is a `Modal` overlay, not a full-page takeover — a real, reported bug
had it blanking out the entire running game.** It used to be a page-level `<Container>`
returned from an early `if (bankruptcyEvents.length > 0) return <BankruptcyOverlay .../>`
check in `App.tsx`, positioned *ahead of* the `currentPhase` switch — which meant it fully
replaced whatever was on screen, including a still-in-progress `GamePhase` for every
surviving player, the instant anyone else went bankrupt. From a surviving player's point of
view the game appeared to stop dead and show nothing but this notice, even though the round
timer, their own KPIs, and everyone else's turn were all still very much live underneath.
Fixed by changing the container from `<Container>` to a Mantine `Modal` and rendering it
*alongside* `page` in the final return (`{page}{bankruptcyEvents.length > 0 && <BankruptcyModal .../>}`)
instead of returning it early — `page` (whatever `currentPhase` currently resolves to) keeps
rendering underneath, dimmed by the modal's overlay backdrop exactly like every other
"info window" in this app (the News item modal, `SueModal`, etc.), and the running game is
visible and interactive again the instant the notice is dismissed. The reasoning for why
this has to stay a top-level `gameStore` check rather than a `GamePhase`-local News item is
unchanged (see above) — only the *rendering* changed, from "instead of the page" to "on top
of the page."
