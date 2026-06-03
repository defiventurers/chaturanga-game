const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 4;

const rooms = new Map();
const socketsByClientId = new Map();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const body = JSON.stringify({
      ok: true,
      rooms: rooms.size,
      clients: socketsByClientId.size
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Arctic Dominion WebSocket server is running.");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

function send(socket, packet) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(packet));
}

function sendError(socket, requestId, message, code) {
  send(socket, {
    type: "error_notice",
    requestId,
    payload: {
      message,
      code
    }
  });
}

function trackClientSocket(clientId, socket) {
  if (!clientId) return;
  socket.clientId = clientId;
  socketsByClientId.set(clientId, socket);
}

function getRoomPlayerCount(room) {
  return Object.keys(room?.players || {}).length;
}

function ensureRoomShape(room) {
  if (!room || typeof room !== "object") return null;

  const roomCode = normalizeRoomCode(room.roomCode || room.code);
  if (!roomCode) return null;

  const normalizedRoom = {
    ...room,
    roomCode,
    players: room.players && typeof room.players === "object" ? room.players : {},
    updatedAt: Date.now()
  };

  return normalizedRoom;
}

function ensureHostPlayer(room, clientId) {
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

  room.hostClientId = room.hostClientId || clientId;
  room.players[clientId].clientId = clientId;
  room.players[clientId].isHost = true;
}

function addJoiningPlayer(room, clientId, player) {
  if (room.players[clientId]) return;

  room.players[clientId] = {
    ...(player && typeof player === "object" ? player : {}),
    clientId,
    name: player?.name || "Player",
    ready: false,
    isHost: false,
    joinedAt: Date.now()
  };
}

function saveRoom(room) {
  room.roomCode = normalizeRoomCode(room.roomCode);
  room.updatedAt = Date.now();
  rooms.set(room.roomCode, room);
  return room;
}

function broadcastRoomState(room) {
  const packet = {
    type: "room_state",
    payload: { room }
  };

  for (const clientId of Object.keys(room.players || {})) {
    const socket = socketsByClientId.get(clientId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      send(socket, packet);
    }
  }
}

function handleCreateRoom(socket, requestId, payload) {
  const clientId = String(payload?.clientId || "").trim();
  const room = ensureRoomShape(payload?.room);

  if (!clientId) {
    sendError(socket, requestId, "clientId is required.", "BAD_REQUEST");
    return;
  }
  if (!room) {
    sendError(socket, requestId, "A valid room is required.", "BAD_REQUEST");
    return;
  }

  trackClientSocket(clientId, socket);
  ensureHostPlayer(room, clientId);
  saveRoom(room);

  send(socket, {
    type: "create_room_result",
    requestId,
    payload: { room }
  });
  broadcastRoomState(room);
}

function handleJoinRoom(socket, requestId, payload) {
  const clientId = String(payload?.clientId || "").trim();
  const roomCode = normalizeRoomCode(payload?.roomCode);

  if (!clientId || !roomCode) {
    sendError(socket, requestId, "clientId and roomCode are required.", "BAD_REQUEST");
    return;
  }

  const room = rooms.get(roomCode);
  if (!room) {
    sendError(socket, requestId, "Room not found.", "ROOM_NOT_FOUND");
    return;
  }

  const playerLimit = Number(room.playerCount) || MAX_PLAYERS;
  if (!room.players?.[clientId] && getRoomPlayerCount(room) >= playerLimit) {
    sendError(socket, requestId, "Room is full.", "ROOM_FULL");
    return;
  }

  trackClientSocket(clientId, socket);
  addJoiningPlayer(room, clientId, payload?.player);
  saveRoom(room);

  send(socket, {
    type: "join_room_result",
    requestId,
    payload: { room }
  });
  broadcastRoomState(room);
}

function handleGetRoom(socket, requestId, payload) {
  const clientId = String(payload?.clientId || "").trim();
  const roomCode = normalizeRoomCode(payload?.roomCode);

  if (!clientId || !roomCode) {
    sendError(socket, requestId, "clientId and roomCode are required.", "BAD_REQUEST");
    return;
  }

  trackClientSocket(clientId, socket);

  const room = rooms.get(roomCode);
  if (!room) {
    sendError(socket, requestId, "Room not found.", "ROOM_NOT_FOUND");
    return;
  }

  send(socket, {
    type: "get_room_result",
    requestId,
    payload: { room }
  });
}

function handleUpdateRoom(socket, requestId, payload) {
  const clientId = String(payload?.clientId || "").trim();
  const room = ensureRoomShape(payload?.room);

  if (!clientId) {
    sendError(socket, requestId, "clientId is required.", "BAD_REQUEST");
    return;
  }
  if (!room) {
    sendError(socket, requestId, "A valid room is required.", "BAD_REQUEST");
    return;
  }

  trackClientSocket(clientId, socket);
  saveRoom(room);

  send(socket, {
    type: "update_room_result",
    requestId,
    payload: { room }
  });
  broadcastRoomState(room);
}

function handleMessage(socket, rawMessage) {
  let packet;

  try {
    packet = JSON.parse(rawMessage.toString());
  } catch (_error) {
    sendError(socket, null, "Message must be valid JSON.", "BAD_JSON");
    return;
  }

  const type = packet?.type;
  const requestId = packet?.requestId || null;
  const payload = packet?.payload || {};

  if (payload.clientId) {
    trackClientSocket(String(payload.clientId).trim(), socket);
  }

  switch (type) {
    case "create_room":
      handleCreateRoom(socket, requestId, payload);
      break;
    case "join_room":
      handleJoinRoom(socket, requestId, payload);
      break;
    case "get_room":
      handleGetRoom(socket, requestId, payload);
      break;
    case "update_room":
      handleUpdateRoom(socket, requestId, payload);
      break;
    default:
      sendError(socket, requestId, "Unsupported message type.", "UNKNOWN_TYPE");
      break;
  }
}

wss.on("connection", socket => {
  socket.isAlive = true;
  socket.clientId = null;

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", message => {
    handleMessage(socket, message);
  });

  socket.on("close", () => {
    if (socket.clientId && socketsByClientId.get(socket.clientId) === socket) {
      socketsByClientId.delete(socket.clientId);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, () => {
  console.log(`Arctic Dominion WebSocket server listening on port ${PORT}`);
});
