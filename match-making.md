# Typing Game Architecture: The "Seamless Lobby" Setup

## The Big Picture
We want a fast, competitive 5-player typing game. The secret sauce here is **zero wait times** and a sneaky illusion: **every player should feel like they are the host of their own lobby, and everyone else is joining *them*.** 

Instead of making people wait in empty rooms, we merge rooms invisibly behind the scenes between races so lobbies stay constantly full.

---

## 1. Core Rules & Roles

* **Max 5 Racers Per Room:** Small rooms mean you actually notice your rivals, see their typos, and care about beating them.
* **Racers vs. Spectators:** 
  * A room holds **max 5 Racers**. 
  * Spectators are unlimited. They sit in the same chat and watch live, but don't take up a race slot.
* **AFK Handling:**
  * If a racer doesn't type a single letter for **15 seconds during a race**, boot them to Spectator to free up their slot for the next round.
  * If they stay AFK for a whole round without touching anything, kick them to global idle.

---

## 2. How the Server Handles Rooms (The Loop)

Every room runs on 4 simple phases:

1. **WAITING:** The server looks for players to fill open racer slots (up to 5/5).
2. **COUNTDOWN:** Shows the text quote everyone is about to type.
   * **The 5-Second Lock Rule:** If the timer drops to 5 seconds or less, **lock the room**. No late joiners allowed. If someone tries to join right then, put them in a fresh room so they aren't surprised by a 2-second countdown.
3. **RACING:** The live typing race. 
4. **POST-RACE (The Merge Magic):** Race ends, show scores, and check if rooms can be merged before starting the next round:
   * *Can this room's active players fit into another waiting room?* 
     * **YES:** Move everyone silently into that room, kill the old room, and trigger a `"Player X joined your lobby"` event.
     * **NO:** Keep them in this room, pick a new text quote, and start the waiting loop again.

---

## 3. Pulling Off the "Anchor Host" Illusion (Frontend UX)

To make sure the player never feels like they are being bounced around or teleported between servers:

* **Always Frame Joins the Same Way:** Never say *"You were moved to Lobby 3"*. Always show: `"[System] SpeedyKeys joined the lobby."`
* **Updating Preview Text:** When two rooms merge during intermission, update the text box with a quick flip/slide animation and a little badge: `"New challengers joined! Updating quote..."`
* **Adjusting Timers:** If new people join when the countdown is at 6 or 7 seconds, bump the timer back up to 8 seconds and show a quick `"+2s added for new challengers!"` banner.
* **Keep Chat History:** Don't wipe the player's chat feed when rooms merge. Just keep their personal chat log rolling so they don't lose context.

---

## 4. Matchmaking & Solo Players

* **Filling Rooms First:** Always send new website visitors to the waiting room that already has the *most* players (e.g., fill a 4/5 room before a 1/5 room).
* **Solo Play:** If someone joins and literally no one else is around, **let them start a solo race immediately**. No waiting. When their solo race finishes, the Post-Race Merge step will automatically drop them into a multi-player lobby for round two!
* **Full Room Spectators:** If a spectator hits "Join Next Race" but the room is full (5/5), give them two buttons:
  1. **"Wait for Next Spot"** (Grab the slot if someone leaves or goes AFK).
  2. **"Switch Lobby"** (Instantly jump into another active room with an open slot).