/**
 * app.config.ts: server config. Registers rooms.
 * See ARCHITECTURE.md → "Registering rooms".
 */
import path from "path";
import express from "express";
import { defineServer, defineRoom } from "colyseus";
import { RaceRoom } from "./rooms/RaceRoom";

export const server = defineServer({
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
      // Temporary unconditional log: confirms whether the beacon reaches the
      // server at all (vs. a stale client never sending it).
      const q = req.query as Record<string, string | undefined>;
      console.log(`[leave-route] hit q=${JSON.stringify(q)}`);
      if (q.roomId && q.sessionId && q.token) {
        RaceRoom.handleLeaveBeacon(String(q.roomId), String(q.sessionId), String(q.token));
      } else {
        console.log(`[leave-route] missing params, ignoring`);
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
