# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Sue Their Asses" — a multiplayer, server-authoritative business strategy game. Players
run companies for 120s rounds, deploy decisions from a shared 45-decision library, sue
each other over risky moves, buy up rivals' shares to force a hostile takeover, and get
eliminated the instant their cash goes negative or another player crosses 50% ownership of
their company. Last player standing wins. Real-time via Socket.IO; React/Vite client;
Express/Prisma/PostgreSQL server; npm workspaces monorepo (`client`, `server`, `shared`).

The full design spec — every game mechanic, phase flow, socket event, and Zustand store
method — is documented in `README.md`. Read it before making non-trivial changes; this
file only covers what the README doesn't (commands and architecture orientation).

**There is no separate design-spec document for game math anymore.** A
`definitionDocumentation/FORMULAS.md` used to be the source of truth (formulas + the exact
per-turn calculation order, cited throughout the code as `FORMULAS §N`), but it's been
retired: the pure, scalar, named-input math it described (competitiveness, P&L, balance
sheet, legal-risk/risk-gauge formulas) now lives in Postgres (`Formula` table, seeded from
`server/src/engine/defaultFormulas.ts` — that file, not any `.md`, is the closest thing to
a fixed reference for the *default* expressions, though `/admin` can change what's actually
running) and is editable live from `/admin`; the *procedural* half (execution order,
depreciation ledger, bankruptcy/merger waterfall, FIFO tie-breaking) was never data-driven
and has been folded directly into the code that implements it — `gameLoop.ts`'s
`resolveTurn` (the numbered `// ── Step N ──` comments are the current, accurate execution
order) and `calcEngine.ts`/`decisionEngine.ts`/`legalEngine.ts`'s own doc comments. Trust
those inline comments and this file over any memory of the old document — the decision
library/config are similarly DB-backed, not static files; see *"Decisions/config are
DB-backed, not static JSON"* and *"Formulas are DB-backed"* below.

## Working conventions

**If a prompt leaves anything open or underspecified, ask for the details — do not
guess.** This includes ambiguous scope ("fix the modal" when there are several modals),
unclear intent (does "remove X" mean delete the code or just hide it in the UI?),
unstated defaults (a new admin-editable number with no default given), or a request that
could reasonably be implemented two different ways with materially different behavior.
Guessing and building the wrong thing costs more of the user's time than asking up front;
a wrong assumption silently shipped is worse than a clarifying question. This doesn't mean
asking about every trivial detail with an obvious answer from context/convention — use
judgment, but default to asking when genuinely unsure rather than picking an interpretation
and running with it.

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

**`npm run dev:server` uses `nodemon` (polling), not bare `tsx watch`** — a real, repeatedly
reproduced problem: `tsx watch`'s (and, separately, Vite's default) native-OS-file-event
watching would silently go stale after the dev server had been running for a while,
stopping restarts/HMR for **any** further edit (not just cross-package ones — even edits
to `server/src/index.ts` itself stopped triggering a restart), with no error and no
indication anything was wrong short of "I edited the code and nothing changed." The only
fix at the time was killing and restarting the dev processes. Root cause was never pinned
to one deterministic trigger (every short-window isolated test — bare `tsx watch`, `npm
run dev:server` alone, `concurrently` alone, the full chain freshly started — reliably
detected changes; only long-uptime, real-world sessions on this machine actually went
stale, most plausibly tied to something like laptop suspend/resume invalidating native
file-change-event state, though that's inference, not a confirmed repro). Since the
trigger couldn't be pinned down, the fix is to stop depending on native OS file-change
events at all: `server/nodemon.json` configures `nodemon` (not `tsx watch` directly) with
`legacyWatch: true` — polling-based change detection, immune to whatever class of native
watcher staleness was happening — watching both `src` and `../shared/src` (nodemon, unlike
bare `tsx watch`, takes an explicit `watch` list, so this was also the fix for cross-package
`shared/src` edits never reaching the server) and re-execing `tsx src/index.ts` on each
change. `client/vite.config.ts`'s `server.watch: { usePolling: true, interval: 300 }` is
the equivalent fix on the client side, for the exact same reason (Vite's HMR file-watcher
is chokidar-based and has the same native-event dependency `usePolling` bypasses). Verified
live end-to-end after this fix: editing `shared/src/index.ts` while a real browser page is
open produces genuine `[vite] hot updated: ...` console messages, and editing `server/src/`
triggers `[nodemon] restarting due to changes...` — both confirmed via a real dev-server
session, not just config inspection. If you ever revisit this dev-server setup and are
tempted to simplify back to plain `tsx watch` (nodemon is one more moving part), know that
this is exactly the failure mode that reintroduces.

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

### An incoming-attack hint disappears once a real case exists against that exact attacking instance — matched by instance id, not by requiring the suggested ground

`server/src/engine/gameLoop.ts`'s `buildIncomingAttacks` rebuilds the incoming-attacks
list fresh every turn purely from "is there still another active player whose still-active
`target.*`-bearing decision targets me" — it has no concept of "already sued," and doesn't
need one. Instead, `GamePhase.tsx`'s `isAttackAlreadySuedOver` filters the list
client-side, hiding an attack's hint card once a lawsuit exists against exactly this
attacking decision instance — checking both `pending.lawsuits` (queued this turn, not yet
a real case) and `myData.legalCases` (a real case from a prior turn's filing, any status),
since `pending.lawsuits` for it is cleared the moment the real case exists.

**A real case is matched by `c.defendantDecisionInstanceId === attack.attackId`** — the
specific instance, not "same decision name," and regardless of which ground was actually
sued over. This replaced an earlier version that required the ground to be exactly
`attack.suggestedGroundName` (only populated at `investigationLevel >= 3`) — a real,
reported bug: a player who sued over a manually-picked ground via `SueModal`'s own picker
(not the "SUE NOW" shortcut), or who sued correctly before investigating deep enough for
`suggestedGroundName` to even exist, had a genuine open case against the attacker over
that exact decision and still saw the hint card stuck up forever, since a manually-picked
ground never satisfied the old exact-ground-name check. Matching by instance id instead is
both more permissive (any ground counts, no investigation-level floor) and no less
correct: `LegalEngine.fileLawsuit` (`server/src/engine/legalEngine.ts`) only ever stamps
`defendantDecisionInstanceId` for a genuine, still-actionable match — a wrong guess or a
time-barred ground always leaves it `undefined` — so this is still exactly "a real,
non-hopeless case exists against this attack," computed with zero client-side probability
logic (no re-implementing the admin-editable, DB-backed formula evaluation this app
deliberately keeps server-only — see *"Formulas are DB-backed"* below — the way the old
version's `successProbability > 0` gate implicitly relied on the *pre-filing estimate*
being accurate). `IncomingAttackInfo.attackId` and a real case's
`defendantDecisionInstanceId` are guaranteed to be the same underlying id when they match
the same instance: both are stamped from `DeployedDecision.id` (`decision.id` in
`buildIncomingAttacks`, `targetInstance.id` in `fileLawsuit`), never a separately-derived
value.

`pendingLawsuits` (queued this turn, not yet resolved into a real case) has no instance id
to match against at all — a queued `SubmittedLawsuitEntry` is only `{ targetId,
decisionName, groundName }` — so it's still matched loosely, by attacker + decision name,
same as before; this is an accepted, narrower approximation than the real-case check, not
a regression, since it only ever covers the gap within the single turn a lawsuit is
queued but not yet resolved.

### A player can dismiss an incoming-attack hint they're not interested in — a third, purely client-side filter alongside "already sued over"

Requested directly: nothing let a player hide a "[Player] did something to you"/"...did
something that indirectly affects you" hint they'd decided not to act on — it stayed
pinned in the Open Lawsuits box for as long as the underlying decision instance remained
active (which, for a permanent-effect decision, can be most of a game). `GamePhase`
(the top-level component) now holds `dismissedAttackIds: Set<string>` — a plain `useState`,
same "ephemeral, resets on reload" convention as `pending`/`newsItems` elsewhere in this
file, since a "stop showing me this" preference has no reason to be server-authoritative
or to survive a refresh. `AttackHintCard` gained a small "✕" (`IconX`) in its header row,
calling a threaded-down `onDismiss(attack.attackId)` that adds to this set;
`IncomingAttackHints` filters `dismissedAttackIds.has(a.attackId)` alongside its existing
`isAttackAlreadySuedOver` check (see above) before rendering — a third way a hint can stop
showing, alongside "sued over" and "matured/expired/voided out of `incomingAttacks`
entirely" (the server-side list already excludes those on its own).

Keyed by `attackId` (the attacking decision instance's stable id), the exact same id
`isAttackAlreadySuedOver` already matches by — a dismissal sticks for as long as that
specific instance keeps reappearing in `incomingAttacks` every turn, and stops mattering
the moment the server stops sending it (matured out, expired past the statute, voided by a
lawsuit) or a NEW instance of the same decision is redeployed later with a different id, at
which point it's a fresh hint the player hasn't seen before and shows normally — dismissal
is scoped to the one instance, not "this decision, forever," matching how sued-over
already scopes by instance rather than by name for the identical reason (see above). No
server round-trip, no persisted field: this is purely "which cards is this browser tab
currently choosing not to render," the same category of local view state as which KPI
breakdown panel is expanded or which filter chip is selected.
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

### A socket that starts a second game without reloading kept receiving its first game's broadcasts — a real, reported, reproduced bug

Reported directly by a user: playing two sequential games in one browser session (same
player, two different opponents) showed the *second* game's Game Over screen with
information from the *first* game. Reproduced with a live 3-player Playwright scenario
before touching any code (not assumed from reading alone): `PlayerA` forfeits out of a
3-player room1 (room1 keeps going for the other two), returns to the landing page via the
"lost" takeover's **Leave** button (no page reload — same socket connection the whole
time), creates a brand-new room2, and starts a fresh game against `OpponentC`. The instant
room1 later concludes on its own (its remaining two players finish among themselves),
`PlayerA`'s room2 screen — mid-game, nothing to do with room1 — suddenly showed
`"Game Over! OpponentB wins!"` (room1's actual winner) and a
`"OpponentD has gone bankrupt"` info-window modal (a room1-only player who forfeited
there), stomped directly over the correct, still-in-progress room2 UI.

**Root cause: a socket only ever gets added to Socket.IO's per-room broadcast channel
(`socket.join(roomId)`), never removed from an old one on every path that can leave a
player's socket connected but no longer meaningfully "in" that room.** `ROOM_LEAVE` (the
WAITING-lobby "Leave Room" button) is the *only* handler that ever calls
`socket.leave(roomId)`. `GAME_LEAVE` (the in-game "Leave Game" forfeit button) does not —
deliberately, since a forfeited/bankrupted player can choose to keep *spectating* that
exact room (see the game-timeline feature's live mode), so leaving the channel the instant
they forfeit would break that on-purpose feature. But nothing ever left it *later* either,
even once that same socket moved on to a completely different room. `GameEngine`'s own
`playerToRoom` bookkeeping map (socketId → current room id) gets correctly overwritten the
moment that socket creates/joins a new room — so every *outbound* action from that socket
(submitting decisions, filing lawsuits, `game:getGameTimeline`, etc.) is correctly scoped
to the new room — but the *inbound* Socket.IO room membership from the old room was never
torn down, so `io.to(oldRoomId).emit(...)` broadcasts (`turn:resolved`, `phase:changed`,
`player:bankrupt`, `game:over`) kept reaching this socket indefinitely, on top of whatever
the new room's own broadcasts were also sending it. Every client-side handler for these
events (`setGameOver`, `enqueueBankruptcyEvent`, `updatePhase`, `handleTurnResolved`)
applies its payload unconditionally, with no concept of "is this event even about the room
I'm currently looking at" — so the old room's stale broadcast silently won whichever race
it happened to land in.

**Fixed by guarding at the point a socket newly attaches to a room, not by chasing every
individual path that might fail to detach it.** `GameEngine.leaveStaleSocketRoom(socketId,
newRoomId)` reads the *current* `playerToRoom` mapping for that socket before it's
overwritten, and calls `.leave(oldRoomId)` on the actual `Socket` instance (looked up via
`this.io.sockets.sockets.get(socketId)`) if there was a different one. Called from all
three places that ever (re)point `playerToRoom` at a room — `createRoom`, `joinRoom`,
`rejoinRoom` — right before the `.set()` call, so it always sees the outgoing value. This
is deliberately the general fix, not a targeted "also call `socket.leave` in the
`GAME_LEAVE` handler" patch: it closes the gap for forfeit *and* for any other current or
future path that might leave a socket's room membership stale without anyone having
noticed, since it doesn't matter *why* the old membership never got cleaned up — only that
a socket must never belong to more than the one room `playerToRoom` currently says it's in.
The common case (a genuinely fresh socket, e.g. after an actual page reload) is a no-op —
`playerToRoom.get(socketId)` has nothing to return yet.

`gameEngine.test.ts`'s `createMockIo()` gained a `sockets: { sockets: Map }` (empty by
default — every existing test's socket ids have no registered entry, so the optional-
chained `?.leave(...)` this guard performs is a harmless no-op for all of them) so tests
that *do* care can register a fake socket with a `leave` spy directly into that map. Three
regression tests — one each in `createRoom`, `joinRoom`, and `rejoinRoom`'s describe
blocks — register such a socket, attach it to a first room, then (re)attach the same
socket to a second, different room, and assert `.leave(firstRoomId)` was actually called
and `getPlayerRoom` now reports the second room. Extend those, not just the happy path, if
you touch `playerToRoom`/`leaveStaleSocketRoom` again.

### A forfeit's `player:bankrupt` broadcast carries `reason: 'forfeit'` — everyone else gets their own "chickened out" notice, not the generic bankruptcy one

Raised directly by the user: when a player forfeits (`game:leave`), every other still-
in-the-game player used to see the exact same `BankruptcyModal` copy/art ("X HAS GONE
BANKRUPT", `lost.png`) a natural cash<0 elimination gets — voluntarily quitting and
actually running out of money read identically to everyone watching it happen. This was
never a problem for the forfeiting player's *own* screen — `App.tsx`'s `LostOverlay`
already correctly shows "YOU FORFEITED" for them, driven by the separate `game:left`
event (see *Leave Game (Voluntary Forfeit)* in README) — the gap was specifically in what
everyone *else* saw, since `GameEngine.forfeitGame`'s `player:bankrupt` broadcast carried
no `reason` field at all (unlike the natural-elimination path, which always sends
`reason: 'bankruptcy' | 'merger'` from `GameLoop`'s `BankruptedPlayer.reason`), so it fell
through to the same "gone bankrupt" branch every other reason-less case already did.

Fixed by having `forfeitGame`'s broadcast explicitly send `reason: 'forfeit'` — a third
value alongside the pre-existing `'bankruptcy'`/`'merger'`, widened through every type that
carries this field client-side (`socketStore.ts`'s `PLAYER_BANKRUPT` handler,
`gameStore.ts`'s `bankruptcyEvents`/`enqueueBankruptcyEvent`, `App.tsx`'s
`BankruptcyModal` props). `BankruptcyModal` gained a third branch alongside its existing
merger/bankruptcy one: title `🐔 PLAYER CHICKENED OUT`, `chickened-out.png` (a new asset,
moved into `client/public/images/` alongside `lost.png`/`acquired.png` and renamed to this
codebase's kebab-case convention — it arrived at the project root as
`SueTheirAsses_chickenedOut.png`), and "X CHICKENED OUT" / "They forfeited the game rather
than see it through — the rest of you carry on without them." copy. `GameLoop`'s own
`BankruptedPlayer.reason` type (`'bankruptcy' | 'merger'`) was deliberately **not** widened
to include `'forfeit'` — a forfeit never goes through `GameLoop`'s bankruptcy waterfall at
all (`forfeitGame` is one of the four out-of-band exceptions to "everything happens in
resolveTurn," see that section above), so `'forfeit'` could never actually appear there;
the two `reason` unions describe genuinely different, non-overlapping code paths that just
happen to share a client-side rendering component.

`gameEngine.test.ts`'s `forfeitGame — ready interaction` describe block and
`gameStore.test.ts`'s `bankruptcyEvents queue` describe block each gained a regression
test for this (the broadcast payload, and the queue round-tripping the new reason value
unchanged) — extend those, not just the happy path, if you touch this again. Verified live
end-to-end via a real 2-player Playwright run (not just unit tests): the surviving
player's screen shows the "🐔 PLAYER CHICKENED OUT" modal with `chickened-out.png` and
"OPPONENTB CHICKENED OUT," overlaid on the Game Over screen exactly like the pre-existing
bankruptcy modal already does for a natural elimination.

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

### The Decision Deck also has a search field and a KPI sort — search mirrors SueModal's, sort ranks by each decision's own deployment-year effect

Added alongside the level/nature filter chips, not replacing them — all three (filters,
search, sort) compose freely, applied in that order (`filtered` is search-and-filtered
first, then `.sort()`ed in place if a KPI is chosen).

**Search** (`searchQuery` state, a `SEARCH DECISIONS` field) is a straight copy of
`SueModal`'s `SEARCH GROUNDS` field's shape — same `gpStyles.searchInput` div +
`IconSearch` + borderless `TextInput`, same "match name or description, case-insensitive"
logic — just matching `d.decision`/`d.description` instead of a ground's name/description.
Deliberately not shared as a component: each is a two-line inline block wired to its own
local state and its own filter predicate, and factoring out a shared `<SearchField>` for
this little markup would be more indirection than the duplication it removes (matching the
existing "duplicate small pure logic, keep in sync by hand" convention elsewhere in this
file, e.g. `GamePhase.utils.test.ts`).

**Sort by KPI** is a native `<select>` (the same un-styled-Mantine `<select>` `SueModal`'s
own TARGET dropdown already uses, not a Mantine `Select`) listing every KPI field *some
decision in the library actually affects* — `getSortableKpiFields` derives this from the
live `decisions` prop (scanning every `DecisionDefinition.impacts` key, excluding
`target.*`/`competitor*` ones, same exclusion `hasPermanentEffect` already uses and for the
same reason: "sort by Outrage" in this deployer-facing view means the deploying player's
own outrage, not what a decision does to a chosen opponent) rather than a hardcoded
`PlayerVariables` field list — since decisions are DB-backed/admin-editable, a hardcoded
list could easily drift from what's actually in the deck, or offer a field nothing touches.
Two direction chips (`Highest → Lowest` / `Lowest → Highest`, reusing `gpStyles.filterChip`)
only render once a KPI is actually selected — no point showing a direction toggle with
nothing to toggle.

`getDecisionSortValue(def, field)` is the ranking key: `def.impacts[field]`'s schedule value
at deployment time (`schedule[1] ?? schedule['default'] ?? 0`) — deliberately mirrors
`calcEngine.getScheduleValue(schedule, 0)`'s exact convention (the explicit year-1 entry if
the schedule has one, else the steady-state `'default'`, else 0) without importing server
code, since this is a client-only display ranking, not real game math. A decision with no
impact on the chosen field at all sorts as a plain `0`, landing wherever that value falls
among the rest — no special-casing "doesn't affect this KPI" as a separate bucket. This
was a deliberate, simple choice among several reasonable ones (first-year value vs. summed
total vs. steady-state value) — if a future request wants "sort by total lifetime impact"
or "sort by steady-state value" instead, that's a one-line change to this function, not a
structural one.

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

### `canDeploy`'s level-limit check counted a player's entire lifetime of active decisions, not this turn's submissions — a severe, real, reported bug

A real, reported bug: a player deployed three decisions in one turn (Raw Material
Monopoly, Night Dumping, Water Pumping), lost lawsuits over all three (voiding them), and
the next turn's brand-new decisions — unrelated names, nothing to do with the voided ones
— got visibly queued (`QUEUED` badge, normal pending-submission UI) but then silently
vanished the turn after, never becoming active decisions. Neither the deploying player nor
the other player ever saw them. No error was ever surfaced anywhere.

`DecisionEngine.canDeploy` used to take `maxStrategic`/`maxOperational` and, after the
maturity/permanent-effect/exclusion checks, compute `stratCount`/`opCount` by filtering
**`playerDecisions`** (the caller's `ctx.engineState.activeDecisions`) by level and
comparing against those maxes — the intent being "at most `maxStrategicDecisionsPerTurn`/
`maxOperationalDecisionsPerTurn` decisions of each level per turn" (the README/game-design
"1 strategic + 2 operational per round, use-it-or-lose-it" budget). The bug:
`playerDecisions` is a player's **entire historical** `activeDecisions` list — matured
instances are never removed from it, voided-by-lawsuit instances are never removed from it,
nothing is ever removed from it, for the whole game. So `stratCount`/`opCount` weren't "how
many of this level have I submitted this turn" at all — they were "how many of this level
have I ever deployed, in total, since the game began." The instant a player's lifetime
total for a level first reached that level's per-turn max (functionally guaranteed within
the player's first one or two turns of normal play, since the whole point of the budget is
to use it), `canDeploy` began rejecting **every subsequent decision of that level for the
rest of the game** — regardless of maturity, and regardless of whether the old instances
eating the count had since been voided by a lost lawsuit (as in the reported case) or
simply matured. `GameLoop.processNewDecisions` swallows a `canDeploy` rejection with a bare
`continue` and no feedback (by design, for the ordinary "level-limit/maturity/exclusion
reasons this specific entry didn't deploy" case — see `ShareTransactionRequest`'s doc
comment) — from the player's point of view this reads exactly like the bug report: the
decision visibly queues (client-side `pending` state has no idea the server will reject it)
and then just disappears with no trace once the turn actually resolves.

The real per-turn cap was — and still is — already enforced correctly, completely
independently, by the *caller*: `processNewDecisions`'s `for (const entry of
sub[bucket].slice(0, maxForBucket))` only ever attempts at most `maxForBucket` entries from
**this turn's own submission** in the first place, per bucket. `canDeploy`'s own
recomputation was therefore not just buggy but entirely redundant even when correct — two
independent implementations of "cap decisions per turn," one right (bounded to this turn's
submission) and one silently wrong (bounded to the player's lifetime activity). Confirmed
this was a real, live bug (not just a suspicious-looking code path) by writing a two-turn
`GameLoop` reproduction before touching anything: turn 1 deploys exactly
`maxStrategicDecisionsPerTurn`/`maxOperationalDecisionsPerTurn` worth of decisions (normal
play, not an edge case), turn 2 submits one *more*, entirely different decision of each
level — and it was silently dropped every time, matured or not, voided or not.

Fixed by removing `maxStrategic`/`maxOperational`/`level` from `canDeploy`'s signature
entirely (all three existed solely to feed the deleted block — `level` was never read for
anything else, and the client-side mirror `getDeployability` in `GamePhase.tsx` never even
had a level-count check to begin with, further confirming this was never meant to be part
of `canDeploy`'s job) and deleting the "Level limits" block outright, leaving the existing
`.slice(0, maxForBucket)` in `processNewDecisions` as the one and only place this budget is
enforced. `decisionEngine.test.ts`'s two "should block exceeding strategic/operational
limit" tests — which existed specifically to pin down the buggy behavior — were replaced
with regression tests proving the *opposite*: a player with many old matured (or
lawsuit-voided) decisions of a level is *not* blocked from deploying a new, different one.
`gameLoop.test.ts` gained an end-to-end two-turn regression test (turn 1 uses the full
per-level budget via entirely normal submissions, turn 2 submits one more decision of each
level and asserts both actually deploy, including a `target.*`-bearing one showing up in
the *other* player's `incomingAttacks` — covering the "other player didn't see them either"
half of the original report, not just the deploying player's own view) — extend those, not
just the happy path, if you touch `canDeploy` or `processNewDecisions`'s per-turn budget
enforcement again.

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
reimplementing a subset of the 9-step turn math (risking drift from the real thing), it
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

### `ActiveDecisionsBox` — the "Active Decisions" list gained a status filter, a turn/target/name sort, and a fixed-height scroll cap

Everything the box shows — still-queued picks and already-deployed instances — used to
render as one flat, unbounded list with no way to filter or reorder it, straight in
`GamePhase`'s own JSX. Pulled out into its own component, `ActiveDecisionsBox`, following
the same "small view component owns its own local filter/sort state" shape
`DecisionDeckView` already established (see its own section above) rather than lifting
this state into `GamePhase` itself.

**A unified `DecisionBoxItem` discriminated union** (`{ kind: 'queued'; ... } | { kind:
'active'; ... }`) normalizes both shapes down to the handful of fields filtering/sorting
actually needs (`name`, `targetName`, and — active only — `status`/the raw
`ActiveDecisionInstance`) — built once per render from `pending`+`myData.activeDecisions`,
the exact same two sources the box already merged, just now filtered/sorted before being
handed to `QueuedDecisionCard`/`ActiveDecisionCard` (unchanged themselves, aside from
`ActiveDecisionCard` gaining the same optional `targetName` prop
`QueuedDecisionCard` already had).

**The status filter needed `ActiveDecisionInstance` itself to gain a `targetId` field it
never had before.** `ActiveDecisionCard`'s badge logic (voided/expired/matured/still-
maturing) was always computed inline from `decision.voidedByLawsuit`/`isMatured`/
`elapsedYears` plus the looked-up `DecisionDefinition` — pulled out unchanged into
`getActiveDecisionStatus`, now shared between the card's own rendering and the filter's
classification (`decisionBoxItemStatus`, which also handles the fifth filter option,
`'Queued'`, that only ever applies to a still-pending pick), so the two can never
disagree about what "Voided — Sued" vs. "Expired" means for a given instance. But
`targetId` — which decision instance a decision like Bot Attack was aimed at — was never
sent to the client for an *already-resolved* instance at all; only a still-queued
`SubmittedDecisionEntry` carried it (`QueuedDecisionCard`'s existing `targetName` prop).
`GameLoop.resolveTurn`'s Step 13 result-building now includes `targetId: d.targetId` in
the `activeDecisions` it returns (the underlying `DeployedDecision` always had it — this
was a genuine gap in what got exposed to the client, not new engine state), so
`ActiveDecisionCard` can resolve and show `→ {targetName}` (and the box can sort by it)
the same way `QueuedDecisionCard` already could for a pick that hasn't resolved yet.

**Sort follows the exact "native `<select>` + two direction chips" shape** the Decision
Deck's own "SORT BY KPI" already established (see above) — three fields (`turn`, `target`,
`name`), not KPI-derived ones, since sorting a list of decision *instances* by "how much
they affect a KPI" doesn't make sense the way ranking the whole *library* by it did. A
queued pick has no `deployedYear` yet, so `getDecisionBoxTurn` treats it as happening at
the *current round* for sort purposes — "not yet started, treat as happening now," the
same convention the box's own `QUEUED` badge already implies. Sorting by `target`/`name`
uses a plain `localeCompare`; an item with no target (most of the decision library) sorts
via an empty-string fallback, landing wherever that falls alphabetically rather than in a
special "no target" bucket — the same "no special-casing, just let it sort naturally"
choice `getDecisionSortValue` already made for a decision that doesn't touch the chosen
KPI at all.

**`ACTIVE_DECISIONS_MAX_HEIGHT` caps the list to roughly 3 collapsed cards' worth of
height** (`maxHeight` + `overflowY: 'auto'`, the same shape the Decision Deck's own list
already uses at `60vh`), rather than letting a long game's accumulated decisions push the
rest of the page down indefinitely. Deliberately an approximation, not an exact fit — a
real card's height varies with whether it has a target line, a progress bar, or an
expanded SHOW DETAILS panel, none of which a fixed pixel constant can account for; the
constant is sized against a plain collapsed card. Filter/sort controls themselves are only
rendered when the box actually has at least one item — an empty box shows just the MAKE
IMPORTANT DECISIONS button, matching the "no redundant UI when there's nothing to act on"
instinct behind the empty-state-text removal directly above. A filtered-to-nothing result
(items exist, but none match the current status filter) gets its own short dimmed message,
the same "tell the player why the list looks empty" treatment `DecisionDeckView`'s own
filter/search already has — distinct from the *box itself* being empty, which still gets
no message at all (the header count already says zero).

`GamePhase.utils.test.ts`'s `getActiveDecisionStatus`/`decisionBoxItemStatus`/
`getDecisionBoxTurn`/`sortDecisionBoxItems` describe blocks and `gameLoop.test.ts`'s
"carries a target-bearing decision's targetId through to the client-facing
activeDecisions entry (regression)" test are the coverage — extend those, not just the
happy path, if you touch this again.

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

### AI decision generation (EXPERIMENTAL, admin-only) — the same local Qwen3-1.7B can invent a whole decision + its lawsuits, but only as a human-reviewed draft, never live

Explored on request: could the same local model already narrating annual-report blurbs
also *invent* new decisions (with their own `legalRisks`) during a live session? Built as
a real, working prototype — `server/src/services/decisionGenService.ts` (prompt +
network call + retry loop) and `server/src/services/decisionGenGuardrails.ts` (a second,
semantic validation pass) — then evaluated against the actual running container before
deciding how far to take it. **Verdict: yes, worth keeping, but as an admin-side content-
assist tool only — never wired into a live game.** This was the explicit scope from the
start ("let's not go live with this"), and the eval below confirms it was the right call:
the model's *prose* (decision names, descriptions, legally-flavored lawsuit grounds) is
consistently plausible and on-theme, but its *numbers* — both magnitudes and which of
`absolute`/`relative` a given field is supposed to use — are unreliable enough that
nothing it produces should reach a live game without a human looking at it first.

**Generation only ever produces a reviewable draft, never a save.** `POST
/api/admin/decisions/generate` (admin-token gated, same as every other `/api/admin/*`
route) calls `generateDecisionCandidate` and returns the result — it never touches the
`Decision` table itself. `AdminPortal.tsx`'s new "✨ Generate with AI (experimental)"
button (in the Decisions tab, next to "Add Decision") pre-fills the *existing* raw-JSON
`NewDecisionForm` textarea with the draft; saving it still goes through the exact same
`decisionDefinitionSchema`-gated `POST /api/admin/decisions` a hand-written decision
does. There is no code path anywhere that lets a generated decision reach a `Company`'s
`activeDecisions` without an admin explicitly reviewing and clicking Create — the same
"AI proposes, human disposes" boundary this file's earlier LLM section already
established for annual-report text, just for something with real gameplay stakes instead
of flavor text.

**The prompt** (`buildDecisionGenPrompt`) gives the model: the exact required JSON shape
(mirroring `DecisionDefinition`+inline `LegalRiskDefinition`), an explicit whitelist of
the ~30 `impacts` field names it may use (never a free-form field), the `absolute`
(flat add) vs. `relative` (×(1+value)) semantics, a compact magnitude cheat-sheet derived
from scanning the real 45-decision library's own observed ranges per field, a rule that
`legalRisks[].impact.target` may only be `cash`/`equity`/`revenue` (the only three the
engine actually knows how to price stakes from — see `LegalEngine.fileLawsuit`), a
"touch 2-4 fields, not more" instruction, and one real decision (picked fresh at random
from the current live deck each call, not hardcoded) as a full worked few-shot example.
Caller-supplied hints (`theme`/`level`/`nature`/`offensive`) are appended to the user
message; the existing decision library's names are listed so the model doesn't collide
with one.

**The guardrail pass (`clampDecisionCandidate`) is the part doing the real safety work,
confirmed by the eval below — not a defensive afterthought.** Applied AFTER
`decisionDefinitionSchema.parse` already confirmed the raw shape, since a schema-valid
decision can still be a bad one:
- `impacts` is filtered to the same whitelist the prompt describes (anything else,
  including a `target.*`-prefixed hallucination, is dropped with a warning) and capped at
  `MAX_IMPACT_FIELDS` (5) total.
- Every schedule value is clamped into `FIELD_RANGES[field][type]` — the same real-data-
  derived ranges the prompt's cheat-sheet describes, so the prompt and the enforcement
  agree on what's "normal" for a field.
- **A field that only ever appears as ONE of `absolute`/`relative` in the real 45-decision
  library (true of every field except `operatingExpenses`/`capacityUtilization`) has its
  `type` coerced to that one real type if the model picked the other** — `resolveImpactType`
  exists specifically because a magnitude clamp alone can't catch this: a flat `+100`
  "absolute" addition to `materialCostPerTon` (a field the real library only ever treats as
  a `relative` fraction) easily fits inside a generic fallback range even though it's a
  categorically different, uncalibrated effect than what that field is supposed to mean.
- `legalRisks` capped at `MAX_LEGAL_RISKS` (3), `impact.target` forced into
  `cash`/`equity`/`revenue` (defaulting to `cash` otherwise) with `type` forced to match
  (`cash`→absolute, `equity`/`revenue`→relative) regardless of what the model paired them
  as, probability clamped to `[0.01, 0.7]`, duplicate ground names dropped.
- `offensiveAction`/`requiresTarget` are derived from whether a `target.*` impact actually
  *survived* clamping, not trusted from the model's own flag — a decision can't end up
  with a dangling target-picker UI and no real target effect, or vice versa.
- A name collision with an existing decision is resolved by suffix (`"X (AI)"`, `"X (AI
  2)"`, …), `excludes` is filtered to only real existing decision names (a hallucinated
  exclude target is dropped), `cashFlowCategory` is forced present-and-valid whenever
  `impacts.cash` survives and stripped entirely otherwise. A candidate reduced to zero
  real `impacts` fields is treated as a failed generation attempt (`isViableCandidate`),
  not shipped as an empty draft — `generateDecisionCandidate` retries up to 3 times total.
- `decisionGenGuardrails.test.ts` (24 tests) and `decisionGenService.test.ts` (14 tests,
  covering `extractJson`'s handling of `<think>` blocks/markdown fences/stray prose, the
  prompt builder, and the retry loop) are the regression coverage — extend those, not
  just the happy path, if you touch this again.

**Live eval against the actual container** (Qwen3-1.7B-Q4_K_M, CPU-only, no GPU — the
same model/container the annual-report feature uses): 6 generation requests spanning a
mix of themes/levels/natures/offensive hints, each candidate then dropped into a real
`GameLoop` alongside the full 45-decision seed library and played for 20 rounds across 2
random seeds (240 simulated turns total) to check for crashes/NaN/out-of-range values —
a smaller version of this file's own "randomized-simulation bug hunt" methodology, aimed
at one specific new decision instead of the whole deck.

- **6/6 succeeded on the first attempt** (no retry needed) — schema-valid, and left with
  at least one real impact field after clamping. Generation took 85-113 seconds each on
  this CPU-only container (a first run with a too-short 30s timeout aborted 100% of
  attempts — not a model-quality failure, a harness bug, since a ~300-token JSON response
  plus a long, mostly-static system prompt's own processing time genuinely takes this
  long without a GPU). Tolerable for an admin clicking a button and waiting under two
  minutes; not something to ever call synchronously mid-turn.
- **0/6 crashed the engine or produced an invariant violation** across all 240 simulated
  turns — encouraging, but this reflects the *engine's* existing defenses (the zero-floor
  clamps, the NaN guards from this file's own earlier bug-hunt section) and this feature's
  own guardrail pass doing their job, not evidence the model's raw output was safe on its
  own.
- **19 guardrail warnings fired across the 6 successes (~3.2 per decision)** — guardrails
  were load-bearing on nearly every single generation, not decorative. Concretely: one
  outright hallucinated field name (`target.environmentalImpact`, not a real
  `PlayerVariables` field, dropped); five `absolute`/`relative` type-convention mismatches
  across three different decisions (the model swapping which fields use which
  convention despite the prompt's explicit cheat-sheet and worked example); and — the
  most telling single case — a "Strategic" data-center decision that asked for `debt:
  500000-600000`, `operatingExpenses: 150000-180000/turn`, and `capacityUtilization: +0.3
  to +0.4` treated as `absolute` (all clamped down to `120000`/`30000`/`0.2`
  respectively). Unclamped, that one candidate alone would have handed a player 5-6x
  starting cash in fresh debt and nearly 6x a normal decision's ongoing opex burden,
  compounding every turn — exactly the kind of number a small model produces with
  perfectly confident, plausible-sounding prose wrapped around it.
- **One further, accepted limitation surfaced, not fixed**: `revenue`'s real-library
  convention is "absolute, always a positive gain" (the only two real decisions that
  touch it, Channel Stuffing and a marketing-style boost, only ever add revenue) — so
  `FIELD_RANGES.revenue.absolute` is `[0, 50000]`. A generated attack decision that tried
  to reduce a target's revenue by 15-20% (a perfectly reasonable creative intent) had that
  value clamped to `0` — a legitimate-sounding effect silently neutered because it used an
  existing field in a direction the real deck happens to never use it in. This is the
  conservative failure mode of deriving every range strictly from precedent: safe by
  construction, but it can flatten a plausible new idea that doesn't fit an existing
  field's one observed direction. Not fixed here — widening it is a real content decision
  (does this game want revenue-reducing attacks routed through this field?), not a bug.
- **A sign error the guardrails caught rather than the prompt preventing**: one candidate
  gave a `legalRisks[].impact` a *positive* schedule value (as if suing the deployer were
  a payout to them, not a cost) — `LEGAL_RISK_FIELD_RANGES` being strictly negative-only
  is what forced this to a sane number instead of silently inverting who benefits from a
  lawsuit.

**Bottom line**: the model is good at the part it was already proven at (the annual-
report feature) — short, plausible, on-theme prose, including surprisingly convincing
fake legal-doctrine names — and unreliable at the part it was never asked to do before
(tracking a specific game's numeric conventions and scale across ~30 fields). That split
is exactly why this stays a human-reviewed admin content-assist tool: useful for
drafting a starting point worth editing, not a generator trustworthy enough to skip
review, and nowhere close to something that should invent decisions unsupervised inside
a running game session.

While testing this, found and fixed an unrelated, real, pre-existing bug: `docker-
compose.yml`'s `llm` service requested `/models/Qwen3-1.7B-Q4_K_M.gguf`, but the actual
file on disk is lowercase `qwen3-1.7b-q4_k_m.gguf` — a case mismatch on Linux's
case-sensitive filesystem, so the container was crash-looping (`gguf_init_from_file:
failed to open GGUF file`) on every start. Fixed by matching the command's `-m` path to
the real filename. This affected the pre-existing annual-report feature too, not just
this one — anyone who ran `docker-compose up llm` locally would have gotten a
permanently-unavailable LLM (silently masked by `llmService.ts`'s fallback-on-failure
design, which is exactly why nobody had noticed).

### An incoming attack's tier-1 hint reuses the same AI-narrated annual-report blurb — computed in `GameEngine`, never inside `GameLoop`

`IncomingAttackInfo.annualReportBlurb` is set whenever an attack's `investigationLevel`
is exactly 1 — the tier where the attacker's identity is known (`attackerName`) but the
attacking decision itself isn't yet (`decisionName`/`decisionDescription`/`effectSummary`
all still `undefined` — see `revealAttack`'s tiers above). Before this, that tier's hint
card was just a bare "`[player]` did something to you" headline with nothing else to go
on. The blurb reuses the exact same generation `game:getAnnualReport` already produces
for a rival's Full Filing report (`generateAnnualReportBlurb`, with a
`DecisionDefinition.competitorsView` fallback) — deliberately vague, non-mechanical
corporate PR-speak by construction (see the LLM system prompt above), so surfacing it a
tier early doesn't leak anything level 2's real fields don't already reveal more
precisely; it's flavor, not intel.

**This has to live in `GameEngine`, not `GameLoop.buildIncomingAttacks`/`revealAttack`**,
for the same reason `getAnnualReport` itself does: those run inside the pure, synchronous
`resolveTurn`/`getInitialSnapshot`, which must never do network I/O (this file's
two-layer architecture split). Two call sites need it, not one, because
`incomingAttacks` is recomputed fresh every time regardless of whether a dig just
happened:
- **`GameEngine.digDeeper`** — right after persisting the dig's cash/engineState update,
  if the dig happened to land exactly on `investigationLevel === 1` (a heads-up 2-player
  game's `effectiveInvestigationLevel` shortcut can skip straight past this tier to level
  2 — see above — so not every successful dig qualifies), it looks the attacker's decision
  instance up in the already-loaded `dbPlayers` (by `attack.attackerId` + `attack.attackId`)
  and attaches the blurb before returning the result to just that one requesting socket.
- **`GameEngine.resolveGameTurn`** — every *subsequent* turn, `buildIncomingAttacks`
  rebuilds the same level-1 entry fresh from the player's persisted investigation level
  (see *"An incoming-attack hint disappears..."* above for why it has no memory of past
  digs beyond that), so the blurb has to be re-attached on every `turn:resolved` broadcast
  too, not just the one turn the dig happened — `enrichIncomingAttackBlurbs` does this in
  bulk, across every player's `incomingAttacks`, right before the broadcast. It's built
  from `outcome.companyUpdates`' POST-turn `engineState.activeDecisions`, not the pre-turn
  `dbPlayers` `resolveGameTurn` loaded earlier — a decision deployed or matured this exact
  turn must resolve to the same instance `buildIncomingAttacks` itself just described from
  the post-turn state, not a stale pre-turn snapshot.

Both call sites share one private helper, `annualReportBlurbForInstance` — the same
"decision has no `competitorsView` to draw a fallback from → omit the field entirely, not
an empty string" behavior `getAnnualReport`'s own filter already has, so a level-1 hint
for a decision with no flavor text configured just shows no blurb line at all rather than
a blank one. Client-side, `AttackHintCard` renders it as an italic line right under the
headline, gated on `!attack.decisionName` (i.e., only while still at exactly this tier —
once level 2 is reached, the real decision facts replace it, the same way `SueModal`'s SUE
NOW route replaced an older, now-redundant intel source elsewhere in this file).
`gameEngine.test.ts`'s `"digDeeper — incoming-attack annual report blurb"` describe block
(landing on level 1 exactly, going past it, and the no-`competitorsView` omission) and its
`resolveGameTurn` describe block's blurb-persistence regression test (the blurb survives
into a later turn's broadcast without a fresh dig) are the coverage — extend those, not
just the happy path, if you touch this again.

### The tier-3 Dig Deeper reveal shows estimated stakes alongside estimated odds — priced identically to a real filed case, on request

`DecisionEngine.pickBestGround`'s `SuggestedGround` (the tier-3 "suggested ground +
estimated win probability" reveal) used to surface only a probability — a player deciding
whether to actually sue had no idea how much money was even on the line before committing to
the filing fee, only what a real case's `CaseCard` shows *after* filing (`LegalCaseData.
stakes`, always visible regardless of `knowsOdds` — see the STAKES box in `CaseCard`
below). Added a `stakes` field to `SuggestedGround`, threaded through to
`IncomingAttackInfo.suggestedGroundStakes` and rendered in the same row as "Estimated
success" in `AttackHintCard`'s tier-3 box.

**Priced by mirroring `LegalEngine.fileLawsuit`'s real stakes calc exactly, not
independently re-derived** — same fixed `risk.impact.schedule['default'] ??
risk.impact.schedule[1] ?? 0` read (not `getScheduleValue(schedule, elapsedYears)` —
stakes deliberately isn't elapsed-year-sensitive, matching how the real case prices it),
same relative-vs-absolute branch (`absolute` grounds use the schedule value directly;
`relative` grounds — `target: 'equity'`/`'revenue'` in the real library — scale it against
the defendant's own current value of that field, read generically off `PlayerVariables`,
never hardcoded to a specific field name, same principle as `shareTransactionType`/
`legalRiskConditions` elsewhere in this file). The whole point is that the number a player
sees *before* filing matches what the real case will actually carry once filed — an
independently-computed "estimate" that quietly used a different formula would be worse than
no number at all. This is why `pickBestGround`'s `attackerVars` parameter had to widen from
a narrow `Pick<PlayerVariables, 'scrutiny' | 'legalExposureRatio'>` to the full
`PlayerVariables` — computing a relative ground's stakes needs generic index access into
whichever field the ground actually targets, not just the two fields the probability
formula happens to read. Both real call sites (`revealAttack`, and the plaintiff-side
`plaintiffFullyInvestigated` check in `resolveTurn`'s Step 8) already pass the full
`PlayerVariables` object they had on hand, so this was a pure widening, not a behavior
change at either site.

**Deliberately not an expected value.** `stakes` is "what's at stake if this lands," shown
unmodified next to (not multiplied by) `successProbability` — a player weighing "is this
worth $15,000 to file" needs both numbers separately, not one number that's already
discounted by a probability they can also see right next to it.

`decisionEngine.test.ts`'s `pickBestGround` describe block gained two regression tests (an
absolute-type ground's stakes equal the raw schedule value; a relative-type ground's stakes
scale correctly against a defendant fixture's current `equity`) and `gameLoop.test.ts`'s
dig-3 test asserts `suggestedGroundStakes` comes through end-to-end via `GameLoop.digDeeper`
— extend those, not just the happy path, if you touch `pickBestGround`'s stakes calc or add
a relative-type ground against a field other than `equity`/`revenue` again.

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

**A previous version of the depreciation-ledger gate hardcoded a decision-name allowlist
— exactly the class of bug the DB-backed/admin-editable design is supposed to prevent.**
`calcEngine.ts` used to export `DEPRECIATING_ASSETS`, a hardcoded `Set` of 9 decision names,
and `applyDecisionImpacts` only created a depreciation-ledger entry for a positive
`assets`/`intangibleAssets` addition if the decision's name was in that Set — on top of the
already-sufficient structural check (`field === 'assets'/'intangibleAssets'` and
`value > 0` on the deployment year, which is what actually identifies "this is a genuine
capital purchase"). This wasn't a hypothetical risk: auditing the real, shipped
`game_engine.json` against the hardcoded list found `Preventive Maintenance` — a decision
with a genuine positive `assets` impact — already missing from it, silently never
depreciating, no error, no admin edit required to trigger it. Renaming any of the 9 listed
decisions via `/admin`, or adding a brand-new one with a positive asset impact, hit the
exact same silent failure.

Fixed by deleting `DEPRECIATING_ASSETS` outright and trusting the structural signal alone
— `addDepreciationEntry` (now `(assetType, value, currentYear)`, `decisionName` parameter
removed entirely since nothing inside it ever needed the name once the allowlist was gone)
creates an entry for any positive value, unconditionally. Removing that dead parameter
cascaded exactly one layer up on each side of the call chain it was only ever forwarded
through — `decisionEngine.ts`'s `applyInstance`/`applyImpactsForYear` and their two call
sites in `gameLoop.ts`'s `processNewDecisions` — since a parameter that exists solely to be
forwarded and never read is the same class of latent smell, not a separate concern to leave
half-fixed. If you're ever tempted to special-case behavior by decision *name* anywhere in
the engine (as opposed to by a `DecisionDefinition` *field*, e.g. `impacts.assets`,
`legalRisks`, `nature`, `excludes` — all genuinely admin-editable per-decision data), this is
the failure mode to remember: it silently drifts from whatever's actually in the DB, with no
error to catch it, and normal test coverage against the seeded library won't catch it either
unless a test specifically asserts "an arbitrary/renamed decision behaves the same as a
known one" (see `calcEngine.test.ts`'s regression tests, added alongside this fix, which do
exactly that — asserting the depreciation behavior no longer depends on which decision name
is passed in at all).

### `processingLevel`/`capacityUtilization`/`installedCapacity`/`price` are floored at 0 — a requirement that outlived the document that specified it

Surfaced while retiring `definitionDocumentation/FORMULAS.md` (see this file's intro):
the old spec required these 4 fields to have a hard floor of 0 (no ceiling on any of
them), but auditing the actual engine found no clamp anywhere — `applyDecisionImpacts`'
Phase 2 (`calcEngine.ts`) applies accumulated relative multipliers as `currentVal * (1 +
multiplier)` with nothing stopping a large enough negative multiplier (several
Maintenance-Neglect-style decisions' negative relative effects stacking on the same
field, for instance) from driving one of these below zero, which has no real-world
meaning for any of the four — a negative price, negative capacity, etc. This was never
flagged as a deliberate deviation anywhere, unlike every other spec/code mismatch in this
file — genuinely an unimplemented requirement, not a decision to skip it.

Fixed by `calcEngine.ts`'s `clampFloorZeroFields`, a small shared helper (`ZERO_FLOOR_FIELDS
= ['processingLevel', 'capacityUtilization', 'installedCapacity', 'price']`) called at the
end of **both** `applyDecisionImpacts` and `applyTargetImpacts` — a decision's own-field
effects and its `target.*`-routed effects (target.processingLevel/target.capacityUtilization
are both real routable fields, see below) go through separate functions but must agree on
the floor, so one helper is shared rather than duplicating the clamp logic twice. Applied
unconditionally to the field, not just when this turn's application happened to touch it —
simpler than tracking "did this call touch a floored field" and behaviorally identical,
since a field already `>= 0` is a no-op to re-clamp. `calcEngine.test.ts`'s
"zero-floor fields" describe block (nested under `applyDecisionImpacts`) and the new
`applyTargetImpacts` describe block are the regression coverage — including a check that a
field *outside* this set (e.g. `outrage`, which is legitimately allowed to go negative,
see `absOutrage` in the risk gauge) is untouched by the clamp.

### Randomized-simulation bug hunt — a 4-player, many-round, random-decisions-and-lawsuits game engine simulation, run directly against `GameLoop`

On request, ran a standalone script (not committed — a temporary `tsx`-executed harness
importing `GameLoop` directly, since it's a pure engine with no DB/socket dependency) that
plays out full 4-player games against the *real* seed data (`game_engine.json`/
`game_config.json`/`defaultFormulas.ts` — the exact data `prisma/seed.ts` puts in
Postgres), not this suite's smaller hand-written fixture decisions: each active player each
round deploys 1-2 random decisions (skipping ones that would obviously overdraw cash, a
crude "a real player wouldn't do this" heuristic) and files 0-2 blind lawsuits against
random targets over a random ground from the whole library, exactly mirroring
`chargeLawsuitFilingFee`'s real cost/limit checks. After every `resolveTurn` call, every
player's `variables`/`derived`/`riskGauge`/`shareOwnership` were checked against basic
invariants (every number finite, `riskGauge` within its documented 0-100 range, ownership
fractions summing to ~1). 100 seeded games surfaced two real, previously-undiscovered bugs:

**1. `applyDecisionImpacts`'/`applyTargetImpacts`'s absolute-impact write corrupted an
undefined field to `NaN` permanently.** Both had a bare `(v as any)[field] += value` for
an `'absolute'`-type impact. `revenue`/`financeCost`/`taxCost` are "Derived (computed each
turn)" `PlayerVariables` fields — genuinely `undefined` until something writes to them,
since `startingVars()` never seeds them (unlike every *typed* Decimal/required field).
`undefined + number` is `NaN` in JS, and — unlike `receivables`/`equity`/`stockValue`/
`marketShare`/`volume`, which Step 7/Step 4/Step 5 freshly *overwrite* every single turn
regardless of what Step 1/2 left behind — nothing else in a turn ever touches
`vars.revenue`/`financeCost`/`taxCost` again, so once corrupted, `NaN` (and `NaN + anything
= NaN`) persisted for the rest of that player's game the instant they (or, since this
touches shared `PlayerVariables` shape, *any* player) ever deployed a decision whose
`impacts` targets one of these three fields directly — `Channel Stuffing` (`impacts.
revenue`), `Tax Planning` (`impacts.taxCost`), `Payday Loan` (`impacts.financeCost`) are the
three real decisions in the library that do. This was silent in every other test layer:
none of `calcEngine.test.ts`'s existing `applyDecisionImpacts` tests happened to exercise a
field starting genuinely `undefined` (they all use `makeVars()`, which sets every field the
interface allows, including the optional ones) — a hand-written fixture can only ever cover
the specific case someone thought to write, and nobody had reason to think "what if this
field was never initialized" until a random simulation actually hit it. Fixed by guarding
both absolute-write sites with `?? 0` (`(v as any)[field] = ((v as any)[field] ?? 0) +
value`) — the same defensive pattern the relative branch already effectively had for free
(its `typeof currentVal === 'number'` guard already skips an undefined field rather than
corrupting it). This is data hygiene, not a live gameplay-math bug in practice — grepped
every formula input across `calcEngine.ts`: nothing else ever reads `vars.revenue`/
`financeCost`/`taxCost` as an input (P&L/balance-sheet/risk-gauge all take freshly computed
local values, e.g. `pl.revenue`, not these three fields), so the corruption was contained
to the persisted-but-unread JSONB blob (and, once corrupted, silently became `null` on the
next DB write — `JSON.stringify(NaN) === null`) rather than skewing cash, equity, or any
elimination check. Still a real bug worth fixing: any future feature that *does* start
reading these fields (or a client surface that displays `variables.revenue` instead of the
always-correct `derived.revenue`) would have silently inherited permanently-broken data.

**2. The `riskGauge` formula's scrutiny term had no lower clamp, letting the whole gauge
dip below its documented 0-100 range.** `w2*MIN(1,scrutiny/100)` — `scrutiny`, unlike
`outrage` (piped through `Math.abs` before the formula ever sees it as `absOutrage`), has
no floor of its own and nothing in the decision library drives it back up once negative
(no "reduce scrutiny" mechanic exists at all) — a decision with a negative scrutiny impact
can push it arbitrarily negative, and `MIN(1, ...)` only ever caps the *top* of that
division, never the bottom. Fixed in `defaultFormulas.ts`'s seeded `riskGauge` expression
by clamping that one term on both ends (`MAX(0,MIN(1,scrutiny/100))`), matching how
`absOutrage`'s term already only needed the upper clamp since `Math.abs` already guarantees
its lower bound. The client-side mirror (`GamePhase.tsx`'s `computeThreatTerms`, used only
for the Threat Level breakdown's row-by-row display, never the authoritative gauge value
itself — see *KPI history + prediction graphs* / trend-arrow sections above for the general
"duplicate small pure logic client-side" convention this file follows) had the identical
gap and needed the identical fix, plus — noticed while fixing it — was *also* missing the
upper clamp on its outrage term entirely (`Math.abs(v.outrage) / 100` with no `Math.min(1,
...)` at all), a separate, smaller pre-existing mirror-drift bug fixed in the same pass.
**Like every other DB-backed formula change, an already-seeded dev database needs `npm run
db:seed` re-run to pick this up** — editing `defaultFormulas.ts` only changes the seed, not
any already-seeded `Formula` row (see *Formulas are DB-backed* below).

**The simulation itself is kept as a permanent regression test**
(`server/src/engine/gameLoop.simulation.test.ts`), not just a one-off bug-hunting script —
a hand-written fixture library can only ever cover fields/decisions someone thought to
write a test for; a real, evolving 45-decision/83-legal-risk library is exactly the kind of
surface where a specific field-name collision is what actually breaks, not the general
shape of the math. It runs the identical random-play simulation against the real seed data
across several fixed seeds (deterministic, no flakiness) and asserts the same invariants
the manual bug hunt checked, plus two narrow regression cases pinned to the two bugs found
(deploying Channel Stuffing must not corrupt `variables.revenue`; a negative scrutiny value
must not push `riskGauge` below 0). If you add a new decision whose `impacts` targets an
optional/derived `PlayerVariables` field, or change how any Risk Gauge term is clamped,
this is the test most likely to catch a reintroduced version of either bug without anyone
having to think to write a dedicated case for it.

Beyond the two bugs, the same 100-game run is also this project's best current evidence for
several open balance/game-design questions — see the conversation this ran in (not
duplicated into this file, since these are live design judgment calls, not settled facts
the way a bug fix is): games most often see their first elimination by round 3 under
random/careless play; a small number of decisions (`New Factory` most notably — its
`-$100,000` year-1 cash cost alone equals the player's *entire* starting cash, before any
other turn cost) are large enough relative to starting cash to be a real trap for an
unwary early deploy; and a few decisions (`Venture Capital Shadow Money`,
`Hype Initial Coin Offering`) grant a large, immediately-liquid cash injection gated only by
a probabilistic, opponent-dependent legal risk with no guaranteed downside, which combined
with their short (1-year) maturity means they can in principle be redeployed every couple
of turns for compounding "free" cash. None of these are bugs — they're judgment calls about
decision balance that need a product decision, not a code fix — but they're recorded here
as the concrete findings that random-play run turned up, in case a future session picks
this up again.

### `advanceAndApply` re-applied a matured decision's `'default'` effect every turn forever — the real root cause behind the simulation's runaway growth and several "certain doom" death spirals

Follow-up to the randomized-simulation findings above, after the user asked for concrete
fixes to `New Factory`/`Venture Capital Shadow Money` and a way to reduce runaway growth.
While verifying the `New Factory` balance fix (below) empirically — rerunning it through
`GameLoop` turn by turn — a much bigger issue surfaced than "some decisions are too
strong/weak": **any decision instance with a nonzero `'default'` schedule value on *any*
field kept having that value re-applied every single subsequent turn, forever** (bounded
only by `gameSettings.statuteOfLimitationsYears`, default 10 — not literally infinite, but
10 turns of continuous `×1.4` compounding is still ~29x). Confirmed directly: a single
`New Factory` deployment with zero other activity grew `installedCapacity` 350 → 490 → 686
→ 960 → 1345 → 1882 → 2635 over 7 turns — pure exponential compounding from one instance.
The *same* mechanic on `absolute` fields was doing the mirror-image thing on the cost side:
`operatingExpenses` (`default: 25000`) kept adding another $25k on top every turn (20k → 45k
→ 70k → 95k → ...) and `capacityUtilization` (`default: -0.3`) kept subtracting 0.3 every
turn — which is why the *first* attempted `New Factory` balance fix (just reducing/spreading
the year-1/year-2 cash cost) still ended in bankruptcy by round 4 in an isolated
reproduction: the front-loaded cost was no longer the killer, the *ongoing, ever-growing*
opex/capacity-utilization drag was.

This directly explains the earlier randomized-simulation run's most extreme numbers (final
cash ranging from -$1.39 billion to +$49.4 billion from a $100k start) far better than
"cross-decision stacking" ever could — a *single* well-timed permanent-effect decision,
left alone for the length of a real game (median ~8-15 rounds in that run), is enough on
its own. The fix originally proposed for "reduce runaway growth" (a passive scrutiny drift
for dominant players) was reconsidered and **not** implemented as a substitute for this —
a linear drift can't meaningfully counter true per-turn exponential compounding, and would
have been treating a symptom while leaving the actual mechanism untouched.

**Root cause, precisely:** `DecisionEngine.advanceAndApply`'s per-turn loop called
`applyInstance` (→ `applyDecisionImpacts`) at every still-active instance's *current*
`elapsedYears`, on every turn, with no memory of "have I already applied this instance's
now-final value." Once `elapsedYears` passes a decision's own maturity threshold (the max
explicit schedule year across its impacts), `getScheduleValue` permanently returns
`'default'` for every future `elapsedYears` — so the loop kept re-consulting (and
re-applying) that same `'default'` value turn after turn, compounding a `relative` field's
multiplier against itself and accumulating an `absolute` field's addend on top of itself,
indefinitely. This directly contradicted the game's own documented multi-instance stacking
rule (`installedCapacity = base * (1 + 0.4 + 0.4)` for two matured `New Factory`s, summed
once against a *stable* base — a framing that only makes sense if a single instance's own
contribution isn't itself a moving target) and the plain-language framing of "permanent
effect" throughout the decision library and this file (a one-time, lasting step-change —
"this factory permanently raised your capacity" — not a perpetual, uninvested-in annual
re-multiplication).

**Fix:** `advanceAndApply` now applies a decision's own (non-`target.*`) impacts through
and including the turn its maturity threshold is first reached (`elapsedYears <=
threshold` — covering every legitimate explicit-year value plus exactly one `'default'`
application, the turn it's first consulted), and skips the instance entirely on every turn
after (`elapsedYears > threshold`). An instant-maturity decision (threshold 0, `'default'`-
only schedule — the majority of `Operational` decisions) applies its value exactly once, at
deployment (Step 1's `applyImpactsForYear` call, `elapsedYears=0`), and is skipped by
`advanceAndApply` on every subsequent turn from then on (`elapsedYears` starts at 1 on the
very next call, already `> 0`). Composes correctly with the pre-existing statute-of-
limitations early exit, which still matters for the (unusual) case of an admin-configured
statute *shorter* than a decision's own maturity — that check still fires first and can
force `isMatured`/skip application before the natural threshold would have.

**Deliberately scoped to a decision's own impacts only.** `target.*` effects
(`collectTargetImpacts`/`applyTargetImpacts` — an attacking decision's ongoing effect on
its victim) keep their existing "re-applies every turn until the statute of limitations"
behavior, completely unchanged. That's a separate offense/defense balance question (an
ongoing attack that keeps hurting its victim every turn until legally time-barred is a
much more defensible design than a company's own internal investment magically
re-compounding on its own) that nobody asked to revisit here — changing it would weaken
every attacking decision in the library at once, a much bigger, unrequested scope
expansion.

**Regression coverage**, reviewed test-by-test against the *entire* existing
`advanceAndApply`/`collectTargetImpacts` suite before changing anything (only one existing
test, `decisionEngine.test.ts`'s old `"should use default schedule when matured"`, actually
encoded the buggy behavior and needed rewriting — everything else, including every existing
statute-of-limitations/exclusion/voided-instance test, turned out to already be compatible
with the fix, which is itself a good sign the fix is well-targeted):
- `decisionEngine.test.ts`'s `advanceAndApply` describe block: the rewritten "applies the
  default schedule value exactly once, the turn maturity is first reached" test, plus two
  new regression tests (`absolute` field stops accumulating past maturity; `relative` field
  stops compounding past maturity, checked across 3 consecutive calls).
- `gameLoop.test.ts`'s `predictFutureKpis` describe block: the old
  `"keeps ... applying its schedule into every predicted turn"` test (which used an
  instant-maturity decision and asserted an *ever-widening* cash gap — exactly the bug)
  was split into two: one confirming an already-matured decision produces **no further**
  difference in predicted future turns, and a new one confirming a *still-maturing*
  decision's remaining explicit-year values keep landing correctly until it matures, then
  stop (using `suppressRevenue` to isolate the direct cash-schedule effect from
  `New Factory`'s own `installedCapacity`-via-revenue confound — see that fixture's own
  doc comment).
- `server/src/engine/gameLoop.simulation.test.ts` (see above) already re-exercises this
  fix implicitly on every run against the real decision library, and the same 100-game
  randomized simulation run that found the bug was re-run after the fix as direct
  empirical confirmation: final cash across 100 games narrowed from a
  -$1.39 billion..+$49.4 billion range to -$766k..+$9.2 million, `hitRoundCap` (a game
  never resolving within 80 rounds) dropped from 4/100 to 0/100, and median game length
  actually *increased* (8 → 12 rounds) — consistent with games no longer being cut short by
  one player snowballing into an unbeatable, uninteresting lead.

### Decision balance adjustments (round 1: `New Factory`, `Venture Capital Shadow Money`) — data-only, in `game_engine.json`

Both were flagged by the randomized-simulation findings above and fixed by explicit
request, independently of (and before discovering) the compounding bug above — both
remain worthwhile on their own merits regardless of that fix, though the compounding fix
is what makes `New Factory`'s numbers actually *hold* at their new, better-balanced levels
instead of drifting back into "too punishing" territory a few turns later.

**`New Factory`** was pricing its year-1 cash cost (`-$100,000`) at exactly the player's
entire starting cash, before any of the game's own baseline per-turn costs (~$30k
opex+staff), with the capacity payoff not landing until the year *after* maturity (the
`installedCapacity` boost was `default`-only). Changed: the two-year cash cost dropped
from `{1: -100000, 2: -100000}` to `{1: -60000, 2: -60000}` (total outlay -$120k instead
of -$200k), and `installedCapacity`'s schedule gained an explicit, smaller `2: 0.15` step
(a partial +15% capacity benefit starting the turn *before* full maturity, on top of the
unchanged `default: 0.4`) so the investment isn't 100% cost with 0% benefit for its entire
maturation window. The `capacityUtilization: -0.3` ramp-up penalty was deliberately left
unchanged (offered as optional polish, not requested).

**`Venture Capital Shadow Money`** granted an instant `+$250,000` (2.5x starting cash) with
*zero* deterministic cost — its only downside was a probabilistic, opponent-dependent
lawsuit — and a 1-year maturity meant it was redeployable every couple of turns for
compounding "free" cash. Gained a new `financeCost` impact,
`{1: 0, 2: 15000, 3: 15000, 4: 15000, default: 0}` — three turns of a real, guaranteed
$15k/turn repayment cost (total -$45k against the +$250k gain — still strongly net
positive, but no longer *purely* free), which also extends the decision's overall maturity
threshold from 1 to 4 (the max explicit key across all its fields), meaningfully throttling
how often it can be chain-redeployed. Deliberately kept `financeCost`'s `default` at `0`
(not a permanent nonzero value) specifically to avoid triggering `canDeploy`'s
permanent-effect redeploy lock, which — keyed off `gameSettings.statuteOfLimitationsYears`,
default 10 — would have made the decision *nearly one-time-per-game* rather than merely
slower to chain-redeploy; a full lockout wasn't the intent, a real cost and a longer
cooldown were.

Both are data-only changes (`server/src/data/game_engine.json`), exercised automatically by
`gameLoop.simulation.test.ts`'s runs against the real seed data — no dedicated unit test
was added beyond that, matching this codebase's existing convention that individual
decisions' balance numbers aren't unit-tested directly (the *engine* is tested; specific
decision content lives in data, verified by the simulation harness and manual play). As
with every other data-only balance edit in this file, **an already-seeded dev database
needs `npm run db:seed` re-run** to pick these up.

### Decision balance adjustments (round 2: `New Factory`'s remaining penalty, `Vertical Integration`, `Raw Material Monopoly`, `Excess Dividend`) — data-only, in `game_engine.json`

A follow-up randomized-simulation run (150 games, after the compounding-mechanic fix
above) confirmed round 1's fixes were working — `Venture Capital Shadow Money`'s win/loss
correlation dropped from strongly winner-associated to roughly neutral — and surfaced
four more findings, this time cross-checked against each decision's actual raw impact
data rather than relying on correlation alone (which, as documented above, is confounded
by survivorship — an early-eliminated player simply tries fewer distinct decisions).

**`New Factory`'s `capacityUtilization: -0.3` ramp-up penalty** — left as "optional
polish" in round 1 — turned out to still matter: it remained the clearest loser-associated
decision in the follow-up run (winner 14% / eliminated 48%) despite the cheaper, better-
timed cost from round 1, because the penalty cuts sellable volume by 30% at the exact turn
`operatingExpenses` also jumps, compounding two separate blows at once. Softened to `-0.15`.

**`Vertical Integration`** was pricing its entire supply-chain investment as a single
`-$80,000` hit in year 1 alone (no spreading across years the way `New Factory` already
did) — the least-well-timed cost curve in the library by that measure. Reduced to
`-$50,000` (and its matching `assets` credit reduced 1:1 to `+$50,000`, keeping the
"cash converted into assets" bookkeeping consistent), following the same ~35-40%
reduction `New Factory` got in round 1.

**`Raw Material Monopoly` had a genuine sign error, not just a cost problem.** Its own
`materialCostPerTon` impact was **positive** (`+0.10` year 1, `+0.05` ongoing) — meaning
the decision permanently *raised* the deploying player's own material costs, forever,
purely as a side effect of "cornering the market" on materials. The decision's entire
description is about hurting a rival (already correctly captured via
`target.supplySecurity`); nothing in it suggests a self-inflicted cost. Confirmed with the
user before changing (a directional/mechanical change, not just a magnitude tweak) —
flipped to `-0.10`/`-0.05` (cornering the market now genuinely cheapens materials for the
attacker, matching the description), and the `-$40,000` cash cost (already the smallest of
the three flagged, but still real) reduced to `-$25,000`, with `intangibleAssets` reduced
1:1 to match. Before this fix, `Raw Material Monopoly` was arguably the single worst-value
decision in the entire library for the deploying player: pay upfront, permanently pay more
for your own materials, risk two of the most severe legal-risk grounds in the game
(-20%/-25% relative revenue if either lands), all to inflict a comparatively soft
supply-security hit on one rival — worse value than even a cheap, direct decision like
`Bot Attack`.

**`Excess Dividend` had — and still has — no offsetting mechanical benefit at all.**
`impacts: { cash: { 1: -80000 } }` and nothing else: no stock/equity boost, no risk
reduction, no self-benefit of any kind, plus two of its own bolt-on lawsuit risks
(creditors challenging the payout) on top. There is no reading of the decision under which
a rational player would choose it over any other option. Addressed narrowly this round —
cash cost cut from `-$80,000` to `-$20,000` and both legal risks' probability/impact
schedules roughly halved — turning it from an active trap into a low-stakes, harmless
flavor pick, **without inventing a new positive mechanic on our own authority** (a real
fix — giving it, say, a genuine `scrutiny`- or `outrage`-reducing effect — would be
introducing the *first* "reduce scrutiny/outrage" mechanic in the entire library, which
this codebase's own notes elsewhere flag as not currently existing at all; that's a real
design decision, not a data tweak, and wasn't asked for). **Confirmed the cost/risk cut
alone did not fix the deeper issue**: a follow-up simulation check showed `Excess
Dividend`'s win/loss correlation barely moved (still ~-30, the worst of the four
decisions touched this round) even after the cost dropped 75% — because a strictly
dominated, zero-benefit choice still costs a player one of their limited per-turn
decision slots regardless of how cheap it's made. If this needs a real fix, it's "give it
an actual purpose," not "make it cheaper" — a product decision, not something to guess at.

Empirically re-verified via the same 100-game-plus randomized-simulation method as round
1 (game length grew further, median 11 → 14 rounds; `Vertical Integration` and
`Raw Material Monopoly`'s cash-delta-on-deployment medians both improved sharply once
their upfront costs dropped; zero crashes, zero invariant violations, consistent with
every other change this session). All four remain data-only edits in
`server/src/data/game_engine.json`, covered the same way as round 1's — exercised by
`gameLoop.simulation.test.ts` against the real seed data, no dedicated per-decision unit
test. **An already-seeded dev database needs `npm run db:seed` re-run** to pick these up.

### Idle-player breakeven — `price`/`operatingExpenses` tuned so doing nothing neither profits nor loses money, in `game_config.json`

Raised directly by the user: a player who deploys zero decisions, forever, was quietly
netting a real per-turn profit rather than standing still. Root cause was structural, not
one bad number: `theoreticalVolume = marketShare * totalMarketVolume` is always at least
`totalMarketVolume / maxPlayers` (2,500 tons at 4 players, the worst case), while
`maxSupply = installedCapacity * capacityUtilization` is only `350 * 1.0 = 350` — so
`volume = MIN(theoreticalVolume, maxSupply)` is **always capacity-bound at exactly 350
tons**, for any 2-4 player game, completely independent of market share/competitiveness.
Depreciation is also 0 for an idle player (the seeded starting `assets`/`intangibleAssets`
are never entered into the depreciation ledger — only decision-driven purchases are, see
*Deleting a decision is guarded* above), and `debt` starts at 0 so `interestRate` never
fires either — which collapses `profitBeforeTax` for an idle player down to one fixed
expression with no per-turn variability at all:

```
(price - materialCostPerTon - logisticsCostPerTon) * (installedCapacity * capacityUtilization)
  - operatingExpenses - staffCost + otherIncome - baseFinanceCost
```

At the old defaults this was `(700-500-50)*350 - 20000 - 10000 - 5000 = +17,500` — an idle
player netted **+$14,000/turn** (17,500 minus 20% tax) doing nothing at all, every turn,
forever. Since tax only applies to positive `profitBeforeTax`
(`MAX(0,profitBeforeTax)*taxRate`), `profitBeforeTax = 0` is the exact breakeven point for
`netProfit = 0` — not merely "close to zero."

Several single-field ways to remove exactly $17,500 were possible (lower `price`, raise
`materialCostPerTon`/`logisticsCostPerTon`, raise `operatingExpenses`, raise
`baseFinanceCost`); by explicit request the fix **splits the $17,500 evenly across two
fields** rather than moving one number a long way: `price` 700 → 675 (-$8,750 of margin)
and `operatingExpenses` 20,000 → 28,750 (+$8,750 of fixed cost). Chosen over an uneven
split so no single field looks conspicuously arbitrary; `operatingExpenses` was picked as
the cost-side lever (over `staffCost`/`baseFinanceCost`) with no particular reason to
prefer it beyond "pick one," and `price` as the revenue-side lever since it's the more
legible of the two to a player reading their own KPIs. This does mean `price`'s drop
slightly changes `competitiveness`/`stockValue` math for players who *do* act (both take
`price` as a direct input) — an accepted side effect of touching the revenue side at all,
not something `operatingExpenses`-only would have caused.

Both fields are plain `game_config.json` `playerStartingValues` — DB-backed, admin-editable,
same story as every other config value in this file (see *Decisions/config are DB-backed*
above). **An already-seeded dev database needs `npm run db:seed` re-run** to pick this up.
`gameLoop.simulation.test.ts`'s new `"an idle player (never submits a decision) neither
profits nor loses cash, turn over turn"` regression test resolves 5 consecutive turns for
two players who never submit anything and asserts cash stays at exactly the starting
$100,000 the whole way — extend that, not just the happy path, if you touch `price`,
`materialCostPerTon`, `logisticsCostPerTon`, `operatingExpenses`, `staffCost`,
`installedCapacity`, `capacityUtilization`, or `adminVariables.finance.baseFinanceCost`
again, since any of those can silently reopen a nonzero idle-profit floor.

### Randomized-simulation comparison: blind lawsuits vs. investigation-driven ("smart") ones

On request, ran the same randomized-simulation approach as the two balance rounds above,
but with a second, "smart" suing strategy layered in for direct, controlled comparison
against the existing "blind" one (identical decision-deployment logic in both — only
*how a player decides to sue* differs, so any measured difference is attributable to that
alone). "Smart": each turn, dig into up to 2 incoming attacks (`GameLoop.digDeeper`,
prioritizing whichever is already partway investigated so a half-paid investigation is
never abandoned, and only while a real cash cushion remains), then file only over a fully
investigated (`investigationLevel === 3`) suggested ground with a real estimated win
chance (`successProbability > 0.2`) — i.e. an actual player using the Dig Deeper /
suggested-ground mechanic as intended, not guessing blind. 120 games per strategy, same
seeds, same everything else.

**Zero new bugs.** 0 crashes, 0 invariant violations in *either* strategy across all 240
games — notably including the `digDeeper` → informed-`fileLawsuit` path at real volume
(over 10,000 `digDeeper` calls total), which the blind-only simulation never exercises at
all since it never calls `digDeeper`.

**The investigation mechanic works exactly as designed, and the numbers it surfaces are
trustworthy.** Lawsuit win rate: blind guessing ~6.1% (consistent with every prior blind-
suing run this session), informed (dig-then-sue) ~50.7% — roughly an 8x improvement.
That's a meaningful validation beyond just "the feature exists": `pickBestGround`'s
surfaced win-probability estimate (what a player actually sees before deciding whether to
file) turned out to be a *genuinely reliable* signal in practice, not just flavor text —
gating suits on `successProbability > 0.2` produced a real-world win rate in a sane,
expected range (not suspiciously higher or lower than the estimate would suggest).
Lawsuit *volume* dropped ~4.5x in the same comparison (2911 → 641 filings across the same
120 games) — informed players are far more selective, which is the intended shape of the
incentive ("investigate before committing," not "sue constantly and hope").

**Informed suing redistributes more sharply, in both directions, than blind suing does.**
Final cash range narrowed at the top (max dropped ~86.6M → ~24.8M) but widened at the
bottom (min dropped ~-2.1M → ~-4.1M) compared to the blind-suing run. Makes sense on
reflection: a wrong blind guess is usually a 0%-probability "real but hopeless" case (see
*"SUE THEIR ASSES offers the whole decision library's grounds"* above) — it costs the
plaintiff the filing fee but essentially never actually transfers real stakes from the
defendant, since the odds are zero. A correctly-targeted, fully-investigated case has real
odds of actually landing, so when it does, real (often large, since `stakes` for a
relative-type ground scales off the defendant's own current equity/revenue — see this
file's earlier stakes-bug section) money actually moves. Digging also meaningfully taxes
capital on its own (~$110M total spend across the 120 "smart" games, real cash that would
otherwise have compounded) — a secondary, incidental brake on runaway growth, not
something added deliberately for that purpose but a real observed side effect worth
knowing about.

**No clean new decision-balance findings beyond what rounds 1-2 already found.** The same
handful of decisions (`Business-to-Business Key Accounts`, `Patent Trolling`,
`Talent Poaching`, `Preventive Maintenance`) showed up as loser-associated in *both*
strategies, not just one — and none of them carry a direct `cash` impact at all (checked
directly against `game_engine.json`), so per the standing methodology caveat (early-
eliminated players simply try fewer distinct decisions, which alone produces a spurious
"loser" signal for anything commonly picked), these read as the same survivorship-bias
artifact already documented above, not a real balance problem newly exposed by smarter
play. Worth knowing this negative result exists — "smart play didn't reveal a new
imbalance we'd been missing" is itself useful signal that the two rounds of balance work
already done this session covered the real issues.

**Permanent regression coverage**: `server/src/engine/gameLoop.simulation.smart.test.ts`
(new — a sibling to `gameLoop.simulation.test.ts`, same real-data/seeded-RNG approach,
duplicated helpers rather than shared, matching this codebase's established test-file
convention). Covers: no invariant violations / no throws across many seeds with the smart
strategy specifically (the dedicated way `digDeeper` gets exercised at volume by any
automated test); and a win-rate floor (`> 25%`, deliberately loose to avoid RNG flakiness
while still catching a real regression) on lawsuits filed only after full investigation —
guards the calibration finding above, not just "it doesn't crash."

### Share ownership & majority-ownership takeover — a fully-built-out mechanic that was previously just placeholder data

Buy Shares/Sell Shares used to be inert: Buy Shares had a generic `target.operatingExpenses
+15%` impact with no connection to shares at all, and Sell Shares had literally empty
`impacts: {}`. `PlayerVariables.shareOwnership`/`totalSharesOutstanding` already existed and
`stockValue` was already correctly computed, but nothing ever wrote to a cap table, and
`gameLoop.ts`'s own Step 10 comment (`Check for bankruptcies & mergers`) referenced a
mechanic that had never been implemented — flagged during an audit for hardcoded/
unimplemented logic, then built out in full by explicit product decision.

**Data model**: `shareOwnership: Record<string, number>` (fractions summing to 1.0) uses
two reserved sentinel keys (`DecisionEngine`/`calcEngine.ts`'s `SELF_OWNERSHIP_KEY =
'self'`, `EXTERNAL_MARKET_KEY = 'EXTERNAL_MARKET'`, matching the pre-existing seed
convention in `game_config.json`'s `playerStartingValues.shareOwnership: { "self": 1.0 }`)
— any other key is a real player id holding a cross-company stake. `totalSharesOutstanding`
stays a separate absolute count, used only for `stockValue = marketEquity /
totalSharesOutstanding` pricing.

**`GameLoop.startingVars()` had a latent shared-object-reference bug this feature exposed**:
it used to return `shareOwnership: s.shareOwnership` — the SAME object reference from
`config.playerStartingValues` — for every player starting their first turn. Harmless while
nothing ever mutated `shareOwnership` (true until this feature), but once Buy/Sell Shares
actually writes to it, every still-unstarted player would have silently aliased the exact
same cap-table object, so mutating one player's stake would corrupt every other's "starting"
snapshot too. Fixed by spreading a fresh copy (`{ ...s.shareOwnership }`) per player. If you
ever see a JSONB-shaped config value passed straight through into per-player runtime state
without a shallow copy, check whether something downstream is about to start mutating it —
this is exactly the shape of bug that stays invisible for as long as nothing writes.

**`sharesAmount` (Share Issuance) is a decision-impact field that isn't a real
`PlayerVariables` field at all** — it existed in the seed data from the start
(`{1: 50000, default: 0}`) but was silently a no-op (nothing read it) until this feature.
`calcEngine.ts`'s `applyDecisionImpacts` now special-cases and skips it in its generic loop
exactly the way `target.*`/`competitor*` fields already are (same pattern, same reason: not
a field the generic `(v as any)[field] += value` write is correct for) — a positive value on
the deployment year triggers `applySharesAmount`, which increases
`totalSharesOutstanding` and dilutes every existing `shareOwnership` key proportionally,
crediting the new shares 100% to `EXTERNAL_MARKET`. Gated to `elapsedYears === 0` on
purpose, mirroring the depreciation-entry gate above — without it, a decision with a
nonzero `default` schedule value for this field would re-issue new shares every turn
forever.

**Buy Shares' own `impacts` was cleared to `{}`** (its old `target.operatingExpenses +15%`
was placeholder filler standing in for the unbuilt mechanic) and it gained
`shareTransactionType: 'buy'` — a new, generic, admin-editable `DecisionDefinition` field
(`'buy' | 'sell'`), read the same way everywhere: **never** a hardcoded
`decisionName === 'Buy Shares'` check, which would be exactly the class of bug just fixed
for `DEPRECIATING_ASSETS` above. Sell Shares gained `shareTransactionType: 'sell'` (its
`impacts` was already empty). `SubmittedDecisionEntry` gained `amount?: number` — the
player-chosen dollar investment/sale amount, since these are the two decisions in the
library that don't apply a fixed schedule at all.

**A new turn-resolution step ("Step 1b") runs between Step 1 and Step 2** — right after
`processNewDecisions` (so a Buy/Sell Shares instance already exists, matured instantly since
its `impacts` is empty, with completely normal maturity/level-limit/UI bookkeeping — no
special-casing needed there at all) but before `advanceAndApply`. `processNewDecisions` was
extended to also collect a `ShareTransactionRequest` queue for exactly the entries it
actually deployed (mirroring its existing `newDecisionAbsDeltas` collection pattern) — this
is deliberate: some submitted entries get dropped by `canDeploy`/a level-limit check, and
only ones that actually deployed should ever execute a real trade. Step 1b groups the queue
by target, sorts each group by submission timestamp (see below), and applies transactions
sequentially via `GameLoop.applyShareTransaction`.

**Why trades price off `stockValue` as it stood at the START of the turn, not a freshly
recomputed one**: `stockValue` is only recomputed once per turn, in the balance-sheet step
(much later than Step 1b) — waiting for it would mean either restructuring the whole step
order or accepting a circular dependency (decisions processed before the balance sheet that
needs decisions already applied). Using last turn's closing price avoids this entirely, at
the cost of a stock crash from a lawsuit this turn only becoming buyable at that crashed
price starting *next* turn, not the instant it happens — an accepted product tradeoff, not
an oversight.

**The pro-rata dilution formula is genuinely uniform — self-buyback and stacking multiple
buyers need zero special-casing.** A purchase of `fractionBought` (=
`min(1, sharesBought / totalSharesOutstanding)`, where `sharesBought = spend / stockValue`,
or the whole company for whatever was paid if `stockValue` is exactly 0 — a deliberate
"can be bought for free" design choice) scales down EVERY existing `shareOwnership` key by
`(1 - fractionBought)`, then credits the buyer's own key (their real player id, or
`SELF_OWNERSHIP_KEY` if the buyer *is* the target's own founder) with the full
`fractionBought` on top. Self-buyback (reclaiming stake previously diluted to
`EXTERNAL_MARKET`) falls out of this exact same formula for free: the buyer's key in their
own company's map is already `SELF_OWNERSHIP_KEY`, so it's diluted like everyone else and
then gets the full purchased block back — no `if (buyer === target)` branch needed anywhere.
The buyer's cash decreases by the full spend; every *other* diluted key that maps to a real
player (never `EXTERNAL_MARKET`, which absorbs its own dilution with no counterparty; never
the buyer's own key, which would mean paying yourself) receives its pro-rata share of that
spend in cash — a confirmed product decision (the original spec was silent on where the
buyer's money goes to the *other* diluted owners specifically).

**Stacking two purchases against the same target in one turn is a real, intentional
mathematical property worth understanding before "fixing" it**: since `fractionBought` is
always computed against the *whole* company (not "what's currently unowned"), a second
buyer of the same size as an earlier one in the same turn dilutes the earlier buyer's stake
too, ending up proportionally *larger* than the first buyer — e.g. two sequential 50%
purchases land at 25%/50% (founder/first buyer both diluted by the second's purchase), not a
clean 50/50 split. This is the correct, literal consequence of "pro-rata from
ALL current owners, including EXTERNAL_MARKET" applied sequentially, not a bug — being
"first" only protects you from purchases that happened *before* yours, never from ones that
come after. `gameLoop.test.ts`'s FIFO regression test asserts this exact 0.25/0.25/0.5
outcome, not the more intuitive-sounding 0.5/0.25 split a naive reading might expect.

**FIFO ordering needed a real server-arrival timestamp, and a naive
"stamp `Date.now()` on every `submitDecisions` call" implementation would have been
silently wrong** — `game:submitDecisions` is full-replacement (see *Everything per-round is
client-full-replacement* above): the client resends a player's *entire* pending state on
every single toggle, so a per-call timestamp would reflect whenever the player last touched
*anything*, not when they specifically added Buy Shares. `GameLoop` tracks a second map,
`submissionTimestamps` (room → player → per-entry key → first-seen `Date.now()`), keyed by
`${bucket}:${name}:${targetId ?? ''}` — only a key not already present for that player this
turn gets a fresh stamp; a key that survives across resubmits keeps its original one.
Cleared alongside `clearSubmissions()`. `gameLoop.test.ts` has a dedicated regression test
proving an unrelated resubmit (adding some other decision to the same submission) doesn't
reset an already-queued Buy Shares entry's timestamp.

**`isIndirectEffect` needed a `targetId` parameter, or Buy Shares would misclassify as
"indirect" (broadcast to every other player) despite being a real, single-target attack.**
Clearing Buy Shares' `impacts` to `{}` means `extractTargetImpacts(...).size === 0` — the
exact condition `isIndirectEffect` used to treat as "no single target, tell everyone." Fixed
by threading the instance's own `targetId` through: it's only classified indirect when
`targetImpacts.size === 0 && targetId === undefined`. This changes behavior for exactly one
case in the whole 45-decision library (Buy Shares now/Sell Shares never, since its
`legalRisks` is empty regardless) — every other decision either has real `target.*` fields
(never indirect) or has neither `target.*` nor a `targetId` at all (unaffected). The three
call sites that read this classification (`buildIncomingAttacks`, Step 8's
`plaintiffFullyInvestigated` lookup, `digDeeper`'s attacker search) also each needed their
own `targetImpacts.size === 0` gate loosened specifically for
`shareTransactionType === 'buy'` (never `'sell'`, which isn't an attack on anyone and has no
`legalRisks` to reveal regardless) — otherwise a real direct attack with no `target.*`
impacts would still fall through a check written for "no target.* impacts means nothing to
reveal," which stopped being universally true the moment Buy Shares existed.
`revealAttack`'s tier-2 `effectSummary` also needed a Buy-Shares-specific branch
(`Acquired N% ownership stake`, from the instance's own `acquisitionFraction`) since there's
no `target.*` schedule value to summarize generically for it.

**`legalRiskConditions.minPercentAcquiredInSingleTransaction` was previously dead config**
(seeded, validated, never read) — now wired in generically via
`DecisionEngine.meetsLegalRiskConditions(def, instance)`, which checks the instance's own
`acquisitionFraction` (stamped once at execution time in `applyShareTransaction`, threaded
through the same round-trip points `voidedByLawsuit`/`everSued` already go through) against
whatever threshold a decision's `legalRiskConditions` bag specifies — keyed off the
data-driven field, not a hardcoded name, the same principle as `shareTransactionType`.
`LegalEngine.fileLawsuit` and `DecisionEngine.pickBestGround` both gained this as one more
condition that floors probability to 0 (same shape as `timeBarred`/`alreadyClaimed`) — a
purchase too small to cross the threshold was never really suable to begin with.

**Majority-ownership elimination reuses the bankruptcy case waterfall
verbatim** — `distributeCaseWaterfall` (extracted from what used to be an inline loop tied
only to `playersToBankrupt`) is the one place this payout math lives, callable for either
elimination reason, on the principle that "the same rule applies to both
bankruptcy and merger." For a merger specifically, the acquirer additionally inherits the
eliminated company's cash/assets/intangibleAssets (a confirmed product decision beyond what
the original spec describes, which only ever specifies elimination) — deliberately NOT
debt, NOT active decisions/production variables, and NOT legal cases (those already lapsed
via the waterfall call). Two more things this needed, both easy to miss:

- **Precedence when a prospective acquirer is themselves going bankrupt the same turn**: a
  bankrupt player can't complete a takeover — they're leaving the game too — so
  `playersToMerge`'s detection loop explicitly excludes any acquirer already in
  `playersToBankrupt`. Their pending majority stake simply doesn't trigger anything this
  turn; it gets swept to `EXTERNAL_MARKET` by the cleanup below like anyone else's.
- **Cross-holding cleanup**: any player eliminated this turn (either reason) has their stake
  in every *other* company's `shareOwnership` swept back to `EXTERNAL_MARKET`. Without this,
  a departed player's stake would sit forever in someone else's cap table — permanently
  un-payable (their `ctxs` entry no longer exists to receive dilution cash) and
  un-reclaimable (nothing else ever removes a key from `shareOwnership`). This is also what
  makes the bankrupt-acquirer precedence rule fully resolve rather than leaving a stale
  majority claim: the failed acquirer's stake becomes `EXTERNAL_MARKET`'s, which can never
  itself trigger an elimination.

`gameLoop.test.ts`'s "Buy/Sell Shares" and "majority-ownership takeover elimination" describe
blocks are the regression coverage for all of the above — extend those, not just the happy
path, if you touch any part of this mechanic again. Note the bankruptcy-determinism pattern
those tests reuse from elsewhere in the file: a player fixture needs `installedCapacity: 0,
capacityUtilization: 0` to suppress volume/revenue entirely, or a turn's ordinary P&L can
swing cash by amounts large enough to make a "should end up bankrupt" fixture flip sign
unpredictably.

### OWNERSHIP (CAP TABLE) — the STOCK VALUE drill-down shows who actually holds the shares, not just what they're worth

The mechanic above wrote to `shareOwnership` from the start, but nothing ever *displayed*
the resulting cap table — `ShareView` (the STOCK VALUE drill-down) only ever showed the
factors that set the stock *price* (processing level, supply security, etc.), never who
owns how much of the company at that price. `CapTableSection` (`GamePhase.tsx`) closes that
gap: a horizontal stacked bar (same visual language as the pre-existing "YOUR SHARE VS
RIVALS" market-share bar) plus a per-holder row list (name, %, share count, $ value),
sorted largest stake first. It's shared, unmodified, between two call sites — `ShareView`
(`target` is always the viewer's own company) and `RivalFullReportView`'s Full Filing
report (`target` is always a rival's) — since the only thing that differs between them is
which `PlayerTurnResult` is being inspected; `RivalFullReportView` gained two new required
props (`myData`, `competitors`) purely to have a full player roster available for name
resolution (see below), and its one call site in `GamePhase.tsx` gained a `myData &&` guard
it didn't need before, since `myData` can genuinely be `null` before round 1 resolves.

**Deliberately no separate "takeover risk" callout or warning threshold color** — this was
an explicit product decision (offered as one of several layout options, not picked): the
bar and the sorted list already put the largest outside stake at the top with its exact
percentage labeled, and restating "someone else owns 42%" in a second warning banner
underneath doesn't add information, just noise. If a future request specifically wants an
at-a-glance "you're close to losing to a takeover" signal, that's a status-colored addition
on top of this component, not a reason to rebuild it.

`buildCapTable(target, viewerId, allPlayers)` is the pure function behind it, and is where
almost all the actual logic lives — `shareOwnership`'s three kinds of key each need
different name resolution, and the *same* key can mean a different thing depending on
whether `target` is your own company or a rival's:
- `SELF_OWNERSHIP_KEY` ('self') — the target company's own founder's stake. Labeled "You"
  (in red, `#dc2626`, this app's consistent identity color for the viewer throughout —
  `LostOverlay`, the market-share bar's own row, etc.) when `target.playerId === viewerId`
  (viewing your own cap table); labeled with `target.playerName` (in gray, `#9ca3af`) when
  it isn't (viewing a rival's — this is *their* founder stake, not yours).
- `EXTERNAL_MARKET_KEY` ('EXTERNAL_MARKET') — the public float. Always "Public Market",
  always the lightest gray (`#d1d5db`), regardless of whose company this is.
- Any other key is a real playerId — a player (you or a rival) who bought a stake in this
  company via Buy Shares. `key === viewerId` is labeled "You" (red) even when `target` is a
  rival's company — this is the one case where "you" shows up as a *plain* key rather than
  under `SELF_OWNERSHIP_KEY`, since your stake in someone else's company was never yours by
  founding. Every other real-playerId key is resolved to a name by scanning `allPlayers`
  (the viewer's own snapshot + every currently-active rival, i.e. `[myData, ...competitors]`
  at both call sites) and cycles through a small fixed 4-color set
  (`OTHER_HOLDER_COLORS` — blue/violet/teal/burnt-orange) in the order those rows appear
  post-sort (largest such stake gets the first color), rather than being assigned by a
  stable per-player identity — a 5th+ such holder reuses an earlier color rather than
  generating a new indistinguishable hue, matching this skill-guided app's "never a
  generated hue" categorical-color rule. A key matching no one in `allPlayers` (a holder
  eliminated since the stake was recorded) falls back to a generic "Former Shareholder"
  label rather than erroring — expected to be only ever transiently stale, since an
  eliminated player's stake is swept to `EXTERNAL_MARKET` server-side the same turn (see
  *Share ownership & majority-ownership takeover*'s "Cross-holding cleanup" above).

`GamePhase.utils.test.ts`'s `buildCapTable` describe block is the regression coverage —
own-company vs. rival-company self-key labeling, the viewer's-own-plainkey-in-a-rival's-cap-
table case, third-party name resolution via `allPlayers`, the eliminated-holder fallback,
the near-zero-fraction filter, and the other-holder color cycling order — extend that, not
just the happy path, if you touch this again.

### Risk Gauge takeover term — the Threat Level gauge used to know nothing about majority-ownership takeover risk

Audited on request ("does Threat Level account for ownership getting low?") and confirmed
as a real, shipped gap: the Risk Gauge was originally a fixed 3-term blend — legal
exposure ratio, scrutiny, outrage (`w1=0.5, w2=0.25, w3=0.25`) — with **zero** signal from
`shareOwnership`, even though majority-ownership takeover (*Share ownership &
majority-ownership takeover* above) is a fully independent way to lose the game, exactly
as final as bankruptcy. A player could sit at a comfortable, all-green Threat Level while
a rival held 48% of their company, one Buy Shares away from an instant, no-warning
elimination — the gauge is this game's one "am I in danger" glance, and it was silent
about an entire loss condition. `riskGauge` itself is purely computed/display data
(nothing else in the engine reads it — confirmed by grep before making this change), so
nothing else was compensating for the gap either.

**Fixed by adding a 4th weighted term, `w4*ownershipRisk`, rather than a separate second
meter** — a deliberate product decision (offered as one of two options, not assumed): one
glanceable danger number stays consistent with what this gauge already is, at the cost of
rebalancing the existing weights to make room. Seeded defaults changed from `w1=0.5,
w2=0.25, w3=0.25` to `w1=0.4, w2=0.2, w3=0.2, w4=0.2` (`game_config.json`,
`RiskGaugeConfig.riskWeightOwnership_w4` — a new admin-editable field, same DB-backed
story as the other three weights). This is a deliberate deviation from the gauge's
original 3-term design, same category as the negotiation phase and statute of limitations
(see *Deliberate deviations from the design spec*) — documented here since there's no
separate spec document to annotate, per this codebase's established convention.

**`calcEngine.ts`'s `calculateOwnershipRisk(shareOwnership, takeoverThresholdPercent)`** is
the new term's source: the *single largest* real-player (non-`SELF_OWNERSHIP_KEY`,
non-`EXTERNAL_MARKET_KEY`) stake, scaled linearly against `takeoverThresholdPercent` (0 at
0% held, 1.0 right at the threshold, capped at 1 beyond it) — deliberately **not**
`1 - selfOwnership`, the simpler alternative that was also offered and not picked. The
actual elimination trigger only cares about one player crossing the threshold, so this
correctly reads dilution spread thin across several minority holders or the public float
as low risk, while a single concentrated buyer closing in reads as high risk even while
the founder's own stake is still comfortably above 50%. `EXTERNAL_MARKET` is excluded for
the same reason it's excluded from the elimination check itself — it can never be the
acquirer. `calculateRiskGauge` now destructures `riskWeightOwnership_w4` and
`admin.ownership.takeoverThresholdPercent` alongside its existing inputs and passes both
`w4`/`ownershipRisk` into `evalNamed(formulas, 'riskGauge', {...})` — `FORMULA_VARIABLES.
riskGauge` in `validation/schemas.ts` gained both identifiers in its whitelist, and the
`riskGauge` formula's seeded expression (`defaultFormulas.ts`) gained the `+
w4*ownershipRisk` term (already pre-clamped to `[0,1]` in code, so not re-wrapped in
`MIN(1, ...)` the way `scrutiny`/`absOutrage` are — same "clamp once, at the point it's
computed" convention `legalExposureRatio` already established for this formula).

**Fixed a genuinely separate, pre-existing dead-config bug along the way, not scope
creep**: `admin.ownership.takeoverThresholdPercent` already existed in
`OwnershipConfig`/`game_config.json`/`validation/schemas.ts` (seeded, validated,
admin-editable) but the actual elimination check in `gameLoop.ts` (Step 10's
`playersToMerge` detection) hardcoded `fraction > 0.5` directly and never read it — the
exact same class of bug already found and fixed once for
`legalRiskConditions.minPercentAcquiredInSingleTransaction` (see *Decisions/config are
DB-backed* above). Since the new risk-gauge term legitimately needs this same threshold
value as its denominator, wiring `gameLoop.ts`'s check to read
`this.adminVars.ownership.takeoverThresholdPercent` (instead of adding a second,
independently-hardcoded `0.5`) was both the correct implementation choice and a real fix —
an admin-lowered threshold now actually changes when a takeover triggers, not just what
the gauge displays. Default value unchanged (`0.5`), so this has zero effect on any
existing game unless an admin edits it. `gameLoop.test.ts` gained a dedicated regression
pair for this (`'honors an admin-configured takeoverThresholdPercent below 50%'` /
`'does not trigger at 35% under the default 50% threshold'`) — extend those, not just the
ownership-risk-term tests, if you touch this threshold again.

**Client-side `ThreatView` (`GamePhase.tsx`) needed the identical duplicated-formula
treatment `computeThreatTerms` already gets** — the headline Threat Level number on the
KPI card is always the server's authoritative `riskGauge`, but the breakdown modal
recomputes its own copy client-side (same "duplicate small pure logic, keep in sync by
hand" convention as `computeOfferBracket`/`getDeployability`). `THREAT_W1-3` were
rebalanced to match the new seeded defaults, a new `THREAT_W4`/
`THREAT_TAKEOVER_THRESHOLD_PERCENT` pair and `computeOwnershipRisk` (mirroring
`calculateOwnershipRisk`) were added, and the new "Ownership / takeover risk" row is
**deliberately not clickable** — there's no single persisted numeric field for "largest
external shareholder's stake" to open a `KpiHistoryGraph` for, the same "derived-of-derived,
not a tracked field" treatment `CashWaterfallView`'s COGS/EBITDA rows already get (see *KPI
History & Prediction* in README). As with every other hardcoded client-side mirror of an
admin-editable constant in this file, these will silently drift from a live `/admin` edit
to the weights — an existing, accepted limitation of the mirroring convention, not
something this change was expected to solve.

An already-seeded dev database predates `riskWeightOwnership_w4` the same way it predates
every other admin-config field added this way — `npm run db:seed` (safe, an upsert that
fully replaces `gameSettings`/`adminVariables` from the JSON files) needs a re-run before a
local game reflects the new weights; until then Prisma returns `undefined` for the new
field at runtime.

`GamePhase.utils.test.ts`'s `computeThreatTerms` describe block and `calcEngine.test.ts`'s
`calculateOwnershipRisk`/extended `calculateRiskGauge` describe blocks are the regression
coverage — extend those, not just the happy path, if you touch this mechanic again.

### Risk Gauge solvency term — a 5th term for "could my open lawsuits actually bankrupt me next turn," requested and clarified before implementing

Added immediately after the takeover term above, on explicit request: "predicted cash in
next turn vs. open lawsuits against player." Both halves of that phrase had more than one
reasonable reading, so this was clarified before writing any formula — see the four-
question exchange in conversation for the options considered; the choices actually made
are recorded below, since only the *decision*, not the discarded alternatives, is worth
keeping long-term.

**"Predicted cash next turn" is a naive linear extrapolation, not the real prediction
engine — a real engineering constraint, not a shortcut taken for convenience.** This
game already has a genuine forward-looking cash predictor
(`GameLoop.predictFutureKpis`, the one behind the KPI history graphs' dashed
continuation) — but it works by re-running the full turn-resolution engine in a sandbox,
and the Risk Gauge is computed **from inside** `resolveTurn` itself, for every player,
every turn. Reaching for `predictFutureKpis` from `calculateRiskGauge` would mean
`resolveTurn` recursively calling itself once per player on every single turn resolved by
the game — a real recursion/performance risk, considered and explicitly rejected in favor
of a cheap, synchronous alternative:

```
predictNextTurnCashLinear(cashAfterThisTurn, cashBeforeThisTurn)
  = cashAfterThisTurn + (cashAfterThisTurn - cashBeforeThisTurn)
```

"If this turn's trend continues, where does cash land next turn." `cashBeforeThisTurn` is
`PlayerTurnContext.prevCash` — a field that already existed for an unrelated purpose (the
bankruptcy waterfall pool calculation, `distributeCaseWaterfall`), snapshotted once at the
very top of `resolveTurn`'s per-player loop, before that turn's own P&L/balance-sheet
math has touched `ctx.vars.cash` at all. Reusing it here needed zero new state — this
term's entire "prediction" is two already-available numbers subtracted and added back.

**"Open lawsuits against player" reuses the exact same probability-weighted aggregate the
existing legal-exposure-ratio term (w1) already computes** — `legalExposure = Σ
(case.probability × case.stakes)` for every open case where this player is defendant — a
case you're likely to lose counts more than a hopeless one, same as w1. The two terms are
still meaningfully distinct despite sharing this input: w1 divides by **current** cash and
feeds `adjustedProbability`'s snowball effect (more open cases relative to cash makes every case
more likely to succeed too); this new term (w5) divides by **projected next-turn** cash
and asks a narrower, purely forward-looking question — "given where cash is trending,
could these open cases actually break me next turn" — with no snowball feedback into
anything else.

**The combination is a solvency/coverage ratio, capped at 1, with a small floor guarding
the division**:

```
calculateSolvencyRisk(legalExposure, predictedNextCash)
  = 0                                                    if legalExposure <= 0
  = MIN(1, legalExposure / MAX(predictedNextCash, 1))    otherwise
```

The `MAX(predictedNextCash, 1)` floor (`SOLVENCY_RISK_CASH_FLOOR`) is what keeps this
well-behaved once a company is already trending toward insolvency: without it, a
predicted cash at exactly 0 would divide by zero, and a negative predicted cash would flip
the ratio's sign (reading as *less* dangerous the more insolvent the trend gets, which is
backwards) — instead, any nonzero exposure against an at-or-below-zero predicted cash
reads as the maximum, 1.

**Weights rebalanced again**, same "even cut from every existing term" approach the
takeover term used, per explicit confirmation: `w1=0.4, w2=0.2, w3=0.2, w4=0.2` →
`w1=0.32, w2=0.16, w3=0.16, w4=0.16, w5=0.2`. `RiskGaugeConfig` gained
`riskWeightSolvency_w5`; `game_config.json`, `validation/schemas.ts`'s `riskGauge` zod
object and `FORMULA_VARIABLES.riskGauge` whitelist (now including `w5`/`solvencyRisk`),
and `defaultFormulas.ts`'s seeded `riskGauge` expression (`+ w5*solvencyRisk`, already
pre-clamped to `[0,1]` in code so not re-wrapped in `MIN(1,...)`, same treatment
`ownershipRisk` already gets) all moved together — same DB-backed, admin-editable story
as every other Risk Gauge weight; see *Formulas are DB-backed* below.

`calculateRiskGauge`'s new `prevCash` parameter is **optional, defaulting to `vars.cash`**
(assume no trend) — the same "default that preserves every pre-existing call site's
behavior unchanged" convention `statuteOfLimitationsYears`'s `= Infinity` default
established (see *Statute of limitations* above). The one real production call site inside
`resolveTurn`'s Step 11 passes `ctx.prevCash` explicitly; `getInitialSnapshot` (round 1,
before any turn has resolved, where `openCases` is always empty anyway) doesn't pass it at
all and relies on the default — harmless, since with zero legal exposure the term is 0
regardless of what "predicted cash" comes out to.

**Client-side `ThreatView` mirrors this with a real accuracy advantage over a naive
reimplementation, not just a duplicate**: `computeThreatTerms` already gets called once for
the current turn and once for the previous turn (for each row's trend arrow), and
`GamePhase.tsx` already keeps exactly one turn of prior state (`prevData`) — so
`prevCash` for the *current* turn's calculation is simply `prevData.variables.cash`, no new
data needed. For the legal-exposure input, the client deliberately does **not**
reverse-derive it from `legalExposureRatio` (which is already capped by
`legalExposureRatioCap` server-side) — that would silently understate exposure for
exactly the players this term cares about most (already deep in legal trouble, ratio
pinned at the cap). Instead it recomputes the same raw sum directly from
`data.legalCases` (`computeOpenLegalExposure`), which the client already has in full —
more accurate than the ownership term's mirror, not just consistent with it. The row is
non-clickable, same "derived-of-derived, no single tracked field to chart" treatment the
ownership row already gets. One accepted approximation: the *previous* turn's own point
(used only to diff against, for the trend arrow) has no `prevCash` of its own further back
in client state, so it falls back to assuming no trend for that one historical point —
`GamePhase.utils.test.ts`'s test fixtures make this fallback explicit rather than hiding
it.

`calcEngine.test.ts`'s `predictNextTurnCashLinear`/`calculateSolvencyRisk` describe blocks,
the extended `calculateRiskGauge` describe block (a rising vs. falling trend producing
different gauge values from identical current cash/exposure, and the `prevCash` default
matching an explicit flat-trend call), `gameLoop.test.ts`'s dedicated regression test
(proving `resolveTurn` actually threads real `ctx.prevCash` through rather than silently
falling back to the "no trend" default — isolates the whole gauge to w5 and asserts a real
declining trend reads as strictly more dangerous than the same post-turn state would under
the default), and `GamePhase.utils.test.ts`'s extended `computeThreatTerms` describe block
are the regression coverage — extend those, not just the happy path, if you touch this
mechanic again.

### Formulas are DB-backed — but only the pure-math half of the turn-resolution math

The turn-resolution math (competitiveness/market share, volume, P&L, balance sheet,
legal-risk probability, risk gauge) is a mix of two different kinds of logic, and only
one kind is DB-backed:

- **Pure, scalar, named-input math** — e.g. `competitiveness_i = (1/price_i) * (1 +
  wq*processingLevel_i + ...)` — 23 named formulas, each a single arithmetic expression
  over fixed named inputs. **These live in the `Formula` table**
  (`key`/`expression`/`description`), seeded from `server/src/engine/defaultFormulas.ts`
  (the single source of truth both `prisma/seed.ts` and `calcEngine.test.ts`/
  `gameEngine.test.ts` build their fixtures from — never fork this list), and are
  editable live from `/admin`'s Formulas tab.
- **Everything procedural/order-dependent** (the turn execution order, depreciation
  ledger iteration, decision maturity/exclusion locking, bankruptcy/merger waterfall
  distribution, simultaneous-purchase FIFO) is
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
  Its `createRoom`/`joinRoom`/`rejoinRoom` describe blocks each have a regression test for
  `leaveStaleSocketRoom` (a socket that (re)attaches to a second room actually leaves its
  previous one's Socket.IO channel) — see *"A socket that starts a second game without
  reloading kept receiving its first game's broadcasts"* above; extend those, not just the
  happy path, if you touch `playerToRoom` again.
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
  path, if you touch `fileLawsuit` again. `decisionEngine.test.ts`'s `hasPermanentEffect`
  describe block and its `canDeploy` describe block's "permanent-effect redeploy lock"
  nested block (including its statute-of-limitations-aged cases), plus `gameLoop.test.ts`'s
  "resolveTurn — lawsuit voids the sued decision (regression)" describe block (a plaintiff
  trial win voids + unfreezes redeployment + cancels forthcoming effects; a defendant trial
  win does not; a Step 8b stale-offer auto-settle also voids), are the regression coverage
  for *Winning a case voids the sued decision instance* above — extend those, not just the
  happy path, if you touch `voidSuedDecisionInstance`/`hasPermanentEffect`/`canDeploy`'s
  permanent-effect gate again. `decisionEngine.test.ts`'s `advanceAndApply`/
  `collectTargetImpacts` describe blocks (stopping a permanent own/`target.*` effect once
  aged past the statute, forcing `isMatured` on an admin-configured short statute, and NOT
  cutting off a non-permanent decision's legitimately long explicit schedule) and
  `gameLoop.test.ts`'s "resolveTurn — a permanent effect naturally expires at the statute of
  limitations (regression)" describe block are the regression coverage for that natural-
  expiration mechanic — extend those, not just the lawsuit-voiding path, if you touch the
  statute-of-limitations gates in `advanceAndApply`/`collectTargetImpacts` again.
  `decisionEngine.test.ts`'s `pickBestGround` describe block covers the new
  `alreadyClaimed` parameter (floors to 0 independent of `timeBarred`), and
  `gameLoop.test.ts`'s "resolveTurn — one lawsuit per decision instance, ever (regression)"
  describe block is the end-to-end coverage for *Only one lawsuit per decision instance,
  ever* above (same-turn second plaintiff gets the hopeless shape; still blocked several
  turns after the original case has dropped out of persisted `legalCases`; a freshly
  redeployed instance of the same name can be sued again) — extend those, not just the
  happy path, if you touch `everSued`/Step 8's filing loop again. `calcEngine.test.ts`'s
  `sharesAmount`/`renormalizeShareOwnership` describe blocks, `decisionEngine.test.ts`'s
  `meetsLegalRiskConditions` describe block, and `gameLoop.test.ts`'s "Buy/Sell Shares"
  and "majority-ownership takeover elimination" describe blocks are the regression
  coverage for *Share ownership & majority-ownership takeover* above (dilution math,
  self-buyback, FIFO ordering surviving an unrelated resubmit, `isIndirectEffect`
  staying direct for Buy Shares, `legalRiskConditions` gating, waterfall reuse, acquirer
  inheritance, bankrupt-acquirer precedence, cross-holding cleanup) — extend those, not
  just the happy path, if you touch any part of this mechanic again.
- `client/src/**/*.test.ts` — Vitest, Zustand stores and pure UI utilities.
  `GamePhase.utils.test.ts` deliberately duplicates small pure functions out of
  `GamePhase.tsx` (`fmt`, `getGroundsAgainst`, `detectNewlySuedCases`,
  `detectNewlyResolvedCases`, `detectNewlySettledCases`, etc.) rather than importing them,
  to keep this test file lightweight (no Mantine/tabler-icons import chain) — keep any
  duplicated copy in sync with the real implementation by hand if you change one side.
  `detectNewlyResolvedCases`/`detectNewlySettledCases` are each covered from both
  plaintiff and defendant perspectives, including the verdict-flip case (a `'lost'`
  verdict is a *win* for the defendant) — see *Post-turn events are a passive, clickable
  News feed* above. `getSortableKpiFields`/`getDecisionSortValue` (duplicated the same way)
  cover the Decision Deck's KPI sort — deduplication, excluding `target.*`/`competitor*`
  fields, sorting by human-readable label rather than raw field name, and the year-1/
  default/0 fallback chain — see *The Decision Deck also has a search field and a KPI
  sort* above.
- `tests/api/*.test.ts` — Vitest + real Postgres via testcontainers (needs Docker).
  The only layer that actually verifies socket event contracts end-to-end
  (`game:submitDecisions`, `turn:resolved`, `game:over`) against a real Prisma schema.
  Reach for this when a change touches the room/DB/socket boundary, not engine-internal
  math.
- `tests/e2e/*.spec.ts` — Playwright, full browser + live client dev server + backend.
  Use for lobby/matchmaking flows and phase transitions a user would actually click
  through.

### Deliberate deviations from the design spec

The original game design specified that every decision with `legalRisks` automatically
generates a lawsuit from every other player the instant it's deployed. The implemented
behavior is different by explicit product decision: lawsuits are filed deliberately by
players via `game:submitDecisions`'s `lawsuits` array, priced by `LegalEngine.fileLawsuit`
against the ground's probability schedule at the target decision's elapsed time. If a
task asks you to "match the original spec exactly" on this point, flag the conflict rather
than silently reverting the deliberate-filing design — see README's *Lawsuits* section and
`GameLoop`'s Step 8 / `LegalEngine.fileLawsuit` for context.

The original design never modeled a negotiation phase at all — a filed case just resolves
via a probability draw. This codebase's richer `'negotiating'` status, with a real
settlement negotiation flow on top (offer/counter/accept/go-to-court — see *"Settlement
negotiation"* below), is a further addition beyond spec.

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
earned separately by each side* above) already does exactly the right thing here with
zero further changes needed: a wrong guess can never satisfy `plaintiffFullyInvestigated`
(there's no real attacking decision instance targeting the plaintiff to have investigated
in the first place), so the plaintiff's own card shows "Unknown" — they don't know it's
hopeless. The **defendant**, if they pay to dig into the case (`game:digDeeperCase`),
sees the real number (here, a plain `0%`), since they know perfectly well whether they
actually did the thing being alleged — they just have to spend the fee to have the game
confirm it, same as for a genuine case.

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

### A `relative`-type legal risk's stakes must be scaled against the defendant's own field value — reading the raw schedule fraction as dollars silently produced near-zero stakes

A real, reported bug: filing over Hype Initial Coin Offering's "Unfair Competition &
Fraudulent Capital Procurement Action" ground showed a settlement bracket of "min $0 max
$0", and a defendant who lost the case at trial saw "You paid $0 to `<plaintiff>`". Both
symptoms trace to the same root cause in `LegalEngine.fileLawsuit`'s `stakes` calculation.

Every `LegalRiskDefinition.impact` has a `type` (`'absolute' | 'relative'`) and a `target`
field name, mirroring how a decision's own `impacts` work — but `fileLawsuit` used to
compute `stakes` as `Math.abs(risk.impact.schedule['default'] ?? risk.impact.schedule[1] ??
0)` unconditionally, ignoring `type`/`target` entirely. That's correct for an `absolute`
ground (58 of 83 in the real library, all `target: 'cash'`) — the schedule value already
*is* the dollar figure. It's wrong for a `relative` ground (the other 25, `target: 'equity'`
or `'revenue'`) — there, the schedule value is a **fraction** (e.g. `-0.45`) meant to be
scaled against the defendant's own current value of that field, per the same "relative-type
impact ⇒ multiply by the defendant's current field value" convention decision impacts
already follow. Reading `-0.45` directly as dollars produced `stakes = 0.45` — real money,
just off by a factor of the defendant's entire equity — which rounds to display as "$0"
everywhere stakes are shown (`computeOfferBracket`'s `max = caseData.stakes`, and the
plaintiff/defendant "You paid/received `{fmt(c.stakes)}`" trial-outcome line in
`GamePhase.tsx`).

Fixed by making `fileLawsuit` branch on `risk.impact.type`: for `relative`, `stakes =
Math.abs(targetVars[risk.impact.target] * scheduleValue)`, reading `target` generically off
`PlayerVariables` (never hardcoded to `'equity'`/`'revenue'` specifically, so an admin
adding a new relative-type ground against a different field works without a code change —
same principle as `shareTransactionType`/`legalRiskConditions` elsewhere in this file). This
needed a new `targetVars: PlayerVariables` parameter on `fileLawsuit`, since pricing a
relative ground requires the defendant's actual current state, not just their active
decisions list.

**A second, smaller gap surfaced while wiring the new parameter up at its one production
call site (`GameLoop.resolveTurn`'s Step 8 filing loop):** `ctx.vars.equity` is written back
onto the player's own `PlayerVariables` in Step 7 (`ctx.vars.equity = bs.equity`), so it's
already correct and current by the time Step 8 runs — but `ctx.vars.revenue` never is. Step
6's P&L calculation computes `pl.revenue` into a local `plMap`, used only to build the
turn's broadcast result (`derived.revenue`) — nothing round-trips it onto `ctx.vars`, unlike
every other "Derived (computed each turn)" field in the `PlayerVariables` interface
(`equity`, `stockValue`, `marketShare`, `volume`, `receivables` are all written back;
`revenue`/`financeCost`/`taxCost`/`depreciation` are not). Naively passing `targetCtx.vars`
straight into `fileLawsuit` would therefore have silently mispriced all 17 revenue-relative
grounds too (reading `undefined`, or — worse — a stale partial delta from `processNewDecisions`'
own unrelated `ctx.vars.revenue = ... + merged.revenueDelta` write in Step 1, which only ever
covers a freshly-deployed decision's own direct revenue impact, not the turn's real total).
Fixed narrowly, not by promoting `revenue` to a persisted field generally (a bigger, riskier
change with its own knock-on questions this bug didn't need answered): the Step 8 call site
builds `targetVarsForFiling = { ...targetCtx.vars, revenue: plMap.get(filing.targetId)?.revenue
?? targetCtx.vars.revenue }` — a one-off override at the point of use.

`legalEngine.test.ts`'s "relative-type stakes (target.equity / target.revenue)" describe
block and `gameLoop.test.ts`'s "relative-type legal-risk stakes are priced off the
defendant's own current field" describe block (the latter exercising the real
`plMap`/`ctx.vars.equity` wiring end-to-end, not just `LegalEngine` in isolation) are the
regression coverage — extend those, not just the happy absolute-type path, if you touch
`fileLawsuit`'s stakes calculation or add a new relative-type legal risk against a field
other than `equity`/`revenue` (which would need the exact same "read `target` generically"
treatment, no code change required if it already does).

### Statute of limitations — a decision can be sued over for only `gameSettings.statuteOfLimitationsYears` (default 10), independent of its own maturity

Not in the original design spec at all, a further addition beyond spec by the
same kind of explicit product decision as the negotiation phase below. Once a target's
cited decision instance has been active `elapsedYears >= statuteOfLimitationsYears`, suing
over it is time-barred: the case still gets created — same "real but hopeless" shape a
wrong guess already gets (see *SUE THEIR ASSES offers the whole decision library's
grounds* above) — just with `baseProbability` forced to `0` rather than priced off the
ground's real schedule. This is deliberately **independent of `isMatured`** (maturity
governs when an impact schedule locks in — instant vs. multi-year — not legal
liability): a decision can be long matured and still well within the limitations window,
or, if an admin ever sets `statuteOfLimitationsYears` below a decision's own maturity
time, time-barred before it's even matured.

Two call sites needed the cutoff, not one — leaving either unpatched would make the game
lie to the player:
- **`LegalEngine.fileLawsuit`** — the actual case-creation math (`server/src/engine/
  legalEngine.ts`). `targetInstance.elapsedYears >= statuteOfLimitationsYears` forces
  `probability` to `0` before `getScheduleValue` would otherwise price it, exactly
  mirroring the existing "no matching instance at all" branch right above it.
- **`pickBestGround`** (`server/src/engine/decisionEngine.ts`) — the estimate Dig Deeper's
  tier-3 reveal and the "SUE NOW" shortcut surface *before* a player files. Without the
  same cutoff here, a suggestion could quote real, winnable-looking odds for a decision a
  subsequent `fileLawsuit` call would immediately zero out for being too old — a
  suggestion that lies about the very case it's suggesting. `elapsedYears >=
  statuteOfLimitationsYears` floors each ground's `base` probability to `0` before the
  scrutiny/legal-exposure adjustment (`calculateAdjustedProbability(0, ...)` is
  multiplicative, so it stays `0` regardless of the attacker's own stats — same guarantee
  `resolveProbability` already gives a wrong guess), letting the normal "highest
  probability wins" comparison naturally prefer any non-expired ground over an expired
  one, with no separate branch needed.

Both `fileLawsuit` and `pickBestGround` take `statuteOfLimitationsYears` as a trailing,
**defaulted** parameter (`= Infinity`) rather than a required one — neither function has
any other way to reach `GameSettings` (see below), and defaulting means every pre-feature
call site/test that doesn't pass it keeps compiling and behaving exactly as before,
instead of every one of the ~15 existing `fileLawsuit` call sites in `legalEngine.test.ts`
needing a mechanical update just to keep compiling. The two real production call sites
(`GameLoop.resolveTurn`'s Step 8 filing loop, and `revealAttack`) both pass
`this.config.gameSettings.statuteOfLimitationsYears` explicitly — since `GameLoop.
updateConfig` reassigns `this.config` wholesale on every admin edit (see *Formulas are
DB-backed* below for the equivalent live-reload story), a live `/admin` change to this
value takes effect on the very next turn resolved anywhere, no restart needed, with zero
changes required to `LegalEngine` itself (it has no constructor/config access at all,
staying stateless except for `setDefinitions`).

`GameSettings.statuteOfLimitationsYears` is a plain DB-backed admin field like
`digDeeperCost`/`lawsuitFilingCost` — see *Decisions/config are DB-backed, not static
JSON* below for the general story (seeded from `server/src/data/game_config.json`,
editable live via `/admin`'s raw-JSON config editor, validated by `gameSettingsSchema` in
`validation/schemas.ts`). Because Prisma's `GameConfigRow.gameSettings` is JSONB with no
Postgres-level schema, adding this field required no migration — but an **already-seeded**
dev database predates the key and needs `npm run db:seed` re-run (safe — it's an
`upsert` that fully replaces `gameSettings` from the JSON file, not a merge) to actually
have it; until then Prisma returns `undefined` for it at runtime despite the TS type
claiming `number`, which is exactly what the `= Infinity` defaults above guard against.

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

Worth knowing while reading the next section: Step 7's `c.status !== 'resolved'` filter
means a resolved case is only ever re-persisted into `engineState.legalCases` for the one
turn it resolves in — the *following* turn's Step 7 excludes it from `allCases`, and Step 12
persists exactly `allCases` back, so it silently drops out of both parties' persisted
history after that one extra turn. This is fine for the case itself (nothing downstream
needs a resolved case's history beyond the turn it resolves, since legal exposure/risk gauge
only ever look at *open* cases) — but it means anything that wants to remember "this case
existed" longer than that can't just scan `engineState.legalCases` for it; see below for
where this bites.

### Only one lawsuit per decision instance, ever — first come, first served, tracked on the instance itself since case history doesn't last

By explicit product decision, a specific decision instance can be the subject of **at most
one lawsuit for its entire lifetime** — the instant a genuine case is filed against it
(not a wrong guess, not a time-barred ground — the same cases where `defendantDecisionInstanceId`
is already left `undefined`, see above), that instance is permanently claimed. No further
lawsuit — from any player, over any ground, this turn or any later one — can ever target
that same instance again, regardless of whether the first case eventually settles, is won,
or is lost. This is scoped to the *instance*, not the decision name: once that instance is
later voided by a lost lawsuit or naturally expires and the player redeploys the same
decision, the new instance is an independent, cleanly-un-sued one — see *Winning a case
voids the sued decision instance* and the natural-expiration section above for why an
instance's lifecycle is already the right unit to scope this to, not the name.

`DeployedDecision.everSued` (mirrored in `PersistedDecisionInstance`/round-tripped through
every serialization site `voidedByLawsuit` already threads through — `readEngineState`,
Step 12 persistence, `serializeEngineStateForCase`, `digDeeper`'s `engineStateUpdate`) is
set `true` the instant `GameLoop.resolveTurn`'s Step 8 filing loop gets back a `newCase`
with a real `defendantDecisionInstanceId` — that field only exists for a genuine, still-
claimable match in the first place, so this fires exactly once per instance, whichever
filing gets there first. **Deliberately not derived from scanning past cases** — the
previous section explains why that would be unreliable: a resolved case (settled/won/lost)
only survives in `engineState.legalCases` for one extra turn before Step 7's filter drops
it from persisted history entirely, so "was this ever sued" can't be answered by looking
for a matching case object more than a turn after it resolves. A flag stamped permanently
on the decision instance itself — which, unlike a case, never gets pruned; it stays in
`activeDecisions` for the rest of the game — is what makes the block actually permanent.

"First come, first served" falls out of Step 8's existing iteration order for free, with no
extra bookkeeping needed: `targetActiveDecisions` (the candidate list `LegalEngine.
fileLawsuit`'s `.find()`-by-name matches against) is rebuilt fresh from `targetCtx.
engineState.activeDecisions` on every single filing processed, excluding both
`voidedByLawsuit` and `everSued` instances (mirroring the exact filter voided instances
already got — see *Winning a case voids the sued decision instance* above). The moment one
filing claims an instance, that mutation is visible to every subsequent filing in the same
`resolveTurn` call — a second plaintiff (or the same plaintiff filing twice) targeting the
same instance later in the same loop simply finds no unclaimed match, producing the same
"real but hopeless" 0%-probability shape a wrong guess or time-barred ground already gets
(`fileLawsuit` needs zero changes for this — the exclusion happens entirely by what's fed
into `targetActiveDecisions` before it's even called). `pickBestGround` also takes the
instance's `everSued` flag as a new `alreadyClaimed` parameter, flooring probability to 0
the same way `timeBarred` already does, so Dig Deeper's suggested-ground reveal and the
SUE NOW shortcut never quote winnable odds for an instance nobody can successfully sue
anymore.

`gameLoop.test.ts`'s "resolveTurn — one lawsuit per decision instance, ever (regression)"
describe block is the regression coverage: a same-turn second plaintiff gets the hopeless
shape while the first gets a real one; a lawsuit filed several turns after the first case
resolved (and has already dropped out of `engineState.legalCases`, confirmed directly in
the test) is still blocked, proving the block doesn't depend on case history surviving;
and suing a freshly redeployed instance of the same decision name succeeds normally,
proving the scope is per-instance, not per-name. Extend that describe block, not just the
happy path, if you touch `everSued`/Step 8's filing loop/`pickBestGround` again.

### Dig deeper on an open lawsuit — defendant pays to reveal a case's probability, a one-shot reveal reusing the two-party `makeOffer`/`acceptOffer`/`goToCourt` shape

A case's probability used to be free, permanent intel for the defendant the instant it
was filed. `GameLoop.digDeeperOnCase(playerId, caseId, players)` (`server/src/engine/
gameLoop.ts`) changes that: the defendant now pays `gameSettings.digDeeperCost` (same fee
as an incoming-attack investigation click) to flip a new per-case
`LegalCaseData.defendantInvestigated` flag from `false` to `true`, which is what
`knowsOdds` actually gates client-side (see *A case's probability chip is earned
separately by each side* below). Unlike the 3-tier incoming-attack investigation ladder
(`digDeeper`), this is a single one-shot reveal — there's only one thing to learn (the
odds), not a progression of tiers, so one dig either succeeds (`already_investigated`
after that) or fails outright (`not_defendant`, `insufficient_funds`).

Reuses the exact two-party persist/emit shape `makeOffer`/`acceptOffer`/`goToCourt`
already established, because a case lives in **both** parties' `engineState.legalCases`
(see above) and both copies need the flag written back so they never diverge — even
though only the defendant's cash moves. `digDeeperOnCase` calls the same private
`findCaseAndParties` lookup those three methods use, returns the same
`LegalCaseActionOutcome` shape (widened with three new failure reasons: `not_defendant`,
`already_investigated`, `insufficient_funds`), and `GameEngine.digDeeperOnCase` calls the
same `persistLegalCaseAction`/`emitLegalCaseUpdate` helpers those three already use —
`game:digDeeperCase` requesting it, `game:legalCaseUpdate` (not a new event) announcing
the result to both parties' sockets, exactly like an offer or a court decision would. No
new client-side store plumbing was needed for this reason: `applyLegalCaseUpdate` already
patches any updated case into `turnResults` by id, defendant-cash-move or not.

Client-side, `CaseCard` renders a "🔍 Dig Deeper ($X)" button in place of the chip
whenever `isDefendant && !knowsOdds`, styled and wired the same way `AttackHintCard`'s own
Dig Deeper button already is (a local `digging`/`digError` `useState` pair, one-shot
`socket.on(GAME_LEGAL_CASE_UPDATE)`/`socket.on(ERROR)` listeners registered right before
the emit and torn down in the handler, matching `NegotiationPanel`'s `sendAction` pattern
in the same file) — not a shared hook, since neither existing pattern was a hook to begin
with.

### A case's probability chip is earned separately by each side — the plaintiff before filing, the defendant after, via `game:digDeeperCase`

`CaseCard`'s header shows a colored percentage chip (`semaphoreLevel(displayProb)`,
`displayProb` = `adjustedProbability` if the case has one, else `baseProbability`) when
`knowsOdds` is true. `knowsOdds` is `isDefendant ? caseData.defendantInvestigated :
caseData.plaintiffFullyInvestigated` — two independent flags, not one shared reveal.
The *plaintiff* earns theirs by having fully "Dig Deeper"-investigated (investigation
level `MAX_INVESTIGATION_LEVEL`, i.e. 3) the underlying attack before suing over its
exact suggested ground (see the *Attack Awareness & Dig Deeper* section — the same
suggested-ground concept `pickBestGround` computes there). The *defendant* earns theirs
by paying `gameSettings.digDeeperCost` on the case itself (see *"Dig deeper on an open
lawsuit reveals its probability of success"* below) — a case's probability used to be
free, permanent intel for the defendant the instant it was filed; it no longer is.
Whichever side hasn't earned it renders a `semColors.gray`-styled chip reading "Unknown"
instead, via `gpStyles.semaphoreChip('gray', false)` — the second `clickable` argument
(default `true`, only ever passed `false` here) drops the `cursor: pointer` styling,
since there's no `RiskBreakdownView` to open for a probability the player hasn't earned.
The plaintiff's route replaced an earlier "Investigate" button that opened the target's
Full Filing report — removed by product decision as redundant (the identical Full Filing
button already exists in the Competitor Intel panel for every rival, case or no case)
rather than fixed in place; suing over a decision that never targeted the plaintiff at all
(no "attack" concept applies, e.g. a general risky decision like Water Pumping) always
stays "Unknown" on the plaintiff's side, since there's nothing to have investigated —
their only route to the real number on such a case is the defendant-style dig, same as
anyone filing on a hunch.

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

### A case's odds display as a 5-band verbal likelihood, not a raw percentage — the estimate is a snapshot that snowballs, so an exact number invites false confidence

Raised directly by the user: the Dig Deeper tier-3 "Estimated success" figure sometimes
reads noticeably *lower* than what the same case's real trial-time probability turns out
to be. Confirmed as a real, expected property of the design, not a bug: `legalExposureRatio`
(`calculateLegalExposureRatio`, `calcEngine.ts`) is recomputed every turn from whatever
cases are *currently* open against a defendant — and the estimate (`pickBestGround`) is
computed at Dig Deeper time, using whatever `legalExposureRatio` was as of the *last
resolved turn*, before this specific lawsuit exists yet. Two things push the real,
eventual trial-time probability up from there that the pre-filing estimate structurally
can't see:

1. **The case snowballs against its own defendant.** The moment it's actually filed, it
   becomes one more open case counted into that same defendant's `legalExposureRatio` on
   every subsequent turn (`gameLoop.ts`'s Step 7: `legalExposure = Σ (adjustedProbability
   ?? baseProbability) × stakes` across all open cases) — which in turn raises
   `adjustedProbability` for every open case against that defendant, including this one,
   for as long as it stays open.
2. **Other plaintiffs can pile on** in the turns between the dig and the eventual trial,
   pushing the same shared ratio up further still.

So the estimate isn't stale/wrong data — it's an inherently pre-filing snapshot of a number
that keeps moving, almost always upward, once litigation against a target starts
accumulating — structurally analogous to a real litigant not knowing how many *other*
lawsuits will land on the same target before their own reaches trial.

**Fix, by explicit product decision (offered two options; chose to apply the change to
every headline "chance of winning" figure, not just this one hint):** both the Dig Deeper
"Estimated success" line and a filed case's own odds chip (`CaseCard`'s semaphore chip)
now show a fixed 5-band verbal label (`likelihoodLabel`, `GamePhase.tsx`) instead of an
exact percentage — `0–20% → Highly Unlikely`, `20–40% → Unlikely`, `40–60% → Moderate`,
`60–80% → Likely`, `80–100%+ → Highly Likely`. Deliberately a **separate, fixed** ladder
from the existing `semaphoreLevel(p, greenMax, yellowMax)` — that function still drives
the chip's dot *color* (green/yellow/red) and stays admin-configurable via
`gameSettings.semaphoreGreenMax`/`semaphoreYellowMax`; `likelihoodLabel`'s 5 cutoffs are
not currently wired to any config value, matching the exact bands specified when this was
requested. Communicating "this is a rough, dated read" via a verbal band is a more honest
representation of what the number actually is than a precise-looking `%` ever was — the
underlying number hasn't gotten any less prone to drifting, only the display stopped
overstating how exact it is.

**Deliberately NOT applied to `RiskBreakdownView`** (opened by clicking the chip) — every
number in there, including its own final "Adjusted probability" total, is recomputed live
from the viewer's own actual *current* `PlayerVariables` every time the modal opens (not a
frozen dig-time snapshot), so the staleness problem this exists for doesn't apply to it at
all. It's also an intentional "show me the real math" breakdown (base probability + a
scrutiny term + a legal-exposure term = the total) — converting only the bottom row to a
word while the components feeding it stay numeric percentages would read as inconsistent,
and "Moderate = 18% + 6% + 23%" doesn't mean anything regardless.

`GamePhase.utils.test.ts`'s `likelihoodLabel` describe block covers all 5 bands and their
boundaries (matching `semaphoreLevel`'s existing describe block's own boundary-testing
style) — extend that, not just the happy path, if you touch the band cutoffs again.

### Winning a case voids the sued decision instance — matched by id, not by name, since a voided decision can be redeployed

A further addition beyond spec (the original design has no concept of this at all): whenever the
defendant ends up paying on a case — a trial `verdict: 'won'` for the plaintiff, or any
settlement where the defendant pays out (`acceptOffer`, or Step 8b's stale-offer
auto-settle) — `GameLoop.voidSuedDecisionInstance` cancels the sued decision instance's
**forthcoming** effects (whatever it already did in earlier turns stays; `applyInstance` is
never called for it again from `advanceAndApply`/`collectTargetImpacts` onward), forces it
`isMatured: true` (which is what actually frees it for redeployment — `canDeploy`'s
existing "previous instance must have matured" rule already covers the rest), and flags it
`voidedByLawsuit: true` (`ActiveDecisionInstance`, shown client-side as a gray **VOIDED —
SUED** badge in place of ✓ MATURED). A trial verdict of `'lost'` (defendant wins) never
triggers this, and neither does the Step 10b bankruptcy-waterfall `'settled'`/`'cancelled'`
outcome — that's a forced payout because a party went bankrupt, not a real adjudication or
negotiated settlement, and is moot anyway since a bankrupt player's `engineState` is never
persisted (see *A bankrupted player's Company row...* above).

**Why this has to be matched by the specific instance id, not by decision name:** before
this feature, a decision instance's `id` never mattered again once it matured — nothing
downstream needed to tell two same-named instances apart. That's no longer true once a
voided decision can be redeployed: a defendant can end up with a long-dead voided instance
*and* a live new one of the same name sitting in the same `activeDecisions` array at once.
`LegalCaseData.defendantDecisionInstanceId` is stamped once, at filing time
(`LegalEngine.fileLawsuit`), from the specific instance the case was actually priced
against — left `undefined` for a wrong guess or a time-barred ground (the same cases where
`baseProbability` is already forced to 0), since there's no genuine instance to point at.
Two knock-on fixes were needed for the same reason: `GameLoop`'s Step 8 filing loop now
excludes voided instances when building `targetActiveDecisions`, so a fresh lawsuit's
`.find()`-by-name lands on a live redeployed instance instead of a stale voided one sitting
earlier in the array (a voided decision is legally closed — you can't sue over it again
regardless); and `buildIncomingAttacks`/`digDeeper`'s attacker lookup both skip voided
instances too, since a decision with no forthcoming effects isn't attacking anyone anymore.

**Why a permanent-effect decision blocks redeploying itself only until its effect
expires, not forever:** without some limit, redeploying after a voided lawsuit would double
as a way to keep re-rolling a decision that grants an indefinitely-repeating KPI boost until
one attempt goes unsued — but locking it out *forever* once successfully matured (an earlier
version of this rule) was its own problem: a decision's "permanent" effect was never meant
to be permanent in the sense of "outlives the statute of limitations that governs everything
else about it," and a hard forever-lock gave no way back in even long after the effect
itself had stopped mattering. `DecisionEngine.hasPermanentEffect(def)` (mirrored client-side
in `GamePhase.tsx`, same hand-kept-in-sync convention as `getMaturityYears`) flags a decision
whenever any of its own (non-`target.*`, non-`competitor*`) impact fields carries a non-zero
`'default'` schedule value — the same "falls through to `'default'` forever once elapsed
years exceed the explicit schedule keys" mechanic `getScheduleValue`'s doc comment already
describes. `canDeploy` blocks redeploying such a decision only while one of the player's own
instances is both matured, not voided, *and* still younger than
`gameSettings.statuteOfLimitationsYears` (`existing.some(d => d.isMatured &&
!d.voidedByLawsuit && d.elapsedYears < statuteOfLimitationsYears)`) — a voided instance never
blocks at all (see above), and once an instance ages past the statute its effect has expired
(next paragraph), so it stops blocking too. Decisions without a permanent effect are
entirely unaffected by this rule: they can still be redeployed as soon as they mature, same
as always.

### A permanent effect naturally expires at the statute of limitations, freeing the decision for redeployment

Distinct from — but deliberately reusing the exact same `gameSettings.statuteOfLimitationsYears`
value as — the lawsuit-voiding mechanic above: a decision doesn't need to be sued at all for
its permanent effect to end. Once any active instance has been active
`statuteOfLimitationsYears` turns (the same age past which it can no longer be meaningfully
sued over either, per *Statute of limitations* above), `DecisionEngine.advanceAndApply` stops
re-applying its own impacts and `collectTargetImpacts` stops re-applying its `target.*`
impacts (if any — checked via a separate, narrower `hasPermanentImpactMap` helper, since
`hasPermanentEffect` deliberately excludes `target.*` fields for the redeploy-lock's own
reasons above; a decision like Bot Attack, whose only nonzero-`'default'` field is
`target.outrage`, would otherwise never trip `hasPermanentEffect` at all). Both functions
force `isMatured: true` on expiry too, covering the edge case where an admin sets
`statuteOfLimitationsYears` shorter than a decision's own maturity schedule. Whatever the
effect already contributed in earlier turns is untouched — this only stops *forthcoming*
re-application, the identical framing `voidSuedDecisionInstance` uses.

**Superseded by the next section**: `canDeploy`/`getDeployability` used to check this exact
same `elapsedYears < statuteOfLimitationsYears` condition to decide whether an instance still
blocks redeployment — they now check a separate, normally much shorter
`permanentEffectCooldownYears` instead (see *"canDeploy's permanent-effect redeploy lock was
decoupled from the statute of limitations"* below for why). This section's own natural-
expiration mechanic (stopping re-application, forcing `isMatured`) is otherwise unchanged.
A decision instance that expires this way (as opposed to being voided by
a lost lawsuit) is *not* flagged `voidedByLawsuit` — the client tells the two apart purely by
recomputing `hasPermanentEffect(def) && elapsedYears >= statuteOfLimitationsYears` itself
(no new persisted field needed, since it's a pure function of data the client already has),
showing a gray **EXPIRED** badge distinct from **VOIDED — SUED** in "Active Decisions".

A non-permanent decision (no nonzero `'default'` anywhere) is untouched by any of this: its
own explicit schedule already reads as 0 past its last explicit year via `getScheduleValue`'s
existing fallback, so there's nothing indefinite to cut off — the statute-of-limitations
check in `advanceAndApply`/`collectTargetImpacts` is gated on `hasPermanentEffect`/
`hasPermanentImpactMap` specifically so a legitimately long *finite* explicit schedule (e.g.
an admin-authored decision with an explicit year-12 entry and no `'default'`) is never cut
off early just for outliving the statute.

### `canDeploy`'s permanent-effect redeploy lock was decoupled from the statute of limitations — matured decisions were effectively one-time-per-game

Raised directly by the user asking "do matured decisions ever get back to being made again?
They should" — confirmed by reading the code (not assumed) that non-permanent-effect
decisions (the majority — instant-maturity Operational picks, one-shot Strategic ones)
already redeployed freely the instant they matured, exactly as the previous section
describes. The real gap was specifically **permanent-effect** decisions (New Factory,
Vertical Integration, Raw Material Monopoly, Venture Capital Shadow Money, Patent Portfolio,
Bot Attack, and anything else `hasPermanentEffect`/`hasPermanentImpactMap` flags): `canDeploy`
gated their redeploy lock on `gameSettings.statuteOfLimitationsYears` itself (10 by
default) — the exact same clock the previous section's natural-expiration mechanic uses.
Given this session's own randomized-simulation findings put median game length around
12-14 rounds, a 10-turn lock made these decisions an effective **one-time-per-game** pick in
practice, with no way back in short of an opponent choosing to sue it into
`voidedByLawsuit` — even though the game's own documented multi-instance stacking math
(`installedCapacity = base * (1 + 0.4 + 0.4)` for two matured New Factorys, see the
`advanceAndApply` compounding-fix section above) assumes redeploying the same permanent-
effect decision more than once in a game is normal, intended play, not an edge case.

Presented three options before touching anything (the tradeoffs are real, not obvious):
reuse the same clock as always (status quo, the bug); shorten
`statuteOfLimitationsYears` itself (simpler, but also shortens how long a decision stays
legally suable — a bigger behavior change than "let me redeploy sooner"); or remove the
lock entirely (simplest, but permits deliberately stacking a permanent effect the instant
it matures, with zero cooldown at all). Confirmed by the user: add a **new, separate,
admin-editable field**, `GameSettings.permanentEffectCooldownYears` (default 3), used
*only* for this gate — `statuteOfLimitationsYears` (still 10 by default) keeps meaning
exactly what it always has: how long a decision instance stays suable, and (per the
previous section) how long its own/`target.*` effect keeps naturally re-applying before
expiring. The two clocks now serve genuinely different questions ("how soon can I build
another factory" vs. "how long am I legally exposed for this one") and can be tuned
independently from `/admin`.

The actual code change is a rename-in-place, not new logic: `DecisionEngine.canDeploy`'s
third parameter (`statuteOfLimitationsYears = Infinity`) became
`permanentEffectCooldownYears = Infinity`, used in the exact same
`existing.some(d => d.isMatured && !d.voidedByLawsuit && d.elapsedYears < X)` gate it always
had — only which config value `X` is now matters. `GameLoop.processNewDecisions`'s one
production call site passes `this.config.gameSettings.permanentEffectCooldownYears` instead
of the statute; the client mirror, `getDeployability` (`GamePhase.tsx`), got the identical
parameter rename and its one call site (the Decision Deck) now passes
`gameSettings?.permanentEffectCooldownYears`. The natural-expiration mechanic in the
previous section (`advanceAndApply`/`collectTargetImpacts` stopping re-application, the
**EXPIRED** badge) is completely untouched — it still runs on `statuteOfLimitationsYears`,
unchanged; in practice the short cooldown will almost always free a decision for
redeployment long before the (much longer) statute would ever naturally expire it, so the
two mechanisms rarely interact in a single game, but they're independent by design, not by
coincidence.

`decisionEngine.test.ts`'s `canDeploy` "permanent-effect redeploy lock" describe block gained
a dedicated regression test proving the decoupling directly (an instance well within any
real-world statute — `elapsedYears=4`, nowhere near 10 — is still freely redeployable once
past a short `permanentEffectCooldownYears=3`); `gameLoop.test.ts`'s equivalent describe
block was split so the "effect stops applying at the statute" assertion (unaffected) and the
"redeployment unlocks on the (short) cooldown, independent of the statute" assertion (the
actual fix, exercised end-to-end through `resolveTurn`/`submitDecisions`) are two separate,
clearly-named tests rather than one test conflating both. `GamePhase.utils.test.ts`'s
`getDeployability` describe block — which previously had no permanent-effect coverage at all
(its minimal test fixtures had no `impacts` field to check `hasPermanentEffect` against, a
real pre-existing gap in that test's fidelity to the real function) — gained the missing
gate plus the same cooldown/statute-independence coverage. Extend all three, not just the
happy path, if you touch this mechanic again.

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
`settlement-proposal.png`, `turn-change.png`). `GamePhase.tsx` models all four as a single
discriminated union, `PostTurnEvent = { type: 'sued'; case } | { type: 'verdict'; outcome;
case } | { type: 'settlement'; case } | { type: 'turnChange'; round }` — **one case per
event, always**, never a batch (see the dedicated section below for why). This **used to** drive a
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
changes hands). `defender-won.png` was added specifically for that second case. Since each
'verdict' `PostTurnEvent` is exactly one case (see below), whether I was plaintiff or
defendant *on that case* is unambiguous — `currentEvent.case.plaintiffId !== player?.id`
picks the art directly, no batch/"mixed" guessing involved. `lawsuit-lost.png` is
unaffected — no equivalent role split exists for a *loss*, since no second art asset was
ever commissioned for it. The 'settlement' modal (previously text-only) now leads with
`settlement-proposal.png` the same way every other News modal does — no role split there,
since a settlement is a mutual, negotiated event rather than one side unilaterally winning
or losing.

**One case per event, never a batch — an earlier version bundled and was a real, reported
bug.** `PostTurnEvent`'s `sued`/`verdict`/`settlement` variants originally carried a
`cases: LegalCaseData[]` array, and the turn-sync effect built at most one event per
*kind* per turn (`{ type: 'sued', cases: newlySued }`, one `'won'` event, one `'lost'`
event, one `{ type: 'settlement', cases: newlySettled }`) — every case of that kind
resolving in the same turn was folded into that single event/News row, rendered as a list
inside one modal. Reported as a bug because it reads exactly like data loss even though
nothing was actually dropped: two lawsuits landing on the same player in one turn (or two
verdicts, or two settlements) produced only **one** News row and one "alert" — a player
skimming the News box for "how many things happened" undercounted, and a player who only
opens the first-seen row of a given topic could miss every case after the first entirely
if they didn't notice the modal's internal list scrolled past one entry. Each case is its
own independent win/loss/settlement outcome — nothing about "another case of the same kind
resolved the same turn" makes two cases one event. Fixed by flattening every array to a
single case (`{ type: 'sued'; case: LegalCaseData }`, `{ type: 'verdict'; outcome; case:
LegalCaseData }`, `{ type: 'settlement'; case: SettledCaseForMe }`) and mapping each
detector's result array into its own `PostTurnEvent` (`newlySued.map((c) => ({ type:
'sued', case: c }))`, etc.) rather than wrapping the whole array once. `detectNewlySuedCases`/
`detectNewlyResolvedCases`/`detectNewlySettledCases` themselves are unchanged — they always
returned arrays of every relevant case, correctly; the bug was purely in how the component
turned that array into News items afterward, so this only touched `PostTurnEvent`'s shape
and its two use sites (the event-building effect, the modal's render branches — each
dropped its `.map()` over a list in favor of rendering the event's one `case` directly).
Two independent same-turn lawsuits against the same player, or two verdicts, now produce
two separate News rows and two separate clickable alerts, each fully independent of the
other — exactly the "each case is handled as its own case" behavior a player would expect.

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

### Game Timeline — a Civilization-style game-over replay that's also the live spectator view for eliminated players

Before this feature, an eliminated player hit a dead end: `LostOverlay`'s single "Return
to Start" button, and no way to keep watching. Game Over itself was a static "Final
Standings" `Table` with no history at all. `GameTimelineView`
(`client/src/pages/GameTimelineView.tsx`) replaces both: a switchable KPI race chart
(one line per player, like Civ's Score graph), play/pause/speed/scrub controls, a
cumulative "happenings" log (every decision deployed + every lawsuit filed/resolved, for
every player), and a ranked standings list — used in two modes, `'live'` (an eliminated
player who chose to keep watching) and `'finished'` (`GameOver.tsx`, now just `<GameTimelineView
mode="finished" />`, for the winner and every spectator alike). Scrubbing to the final
round *is* the final-standings view — there's no separate table anymore.

**The data plumbing for live spectating already existed before this feature — confirmed
by reading the code, not assumed.** A bankrupt/forfeited player's socket is never
disconnected (`resolveGameTurn`'s bankruptcy loop and `forfeitGame` never call
`socket.leave()`/`.disconnect()`), so it keeps receiving `turn:resolved`/`phase:changed`
for the rest of the game regardless of what's rendered. Building this feature was
therefore mostly a client-side rendering/routing decision (`App.tsx`, below) plus closing
real gaps in what was durably persisted, not new realtime infrastructure.

**Two genuinely new pieces of persisted data were needed, confirmed missing by reading
the code, not assumed:**

- **`Player.eliminatedRound: Int?`** — `Player.bankrupt` had no round attached anywhere.
  Set alongside `bankrupt: true` at both write sites (`resolveGameTurn`'s bankruptcy loop,
  covering both `'bankruptcy'` and `'merger'` reasons via the same loop; `forfeitGame`) —
  **and, critically, also synced onto the in-memory `roomState.players` entry**, not just
  the DB row. This closes a real, pre-existing gap: `forfeitGame` already set
  `player.bankrupt = true` in memory, but the natural-bankruptcy loop never did, only
  writing the DB — anything reading "is this player eliminated" from the live roster (the
  new disconnect-cleanup exemption below depends on exactly this) would have seen a stale
  `false` for a naturally-bankrupted player.
- **`LegalCaseHistory`** (new Prisma model) — a resolved `LegalCaseData` only survives one
  extra turn in `engineState.legalCases` before `GameLoop`'s Step 7 prunes it from
  persisted state for good (see the dedicated section on this earlier in this file), so
  there was no way to answer "every lawsuit filed/resolved, for the whole game" from
  existing data. One row per case (id == `LegalCaseData.id`), created at filing, updated
  once at resolution. **Deliberately no FK to `Player`** — only to `Room` — with
  plaintiff/defendant names denormalized at write time, since a `Player` row can still be
  deleted independently (a disconnected player's grace period expiring) and this row must
  keep meaning something regardless. Decision-deployment history needed **no** new table —
  `Company.engineState.activeDecisions` is confirmed append-only (nothing ever removes an
  entry), so it's fully recoverable from current state alone.

`GameEngine.persistLegalCaseHistory` (called from `resolveGameTurn` right after
`persistKpiSnapshots`) is the once-per-turn write hook: dedupe every case appearing across
`outcome.result.players[].legalCases` by id (a case appears in both parties' arrays), then
`upsert` (create-if-missing, populating every field including `resolvedRound`/`verdict` if
already resolved at first sight — covers "filed and resolved the same turn" via the
bankruptcy waterfall) plus a **separately guarded** resolve-update:
`updateMany({ where: { id, resolvedRound: null }, data: { resolvedRound, verdict } })`. The
`resolvedRound: null` guard exists so a case seen again in a later call can never overwrite
an already-stamped resolution round to a wrong, later one — defensive, since tracing the
actual turn-cycle mechanics suggests a resolved case is normally only ever visible in the
exact turn it resolves in (Step 7 excludes it from `allCases` starting the very next turn),
but the guard costs nothing and protects against this ever changing. `acceptOffer` is the
one *out-of-band* case action that can resolve a case outside `resolveTurn` (`makeOffer`
never changes status; `goToCourt` only ever reaches `'awaiting_trial'`, never a loggable
"resolved" event) — it calls the same shared resolve-update helper directly, using
`roomState.room.currentPhaseRound` for the round number.

**A bankrupted player's KPI history used to stop one round early.** `persistKpiSnapshots`
only ever runs against `outcome.result.players`, which excludes eliminated players the
same way `companyUpdates` does — so there was no `KpiSnapshot` capturing a player's actual
final (negative) numbers, only their last still-active round. Closed by extending
`BankruptedPlayer` (`gameLoop.ts`) with `finalVariables`/`finalDerived`/`finalRiskGauge` —
computed via a small `buildFinalSnapshot` helper inside `resolveTurn`'s Step 10b, mirroring
Step 11/13's own per-active-player computation (`calculateRiskGauge`, the same derived-stats
shape) but run once more for a pid about to be eliminated, before its engine state is
discarded. `GameEngine.resolveGameTurn`'s existing bankruptcy-persistence loop (which
already writes `cash: finalCash`) gets one more `kpiSnapshot.upsert` call using these
captured fields. Pure `GameLoop` change only — no I/O added, just more data returned on an
object the caller already persists from.

**Eliminated players are now exempt from the disconnect-cleanup grace-period sweep** — a
real risk this feature would otherwise have: an eliminated player who simply closes their
tab (arguably *more* likely than an active player doing so) would previously have their
`Player`/`Company` rows (and cascaded `KpiSnapshot` history) deleted by
`finalizePlayerRemoval` after `RECONNECT_GRACE_PERIOD_MS`, defeating the entire "replay
everyone's history" premise. `startHeartbeatCleanup`'s sweep now skips finalizing removal
for any player whose (now-reliably-synced) in-memory `bankrupt` flag is `true` — they can
still `room:rejoin` at any time no matter how long they've been gone, since their row is
never deleted while anyone else remains connected to the room.

**This exemption needed a matching fix to the stale-room cleanup, or the room itself would
leak forever once any player had ever been eliminated in it.** The stale-room check used to
require `roomState.players.size === 0` (every player actually removed) — with eliminated
players now permanently kept, that condition could stop being reachable at all. Fixed by
requiring instead that **every remaining player is both eliminated and currently
disconnected** (`p.bankrupt && !p.socketId`), not just "every socket currently
disconnected" — the latter, tried first, was a real regression: it made the stale-room
sweep race ahead of a perfectly normal, still-active player's ordinary reconnect grace
period (their `socketId` is also temporarily null) and delete the whole room out from
under them before `finalizePlayerRemoval` got a chance to run properly. Requiring
`p.bankrupt` too means only "everyone left in this room is a disconnected, eliminated
spectator" ever counts as stale — a room stays alive as long as anyone (winner or
spectator) is still connected, and only gets reclaimed (cascading away `LegalCaseHistory`,
`KpiSnapshot`, etc.) once literally nobody is. Covered directly by two
`gameEngine.test.ts` regression tests: one confirming an eliminated player's row survives
indefinitely while another player stays connected, one confirming the whole room still
gets cleaned up once everyone (including that eliminated player) has actually disconnected.

**`GameEngine.getGameTimeline(roomId)`** (→ `game:getGameTimeline` / `game:gameTimelineResult`)
is pure serialization, no `GameLoop`/`DecisionEngine` involvement — decision names are
resolved client-side against the already-cached deck (the same pattern
`ActiveDecisionCard` already uses), and everything else is either already in Postgres
verbatim (`KpiSnapshot`, `LegalCaseHistory`) or raw JSON already sitting in
`Company.engineState.activeDecisions`. Queries **every** `Player` in the room regardless
of `bankrupt` (mirroring `buildGameOverPayload`'s existing "everyone, not just active"
query shape, not `loadActiveCompanyPlayers`'s active-only one), ordered by `createdAt` —
this stable join order is what lets the client assign each player a stable categorical
chart color by array position, without needing its own id-to-color persistence. The one
genuinely new thing about this handler: it's the first payload-less client→server request
in the codebase (no per-target selection, unlike `game:getKpiHistory`), and it's
deliberately allowed in **both** `GAME_PHASE` and `AFTERMATH` — every other on-demand
handler only allows `GAME_PHASE`. It also calls `touchRoomActivity` so a room being
actively watched (read-only, no state-mutating actions) doesn't get stale-swept out from
under a spectator.

**Client-side, `App.tsx` splits "am I eliminated" (durable) from "have I acknowledged it"
(transient)** — a new `gameStore.hasAcknowledgedElimination` flag (default `false`,
deliberately **not** persisted to `localStorage`, so a page reload while still eliminated
briefly re-shows the acknowledgment screen once more before returning to spectating; reset
by both `setSelfEliminationReason` defensively and `resetSession()`). `LostOverlay`'s old
single "Return to Start" button is now two: "Watch the rest of the game" (calls
`acknowledgeElimination()`) and "Leave" (the old `returnToLanding()`, unchanged). Once
acknowledged, `App.tsx` renders `<GameTimelineView mode="live" />` in place of the normal
`currentPhase` switch — but only while `currentPhase !== 'AFTERMATH'`; the instant the game
actually ends, the switch's existing `AFTERMATH` case (`GameOver`, itself just
`GameTimelineView` in `'finished'` mode) takes over automatically, since every socket still
in the room — survivors and spectators alike — receives the same `phase:changed` broadcast
and lands on the same finished-game replay together. No special-casing needed for that
transition; it falls out of the existing phase switch for free.

Verified end-to-end with a live 3-player Playwright run (not just unit tests): one player
forfeits, sees the watch/leave choice, chooses to watch, and the live spectator view
renders with a working chart/standings/OUT badge; the two remaining players ready up to
force a turn resolution, and the spectator's view auto-advances to the new round with no
action on their part; a second player forfeits (ending the game, since only one remains
active), and every participant — the winner, the first spectator (already watching), and
the second player (choosing to watch from their own forfeit screen after the fact) — all
land on the identical finished-game replay, each correctly seeing their own name
highlighted as "(You)".

`gameEngine.test.ts` gained `describe` blocks for `persistLegalCaseHistory`
(create/resolve, the same-turn filed-and-resolved case, the `resolvedRound: null` overwrite
guard) and `getGameTimeline` (active+bankrupt players, grouped KPI history, decisions
derived from raw `engineState`, lawsuits from `LegalCaseHistory`, reachability during
`AFTERMATH`), plus extended `resolveGameTurn`/`forfeitGame`/heartbeat-sweep tests for
`eliminatedRound` and the exemption. `gameLoop.test.ts`'s existing bankruptcy/merger tests
gained `finalVariables`/`finalDerived`/`finalRiskGauge` assertions. Client-side,
`GameTimelineView.utils.test.ts` duplicates and tests `getKpiFieldValue`/`buildHappenings`/
`rankPlayersAtRound` (the same "duplicate small pure logic, keep this test file lightweight"
convention `GamePhase.utils.test.ts` established), and `gameStore.test.ts` covers
`hasAcknowledgedElimination`/`acknowledgeElimination` and their interaction with
`setSelfEliminationReason`/`resetSession`. `tests/api/room.test.ts` gained a real-Postgres
round trip for both `Player.eliminatedRound` and `LegalCaseHistory`'s full lifecycle
(including its cascade-delete-with-room behavior) — extend these, not just the happy path,
if you touch any part of this feature again.
