# Backend Implementation Steps (Executed in this Repository)

This file maps the requested backend scope to concrete implementation artifacts now included in the repository.

## 1. Local Infrastructure

- Added `docker-compose.yml` with:
  - PostgreSQL service for Nakama persistence.
  - Nakama service with startup migration.
  - Runtime module mount from `nakama/modules`.

## 2. Authoritative Match Engine

- Added `nakama/modules/index.js` with an authoritative `tic_tac_toe_match` handler that supports:
  - Strict server-side move validation.
  - Turn enforcement.
  - Win/draw detection.
  - Match state broadcasting.

## 3. Timed Mode

- Implemented timed mode behavior in match loop:
  - Turn deadlines (`turnDeadlineMs`).
  - Remaining-time broadcast.
  - Auto-forfeit on timeout.

## 4. Concurrent Session Support

- Match state is isolated per match instance.
- Each match can host up to 2 players.
- No cross-match shared mutable state is used for game data.

## 5. Private Room and Match Access RPCs

Implemented RPCs:

- `rpc_create_private_room`
- `rpc_join_private_room`
- `rpc_get_player_stats`
- `rpc_get_leaderboard`

Private room mapping is persisted via Nakama storage collection `private_rooms`.

## 6. Leaderboard and Stats

- Ensures leaderboard `global_ttt_ranked` exists at module init.
- Persists per-player stats in `player_stats` collection.
- Updates leaderboard rating after each match completion.

## 7. Runtime Notes

- Match opcode contract:
  - `1` move
  - `2` state update
  - `3` error
  - `4` timer update
  - `5` system events (e.g., match end)

## 8. Quick Start

```bash
docker compose up --build
```

Nakama endpoints:

- `http://localhost:7350` (HTTP/WS)
- `http://localhost:7351` (Console)

## 9. Next Steps

- Add automated integration tests using Nakama client SDK.
- Add matchmaker queue integration for random matchmaking buckets.
- Add reconnect grace timer instead of immediate disconnect forfeit.
- Add CI workflow to lint runtime JS and validate compose configuration.
