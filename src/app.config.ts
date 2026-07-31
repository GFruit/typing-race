/**
 * app.config.ts: server config. Registers rooms.
 * See ARCHITECTURE.md → "Registering rooms".
 */
import path from "path";
import express from "express";
import { defineServer, defineRoom, WebSocketTransport } from "colyseus";
import { RaceRoom } from "./rooms/RaceRoom";

// Dead-connection detection via ping/pong. This is the ONLY way we notice a
// client that vanished ABRUPTLY (a crash, an incognito teardown, or - behind a
// proxy like Render that holds the dead upstream socket - a close whose signal
// never reaches us): there's no clean WS close and the pagehide beacon can't
// fire, so we fall back to "has this socket answered a ping lately?".
//
// This was previously 1s x 2 (~3s to give up), chased down as low as it would
// go to clear an abruptly-closed incognito tab from the roster fast. That
// turned out to be FAR too twitchy for live play: a client only has to go ~2s
// silent to be terminated, and ordinary causes do that all the time - Render's
// proxy jittering, a flaky mobile link, or (the big one when testing multiple
// tabs) a browser FREEZING a backgrounded tab, which suspends even its
// protocol-level pong replies. Every one of those killed a perfectly healthy
// connection, and the drop then cascaded into the "stuck reconnecting" bug
// (see RECONNECTION_GRACE_SECONDS in RaceRoom.ts). Connection stability matters
// more than shaving seconds off roster cleanup, so this is relaxed to ~15s of
// tolerance (5s x 3): a live client answers one trivial ping per 5s, and only
// a genuinely dead socket goes a full ~15s silent. The cost is only that a
// crash/incognito close (no beacon) lingers in the roster ~15s before "X left"
// instead of ~3s - a graceful close/refresh still clears fast via the beacon.
export const server = defineServer({
  transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 3 }),
  rooms: {
    // Fill the fullest non-locked room first (most racers before least), per
    // match-making.md's "Filling Rooms First". Room instances briefly lock
    // themselves (see RaceRoom's 5-second countdown lock) right before a race
    // starts, dropping out of matchmaking placement so joinOrCreate falls
    // through to another room, or spawns a fresh one, instead.
    race_room: defineRoom(RaceRoom).sortBy({ "metadata.racerCount": -1 }),
  },
  // Serves client/index.html on the same host/port as the game server, so
  // the deployed site is one process/one URL: no separate static host, and
  // no cross-origin WebSocket setup for the client to get right.
  express: (app) => {
    // Leave beacon (see RaceRoom.handleLeaveBeacon). The client fires
    // navigator.sendBeacon() here on pagehide - a plain HTTP POST, which a
    // WebSocket proxy (e.g. Render) forwards promptly even when it won't
    // forward the WS close frame - so a tab close is noticed right away
    // instead of waiting out the ~9-12s ping-timeout. sendBeacon always POSTs;
    // the identifying params ride in the query string (no body parser needed).
    // Registered before the static handler so it isn't shadowed by it.
    app.post("/leave", (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      if (q.roomId && q.sessionId && q.token) {
        RaceRoom.handleLeaveBeacon(String(q.roomId), String(q.sessionId), String(q.token));
      }
      res.sendStatus(204);
    });
    // Never let the browser serve a stale index.html: the client is the whole
    // app, and shipping fixes is pointless if an old cached copy is what runs.
    // no-cache = the browser must revalidate with the server before reuse, so a
    // new deploy is picked up on the next load (304 when unchanged, so it's
    // cheap). A build marker is logged client-side too (see index.html) so we
    // can confirm which version is actually running.
    app.use(express.static(path.join(__dirname, "..", "client"), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    }));
  },
});
