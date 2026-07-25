# Typing Race — Claude Code instructions

The full design, data model, and roadmap live in @ARCHITECTURE.md. Read it first —
it is the single source of truth. Keep it current (especially the roadmap
checkboxes and the Status log) as part of finishing any step.

## Working agreement
- Work in small, independently testable steps — one working feature at a time (or
  a sub-step of a big one). Stop after each so it can be tested before continuing.
  Don't jump ahead in the roadmap.
- The server is authoritative. Clients send intents; the server validates and owns
  all state and stats. Never trust a client-reported stat (WPM, progress, finish).
- Keep the synchronized Schema state minimal — only what clients must see. Ephemeral
  server-only data (timers, buffers) lives on the room instance, not in state.
- Preserve the loop "client sends intent → server mutates state → onStateChange
  re-renders". Don't update the client UI optimistically for authoritative data.

## Commands
- `npm start` — run the dev server (Colyseus, port 2567, hot-reload).
- Test multiplayer by serving the client (`npx serve client`) and opening 2+ tabs.

## Conventions
- Server: TypeScript, Colyseus 0.17. Rooms in `src/rooms/`, synchronized state in
  `src/rooms/schema/`. Rooms are registered in `src/app.config.ts`.
- Client: a single `client/index.html` (plain HTML/CSS/JS) for now.
- After finishing a step: tick its roadmap box and append a dated Status log entry
  in ARCHITECTURE.md.
