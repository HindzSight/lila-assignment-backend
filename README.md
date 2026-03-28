# Multiplayer Tic-Tac-Toe Backend (Nakama)

This document provides a production-focused backend implementation plan for a multiplayer Tic-Tac-Toe game using Nakama. It includes architecture, setup, implementation steps, deployment, configuration, and testing guidance.

## 1) Backend Scope and Goals

The backend must provide:

- **Server-authoritative gameplay**: all moves are validated and applied by server logic only.
- **Real-time multiplayer**: low-latency state updates to both players.
- **Matchmaking and room support**: random pairing and private room flows.
- **Concurrent session support**: multiple game sessions in parallel with isolation.
- **Leaderboard and player stats**: wins, losses, draws, streaks, ranking.
- **Timed mode support**: turn timeout with auto-forfeit handling.

---

## 2) Recommended Architecture

### 2.1 Components

- **Nakama Server** (runtime + authoritative match handler)
- **Database (PostgreSQL via Nakama)** for accounts, storage objects, and leaderboard records
- **Client App** (web/mobile) for UI and socket communication
- **Optional API Gateway / Reverse Proxy** (NGINX, Cloud LB)

### 2.2 Logical Modules

1. **Authentication Module**
   - Device, email, or custom ID auth using Nakama client APIs.
2. **Matchmaking Module**
   - Queue players for classic or timed mode.
   - Support room code creation/join.
3. **Authoritative Match Engine**
   - Initialize board and players.
   - Validate move legality and turn ownership.
   - Detect win/draw and finalize match.
4. **Timer Engine (timed mode)**
   - Track turn deadline and auto-forfeit on timeout.
5. **Stats & Leaderboard Module**
   - Persist match result.
   - Update rating/score and streaks.
6. **Observability Module**
   - Structured logs, metrics, and alerts.

---

## 3) Data Model (Backend)

Use Nakama storage and leaderboard features with these recommended records:

### 3.1 Storage Collections

- `player_profile`
  - `user_id`
  - `display_name`
  - `created_at`
- `player_stats`
  - `wins`
  - `losses`
  - `draws`
  - `win_streak`
  - `best_win_streak`
  - `total_games`
  - `rating` (or points)
- `match_history`
  - `match_id`
  - `mode` (`classic` or `timed`)
  - `players`
  - `result`
  - `move_count`
  - `duration_ms`
  - `ended_at`

### 3.2 Leaderboard

- Leaderboard ID: `global_ttt_ranked`
- Sort: descending score/rating
- Metadata: optional region, mode, season

---

## 4) Implementation Plan (Step-by-Step)

## Phase 1 — Bootstrap Nakama Runtime

1. Provision Nakama and PostgreSQL locally via Docker Compose.
2. Configure runtime modules directory and server key/env.
3. Add TypeScript or Lua runtime for authoritative match logic.
4. Implement health checks and startup scripts.

**Outcome:** Backend service starts consistently in local/dev.

## Phase 2 — Authentication and Session Handling

1. Implement client authentication flow (device/custom ID recommended for quick start).
2. Return session token and open real-time socket.
3. Add reconnect strategy:
   - short disconnect grace period
   - session resume where possible

**Outcome:** Players can securely connect and stay authenticated.

## Phase 3 — Authoritative Match Handler

1. Create match state shape:
   - board (9 cells)
   - player IDs and assigned marks (X/O)
   - current turn
   - move history
   - status (`waiting`, `active`, `completed`)
2. On match join:
   - allow max 2 players
   - lock match start once both players connected
3. On move message:
   - validate sender is current player
   - validate cell empty and index range (0-8)
   - apply move server-side
   - evaluate win/draw
   - broadcast updated state
4. On game end:
   - publish final state and winner
   - persist match result
   - update stats + leaderboard

**Outcome:** Cheat-resistant core gameplay runs entirely on server.

## Phase 4 — Matchmaking and Room Flows

1. Add **random matchmaking** queue by mode (`classic`, `timed`).
2. Add **private room** flow:
   - create room code
   - join by room code
3. Add cancellation/timeout behavior for queue waiting.
4. Ensure disconnected players are handled gracefully:
   - reconnect window
   - auto-forfeit if absent too long

**Outcome:** Users can quickly find or create matches with robust lifecycle handling.

## Phase 5 — Timer-Based Game Mode

1. Extend match state with timer data:
   - `turn_start_ms`
   - `turn_deadline_ms`
   - `mode`
2. Add server tick loop to evaluate timeout.
3. If current player exceeds limit:
   - trigger auto-forfeit
   - finalize result
4. Broadcast remaining turn time to clients on each tick/update.
5. Separate matchmaking pool for timed mode.

**Outcome:** Timed matches enforce fair turn deadlines from backend authority.

## Phase 6 — Leaderboard and Ranking

1. Define scoring strategy (example):
   - win = +10
   - draw = +2
   - loss = 0
   - timeout loss = 0 (or penalty)
2. Submit score to Nakama leaderboard on each match completion.
3. Persist cumulative stats in `player_stats` collection.
4. Add APIs/RPC endpoints for:
   - top-N global leaderboard
   - player rank + stats summary

**Outcome:** Competitive progression and historical stats are available.

## Phase 7 — Hardening and Production Readiness

1. Add idempotency protections for match finalization.
2. Add rate limits for RPC/match actions.
3. Validate all payload schemas server-side.
4. Add structured logging with correlation IDs.
5. Add monitoring dashboards and alerting (CPU, memory, websocket count, match errors).
6. Add backup policy for DB and restore drill.

**Outcome:** Stable backend behavior under concurrent real-world load.

---

## 5) Concurrent Game Support Design

To support multiple simultaneous sessions:

- Use one authoritative match instance per game.
- Keep match state isolated in memory per match handler.
- Avoid global mutable in-memory state for match-specific data.
- Use storage writes only at key checkpoints (end-of-game), not every move.
- Size Nakama node resources by expected concurrent socket count and match tick workload.

Scaling guidance:

- Start with single Nakama node for MVP.
- Introduce horizontal scaling behind load balancer.
- Use sticky websocket routing where required by infrastructure.

---

## 6) API / Server Configuration Details

## 6.1 Environment Variables (example)

- `NAKAMA_NAME=nakama1`
- `NAKAMA_DATABASE_ADDRESS=postgres:5432`
- `NAKAMA_RUNTIME_HTTP_KEY=<server_http_key>`
- `NAKAMA_SOCKET_SERVER_KEY=<socket_server_key>`
- `NAKAMA_LOG_LEVEL=info`

## 6.2 Runtime Config Recommendations

- Enable authoritative matches.
- Set sane websocket ping/pong and idle timeout values.
- Configure max message size to prevent abuse.
- Enable TLS termination at load balancer/reverse proxy.

## 6.3 Suggested RPC Contract

- `rpc_create_private_room(mode)` → returns `room_code`
- `rpc_join_private_room(room_code)` → joins/returns match reference
- `rpc_get_player_stats(user_id)` → stats payload
- `rpc_get_leaderboard(limit, cursor)` → ranked players

---

## 7) Deployment Process Documentation

## 7.1 Local Development

1. Run Nakama + PostgreSQL via Docker Compose.
2. Mount runtime modules into Nakama container.
3. Start backend and verify health endpoint.
4. Connect two test clients and play full match.

## 7.2 Staging Deployment

1. Build container images for Nakama runtime.
2. Apply infrastructure (VM/Kubernetes) + managed Postgres.
3. Inject environment secrets from secret manager.
4. Run DB migrations and runtime module rollout.
5. Smoke test matchmaking, move validation, and leaderboard writes.

## 7.3 Production Deployment

1. Use blue/green or canary rollout.
2. Enforce TLS and WAF/rate-limiting.
3. Configure autoscaling policies.
4. Monitor error budgets and rollback on SLO breach.

---

## 8) How to Test Multiplayer Functionality

## 8.1 Functional Tests

- Two players can match and start game.
- Server rejects invalid moves:
  - out-of-turn move
  - occupied cell move
  - invalid index
- Win and draw conditions are correct.
- Disconnection and reconnect behavior works.
- Timeout in timed mode causes expected forfeit.

## 8.2 Integration / Load Tests

- Simulate N concurrent matches.
- Measure p95/p99 move-to-broadcast latency.
- Validate no state leakage across matches.
- Verify leaderboard consistency after bulk game completion.

## 8.3 Security Tests

- Replay attack attempts on move messages.
- Forged winner payload attempts from clients.
- Excessive RPC spam and malformed payload fuzzing.

---

## 9) Suggested Repository Deliverables

- `README.md` (this document)
- `docker-compose.yml` for local Nakama stack
- `nakama/modules/` runtime scripts (match logic, RPCs)
- `docs/architecture.md` (diagrams + decisions)
- `docs/runbooks.md` (ops, incident, rollback)

---

## 10) Milestone Checklist

- [ ] Authentication and socket connection complete
- [ ] Authoritative match logic complete
- [ ] Matchmaking (random + room code) complete
- [ ] Timed mode complete
- [ ] Leaderboard + stats persistence complete
- [ ] Staging deployment complete
- [ ] Load/security testing complete
- [ ] Production release complete

This plan is designed so you can ship an MVP quickly, then harden incrementally for production-scale concurrency and reliability.
