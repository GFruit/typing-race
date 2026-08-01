/**
 * RaceRoom.ts: the shared typing-race room.
 *
 * Step 1 scope (presence only):
 *   - Everyone who connects is added to state as a spectator ("watching").
 *   - A "setStatus" message lets a client join the next race / go back to
 *     spectating. The SERVER is the only place status actually changes.
 *   - When a client disconnects, they're removed from state.
 *
 * Step 2 scope (this file, added on top): phase lifecycle + a quote.
 *   - `state.quote` always has something in it: a fresh one is picked on
 *     room creation and every time the room settles back to "waiting", so
 *     the upcoming race's text is visible even before anyone has queued.
 *     That same quote then carries unchanged through "countdown" into
 *     "racing" once at least one player queues (see the matchmaking scope
 *     note near the bottom of this comment for the current threshold).
 *   - Joining the race being set up ("watching" -> "racing") is only allowed
 *     during "waiting"/"countdown", no jumping into one already live (see the
 *     "Queueing" scope note below for what happens instead). Bailing out
 *     ("racing" -> "watching") is always allowed, even mid-race.
 *
 * Step 3 scope (this file, added on top): typing + progress.
 *   - Clients send their raw current input via "typeProgress"; the server
 *     never trusts it directly. It recomputes how many leading characters
 *     match `state.quote` and derives `progress`/`wpm` from that. A client
 *     can't just claim "100% done" without having actually typed it.
 *   - `wpm` also ticks on a server-side interval (not just on keystrokes), so
 *     it visibly decays if a racer stops typing instead of freezing.
 *
 * Step 4 scope (this file, added on top): results + auto next race.
 *   - The race ends (phase -> "finished") when every racer finishes, or when
 *     RACE_TIMEOUT_MS elapses, whichever comes first. Stragglers still
 *     typing at that point are ranked afterward, worst-progress last.
 *   - `state.countdown` is reused to count down RESULTS_SECONDS while results
 *     are shown; when it hits 0 the room returns to "waiting" and
 *     immediately re-checks whether a new race can start right away (anyone
 *     still queued stays queued, no need to re-join for back-to-back races).
 *   - A racer who sends no "typeProgress" at all for INACTIVITY_TIMEOUT_MS
 *     (measured from race start, or their last keystroke) is auto-moved to
 *     "watching", same as if they'd clicked Spectate themselves, and flagged
 *     `afk` so clients can keep their leaderboard row in place (tagged "AFK"
 *     instead of wpm) rather than have it vanish and reshuffle the rest of
 *     the list. Reset at the start of every race.
 *
 * Step 5 scope (this file, added on top): chat, then reconnection.
 *   - Chat: always available regardless of phase; it's cosmetic, not part of
 *     the race, so there's no reason to gate it. Sanitized the same way as
 *     names (trim, length cap). History lives in `state.chat` and is capped
 *     at CHAT_HISTORY_LIMIT, so new joiners get recent backlog for free via
 *     the normal state sync rather than needing a separate request.
 *   - Reconnection: an abrupt disconnect (refresh, network blip, tab close)
 *     doesn't remove the player right away. `onDrop` gives them
 *     RECONNECTION_GRACE_SECONDS to reconnect with the very same sessionId,
 *     so their Player entry (and thus race progress, and chat "is this me"
 *     identity) carries over untouched. Only if that window elapses without
 *     a reconnect does `onLeave` run the real cleanup. Note this is orthogonal
 *     to the existing AFK handling: a still-racing player who doesn't resume
 *     typing within INACTIVITY_TIMEOUT_MS still gets AFK-tagged as usual
 *     while disconnected - reconnection is about not losing your seat and
 *     identity, not about exempting you from the race's own idle handling.
 *
 * Matchmaking scope (this file, added on top; see match-making.md): capped
 * racer slots + multi-room placement.
 *   - MAX_RACERS caps a room at 5 racer slots; `setStatus({racing:true})` is
 *     silently ignored once they're all taken. Spectators remain uncapped -
 *     they share the room's chat and roster but never occupy a racer slot, so
 *     there's nothing to cap.
 *   - `state.racerCount` mirrors `countRacers()` into synced state (cheap
 *     for clients that want to show "3/5") and is also pushed into the
 *     room's matchmaking metadata via `setMetadata`, which is what
 *     app.config.ts's `.sortBy({"metadata.racerCount": -1})` reads to place
 *     new visitors into the fullest available room first.
 *   - The countdown lock rule: once `state.countdown` drops to
 *     LOCK_AT_COUNTDOWN_SECONDS or less during "countdown", the room calls
 *     `this.lock()`, which pulls it out of matchmaking placement (existing
 *     connections are unaffected; `joinOrCreate` just stops offering this
 *     room to new visitors, who land in another waiting room or spawn a
 *     fresh one instead). Unlocked again the moment the race actually
 *     starts, since a live race is a perfectly fine spectating destination,
 *     and again defensively whenever the room settles back to "waiting"
 *     (covers the countdown being cancelled while locked).
 *   - Solo play / the racer-count threshold: a single queued racer is
 *     enough to start the countdown, full stop, regardless of how many
 *     spectators happen to be sitting in the room (spectators were never
 *     part of the threshold to begin with; see match-making.md's "Solo
 *     Play"). Symmetrically, once running, the countdown/race only
 *     cancels/resets to "waiting" if racerCount drops all the way to 0 -
 *     losing some but not all racers (e.g. two queued, one leaves) just
 *     continues with whoever's left instead of cancelling and forcing a
 *     restart, which used to strand the remaining racer in "waiting" with
 *     no automatic re-trigger.
 *   - Post-race merging: when results end, instead of unconditionally
 *     resetting to "waiting", the room first tries to fold its entire
 *     roster (racers, spectators, and chat - see match-making.md's
 *     "POST-RACE" step) into another room that's currently "waiting" (or
 *     mid-"countdown" but not yet locked - same eligibility as ordinary
 *     new-visitor placement) and has room for this room's racers, killing
 *     this room in the process. Only falls back to the normal
 *     reset-and-wait-here behavior if no such target exists. See
 *     `attemptMerge()`/`findMergeTarget()`. (match-making.md's "Adjusting
 *     Timers" - bumping the countdown back up when racers land in an
 *     already-running one - was tried and then removed: `onRosterChanged()`
 *     had no way to tell a genuine merge/Switch Lobby arrival apart from a
 *     player just spamming their own spectate/rejoin toggle, so the latter
 *     could stall a race indefinitely by keeping the timer perpetually
 *     bumped. The countdown lock rule below is what replaced it - instead
 *     of ever bumping the timer, new arrivals just stop being eligible to
 *     land in a room whose countdown has gotten too low, full stop.)
 *   - Colyseus has no way to transplant a live WebSocket from one Room
 *     instance to another; a merge is really "tell every client which room
 *     to jump to, then disconnect them here." `RaceRoom.instances` (a
 *     static registry, populated in onCreate/onDispose) lets a room reach
 *     other live instances directly, since they all run in the same
 *     process (this whole scheme assumes a single process; it would need
 *     rework, e.g. querying via `matchMaker`/presence instead, to run
 *     across multiple server processes). Each redirected client gets a
 *     `"redirect"` message with the target roomId and whether they were
 *     racing, then the room calls `this.disconnect()`; the client (see
 *     client/index.html) reacts to `"redirect"` by calling
 *     `client.joinById(...)` on the target instead of treating the drop as
 *     a real disconnect, carrying its reconnection token and UI state
 *     (chat log, etc.) forward across the swap.
 *
 * Seat-reservation scope (this file, added on top): closing the redirect gap.
 *   - Choosing a merge/Switch Lobby target and the redirected client actually
 *     ARRIVING there are separate moments, with a reconnect handshake in
 *     between. Without a hold, findMergeTarget's answer is only advisory: two
 *     rooms whose races end a moment apart both hunt for the fullest room with
 *     space, so they can pick the same target and both be told the same last
 *     seat is free - and whoever landed second lost it.
 *   - `reserveSlots()` (called by the SOURCE room on its chosen target, before
 *     redirecting anyone) holds seats by `Player.clientId`, the only
 *     identifier that survives a redirect - the sessionId is reissued on
 *     arrival. `countCommittedSlots()` = seats sat in + seats held, and every
 *     capacity decision reads it, so an in-room opt-in or a waitlist promotion
 *     can't take a held seat either. `onJoin` claims the hold, which is what
 *     frees the seat for its intended owner and nobody else.
 *   - Holds lapse after SLOT_RESERVATION_MS, purged on every read rather than
 *     by the timer that also gets set: a leaked hold would be strictly worse
 *     than the race it fixes (a phantom seat, permanently unclaimable and
 *     unfreeable), so correctness can't rest on a timer firing. The timer is
 *     only a nudge to re-evaluate so a lapsed hold doesn't leave a waitlister
 *     stuck until some unrelated roster change happens by.
 *
 * Race-queue scope (this file, added on top): a fourth player status,
 * "waitlist" - wanting in when every slot is already taken.
 *   - `setStatus({racing:true})` against a full room no longer does nothing
 *     (which surfaced as a dead "Race Full" button); it puts the player in
 *     LINE, stamped with a `waitlistOrder`. They hold no slot and are counted
 *     by neither `countRacers()` nor `countTakenSlots()` - a waitlisted player
 *     is capacity-wise a spectator, which is what keeps the MAX_RACERS cap
 *     honest while the queue behind it is unbounded.
 *   - `promoteFromWaitlist()` hands each freed slot to the front of the line.
 *     It runs from `onRosterChanged()` (the choke point for Spectate,
 *     departures and switch-aways) and from the AFK sweep. Deliberately NOT
 *     from the race lifecycle: a race ending frees nothing, since its racers
 *     keep their slots for the next one.
 *   - Promotion respects `acceptsNewRacers()` exactly like a normal opt-in, so
 *     coming off the queue mid-race means "queued" for the next race, never
 *     being dropped into one already running.
 *
 * Queueing scope (this file, added on top): a third player status, "queued".
 *   - Opting in is now never refused for timing reasons. When the room can't
 *     add you to the race it's setting up - a live race, a results screen, or
 *     a countdown with LOCK_AT_COUNTDOWN_SECONDS or less to go (see
 *     `acceptsNewRacers()`) - `setStatus({racing:true})` makes you "queued"
 *     instead of doing nothing: you take a racer slot immediately, sit out the
 *     current race entirely, and are moved into the next one wholesale by
 *     `promoteQueuedRacers()` when the room settles back to "waiting". The
 *     only hard refusal left is a genuinely full room (see below).
 *   - Two different counts now exist, and mixing them up is the easy bug here:
 *     `countRacers()` (racing only) drives the RACE LIFECYCLE - start/cancel a
 *     countdown, is a live race still populated, is everyone finished - so a
 *     queued player can never start or sustain a race they aren't in.
 *     `countTakenSlots()` (racing + queued) drives CAPACITY - the MAX_RACERS
 *     cap, merge-target free slots, `state.racerCount`/matchmaking metadata -
 *     so a reserved slot is never handed to someone else.
 *   - It also removes the old "you lose your slot" edges from redirects: a
 *     racing-or-queued player who merges or Switch-Lobbys into a room that
 *     turns out to be mid-race by the time they land arrives "queued" rather
 *     than demoted to spectating (see onJoin).
 */
import { Room, Client, CloseCode } from "colyseus";
import { Delayed } from "@colyseus/timer";
import type { ArraySchema } from "@colyseus/schema";
import { RaceState, Player, ChatMessage } from "./schema/RaceState";
import { QUOTES } from "./quotes";

const COUNTDOWN_SECONDS = 10;
const MAX_RACERS = 5;
// A curated pool of racer avatars, used for two things: the random avatar
// each player gets on join (see onJoin), and the quick-pick suggestions the
// client shows in its picker. Players are NOT limited to this list - the
// "setEmoji" handler accepts any emoji (see isEmoji) - so it's just a
// pleasant starting set, not the set of allowed values.
const EMOJIS = [
  "🚀", "🏎️", "🐎", "🐆", "🐇", "🦊", "🐢", "🐌", "🦄", "🐉", "🦕", "🐬",
  "🦅", "🦉", "🐝", "🦋", "🚗", "🚴", "🏃", "⚡", "🔥", "⭐", "👾", "🤖",
  "🎮", "🐙", "🦈", "🐧", "🦁", "🐯", "🐸", "🍕",
];

function randomEmoji(): string {
  return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
}

// A pool of plausible display names for admin-spawned test bots (see the
// "spawnBots" handler). Purely so a generated field reads like a real lobby
// rather than "bot1, bot2, ..."; the admin knows they're bots because they
// spawned them. Nothing gameplay-facing keys off these.
const BOT_NAMES = [
  "Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie",
  "Quinn", "Avery", "Parker", "Reese", "Rowan", "Skyler", "Emerson", "Finley",
  "Hayden", "Kai", "Nova", "Sage", "Blake", "Drew", "Elliot", "Frankie",
  "Charlie", "Dakota", "Lennon", "Micah", "Remy", "Sol", "Wren", "Zephyr",
];

function randomBotName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

/** Coerces a possibly-missing/garbage client value to an integer in [min, max]. */
function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Loose "is this a single emoji, and nothing but" check, so a client can pick
 * ANY emoji for its avatar (not just the EMOJIS quick-pick pool) while still
 * being prevented from stuffing arbitrary text/markup into Player.emoji.
 * Accepts pictographic characters plus the usual emoji building blocks - ZWJ,
 * the emoji variation selector, skin-tone modifiers, regional indicators
 * (flags), and keycap sequences (0-9 # * followed by U+20E3) - and caps the
 * total code-point count so a whole run of emoji (or a sentence) can't be
 * crammed in either. Requires at least one actually-pictographic code point,
 * so bare digits/joiners on their own are rejected.
 */
function isEmoji(s: string): boolean {
  const cps = Array.from(s);
  if (cps.length === 0 || cps.length > 12) return false;
  let hasPictographic = false;
  for (const ch of cps) {
    const cp = ch.codePointAt(0)!;
    if (/\p{Extended_Pictographic}/u.test(ch)) { hasPictographic = true; continue; }
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) { hasPictographic = true; continue; } // regional indicators (flags)
    if (cp === 0x20e3) { hasPictographic = true; continue; }                  // keycap combiner (1️⃣, #️⃣): marks a keycap emoji
    if (cp === 0x200d || cp === 0xfe0f) continue;                             // ZWJ, VS16
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue;                             // skin-tone modifiers
    if ((cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a) continue;   // 0-9 # * (keycap bases)
    return false;
  }
  return hasPictographic;
}
// How late into a countdown a player may still be added to the race it's
// counting down to. Governs four things uniformly - pulling the room out of
// Colyseus's own matchmaking (new visitors), excluding it as a merge/Switch
// Lobby target (findMergeTarget), a redirected client's re-check at actual
// arrival time (onJoin), and the in-room opt-in (setStatus) - all reading the
// same number, so no two of those decisions can disagree, and nobody is ever
// added to a race with only a couple of seconds' notice.
//
// Note what missing the cutoff costs, which differs by case: for a NEW visitor
// it just means landing in some other room (or a fresh one), and for anyone
// opting in or arriving with a slot it means "queued" - in the next race
// rather than this one. Nobody is turned away outright by it.
const LOCK_AT_COUNTDOWN_SECONDS = 3;
const RESULTS_SECONDS = 3;
const RACE_TIMEOUT_MS = 60_000;
const INACTIVITY_TIMEOUT_MS = 10_000;
const CHAT_HISTORY_LIMIT = 50;
const CHAT_MESSAGE_MAX_LENGTH = 200;
// Reconnection grace windows (see onDrop). A tab close and a page refresh are
// indistinguishable at close time - both send a *clean* WebSocket close (1001
// "going away") and there's no client/browser signal that says which - so a
// close can never be made truly instant: whatever window a refresh needs to
// reconnect, a close has to wait out too, or every refresh flickers the player
// out and back in (the churn behind the reverted "pagehide" fix - see
// client/index.html). What we CAN do is split by *how* the socket closed:
//   - UNLOAD_GRACE_SECONDS: a clean close (tab close OR refresh). Kept short -
//     just long enough for a normal refresh's reconnect handshake to land - so
//     a real close disappears from the roster quickly.
//   - RECONNECTION_GRACE_SECONDS: an ABNORMAL close (code 1006 / a ping-timeout
//     terminate - i.e. a genuine network blip, which never sends a clean close
//     frame). This has to be long enough for the client SDK's OWN automatic
//     reconnection to actually LAND, or reconnecting is impossible: the SDK
//     retries on an exponential backoff over tens of seconds
//     (@colyseus/sdk's Room.reconnection), so a 2s window here (the old value)
//     meant the server destroyed the session before the second retry, and
//     every retry afterward hit a session that no longer existed - the client
//     sat "reconnecting" against a corpse until the SDK exhausted all 15
//     retries (~55s), buttons frozen, with a reload the only real recovery.
//     20s comfortably covers the SDK reconnecting through a real blip. The
//     seat is held that long for a truly-dead abnormal close too, but those
//     are rarer than clean closes (which the beacon already clears fast), and
//     holding a seat 20s beats making reconnection impossible.
const UNLOAD_GRACE_SECONDS = 1.5;
const RECONNECTION_GRACE_SECONDS = 20;
// How long a racer seat is held for a client another room has already
// redirected here but who hasn't finished connecting yet (see reserveSlots).
// It only has to cover the redirect's reconnect handshake - well under a
// second - so this is deliberately generous. A hold nobody ever claims (the
// tab closed mid-jump) costs the room one seat for this long and no longer.
const SLOT_RESERVATION_MS = 5000;

// Admin testing tool (see the "spawnBots"/"clearBots" handlers and
// client/index.html's admin panel). ADMIN_KEY gates every bot action: it must
// be set in the environment (Render dashboard env var, or `$env:ADMIN_KEY=...`
// locally) for the feature to work at all - unset means the handlers no-op, so
// the safe default is "off". A request's `key` must equal it exactly.
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// Guardrails on a spawn request so a stray/huge value can't wedge a room.
const BOT_MAX_TOTAL = 40;      // most bots one spawn call may add at once
const BOT_MIN_WPM = 10;
const BOT_MAX_WPM = 250;
// Each bot's own speed is jittered this fraction around the requested average,
// so a spawned field doesn't move in lockstep.
const BOT_WPM_VARIANCE = 0.15;
// Longest random "reaction time" before a bot starts typing at race start, so
// they don't all leave the line on the same frame.
const BOT_MAX_START_DELAY_MS = 1200;

export class RaceRoom extends Room {
  // Every live RaceRoom instance, keyed by roomId. Only valid within a
  // single process (see the "Post-race merging" doc note above); lets
  // attemptMerge() reach another room's state/methods directly instead of
  // going through matchmaker queries.
  private static instances = new Map<string, RaceRoom>();

  // The synchronized state. Do NOT reassign this later; always mutate it
  // (e.g. this.state.players.set(...)), never `this.state = ...`.
  state = new RaceState();

  // Ephemeral, server-only, NOT part of synchronized state.
  private countdownTimer: Delayed | null = null; // pre-race countdown AND results countdown (mutually exclusive phases)
  private wpmTicker: Delayed | null = null;
  private raceTimeoutTimer: Delayed | null = null;
  // Admin testing bots (see the "spawnBots" handler). Server-only, per the
  // state-minimalism rule: bots are ordinary synced `Player` entries, but
  // "which players are simulated" and each one's target speed are bookkeeping
  // clients never need. `botTicker` drives their typing during a live race.
  private botSessions = new Set<string>();
  private botSim = new Map<string, { wpm: number; startDelayMs: number }>();
  private botTicker: Delayed | null = null;
  private nextBotId = 1;
  // Admin testing switch (see the "setAfkKick" handler and client's Testing
  // panel): when true, tickRace()'s inactivity sweep never moves an idle racer
  // to spectating, so you can sit on a race and watch it without being kicked.
  // Off by default and admin-gated, exactly like the bot tools; nothing about
  // it is synced (it only changes server-side sweep behaviour).
  private afkKickDisabled = false;
  private raceStartedAt = 0;
  private correctCharsBySession = new Map<string, number>();
  private lastActivityBySession = new Map<string, number>();
  private nextPlace = 1;
  // Hands out Player.slotOrder: bumped every time someone takes a racer slot
  // in this room, so the stamps read as "who opted in first". Never reset -
  // it's an ordering key, not a count, and reusing a number would let a new
  // racer tie with (and so reorder against) an existing one.
  private nextSlotOrder = 1;
  // Same idea for Player.waitlistOrder: the race queue's ordering key. Also
  // never reset, so a departing waitlister can't free a number that would let
  // a later arrival tie with (and reorder against) someone already in line.
  private nextWaitlistOrder = 1;
  // Set right before attemptMerge() disconnects everyone as part of a
  // merge's mass teardown; checked by onLeave to skip posting "left the
  // lobby" for those departures (they're framed as joining wherever they
  // land instead, never as leaving here).
  private isMerging = false;
  // sessionIds we've force-terminated in response to a leave beacon (see
  // handleLeaveBeacon). onDrop consumes this to give those the SHORT unload
  // grace: the terminate surfaces as an abnormal 1006 close, which would
  // otherwise look like a network blip and get the longer grace.
  private beaconLeaving = new Set<string>();
  // sessionIds we're kicking as duplicates of the same browser tab (see
  // onJoin's clientId dedup); onLeave checks this to skip the "left the lobby"
  // announcement for them (the tab isn't actually leaving, just shedding a
  // stale duplicate session).
  private dedupKicking = new Set<string>();
  // Seats held for clients that another room has already decided to send here
  // but that are still mid-reconnect: Player.clientId -> when the hold lapses.
  // Ephemeral and server-only per the state-minimalism rule - the *number* of
  // held seats reaches clients through state.racerCount (see
  // countCommittedSlots/updateRacerCount); this bookkeeping doesn't.
  private slotReservations = new Map<string, number>();

  onCreate(options: any) {
    this.state.phase = "waiting";
    this.assignNewQuote();
    // Metadata starts in sync with the (empty) synced racerCount; see
    // updateRacerCount(). Needed here too since that's only called once the
    // roster actually changes, and app.config.ts's sortBy reads this field
    // for placement even before this room has anyone in it.
    this.setMetadata({ racerCount: 0 });
    RaceRoom.instances.set(this.roomId, this);
    console.log("[RaceRoom] created:", this.roomId);

    // NOTE on multi-room matchmaking: joinOrCreate("race_room") now places
    // new visitors into whichever unlocked instance already has the most
    // racers (see app.config.ts's sortBy), spawning a fresh instance once
    // every existing one is locked (see the countdown lock rule above) or
    // gone. When the last person in an instance leaves, it's disposed; that's
    // fine, a new one gets created on demand for the next visitor. If you
    // later need a room (and its in-memory race state) to survive empty
    // periods, uncomment:
    // this.autoDispose = false;
  }

  /**
   * Message handlers (Colyseus 0.17 style).
   * These are arrow functions so `this` refers to the room instance.
   * Clients trigger them with room.send("setStatus", { racing: true }).
   */
  messages = {
    setStatus: (client: Client, payload: { racing?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return; // unknown client, ignore

      const wantsToRace = !!payload?.racing;

      // Backing out is always allowed, from any of the three "I want in"
      // states: bailing out of a live race, giving up a reserved slot before
      // the next race, or leaving the race queue.
      if (!wantsToRace) {
        player.status = "watching";
        player.waitlistOrder = 0;
        this.onRosterChanged();
        return;
      }

      // Already racing, holding a slot, or in line - opting in again is a
      // no-op. Without this an extra/duplicate message would re-stamp their
      // ordering key and jump them to the back of their own list.
      if (player.status !== "watching") return;

      // Racer slots are capped at MAX_RACERS, counting queued players (their
      // slot is already reserved - see Player.status) and seats being held for
      // players mid-redirect (see reserveSlots), so opting in from in here
      // can't snatch a seat out from under someone already on their way to it.
      // With every slot taken, opting in means getting in LINE for one: no
      // slot is held, and promoteFromWaitlist() moves them in the moment one
      // frees up. (This used to be a silent refusal, which surfaced
      // client-side as a dead "Race Full" button.)
      if (this.countCommittedSlots() >= MAX_RACERS) {
        player.status = "waitlist";
        player.waitlistOrder = this.nextWaitlistOrder++;
        this.onRosterChanged();
        return;
      }

      // A slot is free, so the one decision left is: does this put them in the
      // race being set up right now, or reserve them a slot in the one AFTER
      // it? A live race, a results screen, or a countdown too far along to
      // join all become "you're in the next one".
      player.status = this.acceptsNewRacers() ? "racing" : "queued";
      // Stamped here, on taking the slot, rather than when a "queued" player
      // is later promoted: the queue's whole point is that you're in line from
      // the moment you opt in, so that's the moment the order is fixed.
      player.slotOrder = this.nextSlotOrder++;
      this.onRosterChanged();
    },

    // Lets a client rename itself at any time, including mid-race; it's a
    // cosmetic label only, so there's no need to lock it to any phase.
    setName: (client: Client, payload: { name?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const name = (payload?.name ?? "").toString().trim().slice(0, 20);
      player.name = name || "guest";
    },

    // Lets a client pick its own racer avatar, any time. Cosmetic only, so no
    // phase gate. Any single emoji is accepted (see isEmoji); anything that
    // isn't one is silently ignored, so Player.emoji can never hold arbitrary
    // client-supplied text.
    setEmoji: (client: Client, payload: { emoji?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const emoji = (payload?.emoji ?? "").toString().trim();
      if (!isEmoji(emoji)) return;
      player.emoji = emoji;
    },

    sendChat: (client: Client, payload: { text?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const text = (payload?.text ?? "").toString().trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
      if (!text) return;

      const msg = new ChatMessage();
      msg.sessionId = client.sessionId;
      msg.name = player.name;
      msg.emoji = player.emoji;
      msg.text = text;
      msg.sentAt = Date.now();
      this.pushChatMessage(msg);
    },

    typeProgress: (client: Client, payload: { input?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (this.state.phase !== "racing" || player.status !== "racing" || player.finished) return;

      this.lastActivityBySession.set(client.sessionId, Date.now());

      // Clamp: we only ever need up to quote.length characters to score this.
      const input = (payload?.input ?? "").toString().slice(0, this.state.quote.length);
      const correctChars = this.countMatchingChars(input);
      const quoteLength = this.state.quote.length;

      this.correctCharsBySession.set(client.sessionId, correctChars);
      player.progress = quoteLength > 0 ? correctChars / quoteLength : 0;
      player.wpm = this.calcWpm(correctChars);

      if (quoteLength > 0 && correctChars === quoteLength) {
        player.finished = true;
        player.place = this.nextPlace++;
        if (this.allRacersFinished()) {
          this.endRace();
        }
      }
    },

    // User-initiated lobby switch (see match-making.md's "Full Room
    // Spectators", generalized per user request to always be available,
    // regardless of current phase or the player's own racing/spectating
    // status). Always allowed - unlike setStatus's racing transition, there's
    // no phase gate here; leaving mid-race to go elsewhere is the player's
    // call. Reuses the exact same "redirect" mechanism as post-race merging
    // (see attemptMerge()), just for one client instead of the whole room,
    // and without disconnecting/killing this room.
    switchLobby: (client: Client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      // Always requires the target to have a free racer slot right now,
      // regardless of whether this player is racing, queued or spectating (a
      // deliberate simplification: guarantees "switch lobby" always lands
      // somewhere with room to grow, not just any room). An
      // incomingRacerCount of 1 is exactly "needs at least one free slot" -
      // the same eligibility findMergeTarget already uses for merges, just
      // sized for one switching player instead of a whole room's worth.
      const target = RaceRoom.findMergeTarget(this, 1);
    // Hold that seat until this client actually lands (see reserveSlots) -
    // exactly the one seat findMergeTarget was asked to verify. Only for a
    // player who'll try to claim one on arrival, which is the same condition
    // as the `resumeRacing` flag below: a spectator switching rooms needs the
    // target to have room (that's the policy above) but doesn't take a seat
    // when they get there, so holding one would just idle it for 5 seconds.
    if (target && player.status !== "watching") target.reserveSlots([player.clientId]);
      // `soloSwitch: true` distinguishes this (one player leaving alone) from
      // a whole-room merge's redirect (attemptMerge, no such flag). The
      // client uses it to decide what to do with its "who's already in my
      // lobby" set: a solo switcher leaves everyone in this room BEHIND, so
      // they must forget them (else a person they knew here who later merges
      // into the destination would be wrongly suppressed as "already known" -
      // see client/index.html's myKnownClientIds); a merge moves the whole
      // room together, so those teammates ARE still with you and stay known.
      client.send("redirect", { roomId: target?.roomId ?? null, resumeRacing: player.status !== "watching", soloSwitch: true });

      // Only this one client leaves (not this.disconnect(), which would
      // kill the whole room for everyone else still here). Must pass
      // CloseCode.CONSENTED explicitly: Colyseus's own _onLeave picks
      // onLeave (final, real cleanup) vs onDrop (this room's onDrop always
      // calls allowReconnection - see above) purely by close code, and
      // client.leave()'s default code is a plain 1000, which routes through
      // onDrop. That was letting the client-side SDK's own automatic
      // reconnection (unrelated to this codebase's onDrop/reconnect-token
      // logic - see @colyseus/sdk's Room.reconnection) silently reconnect
      // to the room being switched away from a moment later, resurrecting
      // its listeners alongside the new room's and making the UI flicker
      // between both rooms' state until the old one's race ended (found via
      // manual testing). CONSENTED skips onDrop entirely, so this session
      // is really, finally gone, exactly like the player clicking a normal
      // "leave" would be - no reconnection offered, none attempted.
      client.leave(CloseCode.CONSENTED);
    },

    // ---- Admin testing tool (see ADMIN_KEY, and client/index.html's admin
    // panel). Both handlers are gated on the shared secret: an unset ADMIN_KEY
    // or a mismatched `key` is silently rejected, so nobody without the key can
    // spawn or clear bots even if they discover these message names. Bots are
    // real synced Player entries, so they appear and behave like ordinary
    // players to everyone in the room. ----

    // Populate the room with simulated players. `racers` of them take a racer
    // slot (subject to MAX_RACERS - overflow lands on the waitlist, the same as
    // real opt-ins), `spectators` of them just watch, and racer bots type at
    // roughly `wpm` (jittered per bot). Replies with a "botResult" ack the panel
    // shows.
    spawnBots: (client: Client, payload: { key?: string; racers?: number; spectators?: number; wpm?: number }) => {
      if (!this.isAdmin(payload?.key)) {
        client.send("botResult", { ok: false, message: "Unauthorized (bad or missing admin key)." });
        return;
      }
      const racers = clampInt(payload?.racers, 0, BOT_MAX_TOTAL);
      const spectators = clampInt(payload?.spectators, 0, BOT_MAX_TOTAL);
      const wpm = clampInt(payload?.wpm, BOT_MIN_WPM, BOT_MAX_WPM);
      const total = Math.min(racers + spectators, BOT_MAX_TOTAL);
      if (total <= 0) {
        client.send("botResult", { ok: false, message: "Nothing to spawn (set racers or spectators above 0)." });
        return;
      }

      let addedRacing = 0;
      let addedQueued = 0;
      let addedWaitlist = 0;
      let addedWatching = 0;

      // Racer bots first so they claim the free slots before spectators (spawn
      // order otherwise wouldn't matter, but this keeps the counts predictable).
      const wantRacer = Math.min(racers, total);
      const wantSpectator = total - wantRacer;

      for (let i = 0; i < wantRacer; i++) {
        const p = this.makeBotPlayer(wpm);
        // Same slot logic real opt-in uses (see setStatus): a free committed
        // slot means racing-or-queued (by acceptsNewRacers), otherwise get in
        // line. Bots respect the cap exactly like players do.
        if (this.countCommittedSlots() < MAX_RACERS) {
          p.status = this.acceptsNewRacers() ? "racing" : "queued";
          p.slotOrder = this.nextSlotOrder++;
          if (p.status === "racing") addedRacing++; else addedQueued++;
        } else {
          p.status = "waitlist";
          p.waitlistOrder = this.nextWaitlistOrder++;
          addedWaitlist++;
        }
        this.registerBot(p);
      }
      for (let i = 0; i < wantSpectator; i++) {
        const p = this.makeBotPlayer(wpm);
        p.status = "watching";
        addedWatching++;
        this.registerBot(p);
      }

      // Starts the countdown if racer bots were added into a "waiting" room,
      // and pushes the new racerCount to clients/matchmaking - the same
      // re-evaluation any real opt-in triggers.
      this.onRosterChanged();

      const parts: string[] = [];
      if (addedRacing) parts.push(`${addedRacing} racing`);
      if (addedQueued) parts.push(`${addedQueued} queued`);
      if (addedWatching) parts.push(`${addedWatching} watching`);
      if (addedWaitlist) parts.push(`${addedWaitlist} waitlisted (room cap is ${MAX_RACERS})`);
      client.send("botResult", {
        ok: true,
        message: `Spawned ${total} bot${total === 1 ? "" : "s"}: ${parts.join(", ")}.`,
      });
    },

    // Remove every bot from the room and let the phase re-settle (a countdown
    // that only bots were feeding cancels itself back to "waiting").
    clearBots: (client: Client, payload: { key?: string }) => {
      if (!this.isAdmin(payload?.key)) {
        client.send("botResult", { ok: false, message: "Unauthorized (bad or missing admin key)." });
        return;
      }
      const count = this.botSessions.size;
      for (const sessionId of [...this.botSessions]) {
        this.removeBot(sessionId);
      }
      this.onRosterChanged();
      client.send("botResult", { ok: true, message: count > 0 ? `Cleared ${count} bot${count === 1 ? "" : "s"}.` : "No bots to clear." });
    },

    // Toggle the inactivity kick for this room (see afkKickDisabled). Admin-only,
    // like the bot tools, and acked on the same "botResult" channel the panel
    // already listens on. Purely a testing aid: it does not touch anyone's
    // current status, only whether future idle sweeps kick.
    setAfkKick: (client: Client, payload: { key?: string; disabled?: boolean }) => {
      if (!this.isAdmin(payload?.key)) {
        client.send("botResult", { ok: false, message: "Unauthorized (bad or missing admin key)." });
        return;
      }
      this.afkKickDisabled = !!payload?.disabled;
      client.send("botResult", {
        ok: true,
        message: this.afkKickDisabled
          ? "AFK kick disabled for this room - idle racers stay in."
          : "AFK kick re-enabled for this room.",
      });
    },
  };

  /** True only when the admin key is configured AND the request supplied it. */
  private isAdmin(key: string | undefined): boolean {
    return !!ADMIN_KEY && key === ADMIN_KEY;
  }

  private isBot(sessionId: string): boolean {
    return this.botSessions.has(sessionId);
  }

  /** Builds a bot Player (name/emoji/ids) and its per-bot simulated speed. Does NOT add it to state; see registerBot. */
  private makeBotPlayer(avgWpm: number): Player {
    const id = `bot:${this.roomId}:${this.nextBotId++}`;
    const p = new Player();
    p.name = randomBotName();
    p.emoji = randomEmoji();
    p.clientId = id;
    // Jitter each bot's speed around the requested average so the field doesn't
    // move in lockstep, then keep it in the sane band.
    const jitter = 1 + (Math.random() * 2 - 1) * BOT_WPM_VARIANCE;
    const wpm = Math.max(BOT_MIN_WPM, Math.min(BOT_MAX_WPM, Math.round(avgWpm * jitter)));
    this.botSim.set(id, { wpm, startDelayMs: Math.random() * BOT_MAX_START_DELAY_MS });
    return p;
  }

  /** Commits a built bot into synced state + the bot registry, and announces it like any join. */
  private registerBot(p: Player) {
    // Its synthetic sessionId is the same as its clientId - a bot has no real
    // Colyseus session, so there's nothing to keep them distinct.
    const sessionId = p.clientId;
    this.botSessions.add(sessionId);
    // botSim is already keyed by this same id (see makeBotPlayer), so the
    // ticker - which reads by sessionId - finds it directly.
    this.state.players.set(sessionId, p);
    this.postSystemMessage(`${p.name} joined the lobby.`, p.clientId, false);
  }

  /** Fully removes a bot: synced entry, registry, and all per-race scratch maps. */
  private removeBot(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (p) this.postSystemMessage(`${p.name} left the lobby.`, p.clientId, true);
    this.state.players.delete(sessionId);
    this.botSessions.delete(sessionId);
    this.botSim.delete(sessionId);
    this.correctCharsBySession.delete(sessionId);
    this.lastActivityBySession.delete(sessionId);
  }

  private allRacersFinished(): boolean {
    let allDone = true;
    this.state.players.forEach((p) => {
      if (p.status === "racing" && !p.finished) allDone = false;
    });
    return allDone;
  }

  /** Longest prefix of `input` that matches `state.quote`, character-for-character. */
  private countMatchingChars(input: string): number {
    const quote = this.state.quote;
    const max = Math.min(input.length, quote.length);
    let i = 0;
    while (i < max && input[i] === quote[i]) i++;
    return i;
  }

  /** Standard WPM convention: 1 "word" = 5 characters. */
  private calcWpm(correctChars: number): number {
    const elapsedMinutes = (Date.now() - this.raceStartedAt) / 60000;
    const wordsTyped = correctChars / 5;
    return elapsedMinutes > 0 ? Math.round(wordsTyped / elapsedMinutes) : 0;
  }

  /**
   * Runs every 500ms while a race is live. Recomputes wpm for every
   * still-racing, not-yet-finished racer using their last-known
   * correct-character count. This is what makes wpm visibly tick (and decay
   * if someone stops typing) instead of only updating per keystroke. Also
   * ticks `state.countdown` down as a race-timeout display (see RACE_TIMEOUT_MS),
   * and auto-moves anyone idle for INACTIVITY_TIMEOUT_MS to spectating.
   */
  private tickRace() {
    const now = Date.now();
    const remainingMs = RACE_TIMEOUT_MS - (now - this.raceStartedAt);
    this.state.countdown = Math.max(0, Math.ceil(remainingMs / 1000));

    const idlePlayers: Player[] = [];
    this.state.players.forEach((p, sessionId) => {
      if (p.status !== "racing" || p.finished) return;
      // Bots' wpm/progress/finish are owned entirely by tickBots(); leaving
      // them out here keeps the two tickers from fighting and, since a bot
      // never has real "activity", keeps the AFK sweep below from kicking one.
      if (this.isBot(sessionId)) return;
      p.wpm = this.calcWpm(this.correctCharsBySession.get(sessionId) ?? 0);

      // WPM still ticks (and decays) above; only the kick is suppressed, so a
      // disabled sweep still shows an idle racer slowing to 0 - it just leaves
      // them in the race. See afkKickDisabled.
      if (this.afkKickDisabled) return;
      const lastActivity = this.lastActivityBySession.get(sessionId) ?? this.raceStartedAt;
      if (now - lastActivity >= INACTIVITY_TIMEOUT_MS) {
        idlePlayers.push(p);
      }
    });

    if (idlePlayers.length === 0) return;

    // Same effect as clicking Spectate themselves, plus the `afk` tag so
    // clients keep their leaderboard row in place. Applied after the forEach
    // above (not during) to avoid mutating the map while iterating it.
    for (const p of idlePlayers) {
      p.status = "watching";
      p.afk = true;
    }
    // Slots just freed, so the race queue advances into them (as "queued" -
    // acceptsNewRacers() is false mid-race - so this can't drop someone into
    // a race already underway, nor affect the countRacers() checks below).
    this.promoteFromWaitlist();
    this.updateRacerCount();

    if (this.countRacers() === 0) {
      this.resetToWaiting();
    } else if (this.allRacersFinished()) {
      // Everyone still racing had already finished; the idle ones were the
      // only holdouts, so the race is effectively over now.
      this.endRace();
    }
  }

  /**
   * Drives every racing bot's typing during a live race (see the "spawnBots"
   * handler). Runs on its own faster interval than tickRace so the progress
   * bars move smoothly. Each bot's correct-char count is derived from how long
   * the race has been going and its own target wpm (minus a small per-bot
   * reaction delay), which the server treats exactly like a real racer's
   * counted input: it drives progress/wpm and, on reaching the full quote,
   * finish + place + the same end-of-race check typeProgress does. Purely a
   * function of elapsed time, so it self-corrects if a tick is skipped and a
   * reconnecting spectator sees a consistent position.
   */
  private tickBots() {
    if (this.state.phase !== "racing") return;
    const quoteLength = this.state.quote.length;
    const elapsedMs = Date.now() - this.raceStartedAt;
    let anyFinishedNow = false;

    this.state.players.forEach((p, sessionId) => {
      if (p.status !== "racing" || p.finished) return;
      const sim = this.botSim.get(sessionId);
      if (!sim) return; // not a bot, or a bot with no sim entry (shouldn't happen)

      const typingMs = Math.max(0, elapsedMs - sim.startDelayMs);
      // wpm * 5 chars per word, per minute of actual typing.
      const targetChars = Math.floor((sim.wpm * 5 * typingMs) / 60000);
      const correctChars = Math.max(0, Math.min(quoteLength, targetChars));

      this.correctCharsBySession.set(sessionId, correctChars);
      // Keep the AFK sweep in tickRace() from ever seeing a bot as idle (it
      // already skips bots, but this keeps the map coherent for any reader).
      this.lastActivityBySession.set(sessionId, Date.now());
      p.progress = quoteLength > 0 ? correctChars / quoteLength : 0;
      p.wpm = this.calcWpm(correctChars);

      if (quoteLength > 0 && correctChars === quoteLength) {
        p.finished = true;
        p.place = this.nextPlace++;
        anyFinishedNow = true;
      }
    });

    // Mirror typeProgress: only check for race end after the loop, and only if
    // a bot actually crossed the line this tick.
    if (anyFinishedNow && this.allRacersFinished()) this.endRace();
  }

  onJoin(client: Client, options: { name?: string; resumeRacing?: boolean; clientId?: string; emoji?: string }) {
    const player = new Player();
    player.name = (options?.name || "guest").toString().slice(0, 20);
    // Honor a client-remembered avatar if it's one of ours (a returning
    // visitor sends back whatever they had last time, including a random
    // one the server assigned before - so it stays stable across reloads),
    // otherwise assign a fresh random one.
    const requestedEmoji = (options?.emoji ?? "").toString().trim();
    player.emoji = isEmoji(requestedEmoji) ? requestedEmoji : randomEmoji();
    // Falls back to the (session-scoped) sessionId if the client somehow
    // didn't send one; only degrades the "don't re-announce a known
    // teammate" feature for that one join, doesn't break anything else.
    player.clientId = (options?.clientId || client.sessionId).toString().slice(0, 64);
    // Ordinarily everyone starts as a spectator; the one exception is a
    // client arriving via a post-race merge/Switch Lobby redirect (see
    // attemptMerge()/the "switchLobby" handler), which passes `resumeRacing`
    // to preserve "this player wanted a racer slot" across the room swap -
    // set for anyone who was racing OR queued over there, since both mean the
    // same thing on arrival: put me in a race here.
    //
    // Whether that's still honorable is re-checked here rather than trusted
    // from the redirect, because the target's roster/countdown can shift in
    // the gap between the redirect decision and this join (an unrelated
    // visitor taking the last slot, or the countdown ticking past
    // LOCK_AT_COUNTDOWN_SECONDS - findMergeTarget only checked those at
    // *selection* time). A free slot is the hard requirement; missing it means
    // spectating. Missing only acceptsNewRacers() - landing mid-race, on a
    // results screen, or in a countdown's final seconds - is no longer fatal
    // though: that's exactly what "queued" is for, so they keep their slot and
    // race in the next one instead of silently losing it.
    //
    // A seat held for this exact client (see reserveSlots) is claimed first,
    // which is what makes the re-check below pass for them: dropping the hold
    // frees the very seat it was protecting, and only for whoever it was held
    // for. Claimed on ANY arrival, not just one still wanting to race - a
    // client that changed its mind in transit must release the hold rather
    // than leave the seat idling until it lapses.
    const claimedReservation = this.slotReservations.delete(player.clientId);
    const wantsIn = !!options?.resumeRacing;
    const wantsSlot = wantsIn && this.countCommittedSlots() < MAX_RACERS;
    player.status = !wantsIn ? "watching"
      : !wantsSlot ? "waitlist" // arrived wanting in, but the slots are gone: get in line rather than lose the intent entirely
      : this.acceptsNewRacers() ? "racing" : "queued";
    // Arriving with a slot counts as taking one here (this room's ordering is
    // its own - a merged-in racer takes their place behind whoever was already
    // racing here, in arrival order).
    if (wantsSlot) player.slotOrder = this.nextSlotOrder++;
    else if (wantsIn) player.waitlistOrder = this.nextWaitlistOrder++;
    this.state.players.set(client.sessionId, player);

    // Dedup by clientId: one browser tab (its persistent clientId) must never
    // appear twice in the same room. A rare client-side race on rapid Switch
    // Lobby can land two sessions for the same tab; kick the older one(s) so
    // the player never shows up duplicated in a lobby. Only runs when a real
    // clientId was sent - the sessionId fallback is unique per session, so this
    // can never false-match across genuinely different tabs. The kicked
    // session's "left the lobby" is suppressed (see dedupKicking / onLeave):
    // the tab isn't leaving, just shedding a stale duplicate.
    if (options?.clientId) {
      for (const c of this.clients) {
        if (c.sessionId === client.sessionId) continue;
        const other = this.state.players.get(c.sessionId);
        if (other && other.clientId === player.clientId) {
          this.dedupKicking.add(c.sessionId);
          // Remove from the synced state SYNCHRONOUSLY so the duplicate never
          // shows in the roster, not even for the one broadcast before the
          // async connection close lands - otherwise a continuous Switch-Lobby
          // spam keeps a transient duplicate visible the whole time. onLeave's
          // own delete then no-ops.
          this.state.players.delete(c.sessionId);
          c.leave(CloseCode.CONSENTED);
        }
      }
    }

    this.postSystemMessage(`${player.name} joined the lobby.`, player.clientId, false);
    console.log(`[RaceRoom] ${player.name} joined, ${this.state.players.size} online`);
    // Only if they took a slot (racing or queued): a plain spectator changes
    // neither the racer count nor the phase, so there's nothing to re-evaluate.
    // Unless they arrived holding a reservation and DIDN'T take a slot - then
    // releasing it just freed one, which the waitlist should get a shot at.
    if (player.status !== "watching" || claimedReservation) this.onRosterChanged();
  }

  /**
   * Called on an abrupt disconnect (refresh, network blip, tab close) -
   * anything that isn't a deliberate, consented leave. Opens a grace window
   * during which the Player entry stays put (untouched) and the client can
   * reconnect with the same sessionId via `allowReconnection`. Deliberately
   * not awaited: this fires it off and returns immediately, so the room
   * keeps running normally while the window is open in the background.
   * `onLeave` below runs the real cleanup, but only if the window elapses
   * without a reconnect.
   *
   * `code` is the raw WebSocket close code. A tab close / page refresh sends a
   * clean close (1001 "going away", occasionally 1000), so those get the short
   * UNLOAD_GRACE_SECONDS and disappear from the roster quickly. A network blip
   * has no clean close frame - the server's ping-timeout terminates the socket,
   * surfacing as an abnormal 1006 - so anything else keeps the longer
   * RECONNECTION_GRACE_SECONDS, so a momentary drop doesn't lose the seat.
   * (A refresh is a clean close too, hence UNLOAD_GRACE can't go below what a
   * refresh needs to reconnect without reintroducing the join/leave flicker.)
   */
  onDrop(client: Client, code: number) {
    // A clean browser close (1001/1000) OR a beacon-triggered terminate (which
    // surfaces as an abnormal 1006 - see handleLeaveBeacon) is a deliberate
    // unload, so it gets the short grace. Anything else (a real ping-timeout
    // network blip) keeps the longer grace.
    const beaconLeave = this.beaconLeaving.delete(client.sessionId);
    const cleanClose = code === 1000 || code === 1001 || beaconLeave;
    this.allowReconnection(client, cleanClose ? UNLOAD_GRACE_SECONDS : RECONNECTION_GRACE_SECONDS);
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    console.log(`[RaceRoom] ${player?.name ?? client.sessionId} reconnected`);
  }

  onLeave(client: Client, code: number) {
    // Reached either for a consented leave, or once a dropped client's
    // reconnection window (see onDrop) elapses without them coming back.
    const player = this.state.players.get(client.sessionId);
    // Skip the "left" announcement during a post-race merge's mass teardown
    // (see attemptMerge's `isMerging` flag): every remaining client leaves
    // simultaneously as part of the SAME event there, not individually, and
    // the whole point of a merge is that it never reads as anyone "leaving" -
    // they're framed as joining wherever they land instead (see onJoin). Not
    // gated by close code: a Switch Lobby departure ALSO uses
    // CloseCode.CONSENTED (same as a merge's mass disconnect) but SHOULD
    // post "left the lobby" here, so the two can't be told apart that way.
    // Also skip it for a duplicate-session kick (see onJoin's clientId dedup):
    // the tab isn't leaving, we're just shedding a stale duplicate of it.
    const wasDedupKick = this.dedupKicking.delete(client.sessionId);
    if (player && !this.isMerging && !wasDedupKick) {
      this.postSystemMessage(`${player.name} left the lobby.`, player.clientId, true);
    }
    this.state.players.delete(client.sessionId);
    console.log(`[RaceRoom] left, ${this.state.players.size} online`);
    this.onRosterChanged();
  }

  onDispose() {
    this.countdownTimer?.clear();
    this.wpmTicker?.clear();
    this.raceTimeoutTimer?.clear();
    this.botTicker?.clear();
    RaceRoom.instances.delete(this.roomId);
    console.log("[RaceRoom] disposed:", this.roomId);
  }

  /** Re-evaluate the phase after a join/leave/status change. */
  private onRosterChanged() {
    // First, because this is the choke point every slot-freeing path runs
    // through (Spectate, a departure, a switch away): whoever's next in line
    // takes the slot before anything below counts racers, so a promotion into
    // an empty "waiting" room starts that room's countdown in this same pass.
    this.promoteFromWaitlist();

    const racerCount = this.countRacers();
    this.updateRacerCount();

    // A single queued racer is enough to start the countdown, regardless of
    // how many spectators are around (see match-making.md's "Solo Play");
    // spectators were never part of the threshold, they just share the
    // chat/roster without occupying a racer slot. Post-race merging
    // (separate step) is what's meant to fold a solo racer into a
    // multiplayer lobby afterward. Once running, the countdown/race only
    // cancels/resets if EVERY racer drops out (racerCount reaches 0) - losing
    // some but not all racers just continues with whoever's left, instead of
    // cancelling and waiting to restart (which used to introduce a stall
    // whenever a racer left a 2+ person countdown/race).
    if (this.state.phase === "waiting" && racerCount >= 1) {
      this.startCountdown();
    } else if (this.state.phase === "countdown" && racerCount === 0) {
      this.cancelCountdown();
    } else if (this.state.phase === "racing" && racerCount === 0) {
      // Everyone bailed to spectate mid-race. Nothing left to race.
      this.resetToWaiting();
    } else if (this.state.phase === "racing" && this.allRacersFinished()) {
      // A racer leaving (Switch Lobby / disconnect) or bailing to spectate
      // mid-race can leave everyone who's STILL in the race already finished.
      // Without this, endRace() would only ever fire from the last finisher's
      // own typeProgress (which already happened, back when this now-departed
      // racer was still going) or the full RACE_TIMEOUT_MS - so the finishers
      // would sit stuck on "Race in progress" for up to a minute. Mirrors the
      // same all-finished check tickRace() already does after AFK removals.
      // racerCount > 0 here (the === 0 case is handled just above), so this is
      // genuinely "all REMAINING racers are done", not the empty-race case.
      this.endRace();
    }
  }

  /**
   * How many players are in the race currently being set up or run. This is
   * the RACE LIFECYCLE number - what decides whether a countdown starts,
   * cancels, or a live race has anyone left in it - so it deliberately
   * excludes "queued" players, who belong to the race after this one and
   * mustn't be able to keep the current one alive (or start one) on their own.
   * For "is there room for one more", use countTakenSlots() instead.
   */
  private countRacers(): number {
    let count = 0;
    this.state.players.forEach((p) => {
      if (p.status === "racing") count++;
    });
    return count;
  }

  /**
   * How many of MAX_RACERS's slots are spoken for: racers PLUS queued players,
   * since queueing reserves a real slot the moment it's taken (see
   * Player.status). This is the CAPACITY number - every "does another racer
   * fit here" decision reads it, whether that's this room's own opt-in cap,
   * a merge target's free slots, or a redirected client's arrival re-check.
   */
  private countTakenSlots(): number {
    let count = 0;
    this.state.players.forEach((p) => {
      if (p.status === "racing" || p.status === "queued") count++;
    });
    return count;
  }

  /**
   * Holds one racer seat here for each of `clientIds` (see Player.clientId)
   * until they arrive or SLOT_RESERVATION_MS elapses.
   *
   * Called by the SOURCE room on the target it just picked, before it
   * redirects anyone (see attemptMerge / the "switchLobby" handler). It closes
   * the gap between a target being *chosen* and the redirected client actually
   * *landing*: those are separate moments with a reconnect handshake in
   * between, and without a hold, findMergeTarget's answer is only advisory.
   * Two rooms whose races end a moment apart both look for the fullest room
   * with space, so they can easily pick the SAME target and be told the same
   * last seat is free - and whoever's handshake lands second used to lose it
   * silently. Anything else that could take the seat meanwhile (a spectator
   * here clicking Join, a waitlist promotion) is held off the same way, since
   * every capacity decision reads countCommittedSlots().
   *
   * Keyed by clientId rather than sessionId deliberately: a redirect issues a
   * brand new sessionId on arrival, while clientId is stable for the whole
   * browser tab - it's the only identifier that survives the jump.
   *
   * Reserve exactly what was checked for: whatever count findMergeTarget was
   * asked to verify is what may be held, or a room could reserve seats whose
   * existence nobody ever confirmed.
   */
  private reserveSlots(clientIds: string[]) {
    const expiresAt = Date.now() + SLOT_RESERVATION_MS;
    for (const clientId of clientIds) {
      if (clientId) this.slotReservations.set(clientId, expiresAt);
    }
    // Holding a seat doesn't change who's racing, so there's no phase to
    // re-evaluate - but the room IS fuller now, for clients and for
    // matchmaking placement alike.
    this.updateRacerCount();
    // Purely a nudge to re-evaluate once these lapse, so a hold nobody claimed
    // doesn't leave the room showing itself as full (and any waitlister stuck
    // in line) until some unrelated roster change happens along. Correctness
    // never depends on it firing - see activeReservations.
    this.clock.setTimeout(() => this.onRosterChanged(), SLOT_RESERVATION_MS + 50);
  }

  /**
   * How many held seats are still live, discarding any that have lapsed.
   *
   * The purge happens HERE, on every read, rather than in the timer that
   * reserveSlots sets: a hold then cannot outlive its window even if that
   * timer never runs (the room disposed, the clock stopped, the callback threw
   * on the way in). That matters more than it might seem - a leaked hold is
   * strictly worse than the problem reservations solve, since it would show
   * the room as permanently fuller than it is, with a phantom seat nobody can
   * claim and nobody can free.
   */
  private activeReservations(): number {
    const now = Date.now();
    for (const [clientId, expiresAt] of this.slotReservations) {
      if (expiresAt <= now) this.slotReservations.delete(clientId);
    }
    return this.slotReservations.size;
  }

  /**
   * The real capacity number: seats sat in (countTakenSlots) PLUS seats held
   * for people on their way here (activeReservations). Every "does another
   * racer fit" decision reads this - the in-room opt-in, waitlist promotion, a
   * redirected arrival's re-check, and merge-target eligibility - so a held
   * seat is as spoken for as an occupied one, whoever is asking.
   *
   * countTakenSlots() is still the right number for the other question,
   * "how many of MY people need a seat somewhere" (see attemptMerge), which is
   * about players and not about holds.
   */
  private countCommittedSlots(): number {
    return this.countTakenSlots() + this.activeReservations();
  }

  /**
   * Whether opting in right now lands you in the race being set up, or only
   * in the queue for the one after it. True while "waiting", and during a
   * "countdown" that still has more than LOCK_AT_COUNTDOWN_SECONDS to go;
   * false once a race is live, while results are up, and in the countdown's
   * final seconds.
   *
   * Read by BOTH the in-room opt-in (setStatus) and the arrival check for
   * redirected clients (onJoin), which is deliberate: it's the same question
   * either way, and the same threshold that pulls this room out of
   * matchmaking placement (see LOCK_AT_COUNTDOWN_SECONDS). It used to differ -
   * someone already in the room could join right up until the race started,
   * on the reasoning that they'd been watching the countdown and so couldn't
   * be surprised by it - but now that missing the cutoff means "queued for the
   * next race" rather than "rejected, stay a spectator", there's nothing left
   * for that exception to buy them.
   */
  private acceptsNewRacers(): boolean {
    if (this.state.phase === "waiting") return true;
    if (this.state.phase === "countdown") return this.state.countdown > LOCK_AT_COUNTDOWN_SECONDS;
    return false; // "racing" / "finished"
  }

  /**
   * Moves everyone waiting on the next race into it (see Player.status's
   * "queued"). Called from resetToWaiting(), which is the single point where
   * the room starts setting up a fresh race - and thus the moment "the next
   * race" becomes "this race". Safe to promote all of them unconditionally:
   * queued players already hold their slots, so racers + queued can never
   * exceed MAX_RACERS in the first place.
   */
  private promoteQueuedRacers() {
    this.state.players.forEach((p) => {
      if (p.status === "queued") p.status = "racing";
    });
  }

  /**
   * Hands every free racer slot to the front of the race queue (see
   * Player.status's "waitlist"), in `waitlistOrder`, until either the queue
   * empties or the slots fill back up.
   *
   * Note what does NOT free a slot: a race merely ending. Racers keep their
   * slots for the next race, so the queue only advances when someone actually
   * gives one up (Spectate, going AFK mid-race) or leaves the room - which is
   * why this hangs off onRosterChanged() and the AFK sweep rather than the
   * race lifecycle.
   *
   * A promoted player lands as "racing" or "queued" by the same rule as
   * opting in normally does (see acceptsNewRacers), so getting in off the
   * queue mid-race means the next race, not this one. They're stamped a fresh
   * slotOrder, which puts them at the END of the racer list - correct, since
   * that's exactly when they took the slot.
   *
   * Callers must run updateRacerCount() afterward: this changes who holds a
   * slot but deliberately doesn't push the count itself, so a caller doing
   * several roster mutations only syncs once.
   */
  private promoteFromWaitlist() {
    // countCommittedSlots, so a seat being held for someone mid-redirect isn't
    // handed to the queue out from under them.
    while (this.countCommittedSlots() < MAX_RACERS) {
      let next: Player | undefined;
      this.state.players.forEach((p) => {
        if (p.status !== "waitlist") return;
        if (!next || p.waitlistOrder < next.waitlistOrder) next = p;
      });
      if (!next) return; // queue empty; the remaining slots just stay open
      next.status = this.acceptsNewRacers() ? "racing" : "queued";
      next.slotOrder = this.nextSlotOrder++;
      next.waitlistOrder = 0;
    }
  }

  /**
   * Pushes the current slot occupancy into both synced state
   * (`state.racerCount`, for clients) and matchmaking metadata (`setMetadata`,
   * for the `.sortBy({"metadata.racerCount": -1})` fullest-first placement in
   * app.config.ts). Call after anything that can change who holds a slot.
   */
  private updateRacerCount() {
    // Held seats included: a room with one is genuinely fuller, and leaving
    // them out would have the client show "4 / 5" with a Join Race button that
    // the server then answers with a waitlist spot. Better a count that's
    // briefly ahead of the visible roster than a button that lies.
    const racerCount = this.countCommittedSlots();
    this.state.racerCount = racerCount;
    this.setMetadata({ racerCount });
  }

  /**
   * Picks a new quote and bumps `quoteId` so clients can reliably detect "a
   * new race just started" even on the (~1-in-4) chance the same quote text
   * gets picked twice in a row.
   */
  private assignNewQuote() {
    this.state.quoteId++;
    this.state.quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  }

  private startCountdown() {
    this.state.phase = "countdown";
    this.state.countdown = COUNTDOWN_SECONDS;
    // `state.quote` was already picked (room creation or the last
    // resetToWaiting()) and has been previewable during "waiting"; keep the
    // same one through the countdown and into the race.

    this.countdownTimer = this.clock.setInterval(() => {
      this.state.countdown--;
      // Countdown lock rule: pull this room out of matchmaking placement once
      // it's about to start, so a brand new visitor can't land here with only
      // a couple seconds to get their bearings. Existing connections are
      // unaffected; this only stops joinOrCreate from offering this room to
      // people who haven't connected yet.
      if (this.state.countdown <= LOCK_AT_COUNTDOWN_SECONDS) {
        this.lock();
      }
      if (this.state.countdown <= 0) {
        this.startRace();
      }
    }, 1000);
  }

  private cancelCountdown() {
    this.countdownTimer?.clear();
    this.countdownTimer = null;
    // Keep the same quote: the countdown was cancelled before any race
    // actually ran (e.g. the only queued racer clicked Join then Spectate),
    // so there's nothing to reroll. The quote should only change after a race
    // is actually run (see resetToWaiting's callers) or on a lobby switch
    // (which lands you in a different room's quote entirely).
    this.resetToWaiting(false);
  }

  /**
   * Returns the room to "waiting". `pickNewQuote` controls whether the next
   * quote is rerolled: true after a race has actually run (post-results, or a
   * mid-race abort where everyone left/idled out), false when a countdown was
   * cancelled before the race started - in that case the previewed quote
   * should stay put rather than switch out from under everyone.
   *
   * This is also where anyone queued for "the next race" gets promoted into
   * it (see promoteQueuedRacers), since settling back to "waiting" is exactly
   * the moment the next race becomes the current one - so it ends by
   * re-evaluating the roster, which is what actually starts that race's
   * countdown. Callers therefore don't need to call onRosterChanged
   * themselves. Safe from recursion despite onRosterChanged being one of those
   * callers: it only reaches here while the phase is "racing", and the phase
   * is "waiting"/"countdown" by the time the nested call reads it.
   */
  private resetToWaiting(pickNewQuote: boolean = true) {
    this.countdownTimer?.clear();
    this.countdownTimer = null;
    this.wpmTicker?.clear();
    this.wpmTicker = null;
    this.raceTimeoutTimer?.clear();
    this.raceTimeoutTimer = null;
    this.botTicker?.clear();
    this.botTicker = null;
    this.correctCharsBySession.clear();
    this.lastActivityBySession.clear();
    this.state.phase = "waiting";
    this.state.countdown = 0;
    // Defensive: covers the countdown being cancelled while already locked
    // (e.g. players bail out past the 5-second mark). A no-op otherwise.
    this.unlock();
    // Pick the next race's quote right away so it's visible during "waiting"
    // too, not just once someone queues and the countdown starts - but only
    // when a race actually ran (see the doc comment / pickNewQuote).
    if (pickNewQuote) this.assignNewQuote();

    // Clear last race's stats immediately (not just at the next startRace())
    // so the leaderboard doesn't show stale wpm/progress/place while sitting
    // in "waiting"/"countdown" before the next race actually begins.
    this.state.players.forEach((p) => {
      p.progress = 0;
      p.wpm = 0;
      p.finished = false;
      p.place = 0;
      p.afk = false;
    });

    // "The next race" is now this one: everyone who queued for it joins it.
    this.promoteQueuedRacers();
    // Starts that race's countdown if the promotion (or anyone still queued
    // from before) left us with racers. Also the only re-evaluation the
    // callers get - see this method's doc comment.
    this.onRosterChanged();
  }

  private startRace() {
    this.countdownTimer?.clear();
    this.countdownTimer = null;
    this.state.countdown = Math.ceil(RACE_TIMEOUT_MS / 1000);
    // `state.quote` has been set (and previewable) since "waiting"; keep the
    // same one for the actual race.
    this.state.phase = "racing";
    // Unlock: a live race is a perfectly fine spectating destination for a
    // new visitor (undoes the countdown lock rule above, if it fired).
    this.unlock();
    this.raceStartedAt = Date.now();
    this.correctCharsBySession.clear();
    this.lastActivityBySession.clear();
    this.nextPlace = 1;

    this.state.players.forEach((p) => {
      if (p.status === "racing") {
        p.progress = 0;
        p.wpm = 0;
        p.finished = false;
        p.place = 0;
        p.afk = false;
      }
    });

    this.wpmTicker?.clear();
    this.wpmTicker = this.clock.setInterval(() => this.tickRace(), 500);

    this.raceTimeoutTimer?.clear();
    this.raceTimeoutTimer = this.clock.setTimeout(() => this.endRace(), RACE_TIMEOUT_MS);

    // Drive any spawned bots' typing for the duration of this race (see
    // tickBots). Faster than the wpm ticker so their progress bars move
    // smoothly. Harmless when there are no bots (the loop finds none).
    this.botTicker?.clear();
    this.botTicker = this.clock.setInterval(() => this.tickBots(), 200);

    console.log(`[RaceRoom] race started, ${this.countRacers()} racer(s)`);
  }

  /**
   * Ends the current race, either because everyone finished or because
   * RACE_TIMEOUT_MS ran out. Anyone still racing but not finished gets
   * ranked afterward, worst-progress last, so every racer ends up with a
   * place. Then shows results for RESULTS_SECONDS before auto-continuing.
   */
  private endRace() {
    this.raceTimeoutTimer?.clear();
    this.raceTimeoutTimer = null;
    this.wpmTicker?.clear();
    this.wpmTicker = null;
    this.botTicker?.clear();
    this.botTicker = null;

    const stragglers: Player[] = [];
    this.state.players.forEach((p) => {
      if (p.status === "racing" && !p.finished) stragglers.push(p);
    });
    stragglers.sort((a, b) => b.progress - a.progress);
    for (const p of stragglers) {
      p.place = this.nextPlace++;
    }

    this.state.phase = "finished";
    this.startResultsCountdown();
    console.log(`[RaceRoom] race finished`);
  }

  private startResultsCountdown() {
    this.state.countdown = RESULTS_SECONDS;

    this.countdownTimer?.clear();
    this.countdownTimer = this.clock.setInterval(() => {
      this.state.countdown--;
      if (this.state.countdown <= 0) {
        // Try to fold this room's whole roster into another waiting room
        // first (see attemptMerge()); only fall back to resetting in place
        // if there's nowhere suitable to merge into. A successful merge
        // disconnects every client here, which lets Colyseus's normal
        // autoDispose finish the job, so there's nothing further to do on
        // this room afterward.
        if (!this.attemptMerge()) {
          // Anyone still holding a slot - last race's racers who didn't
          // switch to spectating, plus anyone who queued during the race or
          // its results - is now in the next race, and resetToWaiting's own
          // roster re-evaluation is what starts it. This is what makes it an
          // *auto* next race.
          this.resetToWaiting();
        }
      }
    }, 1000);
  }

  /**
   * Post-race merge (see match-making.md's "POST-RACE" step, and the
   * "Post-race merging" doc note near the top of this file). Looks for
   * another live room that's "waiting" and has enough free racer slots for
   * this room's current racers, and if one exists, redirects this room's
   * ENTIRE roster (racers, spectators, chat) there and kills this room.
   *
   * Returns false (does nothing) if there's no one here to move, or no
   * eligible target exists - the caller falls back to the normal
   * reset-and-wait-here behavior in that case.
   */
  private attemptMerge(): boolean {
    if (this.clients.length === 0) return false;
    // Never merge a room that holds admin test bots away: a bot has no socket,
    // so it can't follow the "redirect" every real client does - it would just
    // vanish when this room disposes, silently gutting the test field. Keeping
    // the room put lets the bots (and any real players watching them) race on.
    // Real rooms merging INTO this one are unaffected and still fine.
    if (this.botSessions.size > 0) return false;

    // Sized by slots, not just racers: anyone queued here needs a slot over
    // there too (they're about to be promoted into the target's next race).
    // countTakenSlots (not committed) is right here - this asks "how many of
    // MY people need a seat", which is about players, not about any holds this
    // dying room may itself have taken.
    const target = RaceRoom.findMergeTarget(this, this.countTakenSlots());
    if (!target) return false;

    target.mergeChatFrom(this.state.chat);

    // Hold the target's seats before anyone starts reconnecting, so nothing
    // can take them during the handshake (see reserveSlots). Exactly the
    // slot-holders findMergeTarget was asked to verify seats for - deliberately
    // NOT this room's waitlisted players, who have no seat here and were never
    // counted in the eligibility check. They still travel (with resumeRacing,
    // like everyone else who wants in) and simply join the target's own queue
    // if it has no room left for them.
    const seatSeekers: string[] = [];
    this.state.players.forEach((p) => {
      if (p.status === "racing" || p.status === "queued") seatSeekers.push(p.clientId);
    });
    target.reserveSlots(seatSeekers);

    for (const client of this.clients) {
      const player = this.state.players.get(client.sessionId);
      if (!player) continue;
      // Tells the client which room to jump to next, and whether it wants a
      // racer slot there (true for racing, queued AND waitlisted - all three
      // mean "put me in a race"; the target's onJoin decides which of them
      // they land as); client/index.html reacts to this by calling
      // client.joinById(...) instead of treating the disconnect (below) as a
      // real one.
      client.send("redirect", { roomId: target.roomId, resumeRacing: player.status !== "watching" });
    }

    console.log(`[RaceRoom] merging ${this.clients.length} player(s) from ${this.roomId} into ${target.roomId}`);
    // See isMerging's doc comment: makes onLeave skip "left the lobby" for
    // the mass disconnect about to happen below.
    this.isMerging = true;
    // Disconnects everyone (the redirect messages above are already queued
    // to send first) and disposes this room once they're gone.
    this.disconnect();
    return true;
  }

  /**
   * Finds the best merge target for `incomingRacerCount` more racers: among
   * every other live room that's either "waiting" or already mid-"countdown"
   * but not yet locked (the same eligibility normal new-visitor matchmaking
   * placement uses - see app.config.ts's sortBy and the countdown lock rule)
   * with enough free racer slots, picks the one whose slots are already the
   * fullest, consistent with the fullest-room-first philosophy used for
   * new-visitor placement. Free slots and fullness both count queued players
   * as well as racers (see countTakenSlots), so a target can't be picked on
   * the strength of slots that are in fact already reserved. A
   * "racing"/"finished" room is never eligible; merging only ever happens
   * between races. A target's `onJoin` still separately re-checks all of this
   * at actual arrival time (this only checked it at selection time), so
   * whoever lands too close to a countdown room's start gets queued for its
   * following race instead, or spectates if the slots ran out entirely.
   */
  private static findMergeTarget(source: RaceRoom, incomingRacerCount: number): RaceRoom | undefined {
    let best: RaceRoom | undefined;
    for (const candidate of RaceRoom.instances.values()) {
      if (candidate === source) continue;
      if (candidate.state.phase !== "waiting" && candidate.state.phase !== "countdown") continue;
      if (candidate.locked) continue;
      // Committed, not merely occupied: a candidate holding seats for players
      // another room is already sending has that many fewer to offer us. This
      // is what stops two rooms finishing a moment apart from both being
      // promised the same last seat (see reserveSlots).
      const freeSlots = MAX_RACERS - candidate.countCommittedSlots();
      if (incomingRacerCount > freeSlots) continue;
      if (!best || candidate.countCommittedSlots() > best.countCommittedSlots()) best = candidate;
    }
    return best;
  }

  /**
   * Handles a client's "I'm leaving" beacon (see client/index.html's pagehide
   * handler, and app.config.ts's POST /leave route that calls this). On a host
   * behind a WebSocket proxy (e.g. Render), a browser tab close's WS close
   * frame isn't delivered to us promptly, so we'd otherwise only notice the
   * client is gone via the ping-timeout (~9-12s) before the reconnect grace
   * even starts - the ~14s a user reported. The client instead fires a tiny
   * HTTP beacon on pagehide (plain HTTP, which the proxy DOES forward), and we
   * start the leave immediately here.
   *
   * Auth: the reconnection token is a per-session secret that (unlike
   * sessionId, which lives in synced state visible to everyone) is never shared
   * with other clients, so only the real owner can trigger their OWN leave -
   * nobody can beacon another player out. The client's `room.reconnectionToken`
   * may be formatted "roomId:rawToken" while we store just the raw token, so we
   * accept either form.
   *
   * Routes through `client.leave(1001)` - a clean-close code - so it takes the
   * SHORT UNLOAD grace via onDrop. That's what makes it safe for refreshes too:
   * a refresh fires this same beacon, but reconnects within the grace and so
   * never churns (unlike the old, reverted "consented leave on pagehide" that
   * skipped the grace entirely). A genuine network blip fires no pagehide/beacon
   * at all, so it still falls back to ping-timeout + the longer grace.
   */
  static handleLeaveBeacon(roomId: string, sessionId: string, token: string): void {
    const room = RaceRoom.instances.get(roomId);
    if (!room) return;
    const client = room.clients.find((c) => c.sessionId === sessionId);
    if (!client) return;
    // The client's `room.reconnectionToken` joins the raw token with the roomId
    // via ":" (e.g. "roomId:rawToken"); we store just the raw token. Accept the
    // beacon if the raw token equals the whole value or appears as any ":"-
    // delimited segment - robust to the exact join order/format while still
    // requiring knowledge of the per-session secret (so nobody can forge it).
    const raw = client.reconnectionToken;
    if (token !== raw && !token.split(":").includes(raw)) return; // missing/forged token: ignore

    // Force the socket closed NOW rather than client.leave()/ref.close(), which
    // starts a WebSocket closing handshake and waits for the peer to ack it -
    // behind a proxy (Render) whose upstream socket is a dead-but-held
    // connection, that ack never comes, so the close hangs (up to the ws
    // library's ~30s timeout) and the ~9-12s ping-timeout wins the race
    // instead: exactly the ~14s delay reported. terminate() destroys the socket
    // immediately and synchronously fires the 'close' event -> onDrop -> grace.
    // Flag it first so onDrop gives it the short unload grace despite the
    // abnormal 1006 that terminate() produces.
    room.beaconLeaving.add(sessionId);
    const ref: any = (client as any).ref;
    if (ref && typeof ref.terminate === "function") ref.terminate();
    else client.leave(1001);
  }

  /**
   * Copies another (dying) room's chat history into this room's, so the
   * merged room doesn't lose context. Only real messages (`system: false`)
   * are copied - "X joined the lobby" announcements describe an arrival
   * into THAT specific (now-dying) room, not this one, and replaying them
   * here caused real duplicate-looking messages: found via user testing
   * that a player who'd since left the dying room (e.g. via an earlier
   * Switch Lobby) would see their own stale "joined" announcement from
   * that old room resurface as if new once its history got merged in,
   * since a client already sitting in the target room sees a merge's
   * pushed history as fresh array entries regardless of how old the
   * copied message's original `sentAt` is. Every player who's actually
   * arriving in THIS room already gets their own fresh, correct "joined
   * the lobby" from this room's own onJoin - no need to also carry over
   * announcements about a different room's arrivals. Appended in arrival
   * order (not re-sorted by `sentAt`) rather than reordered into a single
   * chronological interleave: `ArraySchema.sort()` on a Schema-typed array
   * turned out to corrupt the encoder's refId bookkeeping mid-flight (a
   * decode-time "refId not found" warning on connected clients, found via
   * manual testing) - not worth chasing for what's a cosmetic ordering
   * nicety on a rare event. Re-capped at CHAT_HISTORY_LIMIT same as any
   * normal chat growth.
   */
  private mergeChatFrom(incoming: ArraySchema<ChatMessage>) {
    for (const msg of incoming) {
      if (msg.system) continue;
      const copy = new ChatMessage();
      copy.sessionId = msg.sessionId; // stale once merged; harmless, just won't match anyone's "is this me" styling
      copy.name = msg.name;
      copy.emoji = msg.emoji;
      copy.text = msg.text;
      copy.sentAt = msg.sentAt;
      this.pushChatMessage(copy);
    }
  }

  /** Appends a chat message and re-caps at CHAT_HISTORY_LIMIT. Shared by sendChat, mergeChatFrom, and postSystemMessage. */
  private pushChatMessage(msg: ChatMessage) {
    this.state.chat.push(msg);
    while (this.state.chat.length > CHAT_HISTORY_LIMIT) {
      this.state.chat.shift();
    }
  }

  /**
   * Posts a "[System] ..." announcement into chat: "X joined the lobby"
   * (see onJoin) or "X left the lobby" (see onLeave). A join is posted the
   * exact same way regardless of whether this is a brand new visitor or
   * someone arriving via a post-race merge/Switch Lobby redirect - see
   * match-making.md's "Always Frame Joins the Same Way".
   *
   * `aboutClientId` tags which player (by their persistent `clientId`, not
   * their per-join Colyseus sessionId - see Player.clientId's doc comment)
   * this announcement concerns, so a client can recognize a join/leave
   * about a specific person across a merge/redirect and decide whether to
   * show it: nobody should ever see an announcement about their own
   * arrival (found via user feedback - after a merge/Switch Lobby
   * redirect, seeing "You joined the lobby" about yourself reads as
   * backwards, since from the mover's own perspective they never left),
   * and nobody who already had this person in their own lobby right
   * before a merge should see them announced as "joining" again either
   * (see client/index.html's `myKnownClientIds`).
   */
  private postSystemMessage(text: string, aboutClientId: string, left: boolean) {
    const msg = new ChatMessage();
    msg.name = "System";
    msg.text = text;
    msg.sentAt = Date.now();
    msg.system = true;
    msg.left = left;
    msg.aboutClientId = aboutClientId;
    this.pushChatMessage(msg);
  }
}
