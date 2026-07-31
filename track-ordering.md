# Live track ordering (multiple-tracks view only)

## What this adds

Today the race tracks stay in a fixed order for the whole race, and only get
sorted into placings once the race is over. This adds two optional ways to show
live positions *during* the race:

- **Slide** — the tracks physically move up and down into rank order.
- **Swap** — the tracks stay put, and the racers' name/avatar labels move
  between them instead.

Both are off by default. Default behaviour is exactly what happens today.

## One setting, not two toggles

Use a single setting with three values rather than two separate toggles:

```
trackOrder: "static" | "slide" | "swap"     // default: "static"
```

Slide and swap are two different answers to the same question ("how do we show
live rank?"), so "both on" has no sensible meaning. One setting removes that
state entirely.

This is a **client-side display preference**. Persist it locally with the other
display settings. No schema fields, no room messages, no server involvement.

## Scope

Applies **only** to the multiple-tracks view. When the shared track or hidden
track is selected, the setting has no effect and should be hidden (or disabled)
in the settings UI.

Applies **only** while a race is live. Before the race starts, tracks use the
normal order. When the race ends, the existing end-of-race sort takes over
unchanged — don't touch that code path.

---

## Part 1: the ordering engine (shared by both modes)

Both modes need the same thing: an ordered list of racers that reflects
position but changes *slowly*. Build this once and let both modes read from it.

Without this, two racers a single character apart will trade places many times
per second and the display strobes. This is not a polish detail — neither mode
is usable without it.

### State

Keep one array on the client, `displayOrder`, holding racer ids in the order
they should appear. It persists across frames — it is never rebuilt from
scratch during a race.

- **Initialise** it at race start to the current track order (the same order the
  tracks are in today).
- **Reset** it when a new race starts.

### Constants

```
STICKY_CHARS     = 5      // how far ahead you must be to take a place
SWAP_COOLDOWN_MS = 600    // quiet period after any swap
```

Convert the sticky distance into the same units as progress:

```
stickyGap = STICKY_CHARS / quote.length
```

Deriving it from quote length is deliberate — short quotes have tighter
finishes, so they need a proportionally wider quiet zone.

### Update rule

On each state update, run **at most one swap**:

1. If less than `SWAP_COOLDOWN_MS` has passed since the last swap, do nothing.
2. Walk `displayOrder` from the top, comparing each neighbouring pair.
3. For the first pair where the lower racer's progress exceeds the upper
   racer's by more than `stickyGap`, swap those two entries, record the swap
   time, and stop.

Only ever swap **adjacent** entries. If a racer needs to climb three places,
that happens as three separate one-step swaps over three cooldown periods. This
is what keeps the movement readable.

Because the rule is "must be ahead by more than `stickyGap`", the reverse swap
needs the same margin in the other direction. That gap in the middle is what
stops the flicker.

### Finished racers

Once a racer finishes, lock them at the top of `displayOrder`, ordered by their
finishing place, and never move them again. Racers still typing sort below all
finishers. A finished racer must never appear to be overtaken.

### Racers who leave or go idle

- **Leaves mid-race:** remove them from `displayOrder`; everything below shifts
  up one.
- **Goes idle mid-race:** no special handling. They stop making progress, so
  they drift down naturally, which is correct.

---

## Part 2: mode "slide"

The tracks move.

- Each track keeps a fixed place in the DOM and is positioned by its index in
  `displayOrder` using a `transform`. Don't reorder DOM nodes — animate the
  transform.
- Transition: **260 ms, ease**. No bounce, no overshoot.
- All track rows must be the same height for this to work.

Because the engine only ever swaps adjacent entries, every animation is a
single row-height move. Nothing ever flies across the screen.

**Reduced motion:** if the user's system requests reduced motion, fall back to
`static` regardless of the setting.

---

## Part 3: mode "swap"

The tracks stay still; the racers move between them.

- Track row *N* always stays exactly where it is. It becomes a slot.
- Each frame, row *N* displays whichever racer is at index *N* in
  `displayOrder` — their name, avatar, colour, progress bar and wpm.
- When a row's occupant changes, **cross-fade the label**: fade the name and
  avatar to transparent over ~150 ms, replace the text, fade back in. Never
  hard-cut a name — a name that teleports reads as a glitch rather than an
  overtake.
- **Don't fade the progress bar.** Let it change instantly. Thanks to the
  sticky gap, two racers only swap when they're about five characters apart, so
  the bar barely moves anyway.

**Reduced motion:** keep the mode working, but replace the cross-fade with an
instant label change.

---

## Settings UI

Add to the display settings, near the existing track-view options:

```
Live positions
  ( ) Off — tracks keep their order until the race ends   [default]
  ( ) Slide tracks into position
  ( ) Swap names between tracks
```

Hide or disable the whole group when the selected track view is shared or
hidden.

---

## How to test

Open two tabs and type at deliberately similar speeds so the two racers stay
neck and neck.

- **Static:** nothing moves during the race. Unchanged from today.
- **Slide:** rows change places occasionally and calmly — roughly at most once
  or twice a second, one step at a time. If rows are visibly vibrating, the
  sticky gap or the cooldown isn't being applied.
- **Swap:** rows never move; names fade in and out of them at the same calm
  rate.

Also check: finishing a race leaves the finisher pinned at the top, and closing
one tab mid-race makes the remaining rows close the gap without any other
reordering.
