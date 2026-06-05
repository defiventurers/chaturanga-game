const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const COUNTDOWN_DURATION_MS = 5000;
const SERVER_TIME_OFFSET_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const PLAYERS = ["red", "green", "blue", "yellow"];
const rooms = new Map();
const socketsByClientId = new Map();
const roomCodesByClientId = new Map();

function serverUpdatedAt() {
  return Date.now() + SERVER_TIME_OFFSET_MS;
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

function send(ws, packet) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(packet));
  }
}

function sendError(ws, requestId, message, code = "ERROR") {
  send(ws, {
    type: "error_notice",
    requestId,
    payload: { message, code }
  });
}

function getPlayers(room) {
  return Object.values(room?.players || {});
}

function rememberClientRoom(clientId, roomCode) {
  if (!clientId || !roomCode) return;
  roomCodesByClientId.set(clientId, roomCode);
}

function rememberRoomSockets(room) {
  for (const player of getPlayers(room)) {
    if (!player?.clientId) continue;
    rememberClientRoom(player.clientId, room.roomCode);
  }
}

function broadcastRoom(room) {
  if (!room?.roomCode) return;
  room.updatedAt = serverUpdatedAt();

  const packet = {
    type: "room_state",
    payload: { room }
  };

  for (const player of getPlayers(room)) {
    const socket = socketsByClientId.get(player.clientId);
    if (socket) send(socket, packet);
  }
}

function createEmptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function makePiece(team, type, isRoyal = false) {
  return { team, type, isRoyal };
}

function createInitialBoard() {
  const board = createEmptyBoard();

  board[0][0] = makePiece("yellow", "ship");
  board[0][1] = makePiece("yellow", "horse");
  board[0][2] = makePiece("yellow", "elephant");
  board[0][3] = makePiece("yellow", "king", true);
  board[1][0] = makePiece("yellow", "pawn");
  board[1][1] = makePiece("yellow", "pawn");
  board[1][2] = makePiece("yellow", "pawn");
  board[1][3] = makePiece("yellow", "pawn");

  board[7][0] = makePiece("red", "ship");
  board[6][0] = makePiece("red", "horse");
  board[5][0] = makePiece("red", "elephant");
  board[4][0] = makePiece("red", "king", true);
  board[7][1] = makePiece("red", "pawn");
  board[6][1] = makePiece("red", "pawn");
  board[5][1] = makePiece("red", "pawn");
  board[4][1] = makePiece("red", "pawn");

  board[7][4] = makePiece("green", "king", true);
  board[7][5] = makePiece("green", "elephant");
  board[7][6] = makePiece("green", "horse");
  board[7][7] = makePiece("green", "ship");
  board[6][4] = makePiece("green", "pawn");
  board[6][5] = makePiece("green", "pawn");
  board[6][6] = makePiece("green", "pawn");
  board[6][7] = makePiece("green", "pawn");

  board[3][7] = makePiece("blue", "king", true);
  board[2][7] = makePiece("blue", "elephant");
  board[1][7] = makePiece("blue", "horse");
  board[0][7] = makePiece("blue", "ship");
  board[3][6] = makePiece("blue", "pawn");
  board[2][6] = makePiece("blue", "pawn");
  board[1][6] = makePiece("blue", "pawn");
  board[0][6] = makePiece("blue", "pawn");

  return board;
}

function createControlMap(room) {
  const humans = new Set(getPlayers(room).map(player => player.team).filter(Boolean));
  const controlMap = {};
  for (const team of PLAYERS) {
    controlMap[team] = humans.has(team) ? "online-human" : "bot";
  }
  return controlMap;
}

function createGameStateSnapshot(room) {
  return {
    board: createInitialBoard(),
    currentPlayerIndex: 0,
    selected: null,
    legalMoves: [],
    dice: { values: [null, null], used: [false, false], rolled: false },
    moveLog: [],
    gameOver: false,
    winner: null,
    controlMap: createControlMap(room)
  };
}

function isRoomReadyToStart(room) {
  const players = getPlayers(room);
  const required = Number(room?.playerCount || 0);
  if (!room || required < 1) return false;
  if (players.length !== required) return false;

  const teams = players.map(player => player.team).filter(Boolean);
  if (teams.length !== required) return false;
  if (new Set(teams).size !== teams.length) return false;

  return players.every(player => player.ready);
}

function maybeAdvanceRoomStart(room) {
  if (!room) return room;

  if (room.gameStarted) {
    if (!room.gameStateSnapshot) room.gameStateSnapshot = createGameStateSnapshot(room);
    return room;
  }

  if (!isRoomReadyToStart(room)) {
    if (room.countdownStartTime) room.countdownStartTime = null;
    return room;
  }

  if (!room.countdownStartTime) {
    room.countdownStartTime = Date.now();
    room.countdownDurationMs = room.countdownDurationMs || COUNTDOWN_DURATION_MS;
    return room;
  }

  const elapsed = Date.now() - room.countdownStartTime;
  const duration = room.countdownDurationMs || COUNTDOWN_DURATION_MS;

  if (elapsed >= duration) {
    room.gameStarted = true;
    room.countdownStartTime = null;
    if (!room.gameStateSnapshot) room.gameStateSnapshot = createGameStateSnapshot(room);
  }

  return room;
}

function prepareRoom(room) {
  if (!room) return null;

  const prepared = {
    ...room,
    roomCode: normalizeRoomCode(room.roomCode),
    players: { ...(room.players || {}) },
    updatedAt: serverUpdatedAt()
  };

  if (!prepared.countdownDurationMs) prepared.countdownDurationMs = COUNTDOWN_DURATION_MS;
  if (typeof prepared.gameStarted !== "boolean") prepared.gameStarted = false;
  if (!("gameStateSnapshot" in prepared)) prepared.gameStateSnapshot = null;

  return prepared;
}

function mergeRoomState(incomingRoom) {
  const incoming = prepareRoom(incomingRoom);
  if (!incoming?.roomCode) return null;

  const existing = rooms.get(incoming.roomCode);
  if (!existing) {
    const advanced = maybeAdvanceRoomStart(incoming);
    advanced.updatedAt = serverUpdatedAt();
    rooms.set(advanced.roomCode, advanced);
    rememberRoomSockets(advanced);
    return advanced;
  }

  const mergedPlayers = {
    ...(existing.players || {}),
    ...(incoming.players || {})
  };

  const merged = {
    ...existing,
    ...incoming,
    roomCode: incoming.roomCode,
    hostClientId: existing.hostClientId || incoming.hostClientId,
    players: mergedPlayers,
    gameStarted: Boolean(existing.gameStarted || incoming.gameStarted),
    gameStateSnapshot: incoming.gameStateSnapshot || existing.gameStateSnapshot || null,
    countdownStartTime: incoming.countdownStartTime ?? existing.countdownStartTime ?? null,
    countdownDurationMs: incoming.countdownDurationMs || existing.countdownDurationMs || COUNTDOWN_DURATION_MS,
    updatedAt: serverUpdatedAt()
  };

  const advanced = maybeAdvanceRoomStart(merged);
  advanced.updatedAt = serverUpdatedAt();
  rooms.set(advanced.roomCode, advanced);
  rememberRoomSockets(advanced);
  return advanced;
}

function handleCreateRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const room = prepareRoom(payload?.room);

  if (!clientId) return sendError(ws, requestId, "Missing clientId.", "MISSING_CLIENT_ID");
  if (!room?.roomCode) return sendError(ws, requestId, "Missing room data.", "MISSING_ROOM");

  socketsByClientId.set(clientId, ws);
  rememberClientRoom(clientId, room.roomCode);

  room.hostClientId = room.hostClientId || clientId;

  if (!room.players[clientId]) {
    room.players[clientId] = {
      clientId,
      name: "Host",
      team: "green",
      ready: false,
      isHost: true,
      joinedAt: Date.now()
    };
  }

  const mergedRoom = mergeRoomState(room);

  send(ws, {
    type: "create_room_result",
    requestId,
    payload: { room: mergedRoom }
  });

  broadcastRoom(mergedRoom);
}

function handleJoinRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const roomCode = normalizeRoomCode(payload?.roomCode);

  if (!clientId) return sendError(ws, requestId, "Missing clientId.", "MISSING_CLIENT_ID");
  if (!roomCode) return sendError(ws, requestId, "Missing room code.", "MISSING_ROOM_CODE");

  const room = rooms.get(roomCode);
  if (!room) return sendError(ws, requestId, "Room not found.", "ROOM_NOT_FOUND");

  socketsByClientId.set(clientId, ws);
  rememberClientRoom(clientId, roomCode);

  if (!room.players[clientId]) {
    const maxPlayers = Number(room.playerCount || 2);
    if (getPlayers(room).length >= maxPlayers) {
      return sendError(ws, requestId, "Room is full.", "ROOM_FULL");
    }

    room.players[clientId] = {
      clientId,
      name: payload?.player?.name || "Player",
      team: null,
      ready: false,
      isHost: false,
      joinedAt: Date.now()
    };
  }

  const mergedRoom = mergeRoomState(room);

  send(ws, {
    type: "join_room_result",
    requestId,
    payload: { room: mergedRoom }
  });

  broadcastRoom(mergedRoom);
}

function handleGetRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const roomCode = normalizeRoomCode(payload?.roomCode || roomCodesByClientId.get(clientId));

  if (clientId) socketsByClientId.set(clientId, ws);

  const currentRoom = rooms.get(roomCode);
  if (!currentRoom) return sendError(ws, requestId, "Room not found.", "ROOM_NOT_FOUND");

  const room = mergeRoomState(currentRoom);

  if (clientId) rememberClientRoom(clientId, roomCode);

  send(ws, {
    type: "get_room_result",
    requestId,
    payload: { room }
  });

  if (!room.gameStarted) {
    send(ws, {
      type: "room_state",
      payload: { room }
    });
    broadcastRoom(room);
  }
}

function handleUpdateRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const room = payload?.room;

  if (!clientId) return sendError(ws, requestId, "Missing clientId.", "MISSING_CLIENT_ID");
  if (!room?.roomCode) return sendError(ws, requestId, "Missing room data.", "MISSING_ROOM");

  socketsByClientId.set(clientId, ws);
  rememberClientRoom(clientId, normalizeRoomCode(room.roomCode));

  const mergedRoom = mergeRoomState(room);

  send(ws, {
    type: "update_room_result",
    requestId,
    payload: { room: mergedRoom }
  });

  broadcastRoom(mergedRoom);
}

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Arctic Dominion WebSocket server is running.");
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      clients: socketsByClientId.size
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let packet;

    try {
      packet = JSON.parse(raw);
    } catch (_error) {
      sendError(ws, null, "Invalid JSON packet.", "BAD_JSON");
      return;
    }

    const { type, requestId, payload = {} } = packet || {};

    if (payload.clientId) {
      socketsByClientId.set(payload.clientId, ws);
    }

    if (type === "create_room") return handleCreateRoom(ws, requestId, payload);
    if (type === "join_room") return handleJoinRoom(ws, requestId, payload);
    if (type === "get_room") return handleGetRoom(ws, requestId, payload);
    if (type === "update_room") return handleUpdateRoom(ws, requestId, payload);

    sendError(ws, requestId, `Unknown message type: ${type}`, "UNKNOWN_TYPE");
  });

  ws.on("close", () => {
    for (const [clientId, socket] of socketsByClientId.entries()) {
      if (socket === ws) socketsByClientId.delete(clientId);
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    const beforeStarted = room.gameStarted;
    const beforeCountdown = room.countdownStartTime;
    maybeAdvanceRoomStart(room);
    room.updatedAt = serverUpdatedAt();
    const justStarted = beforeStarted !== room.gameStarted;
    const countdownChanged = beforeCountdown !== room.countdownStartTime;
    if (!room.gameStarted && (isRoomReadyToStart(room) || countdownChanged)) {
      broadcastRoom(room);
    } else if (justStarted) {
      broadcastRoom(room);
    }
  }
}, 500);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Arctic Dominion server running on port ${PORT}`);
});
