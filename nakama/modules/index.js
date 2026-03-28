/*
 * Nakama authoritative Tic-Tac-Toe module.
 * Includes:
 * - Authoritative match handler (classic + timed mode)
 * - Private room creation/join RPCs
 * - Player stats and leaderboard read RPCs
 */

var COLLECTIONS = {
  PRIVATE_ROOMS: "private_rooms",
  PLAYER_STATS: "player_stats",
};

var LEADERBOARD_ID = "global_ttt_ranked";

var OP = {
  MOVE: 1,
  STATE: 2,
  ERROR: 3,
  TIMER: 4,
  SYSTEM: 5,
};

var DEFAULT_TURN_TIMEOUT_MS = 30_000;

function InitModule(ctx, logger, nk, initializer) {
  logger.info("Initializing Tic-Tac-Toe Nakama module.");

  try {
    nk.leaderboardCreate(
      LEADERBOARD_ID,
      true,
      "desc",
      "best",
      "",
      { mode: "global" },
      true
    );
    logger.info("Leaderboard ensured: %s", LEADERBOARD_ID);
  } catch (err) {
    logger.warn("Leaderboard create skipped: %s", err);
  }

  initializer.registerMatch("tic_tac_toe_match", {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchSignal: matchSignal,
    matchTerminate: matchTerminate,
  });

  initializer.registerRpc("rpc_create_private_room", rpcCreatePrivateRoom);
  initializer.registerRpc("rpc_join_private_room", rpcJoinPrivateRoom);
  initializer.registerRpc("rpc_get_player_stats", rpcGetPlayerStats);
  initializer.registerRpc("rpc_get_leaderboard", rpcGetLeaderboard);

  logger.info("Tic-Tac-Toe Nakama module initialized.");
}

function rpcCreatePrivateRoom(ctx, logger, nk, payload) {
  ensureAuthed(ctx);

  var body = parsePayload(payload, { mode: "classic" });
  var mode = body.mode === "timed" ? "timed" : "classic";
  var roomCode = generateRoomCode();

  var matchId = nk.matchCreate("tic_tac_toe_match", {
    mode: mode,
    private: true,
    roomCode: roomCode,
    ownerUserId: ctx.userId,
  });

  nk.storageWrite([
    {
      collection: COLLECTIONS.PRIVATE_ROOMS,
      key: roomCode,
      userId: ctx.userId,
      value: {
        matchId: matchId,
        mode: mode,
        createdBy: ctx.userId,
        createdAt: Date.now(),
      },
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);

  return JSON.stringify({ roomCode: roomCode, matchId: matchId, mode: mode });
}

function rpcJoinPrivateRoom(ctx, logger, nk, payload) {
  ensureAuthed(ctx);

  var body = parsePayload(payload, {});
  if (!body.roomCode || typeof body.roomCode !== "string") {
    throw Error("roomCode is required");
  }

  var roomCode = body.roomCode.toUpperCase().trim();

  var records = nk.storageRead([
    {
      collection: COLLECTIONS.PRIVATE_ROOMS,
      key: roomCode,
      userId: ctx.userId,
    },
  ]);

  if (!records || records.length === 0) {
    throw Error("Room not found");
  }

  var room = records[0].value;
  return JSON.stringify({
    roomCode: roomCode,
    matchId: room.matchId,
    mode: room.mode || "classic",
  });
}

function rpcGetPlayerStats(ctx, logger, nk, payload) {
  ensureAuthed(ctx);

  var body = parsePayload(payload, {});
  var targetUserId = body.userId || ctx.userId;

  var stats = getPlayerStats(nk, targetUserId);
  return JSON.stringify(stats);
}

function rpcGetLeaderboard(ctx, logger, nk, payload) {
  ensureAuthed(ctx);

  var body = parsePayload(payload, { limit: 20, cursor: "" });
  var limit = Math.max(1, Math.min(100, Number(body.limit || 20)));
  var cursor = body.cursor || "";

  var result = nk.leaderboardRecordsList(LEADERBOARD_ID, [], limit, cursor, 0);
  return JSON.stringify({
    records: result.records || [],
    ownerRecords: result.ownerRecords || [],
    cursor: result.nextCursor || "",
    prevCursor: result.prevCursor || "",
  });
}

function matchInit(ctx, logger, nk, params) {
  var mode = params.mode === "timed" ? "timed" : "classic";

  var state = {
    matchId: ctx.matchId,
    mode: mode,
    private: !!params.private,
    roomCode: params.roomCode || null,
    board: ["", "", "", "", "", "", "", "", ""],
    status: "waiting", // waiting|active|completed
    winner: null,
    winLine: null,
    turn: null,
    players: {}, // userId => { presence, mark, connected }
    marks: { X: null, O: null },
    moveHistory: [],
    tickRate: 5,
    turnTimeoutMs: mode === "timed" ? DEFAULT_TURN_TIMEOUT_MS : null,
    turnDeadlineMs: null,
    lastTickMs: Date.now(),
    createdAtMs: Date.now(),
    completedAtMs: null,
  };

  return { state: state, tickRate: state.tickRate, label: mode + (state.private ? "|private" : "|public") };
}

function matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  if (state.status === "completed") {
    return { state: state, accept: false, rejectMessage: "Match already completed" };
  }

  if (!state.players[presence.userId] && Object.keys(state.players).length >= 2) {
    return { state: state, accept: false, rejectMessage: "Match is full" };
  }

  return { state: state, accept: true };
}

function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    if (!state.players[p.userId]) {
      var assignedMark = state.marks.X ? "O" : "X";
      state.players[p.userId] = { presence: p, mark: assignedMark, connected: true };
      state.marks[assignedMark] = p.userId;
    } else {
      state.players[p.userId].presence = p;
      state.players[p.userId].connected = true;
    }
  }

  maybeStartMatch(state);
  broadcastState(dispatcher, state);
  return { state: state };
}

function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    if (state.players[p.userId]) {
      state.players[p.userId].connected = false;
    }
  }

  if (state.status === "active") {
    var disconnected = findDisconnectedPlayer(state);
    if (disconnected) {
      finalizeMatch(logger, nk, dispatcher, state, {
        winnerUserId: opponentOf(state, disconnected),
        reason: "disconnect_forfeit",
      });
    }
  }

  return { state: state };
}

function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  state.lastTickMs = Date.now();

  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];

    if (message.opCode !== OP.MOVE) {
      continue;
    }

    var move;
    try {
      move = JSON.parse(message.data);
    } catch (err) {
      sendError(dispatcher, message.sender, "Invalid move payload");
      continue;
    }

    if (state.status !== "active") {
      sendError(dispatcher, message.sender, "Match is not active");
      continue;
    }

    var senderUserId = message.sender.userId;
    var player = state.players[senderUserId];
    if (!player) {
      sendError(dispatcher, message.sender, "Sender is not in match");
      continue;
    }

    if (state.turn !== senderUserId) {
      sendError(dispatcher, message.sender, "Not your turn");
      continue;
    }

    var index = Number(move.index);
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      sendError(dispatcher, message.sender, "index must be an integer between 0 and 8");
      continue;
    }

    if (state.board[index] !== "") {
      sendError(dispatcher, message.sender, "Cell already occupied");
      continue;
    }

    state.board[index] = player.mark;
    state.moveHistory.push({
      by: senderUserId,
      mark: player.mark,
      index: index,
      atMs: Date.now(),
    });

    var winLine = detectWinLine(state.board, player.mark);
    if (winLine) {
      finalizeMatch(logger, nk, dispatcher, state, {
        winnerUserId: senderUserId,
        reason: "win",
        winLine: winLine,
      });
      continue;
    }

    if (isBoardFull(state.board)) {
      finalizeMatch(logger, nk, dispatcher, state, {
        winnerUserId: null,
        reason: "draw",
      });
      continue;
    }

    state.turn = opponentOf(state, senderUserId);
    resetTurnDeadline(state);
    broadcastState(dispatcher, state);
  }

  if (state.status === "active" && state.mode === "timed" && state.turnDeadlineMs) {
    var now = Date.now();
    var remainingMs = Math.max(0, state.turnDeadlineMs - now);

    dispatcher.broadcastMessage(OP.TIMER, JSON.stringify({
      turnUserId: state.turn,
      remainingMs: remainingMs,
    }), null, null, true);

    if (remainingMs === 0) {
      finalizeMatch(logger, nk, dispatcher, state, {
        winnerUserId: opponentOf(state, state.turn),
        reason: "timeout_forfeit",
      });
    }
  }

  return { state: state };
}

function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
  if (data === "terminate") {
    return { state: state, data: "Terminating match" };
  }

  return { state: state, data: "Unhandled signal" };
}

function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  return { state: state };
}

function maybeStartMatch(state) {
  if (state.status !== "waiting") {
    return;
  }

  var ids = Object.keys(state.players);
  if (ids.length < 2) {
    return;
  }

  state.status = "active";
  state.turn = state.marks.X;
  resetTurnDeadline(state);
}

function resetTurnDeadline(state) {
  if (state.mode !== "timed") {
    state.turnDeadlineMs = null;
    return;
  }

  state.turnDeadlineMs = Date.now() + state.turnTimeoutMs;
}

function broadcastState(dispatcher, state) {
  dispatcher.broadcastMessage(OP.STATE, JSON.stringify(publicState(state)), null, null, true);
}

function publicState(state) {
  return {
    matchId: state.matchId,
    mode: state.mode,
    private: state.private,
    roomCode: state.roomCode,
    board: state.board,
    status: state.status,
    winner: state.winner,
    winLine: state.winLine,
    turn: state.turn,
    marks: state.marks,
    moveHistory: state.moveHistory,
    turnDeadlineMs: state.turnDeadlineMs,
    createdAtMs: state.createdAtMs,
    completedAtMs: state.completedAtMs,
  };
}

function finalizeMatch(logger, nk, dispatcher, state, result) {
  if (state.status === "completed") {
    return;
  }

  state.status = "completed";
  state.winner = result.winnerUserId;
  state.winLine = result.winLine || null;
  state.completedAtMs = Date.now();
  state.turn = null;
  state.turnDeadlineMs = null;

  persistMatchOutcome(logger, nk, state, result);

  dispatcher.broadcastMessage(OP.SYSTEM, JSON.stringify({
    type: "match_end",
    reason: result.reason,
    winnerUserId: state.winner,
  }), null, null, true);

  broadcastState(dispatcher, state);
}

function persistMatchOutcome(logger, nk, state, result) {
  var xUserId = state.marks.X;
  var oUserId = state.marks.O;

  if (!xUserId || !oUserId) {
    logger.warn("Skipping stats persist: players not complete.");
    return;
  }

  var statsX = getPlayerStats(nk, xUserId);
  var statsO = getPlayerStats(nk, oUserId);

  var winner = result.winnerUserId;

  if (!winner) {
    applyDraw(statsX);
    applyDraw(statsO);
  } else if (winner === xUserId) {
    applyWin(statsX);
    applyLoss(statsO, result.reason);
  } else {
    applyWin(statsO);
    applyLoss(statsX, result.reason);
  }

  writePlayerStats(nk, xUserId, statsX);
  writePlayerStats(nk, oUserId, statsO);

  writeLeaderboardRecord(nk, xUserId, statsX.rating);
  writeLeaderboardRecord(nk, oUserId, statsO.rating);
}

function writeLeaderboardRecord(nk, userId, rating) {
  nk.leaderboardRecordWrite(LEADERBOARD_ID, userId, rating, rating, null, null);
}

function getPlayerStats(nk, userId) {
  var records = nk.storageRead([
    {
      collection: COLLECTIONS.PLAYER_STATS,
      key: userId,
      userId: userId,
    },
  ]);

  if (records && records.length > 0) {
    return records[0].value;
  }

  return {
    userId: userId,
    wins: 0,
    losses: 0,
    draws: 0,
    winStreak: 0,
    bestWinStreak: 0,
    totalGames: 0,
    rating: 0,
    updatedAt: Date.now(),
  };
}

function writePlayerStats(nk, userId, stats) {
  stats.updatedAt = Date.now();

  nk.storageWrite([
    {
      collection: COLLECTIONS.PLAYER_STATS,
      key: userId,
      userId: userId,
      value: stats,
      permissionRead: 2,
      permissionWrite: 0,
    },
  ]);
}

function applyWin(stats) {
  stats.wins += 1;
  stats.totalGames += 1;
  stats.winStreak += 1;
  stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.winStreak);
  stats.rating += 10;
}

function applyLoss(stats, reason) {
  stats.losses += 1;
  stats.totalGames += 1;
  stats.winStreak = 0;

  if (reason === "timeout_forfeit") {
    stats.rating = Math.max(0, stats.rating - 2);
  }
}

function applyDraw(stats) {
  stats.draws += 1;
  stats.totalGames += 1;
  stats.winStreak = 0;
  stats.rating += 2;
}

function opponentOf(state, userId) {
  if (!userId) return null;
  if (state.marks.X === userId) return state.marks.O;
  if (state.marks.O === userId) return state.marks.X;
  return null;
}

function findDisconnectedPlayer(state) {
  var userIds = Object.keys(state.players);
  for (var i = 0; i < userIds.length; i++) {
    var id = userIds[i];
    if (!state.players[id].connected) {
      return id;
    }
  }

  return null;
}

function sendError(dispatcher, presence, message) {
  dispatcher.broadcastMessage(OP.ERROR, JSON.stringify({ message: message }), [presence], null, true);
}

function isBoardFull(board) {
  for (var i = 0; i < board.length; i++) {
    if (board[i] === "") return false;
  }

  return true;
}

function detectWinLine(board, mark) {
  var lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (board[line[0]] === mark && board[line[1]] === mark && board[line[2]] === mark) {
      return line;
    }
  }

  return null;
}

function parsePayload(payload, defaults) {
  if (!payload || payload === "") {
    return defaults;
  }

  var parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object") {
    return defaults;
  }

  return Object.assign({}, defaults, parsed);
}

function ensureAuthed(ctx) {
  if (!ctx.userId) {
    throw Error("Unauthenticated");
  }
}

function generateRoomCode() {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var out = "";
  for (var i = 0; i < 6; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return out;
}
