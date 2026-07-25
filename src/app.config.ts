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
    app.use(express.static(path.join(__dirname, "..", "client")));
  },
});
