# Typing Race: Architecture & Decisions

> Living design doc. Read this first. Update the **Status log** at the bottom
> whenever you make a decision or finish a step, so a fresh session (human or AI)
> can pick up without re-deriving context.

## What this is
A room-based multiplayer typing-race website. Players connect to a shared room,
spectate, and can join upcoming races. The server is authoritative: it owns all
race state and stats; clients only send *intents* (e.g. "I want to race",
"here's my typing progress") which the server validates.

## Stack
- **Server:** Colyseus 0.17 (Node.js). Authoritative multiplayer framework.
  Chosen for built-in rooms, automatic state sync (server mutates state → deltas
  auto-broadcast to clients), and matchmaking. Docs: https://docs.colyseus.io
- **Client:** Plain HTML + JS via the `@colyseus/sdk` browser build (CDN, no build
  step) for now. Deliberately framework-free so the game logic stays the focus.
  Can migrate to SvelteKit/React later; the SDK is framework-agnostic.
- **Transport:** WebSockets (Colyseus default). Server listens on port `2567`.

## Layout
```
/                      project root (created by `npm create colyseus-app`)
├─ src/
│  ├─ app.config.ts    server config: registers rooms (see "Registering rooms")
│  ├─ index.ts         entry point (generated; usually untouched)
│  └─ rooms/
│     ├─ RaceRoom.ts   the room logic (join/leave, message handlers)
│     └─ schema/
│        └─ RaceState.ts   the SYNCHRONIZED state (players, phase)
└─ client/
   └─ index.html       the whole client for now (HTML + CSS + JS in one file)
```

## Core model
- **One shared room**, registered under the name `race_room`.
  `client.joinOrCreate("race_room")` funnels everyone into a single instance.
- **RaceState** (the synchronized state, in `schema/RaceState.ts`):
  - `phase: string`, room lifecycle: `"waiting" | "countdown" | "racing" | "finished"`.
  - `countdown: number`, reused for two waits: seconds until the race starts
    while `phase === "countdown"`, and seconds until the next race while
    `phase === "finished"`. 0 otherwise.
  - `quote: string`, the text for the *upcoming* race. Always populated: picked
    on room creation and again every time the room settles back to `"waiting"`,
    so it's previewable well before anyone queues, and carried unchanged
    through `"countdown"` into `"racing"`.
  - `quoteId: number`, increments every time a new quote is picked. The quote
    pool is small enough that consecutive races can land on identical text, so
    clients must detect "a new race started" via this counter, not by
    comparing `quote` itself.
  - `players: Map<sessionId, Player>`, everyone currently connected.
  - `chat: ChatMessage[]`, recent chat history, capped at CHAT_HISTORY_LIMIT
    (50; oldest dropped first). Synced like everything else, so a fresh
    joiner gets the backlog for free. Each `ChatMessage` has `sessionId`
    (for "is this me" styling), `name`, `text`, `sentAt`. Sanitized the same
    way as player names (trim, cap at 200 chars, empty ignored). Always
    available regardless of `phase`; it's cosmetic, not part of the race.
- **Player**:
  - `name: string`. Set on join from the client-supplied name (see
    `joinOrCreate` options), and changeable any time via the `"setName"`
    message; sanitized server-side either way (trim, cap at 20 chars, empty
    falls back to `"guest"`). Client persists its own name in
    `localStorage` so it survives reloads.
  - `status: string`: `"watching"` (spectating) or `"racing"` (in/awaiting race).
    Joining is only allowed while `phase` is `"waiting"`/`"countdown"`; bailing
    out to `"watching"` is always allowed, even mid-race.
  - `progress: number`, 0..1 fraction of the quote typed correctly so far.
  - `wpm: number`, live words-per-minute, server-computed.
  - `finished: boolean`, true once `progress` reaches 1. False for stragglers
    ranked by timeout (DNF); see Step 4 below.
  - `place: number`, final standing (1 = first, ...), 0 until ranked. Assigned
    in finish order; racers still going when the race times out are ranked
    afterward by progress.
  - `afk: boolean`, true if the server auto-moved this player to `"watching"`
    for going idle mid-race (no `"typeProgress"` for INACTIVITY_TIMEOUT_MS).
    Reset false at the start of every race. Lets clients keep their
    leaderboard row in place (tagged "AFK") instead of it vanishing and
    reshuffling the rest of the list.
  - Server never trusts a client's own progress/wpm/finished/place claim: it
    recomputes `progress`/`wpm` itself from the raw input string sent via the
    `"typeProgress"` message, and only it assigns `place` (see RaceRoom).
    (Later: `connected`, ...)

## Golden rule: the server is authoritative
Clients NEVER set their own stats. They send messages describing intent; the
server decides what happens and mutates `this.state`. This is what makes stats
trustworthy and the anti-cheat story simple. When adding a feature, ask:
"could a malicious client lie about this?" If yes, the server must compute/verify it.

## How state sync works (mental model)
1. Server mutates `this.state` (e.g. `player.status = "racing"`).
2. Colyseus encodes only the *change* and pushes it to every client (~20fps).
3. On each client, `room.onStateChange(state => ...)` fires with the latest state.
   Step 1 just re-renders the player lists from scratch on every change. Simple
   and fine for small state. Later we can switch to fine-grained callbacks
   (`Callbacks.get(room).onAdd/onRemove/listen`) if re-rendering gets expensive.

## Registering rooms
In `src/app.config.ts`, the room must be registered under the name `race_room`.
With the 0.17 `defineServer` API it looks like:
```ts
import { defineServer, defineRoom } from "colyseus";
import { RaceRoom } from "./rooms/RaceRoom";

export const server = defineServer({
  rooms: {
    race_room: defineRoom(RaceRoom),
  },
});
```
The scaffold may instead generate the older `@colyseus/tools` style with
`gameServer.define("my_room", MyRoom)`. Either is fine; just register
`RaceRoom` under the name `"race_room"` wherever the example room is registered.

## Conventions
- Small, independently testable steps. Test by opening 2+ browser tabs.
- Keep the synchronized state minimal; only what clients must see. Ephemeral
  server-only data (timers, buffers) lives on the room instance, not in state.
- Update the Status log below after each step.

## Roadmap
- [x] **Step 1: Presence.** One room, auto-spectate on visit, live player list,
      Join/Spectate toggle that syncs to everyone.
- [x] **Step 2: Race lifecycle.** Countdown + phases + a quote to type.
- [x] **Step 3: Typing + progress.** Client reports progress; server validates
      and computes WPM; progress bars.
- [x] **Step 4: Results & auto next race.**
- [x] **Step 5: Chat, reconnection, then multiple rooms.** All sub-steps
      done (see Status log); match-making.md's matchmaking overhaul is
      complete pending real-world feedback from actually using it.
  - [x] Racer cap (5/room, spectators uncapped) + fullest-room-first
        matchmaking placement + the 5-second countdown lock rule.
  - [x] Solo instant-start.
  - [x] Post-race room merging (the "Anchor Host" illusion's backbone).
  - [x] Instant leave on tab close (was riding the reconnection grace
        window; see Status log).
  - **Descoped per user decision (2026-07-23):** match-making.md's "kick
        idle spectators to global idle after a whole round untouched" -
        not wanted, spectating with no action taken isn't something that
        should get you removed. Only a real disconnect (see above) removes
        someone now.
  - [x] Switch Lobby (generalized beyond just full-room spectators per user
        request - see Status log).
  - [x] Remaining Anchor Host UX polish (join framing, timer bump banner;
        chat history through a merge needed no new work, already unbroken).
        A quote-update toast was tried and then deliberately dropped per
        user feedback - see Status log.

## Status log
- 2026-07-21: Project bootstrapped. Chose Colyseus 0.17 + plain HTML/JS client.
  Step 1 (presence) implemented: RaceState + RaceRoom + client/index.html.
- 2026-07-21: Scaffolded the actual runnable project (package.json, tsconfig,
  src/app.config.ts registering `race_room`, src/index.ts) since only the three
  source files existed with no build setup. Verified Step 1 end-to-end
  (Checkpoint B, two tabs); confirmed working.
- 2026-07-21: Step 2 (race lifecycle) implemented: RaceState gained
  `countdown`/`quote`; RaceRoom starts a 5s countdown once someone queues to
  race, cancels it if all racers leave before it ends, and on 0 picks a random
  quote and moves to `"racing"`. `setStatus` is now ignored once `phase` is
  `"racing"`/`"finished"` (roster locks for the live race). Client shows a
  phase banner and the quote text (read-only; typing input is Step 3).
  Verified with a scripted Colyseus client (waiting → countdown ticking 5→1 →
  racing with quote populated).
- 2026-07-21: Step 2 fixes from manual testing: (1) countdown now requires
  `MIN_RACERS = 2`, not 1; (2) `setStatus` asymmetry: joining a live race is
  still blocked, but bailing out to spectate mid-race is now always allowed
  (and if that drops racers to 0, the room resets to "waiting"); (3) client
  status line now recomputes every render instead of freezing at the initial
  "spectating" text from connect; (4) client redesigned to a Twitch-style
  layout: quote/phase banner always visible in a large left "arena" panel,
  join/spectate button + Racing/Watching panels in a fixed right sidebar.
  Re-verified the roster rules with a 2-client scripted test.
- 2026-07-21: Step 3 (typing + progress) implemented: Player gained
  `progress`/`wpm`/`finished`. Clients send their raw current input via a new
  `"typeProgress"` message; RaceRoom never trusts it; it recomputes the
  longest matching prefix against `state.quote` itself and derives
  progress/WPM from that (a client sending garbage or claiming "finished"
  without matching text is simply ignored). `startRace()` resets these fields
  for every racer at the start of each race. Client adds a live-highlighted
  typing input (green/red per character, cosmetic only) and per-racer
  progress bars + WPM in the sidebar. Also reworked `.layout` so the sidebar
  hugs the right edge of the screen (dropped the centered max-width). Verified
  with a scripted 2-client test: correct full-quote input -> progress 1 /
  finished true; garbage input -> progress 0 / finished false.
- 2026-07-21: Step 3 UI fixes from feedback: (1) moved progress bars/WPM out
  of the sidebar's Racing panel; that panel is now a plain name list like
  Watching, and a new `#leaderboard` (progress bars + WPM) sits above the
  quote in the arena instead; (2) `#quote`/`#typeInput` are now centered as a
  block within the arena (`max-width` + flex `align-items: center` on
  `.arena`) while text inside stays left-aligned (ragged right), not
  center-aligned per line; (3) RaceRoom now runs a 500ms `wpmTicker`
  (`this.clock.setInterval`) that recomputes every non-finished racer's wpm
  from their last-known correct-char count, so wpm keeps updating (and decays
  if someone stops typing) instead of only refreshing on keystrokes. Verified
  with a scripted test: wpm sampled every 700ms while idle after one keystroke
  burst decreased steadily (116 -> 60 -> 47 -> 40 -> 30) instead of freezing.
- 2026-07-21: Two more client-only fixes: (1) the typing cursor's
  `border-left` added real width to whichever character span it was on, so
  when the cursor landed on the first character of a wrapped line, that whole
  line shifted ~1px right relative to the others; switched to `box-shadow`
  (paints without affecting layout) so the text never moves. (2)
  `fillLeaderboard` wiped and rebuilt every `.racer-fill` div on every render,
  so there was never a persisting element for the CSS width transition to
  animate from; every progress-bar update was an instant jump. Reworked it
  to keep one DOM row per sessionId across renders (map keyed by sessionId,
  update in place, only add/remove rows when the racer set changes), and
  bumped the transition to `.25s ease-out`.
- 2026-07-21: Step 4 (results & auto next race) implemented: Player gained
  `place`. RaceRoom ends the race (`phase -> "finished"`) once every racer's
  `finished` flips true, or after RACE_TIMEOUT_MS (60s), whichever comes
  first; stragglers still racing at that point are ranked afterward by
  progress (marked DNF, not "finished"). `state.countdown` is reused during
  `"finished"` to count down RESULTS_SECONDS (8s) before the room resets to
  `"waiting"` and immediately re-checks `onRosterChanged()`; anyone still
  queued as "racing" rolls straight into the next countdown with no re-join
  needed. Client reuses the leaderboard for a results view: sorted by
  `place`, ranked "#N name" labels, "(DNF)" tag for non-finishers, and the
  phase banner shows "Results: next race in Ns…". Verified with two scripted
  tests: (1) both racers finish -> places assigned in finish order (1, 2),
  results countdown ticks 8->5, then auto-continues straight into a new
  countdown since both stayed queued; (2) one racer finishes and the other
  goes silent -> after the race timeout (temporarily shortened to 3s for the
  test, then reverted to 60s) the finisher is place 1, the straggler is place
  2 with `finished: false` and partial progress preserved.
- 2026-07-21: Step 4 fixes from feedback:
  1. Stale wpm/progress after a race: `resetToWaiting()` now zeroes every
     player's `progress`/`wpm`/`finished`/`place` immediately (not just at the
     next `startRace()`), so the leaderboard reads 0 through the whole
     "waiting"/"countdown" gap between races instead of showing the last
     race's numbers until the new one actually starts.
  2. Laggy mistype feedback: the colored quote overlay was only repainted from
     `room.onStateChange`, i.e. after a full round-trip to the server. Correct
     keystrokes usually change server-side progress (visible fast); a mistype
     usually doesn't (the matching-prefix score can't move past an error), so
     there was often no state change to redraw from until an incidental
     update arrived. Client now repaints the overlay synchronously from local
     input the instant you type, in addition to sending the message:
     `sendProgress()` in client/index.html.
  3. Word-locked typing: added client-side word commit. `committed` holds
     everything already locked in (always a verified-correct prefix, ending
     after a space), the input box only ever holds the current word. Space is
     intercepted (`keydown`, `preventDefault`); it only commits (appends to
     `committed`, clears the box) when the box exactly matches the expected
     word, otherwise it's a no-op, so a wrong word blocks progress instead of
     silently committing, and once a word is locked you can't backspace back
     into it. The server protocol didn't need to change: the client still
     sends `committed + box` as one string to `typeProgress`, so RaceRoom's
     existing longest-matching-prefix scoring works unmodified.
  4. Added a subtle race-timeout clock: RaceRoom's existing 500ms ticker
     (renamed `tickRace`) now also writes `state.countdown` down from
     RACE_TIMEOUT_MS during `"racing"` (reusing the same field yet again,
     alongside its pre-race-countdown and results-countdown uses, mutually
     exclusive phases, no conflict). Client shows it as "m:ss" in the arena's
     top-right corner (`#raceTimer`, `position: absolute` on `.arena`),
     separate from the phase banner which still just reads "Race in
     progress". Verified server-side with a scripted test: `state.countdown`
     reads 60 right as a race starts, and every player's stats read back
     zeroed during the post-results "countdown" phase, well before the next
     race's `startRace()` runs.
- 2026-07-21: More feedback fixes: (1) the input's native `placeholder`
  attribute ("Start typing once the race begins…") was showing every time the
  box got cleared after a word, even mid-race; removed it entirely since the
  colored quote + cursor indicator above already convey what to type.
  (2) Removed em dashes site-wide (UI copy and code comments) per user
  preference; rewrote the affected sentences with commas/periods/colons
  instead. (3) Added a subtle selection highlight: the input box's own text
  selection (Ctrl+A, drag, shift+arrows) is now mirrored onto the
  corresponding characters of the race text above it via a new `.selected`
  span class, so the two stay visually in sync. Selection range is tracked
  with `typeInput.selectionStart`/`selectionEnd`, offset by `committed.length`
  since the box only ever holds the current word.
- 2026-07-21: Quote preview during the countdown. `startCountdown()` now
  picks `state.quote` immediately (instead of `startRace()` picking it when
  the countdown ends), so it's visible to everyone, spectators and queued
  racers alike, from the moment the countdown begins; `startRace()` just
  keeps the same quote. `typeProgress` still only takes effect during
  `"racing"` (unchanged guard), so previewing has no effect on scoring even
  if someone tried to type early. Client shows the plain (uncolored) quote
  during `"countdown"` for everyone, and displays the typing input box (but
  `disabled`) to queued racers during the countdown too, so it's visible but
  inert until the race actually starts; the box's own `disabled` attribute
  is what blocks all interaction, no extra JS guard needed. The
  clear-the-input-box moment moved from race start to countdown start, since
  that's now when the box first appears. Verified with a scripted test: the
  quote is already non-empty and identical for both a pure spectator and a
  queued racer partway through the countdown; typing during the countdown
  leaves progress at 0; the same quote string carries through once "racing"
  begins.
- 2026-07-21: Quote preview extended all the way back to "waiting". Moved
  quote-picking off `startCountdown()` and onto `onCreate()` (initial pick)
  and `resetToWaiting()` (a fresh pick every time the room settles back to
  waiting), so `state.quote` is populated even with zero racers queued, not
  just once someone queues and the countdown begins; `startCountdown()` no
  longer needs to pick one at all, it just keeps whatever's already there.
  Factored the random pick into a `pickQuote()` helper. Client merged the
  "waiting" and "countdown" quote-display branches (both just show the plain
  preview text now) and extended `showInputBox` to cover "waiting" too, so a
  queued racer sees the disabled input box from the moment they queue, not
  only once a countdown starts. The input-clear trigger changed from
  "entering countdown" to "the quote itself changed" (tracked via
  `lastQuote`), which is more robust now that the quote can already be
  showing well before any phase transition. Verified with a scripted test: a
  lone spectator with nobody queued already sees a non-empty quote; it stays
  identical while a single racer waits below MIN_RACERS; and it carries
  unchanged once a second racer joins and the countdown begins.
- 2026-07-21: Fixed a stale-input bug reported after playing several races
  back to back: with only 4 quotes in `QUOTES`, about 1 in 4 races landed on
  the exact same text as the previous one, and the client's "clear the input"
  logic was keyed on `state.quote` changing, i.e. the string value, so it
  silently failed to fire on those repeats. The leftover `committed` +
  `typeInput.value` from the finished race then carried straight into the new
  one, looking like the last word (and everything before it) was already
  typed. Added `RaceState.quoteId`, an integer bumped every time
  `assignNewQuote()` runs (room creation and `resetToWaiting()`), which is
  guaranteed unique per race regardless of text repeats; client now keys its
  input-clear on `quoteId` instead of `quote`. Verified with an event-driven
  scripted test (logging on every `onStateChange`, not fixed sleeps) across
  three consecutive races: quoteId went 5 -> 6 -> 7, strictly incrementing
  every time.
- 2026-07-21: Several client-only polish fixes to the results screen and the
  typing cursor:
  1. Removed the "Results are in..." filler sentence from the results
     screen (leaderboard + phase banner already say enough), then, per
     follow-up feedback, kept the just-raced quote itself visible in its
     place (plain text) until the next quote loads, rather than leaving the
     area blank.
  2. Hid the cursor indicator entirely for anyone not actually able to type
     right now (spectating, or viewing during "waiting"/"countdown") via a
     new `showCursor` param on `renderQuote`; previously `input=""` always
     put it on index 0, showing a caret at the very start of the text for
     every non-typing viewer.
  3. Kept a finished racer's fully-colored (green) text visible through the
     results screen too (extended the same "is this me, actively typing or
     just finished" branch to cover `phase === "finished"`, not just
     `"racing"`), instead of it reverting to plain.
  4. Fixed a real vanishing-cursor bug: normal CSS whitespace collapses a
     space to zero width when it lands at a wrapped line's end, which hid
     the box-shadow cursor there. First attempt skipped the cursor past
     spaces entirely, but that desynced it from the actual typing position
     (reported as a follow-up bug) since it also skipped spaces that weren't
     at a line boundary and would have rendered fine. Fixed properly instead
     via `white-space: pre-wrap` on `#quote`, which stops the browser from
     collapsing trailing spaces at all, so the cursor can stay at the exact
     real position (no skipping logic needed).
  5. Added a blinking-caret animation (`@keyframes caret-blink`, 1s
     step-end) matching a native input caret. It animates the box-shadow
     itself rather than the span's opacity, so the character underneath
     stays fully readable throughout the blink; since `renderQuote` rebuilds
     the cursor span fresh on every keystroke, the animation restarts at
     solid/visible each time you type, only blinking during pauses.
- 2026-07-21: Editable username. Persisted in `localStorage`
  (`typingRace.username`) so it survives reloads: first visit generates a
  random guest name and keeps reusing it, rather than regenerating on every
  reload as before. Click (or Enter/Space while focused, for keyboard
  accessibility) the name in the header's top-right corner to edit inline;
  Enter or clicking away saves (trimmed, capped at 20 chars, empty falls
  back silently to the unchanged existing name), Escape reverts without
  saving. Added a `setName` message handler to RaceRoom (mirrors the
  `onJoin` name sanitization: trim, cap at 20 chars, empty -> "guest") so a
  rename takes effect immediately, live, without needing to reconnect —
  consistent with the project's server-authoritative model even though a
  display name has no gameplay stakes. Verified with a scripted test:
  rename propagates to another connected client instantly; leading/trailing
  whitespace is trimmed; a blank name falls back to "guest"; an over-length
  name truncates to 20 characters.
- 2026-07-21: Reworked the username editor per feedback: clicking the name no
  longer edits inline in the header (that caused layout shift issues, fixed
  once but the UX itself wasn't right); it now opens a centered modal dialog
  with a dimmed backdrop instead. Header goes back to being plain, fixed-size
  text. Enter or the Save button commits, Escape/Cancel/clicking the backdrop
  discards. Also guarded the typing input's auto-focus (in `render()`) to
  skip while the modal is open, so it can't yank focus away from the dialog
  during a race.
- 2026-07-21: Added inactivity auto-spectate: a racer who sends no
  "typeProgress" at all for INACTIVITY_TIMEOUT_MS (10s), measured from race
  start or their last keystroke, is auto-moved to "watching" by RaceRoom's
  existing 500ms `tickRace()` ticker (added a `lastActivityBySession` map,
  updated on every `typeProgress`, cleared alongside `correctCharsBySession`
  at each race boundary). Same effect as clicking Spectate themselves: just a
  status change, no stat wipe. Reuses existing roster-change consequences
  (idling out to 0 racers resets to "waiting"; idling out the last unfinished
  holdout while everyone else already finished ends the race) rather than
  duplicating that logic. Verified with a scripted test: an idle racer flips
  to "watching" after ~10s while an active co-racer is unaffected and the
  race continues; once that racer also goes idle, the room resets to
  "waiting".
- 2026-07-21: Several rounds of cursor-blink polish (client-only), from
  feedback after the first attempt:
  1. The cursor blinked inconsistently (short/uneven cycles, occasional
     stray flash of visibility when it should've been off). Cause: the whole
     quote is rebuilt from scratch on every render, which fires on every
     server broadcast (not just keystrokes, e.g. the wpm tick every 500ms),
     so a fresh cursor `<span>` was created far more often than the blink's
     1s cycle, and a freshly-created element always restarts its CSS
     animation at 0%. Fixed by computing `animation-delay` from wall-clock
     time on every rebuild instead of leaving it to restart, so the blink
     phase is correct regardless of how often the element gets recreated.
  2. Per feedback, the cursor shouldn't blink while actively typing at all
     (like a native input caret) — only after a pause. Added
     `lastKeystrokeAt` (updated in `sendProgress()`) and
     `CURSOR_IDLE_BEFORE_BLINK_MS` (500ms); the `.blinking` class (and its
     animation) is only applied once idle that long, otherwise the cursor is
     just a plain solid `box-shadow`. Added a 150ms local repaint tick
     (independent of keystrokes/server broadcasts) so the solid->blinking
     switch happens promptly at the threshold rather than waiting on the
     next incidental state update.
  3. Follow-up bug: the delay before the *first* blink-off after stopping
     varied depending on what wall-clock moment you happened to stop typing
     at (a side effect of fix #1's absolute-time anchor), even though
     subsequent blinks were evenly spaced. Fixed by anchoring the delay to
     time-since-idle-started (`Date.now() - lastKeystrokeAt -
     CURSOR_IDLE_BEFORE_BLINK_MS`) instead of absolute wall-clock time —
     keeps the same rebuild-robustness as fix #1, but now the first "off"
     always lands exactly one cycle after the idle threshold, consistently.
  4. There's no API to read the real `<input>`'s native caret timing (it's
     OS/browser-controlled, not exposed to the page), so exact phase-sync
     between the two isn't possible. Set `caret-color: transparent` on
     `#typeInput` instead, so only the one custom cursor in the quote overlay
     is ever visible.
- 2026-07-21: AFK tag for idle-kicked racers, so their leaderboard row stays
  in place instead of vanishing and reshuffling everyone else's position.
  Added `Player.afk` (bool), set alongside the existing idle-kick in
  `tickRace()`, reset false at every race boundary (`startRace()`,
  `resetToWaiting()`). Client now builds a separate `leaderboardEntries` list
  for the live (non-results) leaderboard: everyone with `status === "racing"`
  plus anyone with `afk === true` (even though their status flipped to
  "watching") — the sidebar's Racing/Watching lists still reflect true
  current status unchanged. An AFK row shows "AFK" where wpm normally goes,
  its bar frozen and grayed out (`.racer-fill.afk`), and the whole row dimmed
  (`.racer-row.afk`), rather than disappearing. Results screen (phase
  "finished") deliberately still uses the plain `racing` list, not
  `leaderboardEntries`: an AFK dropout has no `place` assigned (RaceRoom only
  ranks players still `status === "racing"` when the race ends), so it
  wouldn't make sense to show them in final standings. Verified server-side
  with a scripted test: the idle racer's `status`/`afk` read
  `"watching"`/`true` while the active co-racer's read `"racing"`/`false`.
- 2026-07-21: Chat (first piece of Step 5). Added `ChatMessage` schema
  (`sessionId`, `name`, `text`, `sentAt`) and `RaceState.chat`, an
  `ArraySchema` capped at CHAT_HISTORY_LIMIT (50, oldest dropped first) by a
  new `"sendChat"` message handler; sanitized the same way as names (trim,
  cap at 200 chars, empty ignored). Always available regardless of `phase`,
  it's cosmetic, not part of the race. Being part of synced state (not a
  one-off broadcast) means a fresh joiner gets the recent backlog for free.
  Client: the sidebar's roster panel and a new chat panel now share one
  slot, toggled by a small icon button in the panel's top-right corner
  (`#viewToggleBtn`, absolutely positioned); the icon shown is whichever
  view clicking it switches *to* (chat bubble while looking at the roster,
  people icon while looking at chat), both simple hand-written SVGs (no
  icon library). Chat messages render from `state.chat` inside the existing
  `render()`, but skip rebuilding the DOM unless the message count actually
  changed (mirrors the leaderboard-row pattern) so unrelated state
  broadcasts (e.g. the wpm tick) don't thrash it or reset scroll position.
  Verified with a scripted test: a message sent by one client shows up in
  another's `state.chat` with the right `sessionId`/trimmed text; a
  blank-only message is silently ignored; an over-length message truncates
  to 200 chars; flooding past the 50-message cap correctly drops the
  oldest entries first (63 sent -> last 50 kept, verified exact contents).
- 2026-07-22: Chat/sidebar polish from feedback, several rounds. Fixed a real
  bug: the chat DOM-rebuild guard compared `state.chat.length` only, which
  stops changing at all once history hits the 50-message cap (each new
  message drops the oldest), so sent messages silently stopped rendering
  until a refresh; now keyed on length + the newest message's `sentAt`.
  Fixed scroll-to-bottom being a no-op on load: the chat panel starts
  `display:none` (roster shown first), so `scrollHeight` read 0 at that
  point; now re-applied whenever the chat view is switched to, not just on
  new messages. Sidebar now: chat is the default view (not the roster);
  zero padding throughout (button/panel flush, no gap between them); no
  border-radius (square corners); a custom thin flat scrollbar
  (`::-webkit-scrollbar` + `scrollbar-width`) that sits flush against the
  screen's right edge (panel's own right padding removed, content rows get
  their own `padding-right` instead so text still clears the scrollbar); the
  panel header (title + roster/chat toggle icons) now actually vertically
  centers together (`line-height` on the `h2` matched to the icon button's
  height) with a subtle divider line below it. The roster's separate
  "Racing"/"Watching" grouped lists were also merged into one flat
  "Players" list (same header treatment as "Chat"), since the distinction
  wasn't earning its keep visually; the arena's live leaderboard is
  unaffected, it still tracks racing/AFK status internally for its own
  progress-bar logic.
- 2026-07-22: Reconnection (second piece of Step 5). An abrupt disconnect
  (refresh, network blip, tab close) no longer removes the player
  immediately: `RaceRoom.onDrop` calls `allowReconnection` with a
  RECONNECTION_GRACE_SECONDS (20s) window; `onLeave` (the real cleanup -
  removes the Player, re-evaluates roster/phase) now only fires if that
  window elapses without the client coming back. A player who reconnects
  within the window keeps the exact same sessionId, so their Player entry
  (progress, status, chat "is this me" identity) is untouched - this also
  incidentally fixes chat messages losing their blue "me" highlight after a
  refresh, since that was keyed on sessionId staying stable. Deliberately
  orthogonal to the existing AFK idle-kick: a disconnected racer still gets
  AFK-tagged after INACTIVITY_TIMEOUT_MS (10s) same as before: reconnection
  is about not losing your seat/identity, not about pausing the race for
  you. Client: on load, a `reconnectionToken` from the room is persisted to
  `sessionStorage` (per-tab, not `localStorage` - so two tabs open with the
  same name never fight over one token) and `client.reconnect(token)` is
  tried first, falling back to a normal `joinOrCreate` if the token is
  missing, stale, or expired. Verified with a scripted test against the live
  server: forcibly closed a client's connection mid-session, confirmed the
  Player entry survived untouched, then reconnected via the saved token and
  confirmed the resumed session's `sessionId` matched the original exactly;
  a garbage/invalid token was confirmed to fail gracefully (the real client
  code falls back to joinOrCreate in that case).
- 2026-07-22: Reconnection fix from feedback: mid-race progress was visibly
  resetting to the start after a reconnect, even though the server's
  `player.progress` was (verified) untouched the whole time. Root cause was
  purely client-side: `committed`/`typeInput.value` (what's been typed so
  far) live only in page memory, so a refresh wipes them regardless of what
  the server remembers, and the existing "clear input on new quoteId" logic
  ran on every fresh page load (reconnect included), resetting `committed`
  to `""` unconditionally. Fixed by reconstructing `committed` from the
  server's authoritative `progress` fraction against `state.quote` (it maps
  back to an exact prefix, since the server only ever counts a matching
  prefix) instead of assuming 0 - a no-op for genuinely new races, where
  progress is already 0 by the time quoteId changes. Rounds down to the
  last completed word boundary first, since progress can reflect a partial
  word typed right when the connection dropped and `committed` must only
  ever hold whole words (the word-lock system's invariant); a finished
  racer reconnecting is special-cased to the full quote instead, since
  "finished" means the exact full text with no word-boundary ambiguity.
  Verified server-side with a scripted mid-race test that `progress`
  survives reconnection exactly (down to the float); the client-side resume
  logic was verified by reasoning through the exact word-boundary
  arithmetic (no browser automation available in this environment).
- 2026-07-23: Started match-making.md's matchmaking overhaul (see new
  Step 5 sub-checklist above), broken into independently-testable sub-steps
  per the working agreement rather than one large change. First sub-step
  (racer cap + fullest-room-first placement) implemented and verified;
  the rest are still to come.
  - `RaceState` gained `racerCount` (mirrors `countRacers()`, synced so
    clients can eventually show "3/5").
  - `RaceRoom`: `MAX_RACERS = 5` - `setStatus({racing:true})` is now
    silently rejected once a room already has 5 racers queued (same
    treatment as trying to join a room mid-race), while spectating stays
    uncapped. New `updateRacerCount()` helper pushes `racerCount` into both
    `state` and the room's matchmaking metadata (`setMetadata`) from every
    place the racer count can change (`onRosterChanged`, and the AFK
    idle-kick branch of `tickRace`).
  - `app.config.ts`: `race_room` is now registered with
    `.sortBy({"metadata.racerCount": -1})`, so `joinOrCreate` (used
    unchanged by the client) now places new visitors into whichever
    unlocked room instance already has the most racers, instead of always
    reusing one single shared instance - multiple concurrent room
    instances now arise naturally instead of being a single hardcoded one.
  - 5-second lock rule: `startCountdown()`'s ticker calls `this.lock()`
    once `state.countdown` drops to `LOCK_AT_COUNTDOWN_SECONDS` (5),
    pulling the room out of matchmaking placement (existing connections
    are unaffected) so a brand-new visitor can't land seconds before a
    race starts; `startRace()` unlocks again (a live race is a fine
    spectating destination), and `resetToWaiting()` unlocks defensively
    (covers the countdown being cancelled while locked).
  - Verified with a scripted multi-client test against the live server
    (temporary `@colyseus/sdk` dev install, not committed to
    package.json): two racers queuing land in the same room and a third
    fresh visitor is placed into that same (fullest) room rather than a
    new one; queuing 5 racers hits the cap and a 6th racer request is
    silently ignored (`racerCount` stays at 5, the 6th player's status
    stays `"watching"`); once the countdown ticks into its last 5 seconds
    (room now locked), a brand-new visitor is placed into a *different*,
    freshly-created room instead of the locked one.
  - Added a `#roomInfo` line to the client header ("Room `<id>` · X/5
    racing") purely so this behavior is visible/testable by eye in a
    browser, not just via scripted tests or server logs.
  - Fix from manual testing: `COUNTDOWN_SECONDS` was also 5, same as
    `LOCK_AT_COUNTDOWN_SECONDS`, so the room was locked for the *entire*
    countdown instead of just the last stretch of it. Bumped
    `COUNTDOWN_SECONDS` to 10, giving a real ~5 second open window before
    the lock kicks in.
- 2026-07-23: Solo instant-start (second matchmaking sub-step). A lone
  racer with literally nobody else in the room (`state.players.size === 1`,
  not just `countRacers() === 1`) now gets the normal countdown immediately
  instead of sitting in `"waiting"` for a second racer that may never show
  up; per user decision, still runs the full countdown rather than jumping
  straight to `"racing"`. `onRosterChanged()`'s start condition became
  `racerCount >= MIN_RACERS || soloEligible`. This meant the existing
  cancel-countdown condition (`racerCount < MIN_RACERS`) would immediately
  cancel a solo countdown the moment *anything* re-triggered
  `onRosterChanged()` while still alone, e.g. an unrelated spectator
  wandering into the room mid-countdown - so cancellation now uses a
  dynamic `cancelThreshold` (1 during a solo countdown, MIN_RACERS
  otherwise), tracked via a new ephemeral `isSoloCountdown` flag set in
  `startCountdown(solo)` and cleared in `resetToWaiting()` (the single
  reset point reached by both the normal post-results reset and
  `cancelCountdown()`). Verified with a scripted test against the live
  server: a lone racer queuing immediately entered `"countdown"` at
  `racerCount: 1` without waiting; a spectator joining the same room
  mid-countdown did not cancel it; the countdown ran to completion into
  `"racing"` as normal.
- 2026-07-23: Two bug fixes from manual testing of solo instant-start, plus
  a tuning request:
  1. `RESULTS_SECONDS` 8 -> 3 (the post-race "next race in Ns…" pause felt
     too long).
  2. A solo racer sharing the room with a spectator (not another racer)
     didn't start: the previous "solo" fix only kicked in when
     `state.players.size === 1`, i.e. truly nobody else present, so landing
     in a room with even one spectator (very likely once fullest-room-first
     placement is doing its job) fell back to waiting for a second *racer*
     that would never come.
  3. Related stall: after a countdown/race with 2+ racers, if one racer
     left, `onRosterChanged()` cancelled the whole countdown (old
     `racerCount < MIN_RACERS` rule) and reset to `"waiting"` - but nothing
     re-evaluated whether the *remaining* racer alone should immediately
     start a new countdown, so they sat stalled in "waiting" until some
     unrelated later event happened to call `onRosterChanged()` again.
     Root cause for both 2 and 3 was the same MIN_RACERS=2 threshold, so
     fixing it fixed both at once: deleted `MIN_RACERS` (and the
     now-unnecessary `isSoloCountdown` flag/dynamic cancel-threshold from
     the previous fix) entirely. The rule is now simply: a room starts its
     countdown the moment racerCount reaches 1 (regardless of spectator
     count), and only cancels/resets back to `"waiting"` if racerCount drops
     all the way to 0. Losing some but not all racers (2 queued, one
     leaves) now just continues uninterrupted with whoever's left, instead
     of cancelling and stranding the rest. Verified with a scripted test
     against the live server: a lone racer with a spectator present started
     the countdown immediately (`racerCount: 1`); with 2 racers queued, one
     leaving mid-countdown left the countdown running uninterrupted for the
     other (`phase` stayed `"countdown"`, timer kept ticking) instead of
     cancelling.
- 2026-07-23: Post-race room merging (fourth matchmaking sub-step, and the
  hard one). When the post-race results countdown hits 0, the room now
  tries `attemptMerge()` before falling back to its old `resetToWaiting()`
  behavior:
  - Colyseus can't transplant a live WebSocket from one Room instance to
    another, so a merge is really "tell every client which room to jump to,
    then disconnect them here." Added a `RaceRoom.instances` static
    registry (populated in `onCreate`/removed in `onDispose`) so a room can
    reach another live instance directly - this only works within a single
    process, which matches every other single-process assumption already
    in this codebase; a multi-process deployment would need this to go
    through `matchMaker`/presence queries instead.
  - `findMergeTarget()` picks, among every other room currently `"waiting"`
    with enough free racer slots for this room's racers, whichever already
    has the most racers (same fullest-first philosophy as new-visitor
    placement). `attemptMerge()` then calls the target's new
    `mergeChatFrom()` (copies the dying room's chat history over, capped at
    CHAT_HISTORY_LIMIT same as normal growth), sends every connected client
    a `"redirect"` message (target roomId + whether they were racing), and
    calls `this.disconnect()`, which disconnects everyone and lets
    Colyseus's normal autoDispose finish the room off.
  - `onJoin` gained a `resumeRacing` option (only meaningful for a redirect
    arrival): starts the incoming player as `"racing"` instead of the
    default `"watching"`, but only if the target room still actually has a
    free racer slot by the time they arrive (its roster can shift in the
    gap between the merge decision and this join, e.g. an unrelated new
    visitor queuing up in the meantime) - otherwise they land as a
    spectator instead of silently blowing past MAX_RACERS. Also now calls
    `onRosterChanged()` when a join starts as `"racing"`, since ordinary
    joins never used to (everyone always started `"watching"` before this).
  - Client (`client/index.html`): refactored the room-attachment logic
    (token persistence, `onStateChange`, `onLeave`) out of `connect()` into
    a reusable `attachRoom()`, since it's now needed in two places. Added a
    `room.onMessage("redirect", ...)` handler that calls
    `client.joinById(...)` on the target room and re-attaches to it, rather
    than letting the resulting disconnect show as "Disconnected" - a
    `redirecting` flag (set synchronously before the `await`, safe because
    WebSocket message delivery is ordered before the connection's own close
    event) tells the existing `onLeave` handler to stay quiet when the drop
    was actually a merge redirect.
  - Bug found and fixed during testing: `mergeChatFrom()` originally
    re-sorted the combined chat by `sentAt` after pushing the incoming
    messages in, so two interleaved histories would read chronologically -
    but calling `.sort()` on an `ArraySchema<ChatMessage>` (Schema-typed
    elements) corrupted the encoder's refId bookkeeping, producing a
    client-side "refId not found... please report this issue to the
    developers" decode warning (state itself still ended up correct, but
    not worth shipping a warning like that). Not worth chasing further for
    what's a cosmetic ordering nicety on a rare event, so merged messages
    are now just appended in arrival order instead (no re-sort).
  - Verified with a scripted end-to-end test against the live server: a
    solo racer (room X) raced alone, finished, and was redirected into a
    separate pre-existing room (Y, holding one spectator) exactly as
    `findMergeTarget()` should pick it; following that redirect landed in a
    room with both players present (X now `"racing"` again, Y's spectator
    still `"watching"`), which had already auto-started a fresh countdown
    off the merged roster; chat sent in both source rooms before the merge
    was present in the merged room's `state.chat` afterward, with no decode
    warnings after the sort fix.
- 2026-07-23: Merge-target gap found via manual testing: `findMergeTarget()`
  only considered rooms in phase `"waiting"`, so a room whose countdown had
  already started (even if not yet locked, i.e. still a perfectly valid
  destination for an ordinary new visitor per the existing 5-second lock
  rule) was never picked as a merge target - a room that just finished
  racing would sit alone even when another nearby room was mid-countdown
  with plenty of open time left. Fixed to match ordinary new-visitor
  placement eligibility exactly: any room that's `"waiting"` OR `"countdown"`
  and not `locked` is now eligible. This surfaces match-making.md's
  "Adjusting Timers" rule for the first time: landing racers into an
  already-ticking countdown can leave them very little time to get their
  bearings, so `onRosterChanged()` now bumps `state.countdown` up to a new
  `MERGE_TIMER_FLOOR_SECONDS` (8) whenever racerCount increases during
  `"countdown"` and the clock was already below that floor - covers both a
  merge redirect landing with `resumeRacing` and a spectator clicking "Join
  Next Race" mid-countdown, the two ways racerCount can grow while a
  countdown is already running. Only ever raises the timer, never lowers
  it. Verified with a scripted test: deliberately timed a second room's
  fresh countdown so it had ~7 seconds left (unlocked, but under the new
  floor) right as a solo racer's results screen ended; the solo racer was
  redirected into that room (not just idle "waiting" rooms), and its
  countdown read exactly 8 immediately after the merge landed.
- 2026-07-23: Two pieces of feedback after trying the merge behavior live:
  1. Descoped match-making.md's "kick idle spectators to global idle after
     a whole round untouched" - the user doesn't want spectating-without-
     acting to get anyone removed, full stop. Not implemented, and now
     explicitly crossed off the roadmap rather than left ambiguous (see
     roadmap above).
  2. Closing a tab left the player's row sitting in the roster for a few
     seconds instead of disappearing right away. This was
     RECONNECTION_GRACE_SECONDS (20s) working as designed for its actual
     purpose (a refresh/network blip shouldn't lose your seat), but a tab
     close is indistinguishable from a network blip at the raw transport
     level - the server has no way to tell them apart on its own. Fixed
     client-side instead: a new `pagehide` listener (chosen over
     `beforeunload`, which disables the back/forward cache and isn't
     reliable on mobile) calls `room.leave()` when the page is actually
     going away. That sends Colyseus's consented-leave message before the
     connection closes, which the server (see `onDrop`'s doc comment:
     "called when a client leaves the room without consent") treats as a
     real leave and skips the reconnection grace window entirely, going
     straight to `onLeave`'s real cleanup - refreshing still goes through
     the normal `onDrop` grace window as before, only a genuine close
     changed.
- 2026-07-23: Switch Lobby (Step 4). Per user request, generalized well
  beyond match-making.md's original "spectator hits a full room" framing:
  always available regardless of current phase or the player's own
  racing/spectating status, and always targets a room with at least one
  free racer slot (checked at selection time only - the target could fill
  up between selection and the client actually arriving, which is fine and
  matches how merge targets already work).
  - Server: new `"switchLobby"` message handler reuses the exact same
    `"redirect"` mechanism post-race merging already built
    (`findMergeTarget(this, 1)` - "1" because a single switching player
    only ever needs one free slot, unlike a merge which needs room for a
    whole group), just for one client instead of the whole room, and via
    `client.leave()` instead of `this.disconnect()` so the rest of the room
    is undisturbed. No phase gate on the source room at all, unlike
    `setStatus`'s racing transition - leaving mid-race to go elsewhere is
    the player's call.
  - Client: `room.onMessage("redirect", ...)` (in `attachRoom()`) now
    handles a null `roomId` too (only possible via switchLobby - a merge
    target is always found before a merge is even attempted) by calling
    `client.create(...)` for a guaranteed-fresh room instead of giving up
    when no existing room has a free slot.
  - UI: redesigned the sidebar panel's header into a shared 3-column grid
    (`.panel-header`: title / Switch Lobby button / roster↔chat toggle
    icon) instead of a separate `<h2>` per view with the icon absolutely
    positioned on top - the middle button now stays genuinely centered
    regardless of the title text's width ("Chat" vs "Players") or the
    icon's, and both the button and a shared `#panelTitle` (swapped between
    "Chat"/"Players" in `updateSidebarView()`) are visible/consistent
    across both views instead of being duplicated per view.
  - Verified with two scripted tests against the live server: (1) a racer
    alone in a room, with one candidate room full (5/5, correctly skipped)
    and another holding 2 racers (correctly chosen), was redirected to the
    room with free slots and arrived there still `"racing"`; (2) a pure
    spectator (never sent `setStatus`) switching lobby arrived in the new
    room still `"watching"` (`resumeRacing: false`).
  - Also discovered mid-session that both dev servers (game server + the
    static client server) had stopped running entirely (no node processes
    at all) - not caused by anything in this session's changes as far as
    could be told; just restarted both.
- 2026-07-23: Bug fix (found via manual testing): switching lobby while
  mid-race made the client flicker between "racing" and "spectating" every
  second in the new room until the old room's race finished. Root cause
  traced with a scripted repro logging `onStateChange` from both rooms
  side by side: `switchLobby`'s `client.leave()` used the default close
  code (a plain 1000), and Colyseus's own `_onLeave` picks `onLeave`
  (real, final cleanup) vs `onDrop` (this room's `onDrop` unconditionally
  calls `allowReconnection`) purely by close code - `CloseCode.CONSENTED`
  (4000) goes straight to `onLeave`; anything else goes through `onDrop`.
  So the switched-away-from room kept offering a reconnection window, and
  the client-side SDK's own *automatic* reconnection (a separate mechanism
  from this codebase's own reconnect-token logic; see
  `@colyseus/sdk`'s `Room.reconnection`, triggered on specific close
  codes) silently took it up on that a moment later, resurrecting the old
  room's connection and `onStateChange` listener right alongside the new
  room's - both firing independently caused the flicker, which stopped
  once the old race ended (nothing left to keep reconnecting to). Fixed by
  passing `CloseCode.CONSENTED` explicitly to `switchLobby`'s
  `client.leave()`, so that leave is unambiguously final, same as a
  player-initiated leave. (The merge path's `this.disconnect()` was
  already unaffected: it defaults to `CloseCode.CONSENTED` on its own.)
  Also added client-side defense in depth: `attachRoom()`'s `"redirect"`
  handler now calls `removeAllListeners()` on the just-abandoned room
  object right after successfully attaching to the new one, so even an
  unrelated stray old-room event in the future can't render against the
  wrong room. Verified by re-running the exact repro: the old room no
  longer auto-reconnects, and the new room's countdown/status now stay
  clean and uninterrupted the whole way through.
- 2026-07-23: Step 5 (Anchor Host UX polish), the last matchmaking
  sub-step. All three remaining pieces from match-making.md's "Pulling Off
  the 'Anchor Host' Illusion" section:
  1. **"X joined the lobby" chat framing.** `ChatMessage` gained a
     `system` boolean. New `RaceRoom.postSystemMessage()` (and a shared
     `pushChatMessage()` helper factored out of `sendChat`/`mergeChatFrom`
     to avoid duplicating the push+cap-at-CHAT_HISTORY_LIMIT logic) posts
     "`<name>` joined the lobby." from `onJoin` - for every join, with no
     distinction between a brand new visitor and someone arriving via a
     merge/Switch Lobby redirect, per "Always Frame Joins the Same Way".
     Client renders `system` messages without a name prefix, styled
     italic/muted (`.chat-msg-system`) instead of the normal
     name-plus-bubble treatment.
  2. **Quote-update toast.** New `#toast` pill in the arena. A
     `justSwitchedRooms` flag is set right when `attachRoom()`'s
     `"redirect"` handler lands in a new room, then consumed by the next
     `render()` that notices `state.quoteId` changed - shows "New
     challengers joined! Updating quote…" only for *that* transition, not
     for an ordinary same-room between-races quote change.
  3. **"+Ns added for new challengers!" banner.** The countdown-bump logic
     itself was already implemented (see the earlier merge-target Status
     log entry); this just makes it visible. `state.countdown` only ever
     ticks down by 1 during `"countdown"`, so the client tracks it
     (`lastCountdownDuringCountdown`, reset outside `"countdown"`) and any
     *increase* unambiguously means the server just bumped it - shown via
     the same `#toast`, computed as an actual delta rather than a hardcoded
     "+2s". Applies to everyone in the room, not just whoever triggered it.
  Chat continuity through a merge needed no new work - `mergeChatFrom()`
  already copied full history (now including the `system` flag) into the
  target room, and a fresh room join always syncs the complete existing
  state, backlog included.
  Verified server-side with a scripted test: a join posts a `system:true`
  "X joined the lobby." message; a normal `sendChat` message still posts
  correctly (`system:false`) right alongside it. The two toast triggers
  are client-only (DOM feedback), verified by code reading through the
  render() logic rather than browser automation (none available in this
  environment) - the countdown-bump *data* itself was already
  scripted-test-verified in the earlier merge-target Status log entry, so
  this only added the client-side surfacing of an already-correct number.
  Also discovered mid-session, again, that both dev servers had stopped
  running entirely (no node processes) - seems to keep happening in this
  environment independent of anything in this session's changes; restarted
  both again.
- 2026-07-23: Removed the quote-update toast entirely, per user feedback
  after trying it live. Two problems: (1) it always read "New challengers
  joined! Updating quote..." even for a self-initiated Switch Lobby, which
  is backwards - the switcher obviously knows *they're* the one who moved,
  not that others joined them; (2) more fundamentally, the quote already
  changes on every single race regardless of merging (a fresh one is
  picked every time a room returns to "waiting" - see `assignNewQuote()`),
  so a merge's quote change is completely indistinguishable from perfectly
  ordinary between-races cycling. There was never anything unusual here
  that needed calling out - the toast was manufacturing a discontinuity
  that doesn't actually exist from the player's perspective, working
  against the "seamless" goal rather than for it. Deleted the
  `justSwitchedRooms` tracking flag and its trigger in `render()`'s
  quoteId-change block entirely, rather than just fixing the wording for
  the switch-lobby case. The `#toast` element/mechanism itself stays - the
  countdown-bump banner (a real, otherwise-unexplained discontinuity: the
  timer visibly ticking back UP is not routine behavior the way a new
  quote is) is unaffected and still uses it.
- 2026-07-23: Found and fixed a real exploit in the countdown-bump feature
  (reported by the user from live testing): `onRosterChanged()` bumped the
  timer back up whenever racerCount increased during `"countdown"`, with
  no way to tell a genuine merge/Switch Lobby arrival apart from a player
  just spamming their own spectate-then-rejoin toggle - so repeatedly
  toggling could keep the timer perpetually bumped and stall a race
  forever. Fixed exactly as the user suggested: removed the bump
  mechanism entirely (deleted `MERGE_TIMER_FLOOR_SECONDS` and the
  `onRosterChanged()` branch that used it, along with the now-dead client-
  side `#toast`/`showToast` mechanism and countdown-bump-detection code
  that had nothing left to trigger it - the earlier quote-update toast had
  already been removed, so nothing used `#toast` anymore either), and
  added a new hard join-lock instead: `JOIN_LOCK_AT_COUNTDOWN_SECONDS` (3)
  rejects `setStatus({racing:true})` once the countdown drops to 3 or
  below, same silent-ignore treatment as the existing live-race and
  MAX_RACERS gates. Also applied the same cutoff to a merge/Switch Lobby
  redirect's `resumeRacing` arrival (`onJoin`'s `canResumeRacing`), so a
  racer can't land in a room's race past that same cutoff via that path
  either - relevant because `findMergeTarget`'s own 5-second lock check
  happens at *selection* time, and the target's countdown can keep ticking
  during the async gap before the client actually joins. Client:
  `joinBtn.disabled` now also greys out in the last 3 seconds (mirrors the
  live-race/results disable already there), so clicking it during the
  lockout isn't a silent no-op. Verified with two scripted tests against
  the live server: continuously spamming spectate/rejoin for a racer
  throughout an entire countdown no longer stalls it (countdown ticked
  cleanly down to 1 and the race started on schedule, where it previously
  would have stayed perpetually bumped); a join attempt sent once the
  countdown reached exactly 3 was correctly rejected (status stayed
  `"watching"`).
- 2026-07-23: Refined the previous fix per user feedback: the new
  `JOIN_LOCK_AT_COUNTDOWN_SECONDS` gate on `setStatus` was more
  restrictive than necessary - it blocked someone *already in the room*
  from queuing up in the final seconds, when the actual exploit (spamming
  spectate/rejoin to keep the timer bumped) was already fully closed by
  removing the bump mechanism itself. There's no "surprise" to protect an
  existing member from; they've been watching the same countdown the
  whole time. Reverted that gate entirely - `setStatus`'s "Join Next Race"
  is unrestricted again up until the race actually starts, exactly like
  before either fix.
  The real, still-needed protection is for *new arrivals* who haven't been
  watching: a first-time visitor, a merge target, or a Switch Lobby
  target. That was already unified under one mechanism before this
  session even started - the countdown lock rule from the very first
  matchmaking sub-step (`this.lock()` at low countdown, which
  `findMergeTarget()` already respected via `candidate.locked`, and which
  Colyseus's own `joinOrCreate` already respects automatically) - the user
  asked "how does merge eligibility work?" and the honest answer was "it
  already reuses the new-visitor lock, you don't need a separate concept."
  So rather than inventing a second, disconnected constant, just lowered
  the existing `LOCK_AT_COUNTDOWN_SECONDS` from 5 to 3 (the number the
  user proposed) and deleted `JOIN_LOCK_AT_COUNTDOWN_SECONDS` outright,
  repurposing `onJoin`'s arrival-time re-check (`canResumeRacing`, for the
  narrow async-gap race condition between a merge/switch target being
  *selected* and the client actually *arriving*) to read the same unified
  constant instead of its own copy. One number now governs, uniformly:
  pulling a room out of matchmaking, merge/Switch Lobby target
  eligibility, and the redirect arrival re-check - never whether someone
  already present can click "Join Next Race".
  Directly answered the user's question about merge eligibility while
  making this change: a room in `"racing"` is never a merge target
  (`findMergeTarget()` only considers `"waiting"`/unlocked-`"countdown"`),
  so two simultaneously-racing rooms can't merge into each other - one has
  to finish and return to `"waiting"`/`"countdown"` before it becomes
  eligible, possibly on a later cycle.
  Verified with a scripted test covering all three angles at once: an
  existing racer who bailed and rejoined right at countdown<=1 still
  landed back as `"racing"` (no longer blocked); the spam-toggle exploit
  from the previous fix remains closed (a full countdown of continuous
  spam still ended in `"racing"`, never stuck); and a fresh
  `joinOrCreate` visitor was still correctly routed to a *different* room
  than one whose countdown had reached the lock threshold.
- 2026-07-23: Two more bugs found via manual testing:
  1. **Repeated "X joined the lobby" on every refresh.** Root cause: the
     "instant leave on tab close" fix from earlier this session
     (`pagehide` -> `room.leave()`, a consented leave) also fires on an
     ordinary page refresh - `pagehide` can't tell the two apart, there's
     no such signal available to client JS. A consented leave skips the
     reconnection grace window entirely (see `_onLeave`'s close-code
     branching, covered earlier), so every refresh's saved reconnection
     token had nothing valid left to resume; `connect()`'s fallback to
     `joinOrCreate` then created a brand new session (and posted its own
     join message) every single time. Reverted the `pagehide` handler
     entirely - there is no client-side fix that gets both "instant on
     close" and "seamless on refresh" simultaneously, since the browser
     genuinely doesn't expose which one is happening. Compromise instead:
     `RECONNECTION_GRACE_SECONDS` 20 -> 3. Long enough that a normal
     refresh's reconnect handshake reliably lands inside the window, short
     enough that a real close doesn't leave a stale roster row for long.
  2. **A fresh joiner saw the room's entire chat history**, when the user
     wants a new visitor to only see messages sent from the moment they
     joined onward. This actually was the original, deliberate Step 5
     design (chat lives in synced state specifically so a joiner gets the
     backlog "for free"), which also happens to be exactly what
     match-making.md wants preserved through a merge/Switch Lobby
     redirect - so the fix couldn't just strip history out of synced state
     without breaking that. Colyseus always sends a newly-joining client
     the complete current state (no cheap way to give one client a
     server-side-filtered initial sync without diving into
     `@colyseus/schema`'s StateView machinery, overkill for this), so
     handled it client-side instead: a new `myJoinedAt` timestamp,
     persisted in `sessionStorage` (so it survives a refresh - a
     reconnect is still the same ongoing visit, not a new one - but a
     genuinely new tab starts with a fresh one, since sessionStorage
     doesn't carry over), and `renderChat()` now filters out any message
     timestamped before it. Merge/Switch Lobby arrivals are unaffected
     (their `myJoinedAt` was already set from whenever this tab first
     connected, well before any redirect), so they still see full
     continuity as intended.
  Verified fix 1 with a scripted test: closed a connection abruptly (same
  as what a real refresh does to the WebSocket) and reconnected with the
  saved token well within the new 3s window - resumed the exact same
  sessionId, and the chat log's message count was unchanged (no duplicate
  join message posted). Fix 2 is client-rendering-only and was verified by
  reasoning through the logic (no browser automation available in this
  environment).
- 2026-07-23: Found and fixed a chat-duplication bug via a very precise
  live user repro (three tabs, one of which used Switch Lobby before the
  other two triggered a merge into its new room). Root cause:
  `mergeChatFrom()` copied a dying room's ENTIRE chat history, including
  "X joined the lobby" system announcements - but those describe an
  arrival into THAT specific room, not the merged-into one. If a player
  had already left the dying room before it merged (e.g. via an earlier
  Switch Lobby, as in the repro), their own now-stale "joined" message
  from that old room would get copied in as a fresh array push, and
  anyone already sitting in the target room (who'd long since seen and
  dismissed that exact announcement) would see it resurface as if new -
  the `myJoinedAt` client-side filter from the previous fix couldn't catch
  this, since it only checks a message's original `sentAt`, not whether
  the viewing client has effectively already seen that content once
  before. Fixed by having `mergeChatFrom()` skip `system: true` messages
  entirely - only real chat text carries over in a merge now; every
  player actually arriving in the target room still gets their own
  correct, single "joined the lobby" from that room's own `onJoin`, no
  need to also replay a different room's arrival announcements.
  Verified with a scripted repro matching the user's exact scenario: three
  clients (two sharing a name, mirroring the user's own two-incognito-tab
  collision) in one room, one switches lobby away, the other two then
  race, finish, and merge into the switcher's new room - confirmed the
  merged room's final chat had exactly one join announcement per player
  per room actually arrived in (no stale duplicates) while the real "hey"
  message still carried over correctly.
- 2026-07-23: The previous fix turned out to be incomplete - user testing
  (screenshots of before/after a merge on the "moved" player's own tab)
  showed the chat log visibly reordering, the user's own messages losing
  their blue "me" highlight, and a fresh "G Fruit joined the lobby" about
  themselves appearing at the bottom. Root cause was more fundamental than
  the earlier fix addressed: `renderChat()` still redrew the entire log
  from whichever room happened to be attached, every time. A merge/Switch
  Lobby redirect attaches to a genuinely different room object with its
  own `state.chat` (different order, different composition - the target
  room's own prior history first, then the copied-over real messages), so
  of course the visible log looked different afterward; and since the
  redraw recomputed "is this me" by comparing each message's `sessionId`
  against the *current* room's `sessionId`, every message the player had
  sent under their *previous* room's sessionId stopped matching.
  Rebuilt chat rendering around a persistent, append-only client-side log
  (`myVisibleChat`) that survives redirects untouched and is never
  rebuilt from a room's full state - `renderChat()` only ever adds
  messages it hasn't incorporated before, computing "is this me" once at
  the moment each message is first incorporated (baked into the stored
  entry, immune to a later sessionId change) rather than recomputing it
  against whatever room is current.
  "Already incorporated" needed to become content-based (a composite
  `sessionId|sentAt|text` key, tracked in a `seenChatKeys` Set) instead of
  the previous fix's single `sentAt` cursor: a cursor doesn't work across
  a room switch, because two independently-running rooms' timestamps
  aren't comparable - the destination room's own genuinely-new-to-me
  history can easily have an *older* sentAt than messages already seen in
  the room just left, and a cursor would wrongly hide it (confirmed via a
  standalone logic simulation before touching production code - an
  earlier draft of this fix using a cursor reproduced the exact reported
  bug). The original "don't show a brand new visitor pre-existing
  history" cutoff (`chatGenesisAt`, formerly `myJoinedAt`) is kept, but
  now only for content that predates a tab's very first-ever connection -
  it marks such messages seen (so they never resurface via some future
  merge either) without displaying them, rather than gating every
  message.
  A second bug surfaced during the same investigation: even with correct
  dedup, a player's own redirect-triggered arrival posts a genuinely new,
  distinct "X joined the lobby" system message (a real, new `onJoin`) -
  no amount of deduplication can suppress that, since it isn't a repeat of
  anything. The real fix was realizing nobody should ever see an
  announcement about their *own* arrival, merge-triggered or not - from
  the mover's own perspective they never left. `ChatMessage.system`
  messages previously always posted with `sessionId: ""` (meaningless for
  a system message - nobody "sent" it); `postSystemMessage()` gained an
  `aboutSessionId` parameter repurposing that field as "who this concerns"
  instead, and the client now skips rendering (but still marks seen) any
  system message where that matches its own current sessionId. As a side
  effect, a player no longer sees their own very first "joined the lobby"
  either, not just merge-triggered repeats - judged to be a reasonable,
  more-consistent simplification (most chat apps don't show you your own
  join line either) rather than a regression worth special-casing around.
  Known accepted limitation, not fixed: a player who moves together with
  someone they were already grouped with (e.g. two racers merging
  together into a third room) still sees a redundant announcement for
  that person in the destination room, since there's no persistent
  cross-redirect identity to recognize "I already know this person from
  the room I just left" - only self-suppression is implemented. Fixing
  that fully would need each browser tab to carry a stable identity across
  a redirect (distinct from the Colyseus sessionId, which changes every
  join), a bigger change not undertaken here.
  Verified with two layers: a standalone pure-JS simulation of the exact
  client algorithm against synthetic data matching the user's reported
  scenario (both before and after this fix, showing the earlier
  cursor-based draft reproducing the bug and the final content-key +
  self-suppression version fixing it), then the same tracking logic
  re-run against a real server end-to-end (create two rooms, chat in one,
  merge them) - confirmed zero self-announcements, "me" styling preserved
  across the redirect, and no duplicate real messages.
- 2026-07-23: Generalized self-suppression into "known teammate"
  suppression, and added "X left the lobby" - both per explicit user
  request, with one precise constraint: "already known" means "was
  previously in your lobby right before the merge", not "have I ever met
  this person at any point" - someone who left and is later encountered
  again via a different merge should be re-announced.
  - `Player` gained a persistent `clientId` (client-generated, sent on
    every join including a redirect - unlike Colyseus's own sessionId,
    which changes every single join). `ChatMessage.sessionId`'s system-
    message "about" repurposing from the previous fix was replaced with a
    dedicated `aboutClientId` field (clearer than overloading one field
    with two different meanings depending on `system`), plus a new `left`
    boolean distinguishing a "joined" announcement from a "left" one.
  - Server: `postSystemMessage()` now takes `(text, aboutClientId, left)`
    explicitly. `onLeave` posts "X left the lobby" - but only when the
    room isn't in the middle of a merge's mass teardown (`isMerging`, a
    new flag set right before `attemptMerge()`'s `this.disconnect()`):
    every remaining client leaves simultaneously there as part of the SAME
    event, and per the "Anchor Host" illusion a merge should never read as
    anyone "leaving" - not gated by close code, since a Switch Lobby
    departure ALSO uses `CloseCode.CONSENTED` (same as a merge's mass
    disconnect) but explicitly SHOULD post "left the lobby" per this
    request, so the two can't be told apart that way.
  - Client: replaced the previous fix's simple "is this about me" check
    with `myKnownClientIds`, a Set representing "who's currently in my
    lobby" - seeded once from the very first room's roster (silently, no
    announcement, covers pre-existing occupants whose original join
    predates `chatGenesisAt` and would never otherwise be seen), then
    only ever updated by observed events from then on: a displayed
    "joined" adds its clientId, a "left" removes it. Deliberately NOT
    re-seeded from a room's roster on a redirect - that would silently
    absorb the DESTINATION room's own pre-existing occupants too, hiding
    exactly the announcements (like a fresh merge target's own occupants)
    that should show. Carried over untouched across a redirect instead, so
    a merge/Switch Lobby lands with "whoever I already knew right before
    this" intact, and a "joined" announcement for anyone already in that
    set (self included, seeded at declaration) is suppressed; anyone not
    in it is shown and added. A displayed "left" is always shown
    (regardless of prior familiarity) and removes that clientId, so a
    later re-encounter after they've been elsewhere is correctly treated
    as new again.
  - Verified end-to-end against the live server with a scripted test
    mirroring the exact client algorithm: (1) two racers already grouped
    together merge into a third player's room - the third player's join
    shows, the two teammates' don't; (2) one of those teammates later
    switches away - "X left the lobby" appears and they're dropped from
    the known set; (3) that same player rejoins afterward - correctly
    re-announced as joining this time, since they'd left in between.
- 2026-07-24: Fixed the other half of the illusion, reported by the user
  from live testing: when room B folds into room A, A's existing occupants
  correctly saw "B's player joined" (the server posts that on the arrival),
  but the player coming FROM B saw NO join announcements for A's two
  existing occupants - so the merge felt one-sided (as if they'd been
  teleported into a stranger's room rather than others joining theirs). Root
  cause: A's occupants predate the arrival, so there's no "joined" message
  about them in A's chat to render; the arriving client's `myKnownClientIds`
  is carried over from room B (correct - it must NOT be re-seeded from A's
  roster, or genuinely-new-to-me occupants would be silently absorbed), so
  it simply had no signal that A's occupants existed. Fix: a new
  `announceRosterOnArrival` flag, set right before a redirect attaches to
  the destination and consumed on that room's first `renderChat`, that
  synthesizes a client-side "X joined the lobby" line for each destination
  occupant not already in `myKnownClientIds` (adding them to it) - the exact
  mirror of the silent first-connect roster bootstrap, but announced instead
  of absorbed. Runs BEFORE the `state.chat` loop, so any of the room's own
  post-genesis "joined" messages about those same people are then correctly
  skipped rather than double-posted. Only fires on a Switch Lobby/merge
  redirect, never on a fresh connect or refresh (those go through the silent
  bootstrap), so a brand-new visitor still doesn't get spammed with a
  "joined" line for everyone already sitting in the room. Purely client
  rendering (the server behavior it relies on - only the arriver gets a new
  "joined" message, existing occupants get none - was already established
  and unchanged); handed back for a browser re-test of the exact reported
  three-tab scenario.
- 2026-07-24: The previous entry fixed only the arriving (moving) side; user
  testing surfaced the real, more specific bug via a precise repro: X, Y, Z
  all start together in room A; Z Switch-Lobbies to room B; then X and Y race
  in A and merge into B. After the merge, Z did NOT see "X joined"/"Y joined".
  Root cause: `myKnownClientIds` ("who's in my lobby") was carried over
  UNTOUCHED across every redirect - correct for a merge (your whole room
  moves with you, so you keep knowing your teammates and don't re-announce
  them), but WRONG for a solo Switch Lobby: Z left X and Y BEHIND in room A,
  yet kept them in its known set, so when they later merged into room B their
  server-posted joins were suppressed as "already known". Fix: distinguish the
  two redirect kinds. The server's `switchLobby` handler now tags its redirect
  `soloSwitch: true` (a whole-room `attemptMerge` redirect does not); the
  client, on a `soloSwitch` redirect, resets `myKnownClientIds` to just itself
  (everyone left behind is forgotten - they're no longer in my lobby), while a
  merge redirect still carries the set over intact. Threaded through the
  payload rather than inferred client-side from "did I click Switch Lobby"
  because the server unambiguously knows which redirect it's sending, with no
  click-vs-redirect race. Verified end-to-end against a clean server with a
  scripted replica of the full client algorithm running the exact X/Y/Z
  scenario: after the merge X and Y each see "Zoe joined", Z sees both "Xavier
  joined" and "Yara joined", nobody sees their own join, and teammates who
  moved together aren't re-announced to each other (X's one "Yara joined" is
  the original room-A arrival, not a merge duplicate). The illusion is
  inherently one-directional as the user framed it (X/Y merge INTO Z's room B)
  and now reads correctly from both sides: the movers see the one new face,
  the stayer sees the arrivals. (Restarted the dev server first - leftover
  rooms from still-open browser tabs kept getting chosen as merge targets,
  making earlier repro attempts land somewhere other than the intended room.)
- 2026-07-24: Two more issues from user testing.
  1. **Race hung until the timeout when a racer left mid-race.** If one racer
     finished while another was still typing, the race correctly kept going;
     but if that other racer then left (Switch Lobby / disconnect) or bailed
     to spectate, the finisher(s) sat stuck on "Race in progress" for up to the
     full RACE_TIMEOUT_MS (60s). `endRace()` only ever fired from the last
     finisher's own `typeProgress` (which had already passed, while the
     now-departed racer was still going) or the timeout - and `onRosterChanged`
     (which runs on every leave/bail) only checked "did racers hit ZERO?", not
     "are all the REMAINING racers already finished?". Added that second check
     to `onRosterChanged`'s "racing" branch (after the ===0 case, so racerCount
     is >0): if `allRacersFinished()`, end now. Mirrors the identical
     all-finished check `tickRace()` already does after AFK removals. Verified
     with a scripted test: X finishes, Y (still racing) Switch-Lobbies away,
     and the room flipped to "finished" ~100ms later instead of ~60s.
  2. **Chat now clears on a solo Switch Lobby, but still persists through a
     merge.** A solo switch drops you into a genuinely different group, so
     carrying the old lobby's chat across made no sense (a merge is the
     opposite - same group moving together - and rightly keeps it). Reused the
     same `soloSwitch` payload flag from the previous entry: the client's
     "redirect" handler, on a solo switch only, wipes `myVisibleChat`,
     `seenChatKeys`, and resets `chatGenesisAt` to now - i.e. treats arrival at
     the destination exactly like a fresh first connection (no old messages, and
     the destination's own pre-arrival backlog is skipped too), while the
     destination's current occupants still surface as fresh "X joined the lobby"
     lines via `announceRosterOnArrival`. A merge redirect (no `soloSwitch`)
     skips all of this, so its history carries over intact as before. Verified
     with a scripted replica: two players chat in room A, one Switch-Lobbies
     away, and their visible log is empty in the new room while the other's is
     untouched.
- 2026-07-24: Corrected part of the previous entry per user feedback: a solo
  Switch Lobby must NOT announce the destination's existing occupants as
  "X joined the lobby" either. That announcement is the Anchor Host illusion -
  "people are joining YOUR lobby" - which only makes sense for a MERGE, where
  the server relocates you unprompted and the goal is to hide that you moved.
  A Switch Lobby is a deliberate choice: the player knows they're landing
  somewhere new, so "X joined the lobby" reads backwards (X was already there;
  the switcher is the one who arrived). Fix: `announceRosterOnArrival` is now
  set ONLY on a merge redirect (the `else` branch), never on a solo switch.
  The solo-switch branch instead resets `rosterBootstrapped = false`, which
  re-runs the exact same SILENT roster bootstrap a brand-new visitor uses -
  the destination's occupants are absorbed into `myKnownClientIds` as
  "already here", with no chat line. Net effect: a solo switch is now
  indistinguishable from a fresh first connection (empty chat, silent roster
  absorb, only genuinely-new activity from arrival onward shows), while a
  merge still announces + keeps history. The X/Y/Z re-announcement fix from
  two entries ago is unaffected: forgetting the departed room's roster (known
  set reset to just me) is what makes a former co-racer merging in LATER still
  read as new; that's about the known set, not about announcing the switch
  destination. Verified with a two-part scripted replica: (1) Z solo-switches
  into a room where X is already sitting (with backlog) - Z's visible chat
  ends up completely empty, no "X joined", no old messages; (2) regression -
  a merge into a populated room still shows "Pat joined the lobby". Both pass.
- 2026-07-25: Deployment prep (free hosting decision made: Render's free web
  service tier - always WebSocket-capable, one instance, which matches this
  codebase's existing single-process assumption around `RaceRoom.instances`/
  room merging; sleeps after 15 min idle, acceptable since an idle server has
  no live race to lose anyway). Collapsed the app to a single deployable
  process/URL rather than a separate static host for the client:
  - `app.config.ts`: `defineServer`'s `express` callback now mounts
    `express.static(client/)`, so the same Colyseus server serves
    `index.html` at its root alongside the WebSocket endpoint.
  - `client/index.html`: `ENDPOINT` changed from a hardcoded
    `http://localhost:2567` to `window.location.origin`, so the client works
    unmodified both locally (dev server serves itself) and once deployed (no
    per-environment URL editing, no CORS/mixed-content setup since page and
    WebSocket share an origin).
  - Verified locally: `npm start`'s server now returns the client HTML at
    `/` (curl), and the served page reflects the same-origin `ENDPOINT`.
  - Initialized the git repo (none existed before) with a `.gitignore`
    (`node_modules/`, `.env*`) and a first commit, since Render deploys from
    a Git remote. Pushing to GitHub and creating the Render service are
    manual steps (external accounts) still to do.
- 2026-07-25: Quote pool expanded from 4 to 200 (`QUOTES`), all 50-98
  characters. Web tools couldn't actually reach reddit.com (both search and
  fetch refused the domain outright), so instead of browsing AskReddit
  directly, general web search surfaced the common *themes* real AskReddit
  threads cover (life advice, "fact that sounds fake but isn't", trivia,
  relationship/work takes, funny observations) and all 200 quotes were
  written fresh in that spirit, not copied or paraphrased from any specific
  comment, so there's nothing to attribute. Moved `QUOTES` out of
  `RaceRoom.ts` into its own `src/rooms/quotes.ts` (200 strings was too much
  to scroll past to reach the actual room logic); `RaceRoom.ts` now imports
  it. `pickQuote()`'s random-selection logic is unchanged, only the data
  source. Verified: a script confirmed exactly 200 entries, all within
  50-300 characters, no duplicates; `tsc --noEmit` passed after the move;
  the running dev server (tsx watch) hot-reloaded cleanly and kept serving.
- 2026-07-25: Quote pool rewritten again per feedback: the first 200 all read
  too similar (uniform advice-column voice, lengths clustered narrowly at
  59-98 characters), the opposite of what makes rewritten-from-social-media
  quotes actually interesting. Tried reaching X/Twitter and Threads directly
  first (per a follow-up question about other source platforms); X's web/API
  access returned 402 Payment Required and Threads renders an empty
  JS-only shell without login, both dead ends same as Reddit. What did work:
  general web search surfaced third-party compilation articles (e.g.
  pleated-jeans.com) of real tweets/posts, and one specific article rendered
  as actual prose text (fetchable normally), while most others embed each
  post as a screenshot image instead. For the image-only pages, downloaded
  the screenshots directly (curl) and read them with the Read tool's own
  image support to OCR them manually, since no other tool here does that.
  Gathered roughly 90 real, wildly varied posts this way (one-liners,
  dialogue-style jokes, rambling stories, deadpan trivia, wholesome
  anecdotes) across five source pages, skipped anything crude/dark/topical,
  then rewrote all 200 quotes: about 55 adapted from that real material
  (names/handles stripped, wording changed, nothing verbatim), the rest
  newly written to match that same variety rather than one voice. Verified:
  the same script confirms 200 entries, no duplicates, all in range, but now
  spread 58-185 characters (vs. the old 59-98 cluster) with real structural
  variety (short deadpan lines, dialogue exchanges, long run-on rants,
  trivia, hot takes); `tsc --noEmit` and the running dev server both stayed
  clean after the swap.
