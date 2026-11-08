# Public lobby

The landing page has a "Public lobby" button. It places the player with strangers on a waiting page
that shows "N of 5 players" and, once a countdown runs, "starting in... S".

## Rules

| Players waiting | What happens |
| --- | --- |
| 1 | Nothing starts, no timer runs |
| 2nd joins | Countdown starts at 30 s |
| 3rd or 4th joins | Countdown resets to 15 s (on every such join) |
| 5th joins | Game starts immediately |
| Countdown reaches 0 with 2-4 players | Game starts |

The game is a normal room with rounds = 3. A round (rotation) means every player draws once, so a public
game is 3 drawing turns per player. The first player placed is host (can "Play again" after game over).

## Edge-case choices

- Placement (`lobby.js`, `Matchmaker.join`) is one synchronous step: find the oldest open lobby with a free
  seat, add the player, apply the timer rule. No await between count check and add, so concurrent clicks
  never overfill a lobby or place one connection twice. A second "public" message from a waiting
  connection is ignored.
- Leave or disconnect while waiting: player removed. Down to 1: countdown cancelled, wait. Down to 2:
  countdown restarts at 30 s. 4 to 3: deadline kept (same rule, no reset on leave). Empty lobby is deleted.
- Countdown expiry re-checks the count; a lobby never starts with fewer than 2.
- A started lobby is removed from matchmaking; late joiners get a fresh lobby. Public rooms cannot be
  joined by room code (only resume/reconnect of existing players works).
- Timers: one setTimeout per counting lobby, cleared on cancel, start, empty and server close. No
  interval exists for lobbies, so idle matchmaking does not keep the Fly machine awake.
- Names reuse the existing name rule. Duplicate names in one game get a suffix: "Pat", "Pat 2", ...
- Rate limit: lobby joins share the existing per-connection join bucket (5 burst, 1 per 5 s) and the
  per-IP connection cap.
- Countdown is server-authoritative: the server sends the remaining ms on every change; clients count down
  locally from receipt time.
- If the server cannot create a room (100-room cap) every waiting player gets "Server busy, try later".
- No new data is stored; history rules unchanged.
- Test knobs: `LOBBY_FIRST_MS`, `LOBBY_RESET_MS` env (or `lobbyFirstMs`/`lobbyResetMs` start options).
