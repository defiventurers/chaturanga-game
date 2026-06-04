const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const rooms = new Map();
const socketsByClientId = new Map();

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

function send(ws, packet) {
  if (ws.readyState === WebSocket.OPEN) {
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

  room.roomCode = normalizeRoomCode(room.roomCode);
  room.players = room.players || {};
  room.updatedAt = Date.now();

  if (!room.countdownDurationMs) room.countdownDurationMs = 5000;
  if (typeof room.gameStarted !== "boolean") room.gameStarted = false;
  if (!("gameStateSnapshot" in room)) room.gameStateSnapshot = null;

  return room;
}

function handleCreateRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const room = prepareRoom(payload?.room);

  if (!clientId) return sendError(ws, requestId, "Missing clientId.", "MISSING_CLIENT_ID");
  if (!room?.roomCode) return sendError(ws, requestId, "Missing room data.", "MISSING_ROOM");

  socketsByClientId.set(clientId, ws);

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

  rooms.set(room.roomCode, room);

  send(ws, {
    type: "create_room_result",
    requestId,
    payload: { room }
  });

  broadcastRoom(room);
}

function handleJoinRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const roomCode = normalizeRoomCode(payload?.roomCode);

  if (!clientId) return sendError(ws, requestId, "Missing clientId.", "MISSING_CLIENT_ID");
  if (!roomCode) return sendError(ws, requestId, "Missing room code.", "MISSING_ROOM_CODE");

  const room = rooms.get(roomCode);

  if (!room) return sendError(ws, requestId, "Room not found.", "ROOM_NOT_FOUND");

  socketsByClientId.set(clientId, ws);

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

  room.updatedAt = Date.now();
  rooms.set(roomCode, room);

  send(ws, {
    type: "join_room_result",
    requestId,
    payload: { room }
  });

  broadcastRoom(room);
}

function handleGetRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const roomCode = normalizeRoomCode(payload?.roomCode);

  if (clientId) socketsByClientId.set(clientId, ws);

  const room = rooms.get(roomCode);

  if (!room) return sendError(ws, requestId, "Room not found.", "ROOM_NOT_FOUND");

  send(ws, {
    type: "get_room_result",
    requestId,
    payload: { room }
  });
}

function handleUpdateRoom(ws, requestId, payload) {
  const clientId = payload?.clientId;
  const room = prepareRoom(payload?.room);

  if (!clientId) return sendError(ws, requestId, "Missing clientId.", "MISSING_CLIENT_ID");
  if (!room?.roomCode) return sendError(ws, requestId, "Missing room data.", "MISSING_ROOM");

  socketsByClientId.set(clientId, ws);
  rooms.set(room.roomCode, room);

  send(ws, {
    type: "update_room_result",
    requestId,
    payload: { room }
  });

  broadcastRoom(room);
}

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Arctic Dominion WebSocket server is running.");
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
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
    } catch {
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
      if (socket === ws) {
        socketsByClientId.delete(clientId);
      }
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
