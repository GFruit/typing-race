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
  - `emoji: string`, the racer's avatar that rides along its progress bar
    (purely cosmetic personality). Assigned a random one from a fixed pool
    (`EMOJIS` in RaceRoom) on join, changeable any time via the `"setEmoji"`
    message; restricted server-side to that same pool so a client can't
    inject arbitrary text. Client persists its own choice (including a first
    server-assigned random one, captured from synced state) in `localStorage`
    and sends it back as a join option, so an avatar stays stable across
    reloads.
  - `status: string`: `"watching"` (spectating), `"racing"` (in the race being
    set up or run), `"queued"` (holding a racer slot for the race AFTER this
    one), or `"waitlist"` (wants in, but every slot is taken). Joining as
    `"racing"` is only allowed while the room can still take racers for the
    current race (`phase` `"waiting"`, or a `"countdown"` with more than
    `LOCK_AT_COUNTDOWN_SECONDS` left - see `acceptsNewRacers()`); opting in
    outside that window yields `"queued"` instead of being refused, and the
    whole queue is promoted to `"racing"` when the room next settles back to
    `"waiting"`. Bailing out to `"watching"` is always allowed from any of
    them, even mid-race. `"racing"` and `"queued"` occupy one of the
    `MAX_RACERS` slots; `"waitlist"` does NOT - capacity-wise a waitlisted
    player is a spectator, which is what keeps the cap honest while the queue
    behind it stays unbounded.
  - Seats can also be HELD for a player another room has already redirected
    here but who hasn't finished connecting yet - server-only bookkeeping on
    the room instance, keyed by `clientId` (see RaceRoom's `reserveSlots` /
    `countCommittedSlots`), never in synced state. Capacity decisions all read
    "sat in + held", so nothing can take a seat out from under someone
    mid-jump. `state.racerCount` counts held seats too.
  - `waitlistOrder: number`, position in the race queue (0 = not in it), from
    a per-room counter that only increases. The displayed "#1, #2" is this
    field's sort order, so a departure renumbers everyone behind by itself.
    Slots are handed to the front of the line by `promoteFromWaitlist()`,
    which runs whenever one frees up (Spectate, a departure, an AFK kick) -
    NOT when a race merely ends, since its racers keep their slots for the
    next one. A promoted player lands as `"racing"` or `"queued"` by the same
    `acceptsNewRacers()` rule as any opt-in, so coming off the queue mid-race
    never drops anyone into a race already underway.
  - `progress: number`, 0..1 fraction of the quote typed correctly so far.
  - `wpm: number`, live words-per-minute, server-computed.
  - `finished: boolean`, true once `progress` reaches 1. False for stragglers
    ranked by timeout (DNF); see Step 4 below.
  - `place: number`, final standing (1 = first, ...), 0 until ranked. Assigned
    in finish order; racers still going when the race times out are ranked
    afterward by progress.
  - `slotOrder: number`, a per-room counter stamped the moment this player
    takes a racer slot (`"racing"` or `"queued"`); 0 = never held one here.
    Only ever increases, and is deliberately NOT cleared on the way back to
    `"watching"`, so an AFK dropout's leaderboard row keeps its position.
    Re-taking a slot re-stamps it, so it means "who opted in first", not "who
    first ever raced". Clients order both the sidebar racer list and the race
    tracks by it, so the sidebar's order IS the track order.
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
        window; then a split-grace by close code; finally a pagehide HTTP
        beacon so it also works behind a WS proxy like Render - see Status log).
  - **Descoped per user decision (2026-07-23):** match-making.md's "kick
        idle spectators to global idle after a whole round untouched" -
        not wanted, spectating with no action taken isn't something that
        should get you removed. Only a real disconnect (see above) removes
        someone now.
  - [x] Switch Lobby (generalized beyond just full-room spectators per user
        request - see Status log).
  - [x] Queue for the next race (a third player status, `"queued"`) - the
        other half of match-making.md's "Full Room Spectators" pair of
        buttons, generalized the same way Switch Lobby was: opting in is no
        longer refused for *timing* reasons anywhere, it just reserves you a
        slot in the next race instead. See Status log.
  - [x] Remaining Anchor Host UX polish (join framing, timer bump banner;
        chat history through a merge needed no new work, already unbroken).
        A quote-update toast was tried and then deliberately dropped per
        user feedback - see Status log.
- [x] **Step 6: Mobile.** A compact layout for phones (client-only, no server
      or schema changes). The wide layout is deliberately untouched - see the
      Status log entry for the breakpoint and what it rearranges.

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
     **Superseded 2026-07-25 (see the last entry):** blocking the space key
     turned out to be a bug. Space is now an ordinary character and the commit
     is driven by `absorbCorrectWords()` off the resulting text instead; the
     `committed`/box invariant and the wire protocol are unchanged.
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
- 2026-07-25: Cosmetic polish (user request): taller progress bars + per-racer
  emoji avatars. `.racer-track` grew from 6px to 14px (leaderboard row gap
  bumped 10px->16px to breathe). Added `Player.emoji`, assigned a random one
  from a fixed `EMOJIS` pool on join and changeable via a new `"setEmoji"`
  message (server validates against the pool, so it can never hold arbitrary
  text). The avatar rides the leading edge of each racer's fill (a
  `.racer-emoji` absolutely positioned in a new `.racer-track-wrap`, sitting
  a touch taller than the bar and inset by its half-width so it stays on the
  track at 0%/100%); the always-present name row between tracks plus the row
  gap keep one avatar's slight vertical overhang clear of the neighbouring
  track's, so stacked bars never collide. Header gained an emoji button
  (left of the username, carrying the `margin-left:auto` that used to be on
  the username box) that opens an 8-col grid popover to pick from the same
  pool. Client persists the choice - including a first server-assigned random
  one captured from synced state - in localStorage and sends it back as a
  join option, so an avatar stays stable across reloads. Server typechecks
  clean; couldn't screenshot (a dev server was already holding :2567, and no
  browser automation in this environment), but the Colyseus process loaded
  the new schema/room without error before the expected EADDRINUSE.
- 2026-07-25: EXPERIMENTAL (user trying it out, may be reverted): "show other
  racers' live carets on your own text" - each other racer gets a thin caret
  at their position in the quote with their emoji as a lollipop above it, so
  you can see the pack move through the text. Deliberately built as a pure,
  fully self-contained CLIENT-ONLY view: it reads the already-synced
  `Player.progress` (caret index ≈ progress × quote.length), so there is NO
  new server/schema state and nothing to desync. Rendered into its own
  overlay layer (`#ghostLayer`, a sibling of `#quote` inside a new
  `#quoteWrap`) so it never touches the quote's per-keystroke render; the
  overlay is recomputed on state change + resize from the char spans'
  geometry. Toggleable via a `#ghostToggle` header button (persisted in
  localStorage, default ON so it gets tried); the wider line-height that makes
  room for the lollipops only applies while it's on (`#quote[data-ghosts=1]`),
  so turning it off restores the exact original layout. Everything is tagged
  "EXPERIMENTAL" in the source (CSS block, markup, refs, JS block) for a clean
  one-shot revert if it doesn't feel good in practice. Client syntax-checks
  clean; not yet play-tested by feel (the whole point of shipping it behind a
  toggle). Follow-ups from live feel-testing: (a) tightened the ghost
  line-height 2.4 -> 2.0 and shrank the lollipop 16 -> 15px (the gaps felt too
  large); (b) reorganized the header - added a settings gear (top-right, next
  to the emoji picker) opening a small popover that now holds BOTH the username
  field (replacing the old centered #usernameModal, which was deleted) and the
  "show racers on text" toggle (now a slider switch instead of the old header
  pill). Username saves on Enter / on panel close via `setName` (no Save
  button); the name still shows in the status line. Emoji picker left where it
  was, per user request. Later: put the username back as a read-only header
  label (between the emoji and the gear) since the user still wanted it
  visible; clicking it opens Settings focused on the name field.
- 2026-07-25: Faster leave on tab close (user: the roster row lingered a few
  seconds after closing a tab). Root cause is unchanged and unavoidable: a tab
  close and a page refresh are indistinguishable at close time, so the server
  must wait a reconnect grace before declaring a close final, or every refresh
  flickers the player out/in. Improvement: `onDrop` now branches on the raw
  WebSocket close code. A clean close (1001 "going away"/1000 - what a browser
  sends on both close AND refresh) gets a short UNLOAD_GRACE_SECONDS (1.5, user
  choice); an abnormal close (1006 / ping-timeout terminate = a genuine network
  blip, no clean frame) keeps the longer RECONNECTION_GRACE_SECONDS (3). So a
  real close disappears in ~1.5s while network blips keep full seat resilience.
  Not truly instant - a refresh is a clean close too, so UNLOAD_GRACE can't drop
  below what a refresh needs to reconnect without bringing back the join/leave
  churn. Verified via a temporary close-code log that a real browser tab close
  hits the clean-close (fast) path, then removed the log; an unexpected code
  falls back to the 3s path harmlessly regardless.
- 2026-07-25: Switch-Lobby duplicate spawn, robust server-side backstop. The
  client `switching` flag + redirect reentrancy guard reduced it (3x -> at most
  a rare 1 duplicate) but couldn't fully close the race. Added a hard guarantee
  in onJoin: one browser tab (its persistent clientId) can never appear twice in
  a room - on join, any OTHER session in the room with the same clientId is
  kicked (CloseCode.CONSENTED). Only runs when a real clientId was sent (the
  sessionId fallback is unique, so no false-match across different tabs), and
  the kicked session's "left the lobby" is suppressed (dedupKicking Set) since
  the tab isn't leaving, just shedding a stale duplicate. Verified with real
  Chrome: two sessions forced to share a clientId land in one room -> the older
  is kicked instantly, roster shows one. Reconnects (same sessionId) don't
  re-trigger onJoin so they're unaffected; distinct clients never match. Later
  made the dedup delete the duplicate from synced state SYNCHRONOUSLY (not just
  the async connection close) so no transient duplicate lingers during a
  Switch-Lobby spam. Accepted the incognito/abrupt-close leave delay as a Render
  proxy limitation (it holds+answers the dead connection until its own ~12s
  timeout; the faster ping-timeout config IS applied, it just can't beat the
  proxy). Only an app-level heartbeat could, deemed not worth it for an edge
  case - real users on normal tabs leave in ~1.5s.
- 2026-07-25: Removed the temporary diagnostics now everything's confirmed live:
  the [config]/[leave-route]/[beacon] server logs and the client console build
  marker. The beacon endpoint, dedup, faster ping-timeout and grace tuning stay.
- 2026-07-25: KEY INSIGHT (user): the slow ~14s "left" happened when closing an
  INCOGNITO tab; a normal tab left fast. Corrected diagnosis (verified by
  driving real Chrome, puppeteer): a graceful close (normal tab, browser process
  survives) fires BOTH the WS close frame AND the pagehide beacon -> fast (~1.5s).
  An abrupt teardown (closing an incognito window kills the process) fires
  NEITHER - no clean close, and the beacon can't flush before the process dies -
  so the ONLY way the server notices is its ping/pong health check. So the
  earlier "Render drops WS close frames" theory was only half-right: normal tabs
  were always fine; only abrupt closes were slow, and behind Render's proxy
  (which holds the dead upstream socket) they wait out the full ping-timeout.
  Real fix: cut Colyseus's ping-timeout from the default (pingInterval 3s x
  pingMaxRetries 2 ≈ 9-12s) to 1s x 2 ≈ 3-4s via a custom WebSocketTransport in
  app.config.ts, and RECONNECTION_GRACE 3s -> 2s. So an abrupt/incognito close
  now clears in ~5-6s instead of ~14s; a graceful close stays ~1.5s (beacon/WS
  close). Can't do better for abrupt closes - no client-side signal fires at
  all, as the test confirmed. Safe: a healthy browser auto-pongs at the protocol
  level, so a live client must go ~2-3s fully silent to be dropped. The beacon
  is kept as the fast path for graceful closes.
- 2026-07-25: The pagehide beacon still showed ~14s live. Two follow-ups: (1)
  the beacon reached the server but `client.leave(1001)` starts a WS closing
  handshake that HANGS when the proxy's upstream socket is a dead-but-held
  connection (no close-ack ever comes), so the ~9-12s ping-timeout won the race
  anyway. Switched handleLeaveBeacon to `client.ref.terminate()` (destroys the
  socket immediately, synchronously fires 'close' -> onDrop), with a
  `beaconLeaving` Set so onDrop still gives the terminate's abnormal-1006 close
  the SHORT unload grace. Added temporary `[beacon]` server logs to confirm on
  Render whether the beacon arrives/matches. (2) Switch-Lobby double/triple
  spawn: rapid clicks fire several `switchLobby` sends before the client's
  `room` is reassigned, so the server replies with several "redirect" messages
  and each ran its own joinById() = multiple sessions in the target lobby.
  Fixed with a reentrancy guard (`if (redirecting) return;`) in the client's
  redirect handler so only the first redirect per room is honored, PLUS a
  `switching` flag on the button that swallows rapid repeat clicks so the
  duplicate `switchLobby` sends never go out in the first place (cleared in
  attachRoom on landing; 8s safety timeout).
- 2026-07-25: Drove the real Chrome (puppeteer-core against the existing
  install, no browser download) to verify these end-to-end on localhost, since
  the earlier fixes were shipped un-play-tested: (a) a tab close fires the
  beacon, the server receives it and the reconnection TOKEN MATCHES
  (`[beacon] OK ... -> terminate`), and the player is removed at ~1523ms (the
  1.5s unload grace) - confirming both the token-format matching and that
  terminate() removes promptly (it's server-local, so it'll fire on Render too
  where the WS close frame never arrives; the localhost proxy-less case can't
  reproduce the ~14s itself); (b) two players in separate rooms, one
  rapid-clicking Switch Lobby x3, lands exactly ONE session in the target
  roster. The `[beacon]` server logs are kept for one live Render confirmation,
  then to be removed.
- 2026-07-25: The close-code split above worked on a direct connection but NOT
  live on Render (user: ~14s to leave). Root cause: Render sits behind a
  WebSocket proxy that doesn't forward the browser's WS close frame, so the
  server never sees the clean 1001 - it only notices via its ping-timeout
  (default pingInterval 3s x pingMaxRetries 2 ≈ 9-12s) and THEN adds the grace
  ≈ ~14s. Fix (user chose it): a pagehide HTTP beacon. On pagehide the client
  `navigator.sendBeacon()`s POST /leave?roomId&sessionId&token (plain HTTP,
  which the proxy forwards promptly); `RaceRoom.handleLeaveBeacon` authenticates
  via the per-session reconnection token (a secret not in synced state, so
  nobody can beacon another player out - matched as any ":"-delimited segment to
  be robust to the "roomId:token" client format) and calls `client.leave(1001)`,
  routing through onDrop's SHORT (1.5s) grace. Crucially this is NOT the old
  reverted consented-leave-on-pagehide: it uses a grace, so a refresh (which
  fires pagehide too) still reconnects within the window and never churns. A
  real network blip fires no pagehide, so it keeps the ping-timeout + longer
  grace fallback. No regression risk: if the beacon never arrives (blocked/hard
  crash), behavior is exactly the previous ping-timeout path.
- 2026-07-25: Replaced the "Race in progress" phase banner with a large live
  WPM readout (`#wpmDisplay`, your own server-computed `wpm`), shown only while
  you're actually racing. Toggleable in Settings (`#wpmToggle`, "Large WPM
  display"), default ON. Client-only view over the already-synced `Player.wpm`
  - no server change. The banner is now hidden during "racing" (other phases
  keep theirs); with the toggle off, racing simply shows no banner.
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
- 2026-07-25: Quote pool rewritten a third time per feedback: the tweet-meme
  tone itself was the problem, not just repetitiveness, the user explicitly
  wanted a mature/reflective/idea-driven voice instead, and asked whether any
  forum besides Reddit could supply that. Checked Hacker News and
  MetaFilter: MetaFilter's AskMeFi returned 403, but Hacker News is fully
  reachable, both its regular pages and, more reliably, its public Algolia
  search API (`hn.algolia.com/api/v1/search`) which returns comment text as
  structured JSON, no OCR needed, and sidesteps the rate limiting that direct
  `news.ycombinator.com` page fetches kept hitting under parallel requests
  (429s; sequential retries with a short pause didn't clear it, the API
  host wasn't affected at all). Ran ~10 topic searches (career mistakes,
  burnout, aging, startup failures, imposter syndrome, best decisions,
  counterintuitive lessons, reading/intellectual growth, parenting, salary
  negotiation, mentorship, moving abroad) and gathered real, substantive
  comment text across all of them. Rewrote all 200 quotes in that register:
  most adapted from real HN comments (usernames stripped, wording changed,
  nothing verbatim), the rest newly written to match the same reflective,
  experience-driven tone, explicitly avoiding meme/social-media humor this
  time. Verified: 200 entries, no duplicates, all in range, spread 62-203
  characters; `tsc --noEmit` and the running dev server both stayed clean.
- 2026-07-25: Quote pool extended (not replaced) with ~190 lighter quotes per
  feedback: the HN-sourced batch skewed heavily toward career/burnout/aging
  reflection, and a typing site needs room for people who just want to chill
  too. Added, in order: (1) ~156 quotes across funny/absurd work stories,
  wholesome kindness anecdotes, joyful travel/meal memories, shocking-but-fun
  trivia and coincidences, and funny kid quotes, sourced the same way as the
  previous entry (HN Algolia searches on lighter topics: funny bugs, TIL
  facts, stranger kindness, best trips/meals, kid quotes), plus originals
  matching that same warmer tone; (2) ~34 more spanning topics HN doesn't
  really have, per a follow-up question about other forums: personal
  finance/FIRE community themes (Bogleheads), UK parenting-forum themes
  (Mumsnet), gardening, and cooking. Direct fetches mostly failed here
  (403s from Bogleheads, early-retirement.org, Quora, Food52; empty
  listing-only pages from Chowhound and Straight Dope's board index; Mumsnet
  did partially work but most of what surfaced was too crude for the site),
  so this last batch leans on real themes and the handful of real lines
  (e.g. a nativity play story) that surfaced through general web search
  rather than a direct page fetch, same caveat as the very first Reddit
  attempt before HN's API was found. Pool is now 390 total, roughly a 200
  heavier / 190 lighter split. Verified: no duplicates, all 50-300 chars
  (62-203 actual spread), `tsc --noEmit` and the running dev server both
  stayed clean.
- 2026-07-25: Quote pool extended again (still not replaced) with ~120 more
  quotes from a different category of source entirely, per a follow-up
  request: news sites, educational/science sites, and idea-driven blogs,
  rather than forum posts. Checked a spread of sources: BBC, Smithsonian,
  Atlas Obscura, Big Think, and Aeon all blocked (403s, or 429 on Aeon), but
  NASA, MIT News, Quanta Magazine, The Conversation, History.com, and the
  Farnam Street blog were all reachable with real substance. Farnam Street's
  mental-models reference page in particular was unusually productive, a
  70-entry catalog of thinking tools (first principles, inversion, Occam's
  razor, feedback loops, emergence, and so on) that translated well into
  standalone one or two sentence explanations. Added five sections: (1) ~39
  mental models/thinking tools rewritten as explanatory quotes, (2) ~35
  science/space/math items from NASA, Quanta, and MIT News, (3) ~25 history
  facts inspired by History.com headlines (Berlin Wall, Carthage's war
  elephants, the Sea Peoples, Jell-O salad's brief prestige, standardized
  time zones, etc.), (4) ~10 literary/philosophical ideas (waiting versus
  living, aging into patience, Chesterton's fence, writing craft advice)
  restated generically without attribution, since the source site (The
  Marginalian) was quoting specific named authors' actual words rather than
  paraphrasing, so those specific quotes weren't reused, only the underlying
  idea, in original wording. Skipped two politically contentious Conversation
  headlines (an abortion-pill ad ban, FEMA funding legality) as out of scope
  for quote content. Pool is now 501 total. Verified: no duplicates, all
  50-300 chars (62-203 actual spread; one false-positive "13 chars" flagged
  by the length-checker script turned out to be a quoted phrase inside a
  comment, not an actual array entry, fixed by rewording the comment);
  `tsc --noEmit` and the running dev server both stayed clean.

- 2026-07-25: Typing-input fixes, both from user testing. (1) Bug: space was a
  dead key on a word you'd mistyped - the old `keydown` handler always called
  `preventDefault()` and only committed when the box exactly matched the
  expected word, so a typo left you unable to type a space at all. Space is now
  an ordinary character; the whole `keydown` handler is gone, replaced by
  `absorbCorrectWords()`, which runs from `sendProgress()` after every keystroke
  and moves any correct, space-terminated word at the front of the box into
  `committed`. That's the same word-lock rule as before (a word locks in when
  typed right and followed by a space), just applied to the resulting text
  instead of to the space keypress, so it also catches the case the old code
  couldn't: typing straight past a mistake and repairing it later still locks
  those words in, rather than leaving the rest of the race to pile up in the
  one-line input. Absorption defers while the caret is behind the word being
  locked, so an in-place repair isn't cut short by its own text vanishing.
  (2) New: a mistake can no longer be typed indefinitely past. `ERROR_TAIL_CAP`
  (15) limits how many characters may follow an uncorrected error (the mistyped
  character counts as the first); at the cap the input refuses insertions via a
  `beforeinput` handler - so a blocked keystroke never lands and the caret never
  jumps - and `#errorNotice` ("Fix errors to continue", red, right-aligned
  inside the box) appears, blinking three times before going static. Deletions
  of every kind pass through untouched and drop the count back under the cap,
  which is what clears the notice. `enforceErrorCap()` re-checks after each
  input event and trims anything that slipped past, covering input types whose
  payload `beforeinput` can't inspect (paste, drop, IME). All client-side only:
  the server still scores the raw input it's sent and is unaffected (it already
  clamps to `quote.length` and counts the matching prefix). The input is now
  wrapped in `#inputWrap`, which carries the show/hide so the notice follows it.
  Also flipped the "Show racers on text" (live ghost carets) default from on to
  off per user request; anyone who already set it keeps their choice.

- 2026-07-25: Followed up on the error-cap work above with the two dead ends it
  left at the END of the quote, both found in user testing. (1) Reaching the
  last character with a mistake still outstanding is a state with no visible
  exit: the race can't complete (the server scores a matching prefix, so an
  earlier typo means `correctChars < quoteLength` forever), there are no
  characters left to type, and `renderQuote` drew no caret there at all - the
  cursor simply vanished, which read as the page breaking. Two fixes: the
  render now emits one extra span past the last character purely as a caret
  slot (it holds a space, because the cursor is a `box-shadow` offset -2px
  behind the span's own box, so a zero-width element would paint nothing), and
  `trackEndStuck()` arms a timer when you first arrive at the end with an error
  outstanding, showing the existing #errorNotice after END_STUCK_NOTICE_MS
  (5s). The clock runs from arrival, deliberately not reset per keystroke, so
  hammering keys past the end can't hold the notice off - "went quiet" and
  "kept typing wrong" are the same dead end and get the same prompt. Hitting
  either cap still shows it immediately, so the timer only matters when you're
  under the caps. (2) Characters typed past the end of the quote rendered as
  nothing whatsoever (the loop stopped at `quote.length`), so overrunning was
  invisible. The loop now runs to `max(quote.length, input.length)` and draws
  the typed characters out there as `.bad` (red + underlined) - in-quote typos
  still show the QUOTE character reddened so the text stays readable, but past
  the end there is no quote character to show, so it shows what was actually
  typed. Overrun gets its own `OVERFLOW_CAP` (5), much tighter than
  ERROR_TAIL_CAP: whichever binds first stops the input, since a typo 2
  characters from the end would otherwise have allowed 13 characters of
  runaway overrun on the tail cap's budget. Note that overrun can only ever
  happen alongside an earlier mistake - type it all correctly and you'd have
  finished - so no server change was needed and no false finish is possible
  (`countMatchingChars` clamps to `quote.length` and counts the prefix).
  Verified by lifting the real functions out of index.html and driving them
  against a mock input + a fake clock: 41 scenarios covering both caps, the
  5s timer under both "idle" and "still typing", repair-and-complete, and the
  render output for mid-quote/at-end/overrun.

- 2026-07-25: Sound cues, per user request. Synthesized with WebAudio
  oscillators rather than audio files - four short blips don't justify assets,
  a fetch, or a loading state, and it keeps the client a single self-contained
  HTML file. Arrivals are a rising pair (C5->G5), departures the same pair
  falling, so direction alone tells them apart; the countdown is three flat low
  ticks (A4) at 3/2/1 and a higher, longer one (A5) on "go". Notes are shaped
  with a ramped gain envelope, since starting/stopping a bare oscillator cuts
  the waveform mid-cycle and clicks audibly. Wiring: join/leave hang off the
  existing announcement branches in `renderChat()` rather than off any new
  roster diffing, so they inherit every suppression rule already worked out
  there for free - silent for the roster absorbed on first connect, for
  pre-existing history before `chatGenesisAt`, and for your own arrival - and
  fire at most once per kind per patch, since a merge can land several
  arrivals at once. Countdown cues are edge-triggered in `render()` off the
  last second seen (render runs per state patch, not per second); "go" hangs
  off the phase change into "racing", because the server calls startRace() in
  the same tick it decrements to 0 and clients never observe `countdown === 0`.
  A null `lastPhase` (first patch after connecting) is excluded so landing in a
  race already underway doesn't sound like a start. Countdown cues are gated on
  `iAmRacing`: "go" means "start typing", which is meaningless to a spectator.
  Two things the autoplay policy forces: the AudioContext is created lazily on
  the first gesture (not at load) and resumed from a document-level
  pointerdown/keydown, and blip() DROPS notes whenever the context isn't
  running rather than scheduling them - a suspended context's clock is frozen,
  so anything scheduled against it stacks at one timestamp and would fire all
  at once on resume (a page left untouched while people came and went would
  greet its first click with every missed blip simultaneously; a backgrounded
  tab suspends the same way). Added a "Sound cues" Settings toggle alongside
  the existing two, on by default, persisted per browser; enabling it previews
  the arrival cue, awaiting the resume first so the very first cue a user ever
  hears isn't the one that gets dropped. Verified end-to-end with three real
  browser sessions against the dev server, AudioContext stubbed to record
  scheduled notes: own-arrival silence, join/leave in both directions, the
  full 3-2-1-go sequence for both racers, and no countdown cues for the
  spectator.

- 2026-07-25: Sharpened the sound cues per user feedback ("more crisp and
  clear"). Two changes, both to `blip()`. (1) Envelope: the attack went from
  15ms to 3ms, which is the whole difference between a note that fades in and
  one that reads as struck - 3ms is still long enough to avoid the click of
  cutting a waveform mid-cycle. (2) Timbre: each note is now a fundamental
  plus an octave and a fifth above it (PARTIALS, levels 1 / 0.4 / 0.14) rather
  than a lone sine. A bare sine carries very little information about its own
  pitch on a laptop speaker - it reads as a dull thud - and the overtones are
  what make it land as a defined, bell-like note. Partial levels are
  normalized against their own sum, so `peak` stays the true output amplitude
  regardless of what's in the table. Notes were also retimed: the join/leave
  pair is spaced 85ms (just under the first note's length) so the second lands
  while the first is still ringing and the pair reads as one gesture, ticks
  are short and dry at 95ms, and "go" got a 300ms tail so it rings past the
  ticks. Verified by rendering the page's own cue functions through an
  OfflineAudioContext and measuring the waveform: attack 3.2-4.1ms, decay to
  10% of peak in 32-90ms, overtones present at the intended 0.39-0.40 and
  0.13-0.14 ratios, true peak 0.145-0.21 (no clipping). Note that blip()'s
  "context must be running" guard also (correctly) refuses to schedule into an
  OfflineAudioContext, which reports "suspended" until rendering starts - the
  harness shadows `state` to get around it.

- 2026-07-25: Reworked the cue voice again per user feedback (didn't like the
  instrument; asked for something piano-like). Still pure WebAudio synthesis -
  no samples - but `blip()` is now a struck-string model rather than a fixed
  chord of overtones. Three things make the difference, and the previous
  version had none of them: (1) every partial gets its OWN envelope and higher
  partials decay FASTER (decay = dur / n^0.55, so the 7th dies ~3x sooner than
  the fundamental). This is the big one: a real string sheds its high harmonics
  first, so the note is bright at the strike and mellows into a warm tail,
  whereas partials sharing one envelope hold their brightness for the whole
  note, which is precisely what an organ does - and was why the old cues read
  as synthetic. (2) The partials sit slightly SHARP of exact multiples
  (f(n) = n*f*sqrt(1 + B*n^2), B = 0.0006), because real strings are stiff
  enough to stretch their own modes; the deviation is small (7th partial ~25
  cents) but its absence is a large part of "sounds like a computer".
  (3) A 2ms attack - a hammer strike has no perceptible rise time. Partial
  count is 7, levels 1/n^1.35 normalized against their own sum so `peak` stays
  the true output amplitude. Cue timings were stretched to suit: struck notes
  need room to ring or they read as clicks, so decay times are long relative to
  how short the cues actually sound (join/leave 520/620ms spaced 130ms apart,
  ticks damped to 380ms so consecutive seconds don't blur, "go" left to ring at
  1100ms). Verified by rendering the page's own cue functions through an
  OfflineAudioContext: 2ms attack; high-partial energy relative to the
  fundamental falls 0.34 -> 0.08 -> 0.006 across the first 200ms (the decaying
  brightness that IS the piano character - a flat ratio here would mean an
  organ); peaks 0.14-0.24, no clipping. The 9-assertion end-to-end cue test
  still passes (the fundamental's stretch is under half a cent, so the
  recorded frequencies are unchanged).

- 2026-07-25: Voiced the cues warmer, again from listening feedback: the notes
  themselves were right but the tone "stung" and read as a cheap, out-of-tune
  piano. Three causes, all addressed in `blip()`. (1) Too much energy in the
  upper partials: the 1/n^1.35 rolloff left partials 5-7 loud enough to pierce,
  because 2-5kHz is where hearing is most sensitive - amplitudes that look
  modest on paper are the harshest thing in the mix. Rolloff steepened to
  1/n^1.9 and the stack cut from 7 partials to 6. (2) Too much inharmonic
  stretch: B was 0.0006, putting the 7th partial 25 cents (a quarter semitone)
  sharp. That is realistic for a real string, but a real piano hides it behind
  a dense spectrum and multiple strings per note; six bare sines do not, so it
  just sounded mistuned. B lowered to 0.0002, which is ~8 cents at the 7th -
  enough to avoid sounding synthetic, not enough to sound wrong. (3) The 2ms
  attack stacked all the in-phase partials into a spike at onset; 5ms still
  reads as struck without the click. Also added a gentle lowpass (Butterworth,
  Q 0.7) tracking the pitch at 4.5x the fundamental, clamped to 1.5-5kHz: real
  instruments and every microphone that recorded one roll off up there, and
  its absence is much of why raw oscillator stacks sound cheap. Measured
  through an OfflineAudioContext: high-partial energy relative to the
  fundamental at the strike fell 0.337 -> 0.124, and the spectral centroid (the
  standard proxy for perceived sharpness) now starts at 721Hz for a 440Hz note
  and falls to 461Hz over the note, i.e. energy sits near the fundamental
  instead of up in the piercing range. Peaks 0.155-0.252, no clipping.
  Note for future edits: the sound harness stubs AudioContext, so a new node
  type used in blip() must be added to the stub or every cue silently fails -
  adding the biquad broke all 9 assertions until the stub learned
  createBiquadFilter.

- 2026-07-25: Abandoned the musical cues entirely per user feedback - however
  well voiced, a pitched note fired every 20-30 seconds became maddening. The
  diagnosis is that pitch is the problem, not timbre: a note carries musical
  intent, so it demands attention every single time and never fades into the
  background, whereas a pitchless broadband click gets filed as incidental and
  stops being attended to. So `blip()` (a stack of tuned oscillators) is gone,
  replaced by `clack()`: a mechanical-keyboard style click, made from a very
  short burst of white noise through a bandpass. A cached noise AudioBuffer is
  shared by every click (AudioBuffers are bound to a sample rate, not a
  context, so one serves the whole page), and each click starts at a RANDOM
  offset into it so repeats are never bit-identical - an exactly repeating
  sample is itself a thing that grates. Bandpass Q is a deliberately broad 1.1;
  higher would ring and start sounding pitched again, which is the whole thing
  being avoided. The low->high / high->low direction of the join/leave pairs is
  preserved, carried by the bandpass CENTRE (dull 760Hz vs bright 1750Hz)
  instead of by pitch, so the cues still mean opposite things without forming a
  melody. Centres stay low by design - the earlier round established that
  sustained energy in 2-5kHz stings. One measurement worth recording: a
  bandpass passes only a slice of the noise's energy, so output is 3-4x quieter
  than the envelope's nominal peak. The first attempt used the old peak values
  directly and measured 0.014-0.033 at the output, around 20dB below the notes
  it replaced and close to inaudible; the values in the cue functions are now
  set from measured output, not guessed. Final: true peaks 0.057 (tick) to
  0.109 ("go"), i.e. ~8-12dB below the old notes, audible 18-22ms per click
  (84-88ms for a pair, which is two clicks 70ms apart). "Loudest band share"
  of 0.10-0.15 confirms the result is genuinely broadband rather than a
  disguised tone - a pure tone would sit near 1.0. The 9-assertion end-to-end
  cue test passes unchanged apart from expecting bandpass centres in place of
  note frequencies.

- 2026-07-25: Cue tuning from listening feedback. The countdown clacks landed
  well and are unchanged. Two changes to arrivals/departures. (1) Dropped the
  departure cue entirely, per user request: someone leaving isn't news you need
  to act on, and clicking at the room for every coming AND going is twice the
  interruption for no added value. Departures are still announced in chat, just
  silently - `cueLeft` is gone along with its `heardLeave` tracking in
  renderChat(). (2) The join cue was reported as inaudible, and measurement
  agreed: it was peaking at 0.067 against the "go" click's 0.109, i.e. ~4dB
  quieter than the one cue the user could reliably hear. Roughly doubled it
  (peaks 0.25/0.22 -> 0.40/0.36) and lifted the centres slightly (760/1750 ->
  900/1800), which now measures 0.14 - level with "go". Note the measurement
  has ~10% run-to-run variance, since each click starts at a random offset into
  the noise buffer, so anything inside a decibel of a target is a match rather
  than a miss. With the falling pair gone the rising pair no longer needs to
  contrast with anything, but it stays a PAIR on purpose: the countdown is only
  ever single clicks, so the two-click rhythm is what tells arrivals apart from
  ticks, and neither has to be loud to be distinguishable. The end-to-end test
  now asserts the inverse for departures - it confirms bob's "left the lobby"
  actually reached the chat and THEN that no cue fired, so a silent departure
  can't be confused with an event that simply went missing.

- 2026-07-25: Fixed "the first cue after a quiet spell is silent, the next one
  works", reported by the user for joins. Reproduced it first, with a test that
  suspends a REAL AudioContext and counts nodes actually scheduled: the first
  cue after the sleep scheduled 0, the next scheduled 2. The cause was our own
  code, not the platform. clack() refuses to schedule into a non-running
  context (rightly - a suspended context's clock is frozen, so queued sounds
  stack at one timestamp and fire together on resume), and the cue functions
  called resumeAudio() alongside, which resolves ASYNCHRONOUSLY - so the cue
  was already discarded by the time the context woke, and only the NEXT one
  found it running. Fix: `withAudio(play)` now wraps every cue and defers the
  scheduling until after the resume resolves, rather than dropping it. At most
  one cue may wait on a given resume, which preserves the anti-pile-up
  property the original guard existed for.
  ANSWERING THE USER'S QUESTION: yes, the countdown had exactly the same bug -
  same code path, and the test confirms cueTick and cueGo each scheduled 0 when
  fired first after a sleep. Since a countdown follows the quiet "waiting"
  phase, its "3" was the tick most likely to be swallowed; hearing 2-1-go still
  reads as correct, which is why it went unnoticed.
  Also addressed the user's own hypothesis (the audio device having to wake),
  which is a real and separate effect: many systems power the output down after
  silence and clip the start of whatever wakes it, and for a ~20ms click "the
  start" is the entire sound. Every click now gets a WAKE_LEAD (120ms) silent
  run-up - the noise source starts immediately with the envelope pinned at the
  floor, and the audible part is scheduled after it - so the device is already
  awake when the click lands. Measured: onset lands at 121ms, run-up sits at
  -88 to -91 dBFS (inaudible). This half is reasoned rather than verified,
  since headless Chrome has no real audio hardware to sleep.
  Two bugs found while measuring the change, both pre-existing in spirit:
  (1) a GainNode defaults to 1.0 and that default governs all samples before
  its first scheduled event, so the second click of a pair (whose envelope
  starts later than the context clock) leaked one FULL-VOLUME sample - a sharp
  tick at -44 dBFS, 50ms ahead of the intended sound. Setting `env.gain.value`
  explicitly closes the window. (2) With playback now spanning the lead-in as
  well as the click, a random start offset into a 0.25s noise buffer could run
  past its end and truncate the click; the buffer is now 0.5s and the source
  loops, so it can never run dry.

- 2026-07-25: Root-caused "I never hear the join sound", and it was not a bug in
  the cue at all. The user's own report pinned it: sound started working the
  moment they clicked "Switch Lobby" in the LISTENING tab. That click was the
  unlock. Browsers refuse to play audio until the user has interacted with that
  specific tab, and it cannot be worked around - user activation requires a
  TRUSTED event, so a synthesized click (isTrusted false) grants nothing, and
  the usual folklore workarounds (priming with silent audio, creating the
  context in a load handler) fail for the same reason. Verified the cue itself
  was fine by tapping ctx.destination with an AnalyserNode on a real page and
  measuring actual output during a real join: peak 0.193, LOUDER than the
  countdown's 0.119. Nothing wrong with the sound; it was never allowed to play.
  This bites this app specifically because "open the lobby and wait for someone
  to turn up" is a normal way to use it and involves clicking nothing - so the
  arrival cue is exactly the one the policy eats, while the countdown cues
  always survive (you have just clicked Join). So instead of failing silently:
  a "🔇 Enable sound" pill in the header, shown only while sound is enabled AND
  the context isn't running, one click to clear, with the arrival cue played
  back as confirmation. Any click anywhere already unblocks it, so for most
  users it will vanish before it is ever read.
  Two robustness fixes found on the way. (1) The `audioWakePending` latch added
  in the previous entry could stick permanently: a browser still waiting for a
  gesture can leave resume()'s promise pending forever, after which the latch
  suppressed EVERY later cue for the life of the page. Replaced with a single
  newest-pending-cue slot plus a freshness bound (AUDIO_WAKE_GRACE_MS, 1.5s),
  which de-duplicates just as well and cannot wedge. Regression test included.
  (2) The pending cue is now flushed from the context's own `statechange`
  event rather than from whichever code path called resume(), so a wake we
  didn't initiate still delivers it - and the prompt re-appears by itself if
  the context is ever suspended again.
  The stub-AudioContext trap noted two entries ago bit again, exactly as
  predicted: adding the statechange listener made getAudioCtx() throw in the
  harness (no addEventListener on the fake), which silently failed all 10
  assertions. If the audio code touches a new Web Audio API, teach the stub.

- 2026-07-25: Replaced the header "Enable sound" pill with a chat-log line, per
  user feedback: the pill looked out of place, and clicking it made a whole
  element vanish with no trace, which read as "did that even do anything?"
  The new version is a LOCAL-ONLY line in the chat panel (never sent to or
  seen by anyone else) that behaves like every other system line ("X joined
  the lobby"): "🔇 Sound is blocked — click anywhere to enable." appears while
  playSounds is on but the AudioContext isn't running, and the SAME line
  transforms in place into "🔊 Sound enabled." plus an inline ⚙️ that opens
  Settings, rather than a second line being appended or the first one
  disappearing. Nothing vanishes; it just becomes part of the log, which is
  what fixed the "did that work?" confusion - the user can SEE it changed.
  Mechanically: `soundStatusEntry` holds the one object (if any) currently
  sitting in myVisibleChat for this; refreshSoundStatusMessage() pushes it,
  mutates it, or removes it, and `renderChatDom()` (the DOM-building tail of
  renderChat(), pulled out into its own function so this can force a repaint
  outside of a server broadcast) repaints immediately - no waiting for the
  next state patch.
  Per the user's explicit request, "off once -> quiet on future visits" is
  implemented as reading the CURRENT playSounds setting live, not a permanent
  one-way flag: turning sound off retracts the line immediately (nothing to
  prompt about if cues are off anyway), and turning it back on later brings
  the notice back if audio is still genuinely blocked. I flagged this
  interpretation choice rather than silently picking one, since "turned off
  once" could also have read as a permanent flag - the live-setting reading
  matches how playSounds already worked everywhere else in the code, so it's
  what shipped. Verified as a distinct behavior: a second tab that inherits
  sound=off from localStorage never shows the line even though ITS OWN audio
  is genuinely blocked too; flipping playSounds back to true while still
  blocked brings the line back.
  Placement note for future edits: myVisibleChat/chatMessages/renderChatDom
  are declared much later in the script than the audio block, so the initial
  refreshSoundStatusMessage() call had to move to right after
  applySoundToggleUi() (near the end of the script) rather than living next to
  getAudioCtx() where it's conceptually closer - calling it early throws (TDZ
  on `let myVisibleChat`). The statechange listener, resumeAudio, and
  withAudio all still call it directly since those only ever fire later
  (post-load, async), so they're unaffected by the ordering constraint.
  One more bug worth recording: `soundToggle.onclick` originally called
  refreshSoundStatusMessage() BEFORE ensuring the AudioContext exists. A
  context created directly inside a trusted click (as this one is) typically
  starts "running" immediately rather than transitioning up from "suspended",
  which means no statechange event ever fires to self-correct a wrongly-shown
  "blocked" line - it would have stuck on "blocked" forever despite sound
  actually working. Fixed by calling getAudioCtx()+cueJoined() first, THEN
  refreshSoundStatusMessage(), so the check sees the context in the state it
  will actually settle into.
  Verified end-to-end (9 assertions): the line appears alone while blocked;
  clicking it collapses to exactly one row (transformed, not duplicated); the
  gear opens Settings; toggling sound off removes the line; a fresh tab that
  inherited sound=off never shows it even though its own audio is blocked;
  re-enabling while still blocked brings it back.

- 2026-07-25: Three follow-ups from user feedback. (1) Removed the em dash from
  the sound-blocked chat line ("Sound is blocked, click anywhere to enable.").
  (2) Cues were reported as inaudible over background music at normal volume -
  measured true output was only 0.05-0.16 peak, genuinely quiet in absolute
  terms. Raised every cue's base `peak` argument by roughly 2x (tick 0.19->0.42,
  go 0.32->0.68, join pair 0.40/0.36->0.85/0.78); re-measured true output now
  0.15-0.27, no clipping (still well under 1.0, and clack()'s single-source-
  per-note design means no risk of multiple simultaneous partials summing the
  way the earlier piano voice could). (3) Added a volume slider: `masterGain`,
  a single GainNode created alongside audioCtx and sitting between every
  clack() and ctx.destination, so scaling is one gain change rather than
  rescaling each cue's envelope individually. `soundVolume` (0-100, default
  100 - the boosted levels above ARE the 100% point) persists to
  typingRace.soundVolume and applies live while dragging, with a tick preview
  on release (not on every `input` tick, which fires continuously mid-drag and
  would otherwise retrigger a click many times a second). New Settings row
  under Sound cues; dims and functionally disables (not just visually) while
  Sound cues itself is off, since a volume that currently controls nothing
  would be a confusing thing to let someone fiddle with.
  Test-infrastructure note for future audio changes: the offline measurement
  harness (tone.js) manually swaps `audioCtx` for an OfflineAudioContext,
  bypassing getAudioCtx() entirely - which means masterGain (only ever built
  INSIDE getAudioCtx()) was never created for it, so clack()'s new
  `.connect(masterGain)` would have connected to null. Fixed by having the
  harness build its own masterGain the same way getAudioCtx() does. Also hit,
  while trying to verify "50% is half of 100%": pinning Math.random() for a
  controlled comparison also zeroed getNoiseBuffer()'s sample-fill loop on any
  sample rate that hadn't been cached yet, turning the "noise" itself to
  silence - not an app bug, a test-harness footgun. Settled on reading
  `masterGain.gain.value` directly for the proportionality claim (deterministic,
  no rendering needed) and reserving an actual offline render for the one
  thing worth rendering: confirming 0% produces genuine digital silence in the
  output, not just a zeroed param.
  All suites re-verified after the peak/volume changes: wake (5), wedge (5,
  updated to check the chat line instead of the removed header pill), 10
  end-to-end multi-tab, 9 chat-status-message, and 8 new volume-control
  assertions - 37 total, all passing.

- 2026-07-25: "Max sound still not high enough" - pushed the cue levels
  significantly further, which required a real safety net first. Simply
  raising the `peak` arguments again turned out to be dangerous: clack()'s
  output is filtered white noise, so its peak SAMPLE is a random draw, not a
  fixed number - measuring the SAME settings repeatedly showed nearly 2x
  swing run to run (e.g. "go" ranged 0.50-0.85 across five otherwise-identical
  renders). A level that measured safely under 1.0 on one take clipped (1.02,
  1.05) on the next. Picking a number "by eye" from one measurement was
  therefore not a real safety margin, just a probability.
  First attempt: a DynamicsCompressorNode (threshold -3dB, ratio 20, attack
  1ms) after masterGain. Rejected after measurement - even a 1ms attack is
  still a ramp with real duration, and these clicks are only ~15-90ms long,
  so enough of the click can pass before the compressor is fully engaged to
  still clip.
  What actually shipped: a WaveShaperNode hard ceiling (getLimiterNode,
  LIMITER_CEILING = 0.85), applied after masterGain, before destination. A
  WaveShaper is a fixed per-SAMPLE function with no envelope/timing at all, so
  the ceiling is a mathematical guarantee rather than something that depends
  on how fast a follower reacts - every sample is independently clamped,
  including the very first one of a transient. Curve is `clamp(x, -0.85,
  0.85)` sampled into a 4097-point array; WaveShaperNode clamps any input
  outside its native domain [-1, 1] to the curve's own edge value rather than
  extrapolating, which is exactly what turns a plain clamp() into a TRUE
  ceiling regardless of how hard the input is driven. oversample: "4x" is
  necessary too - the clamp's sharp corner is a discontinuity that aliases
  into audible harshness without it.
  With the ceiling now unconditional, raised the peak args hard: tick 0.42->
  1.9, go 0.68->2.6, join pair 0.85/0.78->3.2/3.0. Stress-tested 120 renders
  (40 of each cue) rather than a handful, specifically because of the
  run-to-run variance discovered above - worst peak observed across all 120
  was 0.89, comfortably under 1.0 even accounting for the oversample-induced
  corner ripple that pushes slightly past the nominal 0.85 ceiling. True
  peaks now average ~0.49 (tick), ~0.85 (go), ~0.86 (join) - roughly 3-6x
  louder than the previous round depending on the cue, and 8-17x the
  ORIGINAL (pre-any-boost) levels.
  Test-infrastructure notes: (1) tone.js's and volcheck.js's offline-render
  harnesses build their own masterGain (bypassing getAudioCtx()) and now call
  the app's own getLimiterNode() directly rather than reimplementing the
  limiter, since it's a plain function declaration already in scope - so
  future tuning of the limiter only has to happen in one place. (2) sound.js's
  stubbed AudioContext needed createWaveShaper() added (returning a
  curve/oversample/connect stub) - getAudioCtx() now calls it on every context
  it builds, and the stub didn't have it, which would have failed silently
  the same way the createBiquadFilter gap did two entries ago. Recorded again
  because it's the third time this exact class of bug has bitten: any new Web
  Audio node type used in the real code needs a matching stub method, or the
  end-to-end suite either throws or silently stops recording cues.
  Full regression re-run after this change: sound.js (10), wake.js (5),
  wedge.js (5), statusmsg.js (9), volcheck.js (8) all still pass - none of
  them assert on absolute cue loudness, so the boost didn't need any of them
  to change, only the two offline-measurement harnesses' internal wiring.

- 2026-07-25: Fixed the "beginning of the sound is cut off after a quiet spell"
  report - the user described losing the whole "3" of the 3-2-1-go countdown
  (hearing only 2-1-go) and hearing only the second half of the join pair, and
  correctly guessed the cause: the output DEVICE powering down after silence
  and clipping whatever wakes it. For a ~20ms click, "the beginning" is the
  entire sound, which is why a cue could vanish outright rather than merely
  sound clipped.
  WAKE_LEAD (120ms of scheduled silence ahead of each click, added earlier
  specifically for this) turned out to be nowhere near enough: losing an entire
  tick means the device gap is closer to a second, and no lead-in long enough
  to cover that could also stay in sync with the countdown on screen (a
  half-second-late tick would land while the number already read "2").
  So rather than racing the wake, the sleep is now prevented: `updateKeepAlive`
  runs a permanently-looping, inaudible BufferSource straight into destination
  (bypassing masterGain and the limiter deliberately - whether the hardware
  stays awake shouldn't depend on where the user left the volume slider), so
  the output stream never goes idle and there is nothing to wake up. The level
  is the crux: KEEP_ALIVE_LEVEL = 0.0001 (-80dBFS) is non-zero because both
  the OS and the browser detect SILENCE rather than absence-of-stream, so
  literal zeros would be optimised away and the device would sleep regardless -
  but it is far below the noise floor of any real playback chain. Runs only
  while `playSounds && state === "running"`: a suspended context can't feed the
  device anyway, and holding the hardware awake for cues that are switched off
  would be pure waste. WAKE_LEAD is kept as a second layer for the window right
  after unlock, before the keep-alive has been running long.
  Note this is the one part that cannot be verified here - headless Chrome has
  no real audio hardware to fall asleep - so it is confirmed only structurally
  (9 assertions: runs when it should, stops when cues are off or the context
  suspends, restarts after resume, idempotent under repeated calls, and
  renders non-silent-but-below--70dBFS). Whether it actually cures the symptom
  needs the user's ears.
  Also moved `noiseBuffer`/`getNoiseBuffer` above getAudioCtx(). The keep-alive
  reaches for the noise buffer, and getAudioCtx() is called during the load
  sequence, so leaving the `let` declaration below its consumer left a real
  temporal-dead-zone hazard that only stayed latent because the context
  happens to come up suspended in the common case.
  Test-infrastructure notes, all from the keep-alive being a BufferSource like
  the cues are: (1) sound.js's stub threw on `src.start()` with no arguments
  (t.toFixed of undefined) - this is the FOURTH time a new Web Audio call has
  broken that stub, and as before the failure mode was silent (all cues stop
  recording). (2) The keep-alive would also have been counted AS a cue by
  sound.js, wake.js and wedge.js. Fixed everywhere by the same distinction the
  real code already implies: cue clicks are always started with an explicit
  time, the keep-alive is started with none, so `typeof args[0] === "number"`
  separates them. (3) statusmsg.js was counting every chat row, so leftover
  players from the multi-tab suite posting real "joined the lobby" lines made
  it pass or fail depending on run order - now filtered to the sound-status
  rows only. Full battery re-run: sound (10), wake (5), wedge (5), statusmsg
  (9), volcheck (8), keepalive (9), plus the 120-render clipping stress test
  (worst peak 0.889, still no clipping).
- 2026-07-26: Status-slot UI polish. (1) The pre-race countdown is no longer a
  pill banner: it now uses the same big-number treatment as the WPM readout
  (`#countdownDisplay`), with "Race starts in" as the small uppercase caption
  ABOVE a 44px amber number. It always shows during `countdown`, independent of
  the Large-WPM setting - so `#statusSlot` now reserves the tall height
  unconditionally and the `data-reserve` toggle is gone (the banner, countdown
  and WPM readouts all live in a fixed 64px slot, so no phase swap shifts the
  text below). (2) "Waiting for challengers" -> "Waiting for racers" followed
  by three dots pulsing in sequence, so an idle lobby reads as live rather than
  stuck. The banner is plain textContent everywhere except that one state; the
  waiting markup is only rebuilt when the dots aren't already present, since
  render() runs on every state patch and re-creating the nodes would restart
  the animation mid-cycle.
- 2026-07-26: Merged the countdown and WPM readouts into one element
  (`#bigReadout`), replacing `#countdownDisplay` + `#wpmDisplay`. They were two
  separate blocks with the caption on opposite sides of the number, so the
  digits jumped upward the moment countdown handed over to racing. Now there is
  a single number row with a caption row above AND below it; both caption rows
  are always laid out (fixed 13px height, toggled via `data-on` opacity, never
  `display:none`), so the number occupies the same y in every state. The
  handover is now just: "Race starts in" fades out, "WPM" fades in, and the
  number recolors amber -> green (.18s each, `data-mode` drives the color).
  Slot height is therefore fixed at 74px (13 + 2 + 44 + 2 + 13). The readout
  still hides entirely when neither applies (spectating, or racing with the
  Large-WPM setting off).
- 2026-07-26: Added a third player status, `"queued"`, so opting into a race is
  never refused for timing reasons. Previously `setStatus({racing:true})` was
  silently ignored during `"racing"`/`"finished"`, which meant the entire span
  of a race plus its results screen was dead time for the join button - you had
  to sit there and remember to click the instant it reopened. Now the button
  offers **"Queue for Next Race"** in exactly those windows (plus the
  countdown's last `LOCK_AT_COUNTDOWN_SECONDS`, see below); clicking reserves a
  racer slot immediately, sits out the current race entirely, and turns the
  button into **"Leave Queue"**. `RaceRoom.promoteQueuedRacers()` moves the
  whole queue into `"racing"` from `resetToWaiting()` - the single point where
  the room starts setting a fresh race up, and therefore the moment "the next
  race" becomes "this race". `resetToWaiting()` now ends by calling
  `onRosterChanged()` itself (which is what starts that race's countdown), so
  its callers no longer do; the one recursive-looking path is safe because
  `onRosterChanged` only reaches it while the phase is `"racing"` and the phase
  is no longer `"racing"` by the time the nested call reads it.
  - The awkward part, and the thing to be careful around when editing
    RaceRoom: there are now **two** counts, and they answer different
    questions. `countRacers()` (racing only) drives the RACE LIFECYCLE -
    start/cancel a countdown, is a live race still populated, is everyone
    finished - so a queued player can never start or sustain a race they
    aren't in. `countTakenSlots()` (racing + queued) drives CAPACITY - the
    `MAX_RACERS` cap, merge-target free slots, `state.racerCount` and the
    matchmaking metadata behind fullest-first placement - so a reserved slot is
    never handed to someone else. `state.racerCount` therefore changed meaning
    from "racers" to "slots taken"; the client's room indicator reads
    "3/5 racers" accordingly.
  - `LOCK_AT_COUNTDOWN_SECONDS` (3) now also governs the in-room opt-in, via
    the new `acceptsNewRacers()` that both `setStatus` and `onJoin` read. That
    reverses the 2026-07-2x decision to exempt people already in the room from
    the cutoff (the reasoning then: they'd been watching the countdown, so they
    couldn't be surprised by it, and refusing them would have been pure loss).
    Queueing removes that trade-off - missing the cutoff now costs you nothing
    but a race's wait - so all four "can this room take another racer"
    decisions finally read the same threshold and can't disagree.
  - It also closes two silent slot-loss edges on redirects: `resumeRacing` is
    now sent for queued players as well as racing ones (both mean "put me in a
    race over there"), and an arrival that finds the target mid-race lands
    `"queued"` rather than being demoted to spectating. The redirect's decision
    is still re-checked at arrival - only a genuinely full room costs the slot.
  - Client: the button's four states are Spectate / Leave Queue / Race Full /
    Join Race-or-Queue for Next Race, driven by `iHoldSlot` (racing OR queued,
    which is also what `data-racing` now tracks) plus a mirrored copy of
    `acceptsNewRacers`'s condition. Phase no longer disables the button at all;
    a full room is the only dead click left. The plain-join label dropped
    "Next" and is just **"Join Race"** now, since "next" is what the queue
    means. Queued players appear in the roster exactly like anyone else (no
    tag) and never appear in the leaderboard, which is strictly the CURRENT
    race's field - they have no progress or wpm in it, and a 0% row would read
    as a racer who hasn't started. A player AFK'd out of this race keeps their
    held-in-place row and its "AFK" tag even after queueing for the next one:
    the tag describes what happened in this race, and queueing doesn't undo
    it. (`afk` is cleared for everyone in `resetToWaiting()`, so no row can
    carry into a race its player wasn't in.)
  - Verified by driving a real `RaceRoom` through two full race cycles with
    stubbed Colyseus plumbing (25 assertions: late-countdown queueing, the
    queue sitting out a race, promotion on both the normal results path and a
    mid-race abort, the cap counting queued players, and leaving the queue).
- 2026-07-26: Added a search box to the emoji picker, between the tabs and the
  first group. **Answering the question it started with: emoji carry no labels
  of their own, and no browser API exposes their Unicode names** - not
  `Intl.DisplayNames`, not anything else - so there was nothing to search
  against and a name table had to ship with the app. It is GENERATED rather than
  hand-written, which matters for trust: the labels are the same ones every OS
  emoji keyboard searches, not somebody's guesses about what 🫠 should be called.
  - Source: CLDR `common/annotations/en.xml` (+ `annotationsDerived/en.xml`),
    taking `type="tts"` as the name and the plain annotation as keywords, with
    Unicode's `emoji-test.txt` names as a fallback. Emitted for exactly the
    emoji present in `EMOJI_GROUPS`, and it covered all of them - 1161/1161, no
    gaps to hand-fill. Keywords whose every word already appears in the name are
    dropped (they can't affect a substring match), which is what keeps the table
    to ~52KB; index.html went 153KB -> 211KB raw, 51KB -> 76KB gzipped.
  - Stored as `EMOJI_SEARCH_DATA`, one line per emoji: `<emoji> <name>|<keywords>`.
    Self-contained lines were a deliberate choice over a parallel array of names,
    which could silently drift out of alignment with the palette. Parsed once
    into `emojiInfo` (emoji -> {name, text}); `name` also became the cell's
    tooltip, replacing a tooltip that just repeated the emoji you were looking at.
  - Kept inline rather than lazily fetching a separate `emoji-names.txt`: the
    alternative would keep index.html lean and cache the table separately
    (index.html is `no-cache`, so it revalidates every load), but it adds an
    async load state and an offline failure mode to a picker that currently has
    neither, and CLAUDE.md's single-file client convention argues the same way.
    Worth revisiting if the client ever grows a real asset pipeline.
  - Matching is substring, per the request ("where the keyword appears in the
    name"), with all space-separated terms required, so "smiling cat" narrows.
    Substring alone ranks badly though - it makes "love" match g-**love** and
    "fast" match break-**fast** - so results are scored: exact name, whole word
    in name, whole word in keywords, starts a word in name, starts a keyword,
    then mid-word-only last. Ties break on where the term appears in the name,
    then name length, then palette order (`sort` is stable). The
    keywords-before-prefixes ordering is load-bearing: plenty of emoji are known
    by a word absent from their official name, so 🚗 is "automobile" with "car"
    as a keyword, and "car" has to reach it ahead of 🥕 carrot, 📇 card index and
    🪚 carpentry saw. Nothing is filtered out by ranking, only pushed down.
  - UI: search mode hides the themed groups via CSS and swaps in a single
    `#emojiResults` section (appended last, so `groupEls`/tab indices are
    untouched); tabs dim, and clicking one clears the search and jumps there.
    `updateActiveTab` no-ops while searching (every group is `display:none`, so
    they'd all measure as position 0). The box clears on open, so the picker
    never reopens on a stale query.
  - One non-obvious prerequisite: `render()` re-focuses the typing input on
    every state patch (several a second during a race), which would have yanked
    focus out of the search box mid-keystroke. It now stands down while the
    emoji picker is open, the same way it already did for the settings panel -
    this is why the picker could get away with having no text input before.
  - Also fixed a pre-existing palette bug the coverage check surfaced: ♨️ was
    listed in both "Travel & Places" and "Symbols & Flags", so it rendered as a
    duplicate cell. Removed from Symbols & Flags (Unicode groups it under travel).
  - Verified with two scripted suites run against the code sliced out of
    index.html itself, not reimplementations: 37 checks on the table and
    ranking (full coverage, name sanity, keyword-only hits like "happy" -> 😀,
    multi-term narrowing, case-insensitivity, the g-love/break-fast ordering),
    and 31 on the DOM wiring under a small DOM shim (build order, focus on
    open, the data-searching flags, result counts and titles, the empty state,
    clearing, picking from results, and reopening clean).
- 2026-07-26: Fixed two bugs in the local sound-status chat line (see
  `refreshSoundStatusMessage`), both found by scripted testing after a user
  asked to verify that a re-block would appear at the BOTTOM of the chat rather
  than at the top. It didn't appear at all, and could also vanish for good.
  - **Never re-shown.** The re-block path was guarded by `if (!soundStatusEntry)`,
    which is false once the line exists - including when it exists as the
    "🔊 Sound enabled." line. So audio being blocked again after having worked
    did nothing whatsoever, and the log went on claiming sound was enabled while
    it wasn't. Now an enabled -> blocked flip appends a NEW "🔇 Sound is blocked"
    line at the bottom, arriving like any other chat message. It deliberately
    does not edit the existing line in place: by then that line may be far up
    the backlog, so rewriting it would change history where the user isn't
    looking and show nothing where they are. The old "Sound enabled." stays as
    the record of what happened then - consistent with these lines being history
    like any other. The reverse flip (blocked -> enabled) still mutates in
    place, since that's where the user just clicked and it shouldn't jump.
  - **Could vanish permanently.** `myVisibleChat` is capped at
    CHAT_HISTORY_LIMIT_CLIENT and trims from the FRONT - exactly where this line
    sits after a normal page load, the log being empty when it's added - so
    ~50 messages silently shifted it out while `soundStatusEntry` still pointed
    at the orphaned object. Every later check then believed the line was on
    screen and never re-added it. A Switch Lobby hit the same desync by another
    route (`myVisibleChat = []`). `refreshSoundStatusMessage` now reconciles
    against the log rather than trusting the pointer (`indexOf === -1` clears
    it), and the Switch Lobby chat reset calls it explicitly so a fresh log
    re-states a still-blocked status instead of losing it. Being trimmed out is
    fine in itself - a notice pinned atop a 50-message backlog is one nobody
    sees; what matters is that the next cue attempt re-adds it at the bottom,
    and cues fire on every join and countdown tick (each routing through
    `withAudio` -> `refreshSoundStatusMessage`).
  - Verified with 16 checks driving the real function sliced out of index.html:
    first appearance, messages landing below it, the in-place enable, the
    re-block landing last exactly once, no duplicates on repeated refreshes,
    the settings toggle removing/re-adding it, and the cap-trim/re-add cycle.
- 2026-07-26: Sidebar redesigned into one always-visible column, and the header
  stripped back to the wordmark + identity box.
  - **Header:** the room id / "3/5 racers" readout (`#roomInfo`) is gone. It was
    dev/QA visibility for the matchmaking behavior; the count now lives where a
    player actually looks for it (the sidebar's "Racers 3 / 5" row).
  - **Sidebar, top to bottom:** Join Race (unmoved), Switch Lobby on its own row
    under it, then the roster, then chat filling the rest. The roster/chat view
    toggle is gone entirely (`#viewToggleBtn`, `#rosterView`, the `sidebarView`
    state): with both lists on screen at once there's nothing left to toggle
    between, which was the point of the request.
  - **Roster:** "Racers" (left) with the slot count (right), listing everyone
    holding a slot - `"queued"` players included, since they're part of that
    count; they carry a small "next race" tag so the list can't read as "all of
    these are in the current race". Then "Watching N", dimmed as a group, capped
    at 5 rows and scrolling past that but only as tall as its contents otherwise,
    so a quiet lobby doesn't reserve space it isn't using. Rows are the same
    avatar + tinted-name shape as a chat line (shared `fillNames`).
  - **Racer order** is server-stamped: new `Player.slotOrder` (see Core model),
    handed out by RaceRoom's `nextSlotOrder` in `setStatus` and in `onJoin` for
    a redirect arriving with a slot. Both the sidebar list and the leaderboard
    tracks sort by it, so the order you read before the race is the order of the
    tracks in it. Results mode still sorts by `place` - that's the standings,
    not the field.
  - **Chat now fills bottom-up**, even when nearly empty: rows moved into a
    `#chatMessagesInner` wrapper with `margin-top: auto` inside the scroll
    container. Deliberately not `justify-content: flex-end` on the scroller
    itself - that clips overflowing content out of scroll reach.
- 2026-07-27: Race queue (a fourth player status, `"waitlist"`), replacing the
  dead-end "Race Full" button. Opting into a full room now puts you in LINE
  instead of being silently ignored.
  - **Server:** `Player.waitlistOrder` + `promoteFromWaitlist()` (see Core
    model). A waitlisted player holds no slot and is counted by neither
    `countRacers()` nor `countTakenSlots()`, so MAX_RACERS still means what it
    says while the queue behind it is unbounded. Promotion hangs off
    `onRosterChanged()` (the choke point for Spectate/departure/switch-away)
    and the AFK sweep - deliberately not the race lifecycle, since a race
    ending frees nothing. `setStatus({racing:true})` also now ignores repeat
    opt-ins (`status !== "watching"`), which previously would have re-stamped
    an ordering key and jumped the sender to the back of their own list.
  - A redirected player (merge / Switch Lobby) who finds the target's slots
    gone now lands on its waitlist rather than being demoted to spectating -
    the intent survives the room swap either way.
  - **Button:** five states now - Spectate / Leave Next Race / Leave Race Queue
    (+ your position, right-aligned) / Join Race Queue / Join Race. It is no
    longer disabled by anything except an actual disconnect.
  - **Naming:** the pre-existing slot-holding state's labels moved off the word
    "queue" ("Queue for Next Race"/"Leave Queue" -> "Join/Leave Next Race"),
    which now belongs exclusively to the waitlist. Two different kinds of
    waiting both called "Queue" would have been unreadable; "next race" also
    matches the tag that state already carried in the roster.
  - **Sidebar:** the queue renders between the racers and the spectators
    (getting in line takes you out of "Watching"), under a divider, as the
    first 3 + "+N more"; if you're further back, your own row is pinned below
    a second divider so your position is always visible, with your "queue #N"
    label in the same cyan the UI uses for you elsewhere.
  - Verified with 27 scripted checks driving the real room (its own handlers
    and private methods, real schema state, stubbed clock/metadata): fill →
    queue → promote on Spectate/departure/AFK, leaving the queue renumbering,
    re-joining going to the back, mid-race promotion landing as `"queued"` and
    racing only in the NEXT race, duplicate opt-ins being no-ops, a slotless
    redirect arrival getting in line, and a promotion restarting a room whose
    racers all bailed.
- 2026-07-28: Seat reservations, closing the redirect gap that the race queue
  had been catching as a fallback.
  - **The gap:** choosing a merge/Switch Lobby target and the redirected client
    actually landing there are separate moments, with a reconnect handshake in
    between. `findMergeTarget`'s answer was therefore only advisory - two rooms
    whose races ended a moment apart both hunt for the fullest room with space,
    so they could pick the same target and both be told the same last seat was
    free. Whoever's handshake landed second lost it.
  - **The fix:** `reserveSlots()`, called by the SOURCE room on its chosen
    target before it redirects anyone, holds seats by `Player.clientId` - the
    only identifier that survives a redirect, since the sessionId is reissued
    on arrival. `countCommittedSlots()` (seats sat in + seats held) is what
    every capacity decision now reads: the in-room opt-in, waitlist promotion,
    a redirected arrival's re-check, and merge-target eligibility. So an
    in-room Join or a queue promotion can't take a held seat either. `onJoin`
    claims the hold, which is precisely what frees that seat for its intended
    owner and nobody else.
  - **Reserve exactly what was checked for.** A merge holds for its racers +
    queued (what `findMergeTarget` was sized against), NOT for its waitlisted
    players, who had no seat here and were never part of the eligibility check
    - they travel too and simply join the target's own queue. Switch Lobby
    holds the single seat it verified, and only when the switcher will actually
    claim one (a switching spectator needs the target to have room, per the
    existing policy, but doesn't take a seat on arrival).
  - **Lapsing is purge-on-read, not timer-driven.** SLOT_RESERVATION_MS is 5s,
    generous for a sub-second handshake. Expired holds are discarded inside
    `activeReservations()` on every read, so a hold can't outlive its window
    even if the timer never runs (room disposed, clock stopped). A leaked hold
    would be strictly worse than the race it fixes - a phantom seat, forever
    unclaimable and unfreeable - so correctness can't rest on a timer firing.
    The timer that IS set is only a nudge to re-evaluate, so a lapsed hold
    doesn't leave a waitlister stuck in line until some unrelated roster change
    wanders past.
  - `state.racerCount` includes held seats: leaving them out would show
    "4 / 5" next to a Join Race button the server then answers with a waitlist
    spot. A count briefly ahead of the visible roster beats a button that lies.
  - Verified with 27 more scripted checks (same harness style as the race
    queue's): a held seat refused to a local opt-in and then claimed by its
    owner, two rooms merging at once failing to collide, an unclaimed hold
    lapsing and feeding the waitlist, a lapsed hold ignored even with the timer
    discarded, a holder arriving having changed their mind releasing the seat,
    Switch Lobby holding for a racer but not a spectator, and a merge that
    doesn't fit being refused with nothing held. The race-queue suite was
    re-run against the change and still passes.
- 2026-07-29: Client-only polish, no server changes.
  - Bigger "Typro" wordmark (18px -> 26px, `line-height: 1`) without growing
    the header - it now matches the header's existing height (set by the
    emoji button) instead of exceeding it.
  - Inline SVG favicon: a rotated rounded square (a green diamond/emerald) in
    the site's button green, no separate asset to serve.
  - First-open lag on the emoji picker fixed: its ~1000 cells were built
    up-front but never painted while `display:none`, so the first open had to
    rasterize every color-emoji glyph at once. `warmEmojiGlyphs()` now pays
    that cost once, invisibly, during idle time after load (briefly painting
    the picker at `opacity:0`, which still rasterizes unlike `display:none`).
  - **Track display setting** (Settings panel, `#trackModeGroup`): a 3-way
    picker - "All tracks" (the original stacked per-racer rows, still
    default), "Shared track", "Hide tracks". Persisted per browser
    (`typingRace.trackMode`).
    - **Hide tracks:** the arena leaderboard disappears; the sidebar's Racers
      list gains a right-aligned wpm/AFK column (and `#rank` prefixed onto
      names once results are in) - see `augmentRacerRowsWithStats`. Only
      shown when the arena isn't already showing it inline, so the number
      never appears twice.
    - **Shared track:** one big track (`#sharedTrack`), square-edged (not
      pill-shaped, to match the caret bars riding on it). It's colored
      per-viewer, not per-racer - the fill is always MY OWN progress, tinted
      with my emoji's color; there's no single fill that could show every
      racer's progress at once without their colors fighting over the same
      pixels. Every racer, including me, also gets a caret + emoji marker on
      top (same visual language as the live ghost carets on the quote text),
      positioned by overall progress instead of by character - see
      `fillSharedTrack`. Ties (same/near progress) overlap by z-index rather
      than stacking vertically: mine is always frontmost, everyone else
      follows the race list's own join order, the same for every viewer -
      only "which racer is me" changes per screen.
    - The caret uses a punched-up, higher-saturation/lower-lightness variant
      of the same emoji hue (`getEmojiAccentColor`, reusing `getEmojiColor`'s
      sampled hue rather than resampling) so it reads clearly against the
      softer fill instead of blending into it.
    - Both the fill and the caret update with NO CSS transition - they're set
      from the literal same progress value in the same code, but even a
      transition both nominally shared could let a visible gray sliver open
      between them while chasing frequent updates (fast typing). Snapping
      both instantly was the only way to guarantee they never visibly drift
      apart. (The unrelated `.racer-fill`/`.racer-emoji` pair in the default
      view keeps its smoothing - that gap is masked by the avatar's own
      bulk, since the avatar overlaps the fill edge; the shared track's thin
      caret has no such cover.)
  - Verified via automated headless-browser testing (two tabs joining a live
    race, real progress from typing against the actual quote): all three
    modes switch correctly, sidebar stats never duplicate the arena's own,
    caret and fill stay pixel-locked, zero console errors.
- 2026-07-29: Settings panel redesign (client-only; no behavior or wire-format
  changes, every control keeps its existing key, handler, and semantics). The
  panel had grown one control at a time into a flat 280px stack of mismatched
  widgets; it's now a structured popover:
  - **Grouped:** three titled sections (Profile / Race view / Sound) separated
    by hairlines, with a sticky header (title + a real close button) so both
    stay reachable if the body scrolls. The panel is `max-height:
    calc(100vh - 76px)` with internal scrolling (sharing the site's thin
    scrollbar) instead of running off the bottom of a short viewport, and
    opens with a 130ms fade/slide that's dropped under
    `prefers-reduced-motion`.
  - **One row rhythm:** every setting is label + hint on the left, control on
    the right (`.settings-row`), or a full-width `.settings-field` for the two
    controls that need the width (name, track display). Hints sit under their
    label instead of being width-capped to 180px, so nothing wraps awkwardly.
  - **Whole-row toggling:** the three switch rows (`.settings-row-toggle`,
    each pointing at its switch via `data-switch`) forward a row click to
    their switch, so the label is a valid target rather than just the 40x22
    switch. Clicks landing on the switch itself are left alone so nothing
    toggles twice, and the forward uses `.click()` inside the real click
    handler, which preserves user activation - the sound toggle depends on
    that to unblock the AudioContext.
  - **Profile field:** name and avatar as one composite control (avatar button,
    input, live `n/20` counter) that lights up as a unit on focus. The avatar
    hands off to the existing emoji picker (closing Settings first, so the two
    popovers are never stacked) rather than duplicating it.
  - **Track display** options now carry a small diagram of what they do
    (stacked bars / one bar / an empty dashed slot), which says more at a
    glance than the labels alone; the loud solid-green active state became a
    quieter raised pill with green bars.
  - **Volume** is nested under the Sound cues toggle it depends on (indent +
    left rail) instead of sitting as a sibling row, shows its value as a "35%"
    readout, and the slider is custom-drawn so the filled portion is visible
    (`--pct`, written by `applySoundVolumeUi`).
  - **A11y:** all three switches and the three segmented buttons now keep
    `aria-checked` in sync (previously `role="switch"`/`radiogroup` with no
    state exposed at all), and every control has a `:focus-visible` ring.
  - A closing "Changes save automatically" line, since there's deliberately no
    Save button anywhere in the panel.
  - Verified with a headless-browser interaction pass (17 checks, zero console
    errors): gear/close/Escape/outside-click open and close; row clicks toggle
    exactly once and switch clicks don't double-fire; segmented selection
    drives `#leaderboard`'s mode; volume readout and fill track the slider;
    turning cues off dims and disables the volume row; the name counter tracks
    input and Enter saves through to the header label; the avatar opens the
    emoji picker with Settings closed; everything survives a reload; and the
    panel stays fully on-screen at a 560px-tall viewport.
- 2026-07-29: Follow-up fix to the above: the avatar in the Settings name field
  was vertically centered but not horizontally. Cause was the button's UA
  default `padding: 1px 6px`, which left an 18px-wide content box inside the
  30px button while the emoji glyph renders ~25px wide - so the glyph spilled
  out of the box that `place-items: center` was centering, landing ~4px right
  of true center. `padding: 0` lets the glyph fit, after which it centers
  properly (measured in-browser: 2.64px of gap on both sides, exactly equal).
  Then, per follow-up feedback, dropped the avatar's resting box (background +
  border) entirely: it's now just the glyph, with the hover highlight alone
  carrying the "this is clickable" signal, the same way the header's own emoji
  button reads. Centering is unaffected (re-measured: 2.64px left/right,
  6px top/bottom).
- 2026-07-30: Live track ordering (track-ordering.md), client-only. The tracks
  could previously only be sorted into placings once a race was over; there are
  now two optional ways to show live rank DURING one. New setting
  `trackOrder: "static" | "slide" | "swap"`, default `"static"` (exactly
  today's behaviour), persisted in `localStorage` as `typingRace.trackOrder`.
  Purely a display preference: no schema fields, no room messages, nothing the
  server hears about.
  - **One setting, not two toggles.** Slide and swap are two answers to the same
    question ("how do we show live rank?"), so "both on" has no meaning; a
    single three-way choice removes that state entirely.
  - **The ordering engine** (`orderByLivePosition`) is the part neither mode
    works without, not polish. It keeps one `displayOrder` array of sessionIds
    that persists across frames and moves SLOWLY: a racer must be more than
    `STICKY_CHARS` (5) ahead to take a place, and no swap happens within
    `SWAP_COOLDOWN_MS` (600) of the last one. Because the threshold is a
    strict margin, the reverse swap needs the same margin back the other way,
    and that dead zone is what stops two racers one character apart from
    trading places many times a second. Only ADJACENT entries ever swap and
    only one per update, so a racer climbing three places does it as three
    one-step moves - which is what keeps the movement readable.
    - The sticky distance is converted to progress units as
      `STICKY_CHARS / quote.length`, deliberately: short quotes have tighter
      finishes and need a proportionally wider quiet zone.
    - Finishers are pinned to the top in `place` order and never move again -
      a finished racer must never appear to be overtaken. A racer who leaves
      drops out and everything below shifts up; a racer who goes idle needs no
      handling at all, they simply stop progressing and drift down, which is
      correct.
    - Rebuilt from scratch per race, keyed on `roomId + quoteId` (a room switch
      starts its own quoteId sequence that could coincidentally match). The
      rebuild sorts by the real standings rather than blindly by join order:
      at a race start everyone is at 0 so the two are identical, but switching
      the setting ON mid-race then seeds correctly instead of making the viewer
      sit through a dozen catch-up swaps.
  - **Mode "slide":** the tracks move. Rows keep a fixed place in the DOM (join
    order) and are positioned by their rank with a `transform: translateY`,
    260ms ease - nothing is ever reparented out from under its own animation.
    The row pitch is measured from two rows' `offsetTop` rather than assumed,
    since both the row height and #leaderboard's gap come from CSS. Under
    `prefers-reduced-motion` this falls back to `static` outright.
  - **Mode "swap":** the tracks stand still and the racers move between them.
    This is the one structural change to `fillLeaderboard`: rows are normally
    keyed by sessionId (the row IS the racer), but in swap mode they're keyed
    by SLOT INDEX (the row is a position, and its occupant changes). Switching
    keying tears the rows down and rebuilds them (`useLeaderboardKeying`).
    Painting a row is split into `paintRowLabel` (name + avatar: cross-fades
    over 150ms when a slot changes hands, because a name that teleports reads
    as a glitch rather than an overtake) and `paintRowStats` (bar, wpm,
    classes: always instant - thanks to the sticky gap two racers only trade
    places about five characters apart, so the bar barely moves). The pending
    occupant is re-read when the fade completes, so a fade started 150ms ago
    lands on whoever holds the slot NOW. Reduced motion keeps the mode and
    drops the fade.
  - Applies **only** to the "All tracks" display and **only** while
    `phase === "racing"`: before that the join order stands, and the existing
    end-of-race `place` sort is untouched.
  - **Settings UI:** a "Live positions" segmented picker (Off / Slide / Swap)
    with its own SVG diagrams, nested under Track display using the same
    indent + left-rail idiom Volume already uses under Sound cues, since it
    depends on it the same way. The other two track displays DIM it rather
    than hiding it (a control that vanishes when you touch the one above it is
    harder to find again than one that is visibly unavailable) and the hint
    swaps to say why. The hint also says so when reduced motion is what's
    holding slide back, rather than silently doing nothing.
  - Verified with three suites, all driving the real code sliced out of
    index.html: 27 checks on the engine under a fake clock (the gap, the
    hysteresis both ways, the cooldown boundary at 599/600ms, one-swap-only,
    a three-place climb taking three cooldowns, quote length scaling the gap,
    finishers pinned by place, departures, idlers, per-race reset); 28 on the
    DOM wiring under a DOM shim (static vs slide DOM order, transform maths,
    slot re-keying, the cross-fade's timing and its re-read of the current
    occupant, reduced motion, slot count, and the results screen still
    rendering "#1 … (DNF)"); and 27 in two real browser tabs racing against
    the live server (four consecutive clean runs, zero console errors) -
    sliding one row at a time, holding still while neck and neck, swapping
    labels without moving rows, a finisher pinned at 100%, a closed tab
    closing the gap, and the settings group dimming/re-enabling.
- 2026-07-31: Step 6, mobile. Entirely client-side: no schema fields, no room
  messages, no server changes at all. The constraint driving every decision was
  that the DESKTOP layout must not move a pixel, so the whole thing hangs off
  one media query and a matching `matchMedia` in JS.
  - **The breakpoint** is `(max-width: 820px), (max-height: 520px) and
    (pointer: coarse)`. The second clause is for a phone held sideways: it's
    ~844px wide, so width alone would put it on the desktop layout with 390px
    of height to fit a two-column design into. `pointer: coarse` is what keeps
    a merely SHORT desktop window out of it - a mouse is never coarse. The
    identical string lives in both the stylesheet and `compactLayout`, and
    they have to stay in step because the JS half decides where the join
    button lives.
  - **The shape:** header / arena / a bottom action bar, with the 320px
    sidebar demoted to a sheet that slides up over the arena. The sheet is
    positioned inside `.layout` rather than against the viewport, so it can
    never cover the header (Settings and the avatar picker stay reachable
    while it's open), and it's translated rather than `display:none`d, so the
    chat's scroll position survives a close/open. `visibility` flips on a
    delay matched to the slide, so the panel is properly inert once off
    screen without the animation being cut short.
  - **#joinBtn is MOVED, not duplicated.** Join/Spectate is the one action
    that must never be a sheet away, so `syncCompactLayout()` relocates the
    element between the sidebar and the bottom bar. Moving the node keeps
    every listener and every `joinBtn`/`joinBtnLabel` reference in the file
    valid, so no other code knows the layout changed. The only structural
    markup change this needed was wrapping the sidebar's remaining contents
    in `.sidebar-scroll`; on desktop that wrapper just inherits the sidebar's
    own flex column and is a pass-through (verified by measurement - see
    below).
  - **The on-screen keyboard** is the real problem on a phone: it covers the
    bottom of the VISUAL viewport without shrinking the layout viewport, so a
    full-height shell ends up with its typing box behind the keys.
    `updateKeyboardInset()` reads the covered strip off `visualViewport` and
    publishes it as `--kb-inset`; the shell is sized
    `100dvh - var(--kb-inset)`, so the whole app reflows into the space that
    is actually visible. A browser that resizes the layout viewport instead
    reports ~0 and needs nothing (dvh already shrank), and a 120px floor keeps
    a URL bar sliding in and out from being mistaken for a keyboard. The body
    is `position: fixed` on top of that, so iOS can't scroll the page out from
    under the keyboard - the arena is the only thing that scrolls.
  - **Two separate questions, deliberately not conflated.** `compactLayout`
    asks "how big is the window"; `touchInput`
    (`(hover: none) and (pointer: coarse)`) asks "what is typing on this".
    Everything about LAYOUT keys off the first, everything about FOCUS off the
    second. Conflating them was a real bug, caught by the user after the first
    pass: the auto-focus skip was keyed to the breakpoint, so a PC user who
    narrowed their window lost auto-focus and had to click into the box by hand
    every time it reappeared after a countdown, which makes the game
    unplayable. A narrow desktop window has a real keyboard and must behave
    exactly as it does at full width; only a device where focusing cannot raise
    a keyboard takes the hands-off path. Four things hang off `touchInput`: the
    auto-focus skip, the "Tap to type" hint, tap-the-arena-to-focus, and the
    emoji search's auto-focus. A touchscreen laptop reports its mouse as the
    primary pointer and so correctly reads as non-touch.
  - **Typing on a touchscreen:**
    - No auto-focus. A phone only raises its keyboard for a real tap, so
      `render()`'s focus rule would produce a focused box with no keyboard
      behind it - and would suppress the "Tap to type" hint that is the only
      thing explaining that. The whole arena is the tap target, not just the
      43px box; a drag doesn't fire `click`, so this can't fight scrolling.
      `#tapHint` lives in its own `touchInput` media block rather than in the
      compact one, so a wide touch device (a tablet in landscape) still gets
      it; its offsets come from variables the compact block overrides, since
      the wrapper is padded there and bare otherwise.
    - **One tap per session, not per race.** No browser will open the
      on-screen keyboard without a real gesture, and a race starts on a SERVER
      event, so there is genuinely no way to raise it at that moment - the
      literal "pop the keyboard up when the race starts" cannot be built. What
      can be built is never letting it close: a blur is what dismisses the
      keyboard, and both hiding and disabling an element blur it. So for a
      racer on touch the box stays MOUNTED and ENABLED right through the
      results screen and the following countdown (`keyboardParked` in
      `render`), and the keyboard opened by the one tap after joining rides
      the whole loop. RESULTS_SECONDS is 3 and COUNTDOWN_SECONDS is 10, so
      that is a ~13 second gap held open, which is well worth not having to
      re-tap. Tapping Spectate still blurs and drops it, correctly.
    - Leaving the box enabled outside a live race means `disabled` no longer
      answers "may I type now", so two flags written by `render` do:
      `raceInputLive` and `raceInputArmed`. Three places read them - the
      `beforeinput` guard (blocks EVERY input type, not just insertions,
      because pre-typing the quote during a countdown must not carry into the
      race), `sendProgress` (belt and braces: IME composition and some
      paste/drop routes fire `input` without a cancellable `beforeinput`, and
      text left in the box would otherwise be sent on the first real keystroke
      and score most of a quote in one message), and the 150ms caret repaint
      (so no caret blinks on the quote during a countdown or results). On
      desktop all three are exactly equivalent to the old
      `!typeInput.disabled`, and `disabled` there is untouched.
    - The input is `margin-top: auto` + `position: sticky; bottom: 0`, which
      between them bottom-anchor it when the quote is short and pin it when
      the quote overflows. Either way it lands directly on top of the keys.
    - `keepCaretVisible()` scrolls the arena to follow the caret down a quote
      that's several screens tall on a phone. Gated to the compact layout: on
      desktop the caret is never out of view, and this must not introduce
      scrolling there.
    - `autocorrect`/`autocapitalize`/`spellcheck` are all off on the typing
      box: predictive text rewrites whole words behind the racer's back, which
      the per-character scoring reads as a burst of mistakes.
  - **iOS focus zoom**: Safari zooms the page in whenever a focused input is
    under 16px. Every focusable input (`#typeInput`, `#chatInput`,
    `#settingsUsername`, `#emojiSearch`) is held at 16px on compact layouts.
  - Smaller pieces: chat behind a closed sheet raises an unread dot on the
    toggle (a dot, not a count - which messages you missed is what opening it
    is for); the popovers become full-width fixed panels, and the emoji picker
    gains a close button since a screen-spanning popover leaves almost no
    "outside" to tap and a phone has no Escape key; the emoji search box no
    longer steals focus on open (the keyboard would cover the grid); the two
    outside-click handlers moved from `mousedown` to `pointerdown` (same
    moment for a mouse, native for a touchscreen); `overscroll-behavior` stops
    pull-to-refresh from reloading mid-race; and hover transforms are switched
    off under `(hover: none)`, where they stick after a tap and read as the
    element having jammed.
  - Verified in real mobile-emulated Chrome against the live server, 70 checks
    across three suites, zero console errors. 61 on layout and interaction (a
    390x844 phone, an 844x390 landscape phone, a 700x900 narrow DESKTOP window
    with a mouse, and a 1440x900 desktop, all in the same run): the shell's
    height, the relocated join button, the sheet
    opening/closing by toggle, scrim and Escape, no horizontal overflow at
    either phone orientation, the 16px input floor, both popovers fitting on
    screen, the tap hint appearing exactly when typing opens and clearing on
    focus, the caret staying in view through 90 characters, and the unread dot
    appearing and clearing - plus the desktop half asserting the mobile
    elements are all `display:none`, the sidebar is still a 320px column on
    the right edge, the quote is back at 20px, the input isn't sticky, and
    desktop auto-focus still works. The narrow-window case specifically pins
    the regression above: it confirms the compact layout IS active and the
    join button HAS moved, while auto-focus still fires, no tap hint appears,
    typing lands without clicking the box first, and focus is taken back on
    the next state patch exactly as it is at 1440px. 9 more on the keyboard:
    with `--kb-inset`
    driven to 336px the shell, action bar, typing box and chat input all sit
    above it and restore afterwards, and a phone tab racing against a desktop
    spectator typed a full quote to a server-computed 100% and ranked #1.
    Finally, a targeted check that `.sidebar-scroll` is a genuine no-op on
    desktop: measured 20 elements, removed the wrapper live, re-measured, and
    all 20 boxes were identical.
  - A fourth suite (23 checks) covers the keyboard hold specifically, driving
    TWO consecutive races off a single tap: the box is enabled and prompting
    before the race, the tap focuses it, pre-typing during the countdown lands
    nothing and registers no progress, focus survives into race 1, through the
    results screen (with no pointless prompt there), and into race 2 where
    typing lands immediately - then Spectate drops the box entirely. Its
    desktop half asserts the old behaviour is intact: box `disabled` before
    the race, auto-focus when it starts, and the box still HIDDEN on results.
- 2026-07-31: Mobile chat, four fixes from using it on a phone. All compact
  layout or touch only; the desktop sidebar is untouched and asserted so.
  1. **The log was down to about three messages** once the keyboard was up,
     because the sheet was still spending its height on the roster and the
     Switch Lobby row. Neither is any use while you're typing INTO the chat, so
     both now `display: none` while the chat field has focus
     (`.sidebar[data-composing="1"]`), handing the log the whole sheet: about
     190px back, roughly three messages to eleven. They return on blur. The
     blur side is deferred ~150ms, because sending a message can blur and
     re-focus in the same breath and letting the roster spring back in between
     was a visible lurch on every message.
  2. **Sending dropped the keyboard**, costing a tap per message. Two causes,
     both fixed: tapping Send moved focus to the button (its `pointerdown`
     default is now declined, since a button doesn't need focus to be
     activated), and submitting a form drops the soft keyboard anyway (the
     handler now re-focuses the field SYNCHRONOUSLY, which keeps the submit's
     own user activation - the only thing that lets a keyboard stay up).
     Desktop is excluded: focus there is render()'s to hand back to the typing
     box mid-race, and taking it for the chat would change how sending behaves
     while racing.
  3. **The log showed its top when the keyboard opened.** A scroll position
     measured against the old, taller container leaves the newest messages off
     the bottom once it shrinks. Rather than enumerate everything that can
     resize it (keyboard, roster standing down, sheet opening, rotation), a
     `ResizeObserver` on the scroll container re-pins to the newest message on
     any size change. Compact only, and only when the reader was already near
     the bottom, so resizing while reading back through history leaves them
     where they were. `anchorChatToBottom()` defers a frame, since scrollHeight
     read before the reflow lands is the old number.
  4. **Join Race now closes the sheet** - it's covering the race the button is
     about. Both directions: joining wants the typing box in view, backing out
     wants the race you're now watching.
  - Verified with a 26-check suite on a 390x844 phone with a simulated 336px
    keyboard: composing hides both blocks and buys back real height, the log
    stays pinned through the keyboard opening and through sends, Send and Enter
    both send AND keep focus, the roster doesn't flicker back mid-send, Join
    closes the sheet and drops the keyboard, and everything is restored on
    reopen. Its desktop half asserts the roster and Switch Lobby row never
    hide, chat still sends, and the sidebar survives Join.
- Harness note for whoever runs the mobile suites next: a second page in the
  same headless Chrome instance loses its websocket right after connecting, so
  the suites launch a separate browser per client rather than a second tab.
  This reproduces on the committed build with none of the mobile changes
  applied, so it is the test harness, not the app; two real tabs in a normal
  browser are unaffected.
