const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const rooms = new Map();
const socketsByClientId = new Map();
const roomCodesByClientId = new Map();

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

function rememberRoomSockets(room, wsByClient = null) {
  for (const player of getPlayers(room)) {
    if (!player?.clientId) continue;
    rememberClientRoom(player.clientId, room.roomCode);
    if (wsByClient?.has(player.clientId)) {
      socketsByClientId.set(player.clientId, wsByClient.get(player.clientId));
    }
  }
}

function broadcastRoom(room) {
  if (!room?.roomCode) return;

  const packet = {
    type: "room_state",
    payload: { room }
  };

  for (const player of getPlayers(room)) {
    const socket = socketsByClientId.get(player.clientId);
    if (socket) send(socket, packet);
  }
}

function prepareRoom(room) {
  if (!room) return null;

  const prepared = {
    ...room,
    roomCode: normalizeRoomCode(room.roomCode),
    players: { ...(room.players || {}) },
    updatedAt: Date.now()
  };

  if (!prepared.countdownDurationMs) prepared.countdownDurationMs = 5000;
  if (typeof prepared.gameStarted !== "boolean") prepared.gameStarted = false;
  if (!("gameStateSnapshot" in prepared)) prepared.gameStateSnapshot = null;

  return prepared;
}

function mergeRoomState(incomingRoom) {
  const incoming = prepareRoom(incomingRoom);
  if (!incoming?.roomCode) return null;

  const existing = rooms.get(incoming.roomCode);
  if (!existing) {
    rooms.set(incoming.roomCode, incoming);
    rememberRoomSockets(incoming);
    return incoming;
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
    countdownDurationMs: incoming.countdownDurationMs || existing.countdownDurationMs || 5000,
    updatedAt: Date.now()
  };

  rooms.set(merged.roomCode, merged);
  rememberRoomSockets(merged);
  return merged;
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

  const room = rooms.get(roomCode);
  if (!room) return sendError(ws, requestId, "Room not found.", "ROOM_NOT_FOUND");

  if (clientId) rememberClientRoom(clientId, roomCode);

  send(ws, {
    type: "get_room_result",
    requestId,
    payload: { room }
  });
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
