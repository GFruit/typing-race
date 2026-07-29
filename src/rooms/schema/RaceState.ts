/**
 * RaceState.ts: the SYNCHRONIZED state of a race room.
 *
 * Anything defined here with `@type(...)` is automatically encoded and pushed
 * to every connected client whenever the server mutates it. Keep it minimal:
 * only put data here that clients actually need to see. Server-only scratch data
 * (timers, buffers, etc.) belongs on the Room instance, NOT in the state.
 *
 * See ARCHITECTURE.md → "Core model" and "How state sync works".
 */
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/** One connected participant (racer or spectator). */
export class Player extends Schema {
  @type("string") name: string = "guest";

  /**
   * The little avatar that rides along this player's progress bar, purely
   * cosmetic personality. Assigned a random one from a curated pool on join
   * (see RaceRoom's EMOJIS / onJoin) and changeable any time via the
   * "setEmoji" message to ANY emoji. Validated server-side (see RaceRoom's
   * isEmoji) to be a single emoji and nothing else, so a client can't inject
   * arbitrary text/markup here - but not limited to the curated pool.
   */
  @type("string") emoji: string = "🚀";

  /**
   * "watching" = spectating; "racing" = in the race currently being set up or
   * run; "queued" = holds a racer slot for the race AFTER this one;
   * "waitlist" = wants a slot but every one of them is taken.
   *
   * "queued" exists because there are stretches where joining the imminent
   * race isn't possible but wanting in on the next one is perfectly
   * reasonable: while a race is live, while its results are up, and in the
   * last few seconds of a countdown (see RaceRoom's LOCK_AT_COUNTDOWN_SECONDS
   * / acceptsNewRacers()). A queued player occupies a racer slot immediately
   * (so the room can't be oversubscribed) but takes no part in the current
   * race - no progress, no wpm, no place - and is promoted to "racing"
   * wholesale when the room next settles back to "waiting" (see RaceRoom's
   * resetToWaiting()).
   *
   * "waitlist" is the opposite kind of waiting, and the distinction matters:
   * a queued player HAS a slot and is guaranteed the next race, a waitlisted
   * player has NO slot (they don't count toward MAX_RACERS at all) and is
   * simply first in line for whenever one frees up - which only happens when
   * a racer gives theirs up or leaves, never merely because a race ended.
   * They're promoted one at a time, in `waitlistOrder`, by RaceRoom's
   * promoteFromWaitlist(). It replaced the old hard refusal: opting into a
   * full room used to be silently ignored, leaving a dead "Race Full" button.
   *
   * Only the SERVER may change this (via the "setStatus" message handler).
   */
  @type("string") status: string = "watching";

  /**
   * Position in the race queue, as a per-room counter that only ever
   * increases (0 = not on the waitlist). Stamped when a player joins the
   * waitlist and cleared when they leave or are promoted off it, so the
   * displayed "#1, #2, #3" is just this field's sort order - which means
   * everyone behind a departing waitlister moves up by itself, with nothing
   * to renumber.
   */
  @type("number") waitlistOrder: number = 0;

  /**
   * Race progress, computed and owned by the server from the client's raw
   * typed input (see RaceRoom's "typeProgress" handler). Never trust a
   * client-reported value directly.
   */
  @type("number") progress: number = 0; // 0..1 fraction of the quote typed correctly
  @type("number") wpm: number = 0;
  @type("boolean") finished: boolean = false;

  /**
   * Final standing for this race: 1 = first, 2 = second, etc. 0 = not ranked
   * yet. Assigned by the server in finish order; stragglers still racing
   * when the race times out are ranked afterward, by progress. See RaceRoom.
   */
  @type("number") place: number = 0;

  /**
   * True if the server auto-moved this player to "watching" for going idle
   * mid-race (see RaceRoom's INACTIVITY_TIMEOUT_MS). Reset false at the start
   * of every race. Lets clients keep showing their leaderboard row (tagged
   * "AFK" instead of wpm) rather than have it disappear and reshuffle the
   * rest of the list.
   */
  @type("boolean") afk: boolean = false;

  /**
   * WHEN this player took their racer slot, as a per-room counter that only
   * ever increases (0 = they have never held one here). Stamped by RaceRoom
   * the moment a player becomes "racing" or "queued", and deliberately NOT
   * cleared when they drop back to "watching": a mid-race AFK dropout keeps
   * its leaderboard row, and that row must keep its position rather than
   * jump. Re-taking a slot re-stamps it, so the order is always "who opted
   * in first", not "who first ever raced".
   *
   * Clients order both the sidebar racer list and the race tracks by it, so
   * the two always agree and the tracks read in join order.
   */
  @type("number") slotOrder: number = 0;

  /**
   * A random identifier the CLIENT generates once per browser tab (see
   * client/index.html's `myClientId`) and sends on every join, including a
   * post-race merge/Switch Lobby redirect. Unlike the Colyseus sessionId
   * (which is different every single join/redirect, even for the exact
   * same browser tab), this stays stable across a tab's whole session -
   * it's what lets a client recognize "this player was already in my
   * lobby before this merge, so don't re-announce them" (see
   * ChatMessage.aboutClientId and client/index.html's `myKnownClientIds`).
   */
  @type("string") clientId: string = "";
}

/** One chat message. Sanitized server-side; see RaceRoom's "sendChat" handler. */
export class ChatMessage extends Schema {
  @type("string") sessionId: string = ""; // lets clients tell "is this me" for styling; only meaningful for a real (non-system) message
  @type("string") name: string = "";
  /**
   * The sender's avatar at send time (see RaceRoom's "sendChat"), so the
   * client can show it before the name and tint the name to match the
   * racer's track color. Baked in per-message rather than looked up live, so
   * it stays correct even after the sender changes emoji or leaves. Empty for
   * system announcements.
   */
  @type("string") emoji: string = "";
  @type("string") text: string = "";
  @type("number") sentAt: number = 0;

  /**
   * True for a server-generated announcement ("X joined the lobby" /
   * "X left the lobby" - see RaceRoom's onJoin/onLeave/postSystemMessage).
   * A join is posted the exact same way whether it's a brand new visitor
   * or someone arriving via a post-race merge/Switch Lobby redirect, per
   * match-making.md's "Always Frame Joins the Same Way": nothing here
   * distinguishes the two, so a merge never reads as "you were moved".
   */
  @type("boolean") system: boolean = false;

  /** Only meaningful when `system` is true: false = "joined", true = "left". */
  @type("boolean") left: boolean = false;

  /**
   * Only meaningful when `system` is true: which player this announcement
   * concerns, by their persistent `Player.clientId` (not a Colyseus
   * sessionId, which wouldn't survive a merge/redirect). Lets a client
   * recognize and skip an announcement about its own arrival, or about
   * someone it already knew from the room it just came from.
   */
  @type("string") aboutClientId: string = "";
}

/** The whole room's synchronized state. */
export class RaceState extends Schema {
  /**
   * Room lifecycle phase:
   *   "waiting":   no one has queued to race yet.
   *   "countdown": at least one racer has queued; `countdown` ticks to 0.
   *   "racing":    the race is live; `quote` is the text to type.
   *   "finished":  results are in; `countdown` ticks down to the next race.
   */
  @type("string") phase: string = "waiting";

  /**
   * A countdown in seconds, reused for two different waits:
   *   - phase "countdown": time until the race starts.
   *   - phase "finished": time until results clear and the next race can begin.
   * 0 otherwise.
   */
  @type("number") countdown: number = 0;

  /** The text for the upcoming/current race. Always populated; see RaceRoom. */
  @type("string") quote: string = "";

  /**
   * Increments every time a new quote is picked. The quote pool is small
   * enough that two consecutive races can land on the identical text, so
   * clients must key "did a new race just start" off this counter rather
   * than off `quote` itself, or they'd fail to reset stale typed input when
   * the text happens to repeat.
   */
  @type("number") quoteId: number = 0;

  /**
   * Mirrors `countTakenSlots()`; how many of MAX_RACERS's racer slots are
   * currently spoken for - `status === "racing"` PLUS `status === "queued"`,
   * since a queue spot reserves a real slot (see Player.status). Kept in
   * synced state (cheap, small) so clients can show "3/5" - and decide
   * whether joining/queueing is even possible - without counting players
   * themselves; also pushed into the room's matchmaking metadata (see
   * RaceRoom's `updateRacerCount()`) for cross-room fullest-first placement.
   */
  @type("number") racerCount: number = 0;

  /** Everyone currently connected, keyed by their Colyseus sessionId. */
  @type({ map: Player }) players = new MapSchema<Player>();

  /**
   * Recent chat history, capped at CHAT_HISTORY_LIMIT (see RaceRoom) by
   * dropping the oldest message whenever a new one arrives past the cap.
   * Synced like everything else here, so a client who just joined gets the
   * existing backlog for free via the normal state sync, no separate
   * "catch me up" request needed.
   */
  @type([ChatMessage]) chat = new ArraySchema<ChatMessage>();
}
