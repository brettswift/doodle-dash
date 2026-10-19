# Doodle Dash

Multiplayer drawing and guessing game, 2–8 players per room. Zero dependencies: Node HTTP + a minimal WebSocket server.

- `npm test` — real multiplayer integration tests (8 simulated clients)
- `npm start` — serve on `$PORT` (default 8080)
- Server is authoritative for words, timers, scores and stroke history; the word is only sent to the drawer (and to everyone at round end).
- Env: `CHOOSE_MS`, `DRAW_MS`, `RESULT_MS`, `GRACE_MS` tune timers (tests use small values).
