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
 *   - Joining a race ("watching" -> "racing") is only allowed during
 *     "waiting"/"countdown" only, no jumping into one already live. Bailing out
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
 *   - MAX_RACERS caps a room at 5 racers; `setStatus({racing:true})` is
 *     rejected past that (same silent-ignore treatment as trying to join a
 *     live race). Spectators remain uncapped - they share the room's chat
 *     and roster but never occupy a racer slot, so there's nothing to cap.
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
// Governs three things uniformly, all "is this room open to someone who
// isn't already sitting in it": pulling the room out of Colyseus's own
// matchmaking once the countdown gets this low (new visitors), excluding
// it as a merge/Switch Lobby target (findMergeTarget), and a target's
// resumeRacing re-check at actual arrival time (onJoin) - all three read
// the same number, so a merge/redirect/fresh-visitor placement decision
// and its later arrival can never disagree. Does NOT restrict someone
// already in the room from clicking "Join Next Race" right up until the
// race actually starts (see setStatus) - they've been watching the
// countdown the whole time, there's no "surprise" to protect them from.
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
//     frame). A bit longer so a momentary connection drop doesn't cost your
//     seat - but not much, since the ping-timeout that surfaces this (see
//     app.config.ts's pingInterval) has ALREADY spent ~3-4s confirming the
//     connection is dead before this grace even starts.
const UNLOAD_GRACE_SECONDS = 1.5;
const RECONNECTION_GRACE_SECONDS = 2;

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
  private raceStartedAt = 0;
  private correctCharsBySession = new Map<string, number>();
  private lastActivityBySession = new Map<string, number>();
  private nextPlace = 1;
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

      // Joining a live/finished race isn't allowed. The roster for the
      // current race is locked once it starts. Bailing out to spectate,
      // however, is always allowed (even mid-race).
      if (wantsToRace && (this.state.phase === "racing" || this.state.phase === "finished")) {
        return;
      }

      // Racer slots are capped at MAX_RACERS; past that, joining is silently
      // ignored (same treatment as the live-race case above). Spectating out
      // is still always allowed regardless of how full the room is.
      if (wantsToRace && this.countRacers() >= MAX_RACERS) {
        return;
      }

      // Deliberately no countdown-based cutoff here: someone already in this
      // room has been watching the countdown the whole time, so there's no
      // "surprise" to protect them from - they can queue right up until the
      // race actually starts (see LOCK_AT_COUNTDOWN_SECONDS's doc comment
      // for where that protection actually belongs instead: keeping NEW
      // arrivals, who haven't been watching, from landing with no notice).

      player.status = wantsToRace ? "racing" : "watching";
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
      // regardless of whether this player is racing or spectating (a
      // deliberate simplification: guarantees "switch lobby" always lands
      // somewhere with room to grow, not just any room). incomingRacerCount
      // of 1 is exactly "needs at least one free slot" - the same
      // eligibility findMergeTarget already uses for merges, just sized for
      // one switching player instead of a whole room's worth of racers.
      const target = RaceRoom.findMergeTarget(this, 1);
      // `soloSwitch: true` distinguishes this (one player leaving alone) from
      // a whole-room merge's redirect (attemptMerge, no such flag). The
      // client uses it to decide what to do with its "who's already in my
      // lobby" set: a solo switcher leaves everyone in this room BEHIND, so
      // they must forget them (else a person they knew here who later merges
      // into the destination would be wrongly suppressed as "already known" -
      // see client/index.html's myKnownClientIds); a merge moves the whole
      // room together, so those teammates ARE still with you and stay known.
      client.send("redirect", { roomId: target?.roomId ?? null, resumeRacing: player.status === "racing", soloSwitch: true });

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
  };

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
      p.wpm = this.calcWpm(this.correctCharsBySession.get(sessionId) ?? 0);

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
    this.updateRacerCount();

    if (this.countRacers() === 0) {
      this.resetToWaiting();
    } else if (this.allRacersFinished()) {
      // Everyone still racing had already finished; the idle ones were the
      // only holdouts, so the race is effectively over now.
      this.endRace();
    }
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
    // attemptMerge()/the "switchLobby" handler), which passes
    // `resumeRacing` to preserve "was this player queued to race" across
    // the room swap - but only if that's still valid by the time they
    // actually arrive (the target's roster/countdown can shift in the gap
    // between the redirect decision and this join, e.g. an unrelated
    // visitor queuing up, or the countdown ticking past
    // LOCK_AT_COUNTDOWN_SECONDS - findMergeTarget only checked that at
    // *selection* time, this is the re-check at actual arrival time): a
    // free racer slot, same as setStatus's MAX_RACERS check, and not past
    // the same lock threshold every other "is this room open to a new
    // arrival" decision uses - otherwise they land as a spectator instead.
    const pastArrivalLock = this.state.phase === "countdown" && this.state.countdown <= LOCK_AT_COUNTDOWN_SECONDS;
    const canResumeRacing =
      !!options?.resumeRacing &&
      this.state.phase !== "racing" &&
      this.state.phase !== "finished" &&
      !pastArrivalLock &&
      this.countRacers() < MAX_RACERS;
    player.status = canResumeRacing ? "racing" : "watching";
    this.state.players.set(client.sessionId, player);
    this.postSystemMessage(`${player.name} joined the lobby.`, player.clientId, false);
    console.log(`[RaceRoom] ${player.name} joined, ${this.state.players.size} online`);
    if (player.status === "racing") this.onRosterChanged();
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
    // Skip during a post-race merge's mass teardown (see attemptMerge's
    // `isMerging` flag): every remaining client leaves simultaneously as
    // part of the SAME event there, not individually, and the whole point
    // of a merge is that it never reads as anyone "leaving" - they're
    // framed as joining wherever they land instead (see onJoin). Not
    // gated by close code: a Switch Lobby departure ALSO uses
    // CloseCode.CONSENTED (same as a merge's mass disconnect) but SHOULD
    // post "left the lobby" here, so the two can't be told apart that way.
    if (player && !this.isMerging) {
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
    RaceRoom.instances.delete(this.roomId);
    console.log("[RaceRoom] disposed:", this.roomId);
  }

  /** Re-evaluate the phase after a join/leave/status change. */
  private onRosterChanged() {
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

  private countRacers(): number {
    let count = 0;
    this.state.players.forEach((p) => {
      if (p.status === "racing") count++;
    });
    return count;
  }

  /**
   * Pushes the current racer count into both synced state (`state.racerCount`,
   * for clients) and matchmaking metadata (`setMetadata`, for the
   * `.sortBy({"metadata.racerCount": -1})` fullest-first placement in
   * app.config.ts). Call after anything that can change who's racing.
   */
  private updateRacerCount() {
    const racerCount = this.countRacers();
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
   */
  private resetToWaiting(pickNewQuote: boolean = true) {
    this.countdownTimer?.clear();
    this.countdownTimer = null;
    this.wpmTicker?.clear();
    this.wpmTicker = null;
    this.raceTimeoutTimer?.clear();
    this.raceTimeoutTimer = null;
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
          this.resetToWaiting();
          // Anyone still queued (didn't switch to spectating) stays queued;
          // this is what makes it an *auto* next race.
          this.onRosterChanged();
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

    const target = RaceRoom.findMergeTarget(this, this.countRacers());
    if (!target) return false;

    target.mergeChatFrom(this.state.chat);

    for (const client of this.clients) {
      const player = this.state.players.get(client.sessionId);
      if (!player) continue;
      // Tells the client which room to jump to next, and whether it should
      // rejoin as a racer there; client/index.html reacts to this by
      // calling client.joinById(...) instead of treating the disconnect
      // (below) as a real one.
      client.send("redirect", { roomId: target.roomId, resumeRacing: player.status === "racing" });
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
   * with enough free racer slots, picks the one that already has the most
   * racers, consistent with the fullest-room-first philosophy used for
   * new-visitor placement. A "racing"/"finished" room is never eligible;
   * merging only ever happens between races. A target's `onJoin` still
   * separately re-checks LOCK_AT_COUNTDOWN_SECONDS at actual arrival time
   * (this only checked it at selection time), so racers who'd land too
   * close to a countdown room's start get spectators instead.
   */
  private static findMergeTarget(source: RaceRoom, incomingRacerCount: number): RaceRoom | undefined {
    let best: RaceRoom | undefined;
    for (const candidate of RaceRoom.instances.values()) {
      if (candidate === source) continue;
      if (candidate.state.phase !== "waiting" && candidate.state.phase !== "countdown") continue;
      if (candidate.locked) continue;
      const freeSlots = MAX_RACERS - candidate.countRacers();
      if (incomingRacerCount > freeSlots) continue;
      if (!best || candidate.countRacers() > best.countRacers()) best = candidate;
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
    if (!room) { console.log(`[beacon] no room ${roomId}`); return; }
    const client = room.clients.find((c) => c.sessionId === sessionId);
    if (!client) { console.log(`[beacon] no client ${sessionId} in ${roomId}`); return; }
    // The client's `room.reconnectionToken` joins the raw token with the roomId
    // via ":" (e.g. "roomId:rawToken"); we store just the raw token. Accept the
    // beacon if the raw token equals the whole value or appears as any ":"-
    // delimited segment - robust to the exact join order/format while still
    // requiring knowledge of the per-session secret (so nobody can forge it).
    const raw = client.reconnectionToken;
    if (token !== raw && !token.split(":").includes(raw)) { console.log(`[beacon] token mismatch ${sessionId}`); return; }

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
    console.log(`[beacon] OK ${sessionId} -> ${ref && typeof ref.terminate === "function" ? "terminate" : "leave(1001)"}`);
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
