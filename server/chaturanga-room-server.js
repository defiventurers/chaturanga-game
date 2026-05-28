"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const PLAYERS = ["green", "red", "blue", "yellow"];
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 1000 * 60 * 60 * 6);
const MAX_FRAME_BYTES = 1024 * 1024 * 2;

const rooms = new Map();
const roomSockets = new Map();
const sockets = new Set();

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Chaturanga room server is healthy");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

function now() {
  return Date.now();
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isOpen(ws) {
  return ws && !ws.destroyed && ws.writable;
}

function makeFrame(text) {
  const payload = Buffer.from(String(text));
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

function send(ws, type, payload = {}, requestId = null) {
  if (!isOpen(ws)) return;
  ws.write(makeFrame(JSON.stringify({ type, requestId, payload })));
}

function sendError(ws, message, requestId = null, code = "server_error") {
  send(ws, "error_notice", { message, code }, requestId);
}

function closeSocket(ws) {
  try {
    ws.end(Buffer.from([0x88, 0x00]));
  } catch (_error) {}
}

function attachFrameParser(ws, onText) {
  let buffer = Buffer.alloc(0);

  ws.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const byte1 = buffer[0];
      const opcode = byte1 & 0x0f;
      const byte2 = buffer[1];
      const masked = (byte2 & 0x80) !== 0;
      let payloadLength = byte2 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < offset + 2) return;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(MAX_FRAME_BYTES)) {
          closeSocket(ws);
          return;
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }

      if (payloadLength > MAX_FRAME_BYTES) {
        closeSocket(ws);
        return;
      }

      if (!masked) {
        closeSocket(ws);
        return;
      }

      if (buffer.length < offset + 4 + payloadLength) return;

      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;

      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      buffer = buffer.subarray(offset + payloadLength);

      if (opcode === 0x8) {
        closeSocket(ws);
        return;
      }

      if (opcode === 0x9) {
        try {
          ws.write(Buffer.from([0x8a, 0x00]));
        } catch (_error) {}
        continue;
      }

      if (opcode !== 0x1) continue;

      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }

      onText(payload.toString("utf8"));
    }
  });
}

function getRoom(roomCode) {
  return rooms.get(normalizeRoomCode(roomCode));
}

function cacheSocket(roomCode, clientId, ws) {
  const code = normalizeRoomCode(roomCode);
  const id = String(clientId || "");

  if (!code || !id) return;

  if (!roomSockets.has(code)) roomSockets.set(code, new Map());

  roomSockets.get(code).set(id, ws);
  ws.roomCode = code;
  ws.clientId = id;
}

function broadcastRoom(room) {
  if (!room || !room.roomCode) return;

  const code = normalizeRoomCode(room.roomCode);
  const peers = roomSockets.get(code);

  if (!peers) return;

  for (const ws of peers.values()) {
    send(ws, "room_state", { room: cloneJson(room) });
  }
}

function getRoomPlayers(room) {
  return Object.values(room?.players || {}).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

function getTakenTeams(room, exceptClientId = null) {
  return new Set(
    getRoomPlayers(room)
      .filter((player) => player.clientId !== exceptClientId && player.team)
      .map((player) => player.team)
  );
}

function getFirstAvailableTeam(room, preferred = "blue", exceptClientId = null) {
  const taken = getTakenTeams(room, exceptClientId);

  if (preferred && PLAYERS.includes(preferred) && !taken.has(preferred)) return preferred;

  return PLAYERS.find((team) => !taken.has(team)) || null;
}

function normalizeRoom(inputRoom, clientId) {
  const room = cloneJson(inputRoom || {});
  const code = normalizeRoomCode(room.roomCode);

  if (!code) throw new Error("Invalid room code.");

  room.roomCode = code;
  room.hostClientId = String(room.hostClientId || clientId || "");
  room.playerCount = Math.max(1, Math.min(4, Number(room.playerCount || 2)));
  room.countdownStartTime = room.countdownStartTime || null;
  room.countdownDurationMs = Number(room.countdownDurationMs || 5000);
  room.gameStarted = !!room.gameStarted;
  room.gameStateSnapshot = room.gameStateSnapshot || null;
  room.updatedAt = now();
  room.players = room.players && typeof room.players === "object" ? room.players : {};

  Object.entries(room.players).forEach(([id, player]) => {
    player.clientId = String(player.clientId || id);
    player.name = String(player.name || "Player").slice(0, 28);
    player.team = PLAYERS.includes(player.team) ? player.team : getFirstAvailableTeam(room, "green", player.clientId);
    player.ready = !!player.ready;
    player.isHost = player.clientId === room.hostClientId;
    player.joinedAt = Number(player.joinedAt || now());
  });

  return room;
}

function handleCreateRoom(ws, payload, requestId) {
  try {
    const clientId = String(payload?.clientId || "");
    const room = normalizeRoom(payload?.room, clientId);

    if (!clientId) throw new Error("Missing client id.");

    if (!room.players[clientId]) {
      room.players[clientId] = {
        clientId,
        name: "Host",
        team: "green",
        ready: false,
        isHost: true,
        joinedAt: now(),
      };
    }

    room.hostClientId = clientId;
    room.players[clientId].isHost = true;
    room.updatedAt = now();

    rooms.set(room.roomCode, room);
    cacheSocket(room.roomCode, clientId, ws);

    send(ws, "room_state", { room: cloneJson(room) }, requestId);
    broadcastRoom(room);
  } catch (error) {
    sendError(ws, error.message || "Could not create room.", requestId, "create_room_failed");
  }
}

function handleJoinRoom(ws, payload, requestId) {
  try {
    const clientId = String(payload?.clientId || "");
    const code = normalizeRoomCode(payload?.roomCode);

    if (!clientId) throw new Error("Missing client id.");
    if (!code) throw new Error("Missing room code.");

    const room = getRoom(code);

    if (!room) throw new Error("Room not found. Check the room code and make sure the host is online.");
    if (room.gameStarted) throw new Error("This room already started.");

    if (!room.players) room.players = {};

    const existing = room.players[clientId];

    if (!existing && getRoomPlayers(room).length >= room.playerCount) {
      throw new Error("Room is full.");
    }

    const preferredTeam = getFirstAvailableTeam(room, "blue", clientId) || getFirstAvailableTeam(room, null, clientId);

    if (!existing && !preferredTeam) {
      throw new Error("No teams are available in this room.");
    }

    if (!existing) {
      room.players[clientId] = {
        clientId,
        name: String(payload?.player?.name || `Player ${getRoomPlayers(room).length + 1}`).slice(0, 28),
        team: preferredTeam,
        ready: false,
        isHost: false,
        joinedAt: now(),
      };
    }

    const player = room.players[clientId];

    if (!PLAYERS.includes(player.team) || getTakenTeams(room, clientId).has(player.team)) {
      player.team = preferredTeam;
      player.ready = false;
    }

    room.updatedAt = now();

    rooms.set(code, room);
    cacheSocket(code, clientId, ws);

    send(ws, "room_state", { room: cloneJson(room) }, requestId);
    broadcastRoom(room);
  } catch (error) {
    sendError(ws, error.message || "Could not join room.", requestId, "join_room_failed");
  }
}

function handleUpdateRoom(ws, payload, requestId) {
  try {
    const clientId = String(payload?.clientId || ws.clientId || "");
    const incoming = normalizeRoom(payload?.room, clientId);
    const existing = getRoom(incoming.roomCode);

    if (!existing) throw new Error("Room no longer exists on the server.");
    if (!incoming.players?.[clientId]) throw new Error("Only room players can update this room.");

    incoming.updatedAt = now();

    rooms.set(incoming.roomCode, incoming);
    cacheSocket(incoming.roomCode, clientId, ws);

    send(ws, "room_state", { room: cloneJson(incoming) }, requestId);
    broadcastRoom(incoming);
  } catch (error) {
    sendError(ws, error.message || "Could not update room.", requestId, "update_room_failed");
  }
}

function handleGetRoom(ws, payload, requestId) {
  const room = getRoom(payload?.roomCode);

  if (!room) {
    sendError(ws, "Room not found.", requestId, "room_not_found");
    return;
  }

  cacheSocket(room.roomCode, payload?.clientId || ws.clientId, ws);
  send(ws, "room_state", { room: cloneJson(room) }, requestId);
}

function handlePacket(ws, text) {
  let packet = null;

  try {
    packet = JSON.parse(text);
  } catch (_error) {
    sendError(ws, "Invalid JSON message.", null, "invalid_json");
    return;
  }

  const type = String(packet?.type || "");
  const payload = packet?.payload && typeof packet.payload === "object" ? packet.payload : {};
  const requestId = packet?.requestId || null;

  if (payload.clientId) ws.clientId = String(payload.clientId);

  switch (type) {
    case "create_room":
      handleCreateRoom(ws, payload, requestId);
      break;

    case "join_room":
      handleJoinRoom(ws, payload, requestId);
      break;

    case "update_room":
      handleUpdateRoom(ws, payload, requestId);
      break;

    case "get_room":
      handleGetRoom(ws, payload, requestId);
      break;

    case "ping":
      send(ws, "pong", { ok: true }, requestId);
      break;

    default:
      sendError(ws, `Unsupported message type: ${type || "(empty)"}.`, requestId, "unsupported_message_type");
      break;
  }
}

function cleanupExpiredRooms() {
  const cutoff = now() - ROOM_TTL_MS;

  for (const [code, room] of rooms.entries()) {
    if ((room.updatedAt || 0) < cutoff) {
      rooms.delete(code);
      roomSockets.delete(code);
    }
  }
}

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];

  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  socket.id = crypto.randomUUID();
  sockets.add(socket);

  send(socket, "connected", { socketId: socket.id });

  attachFrameParser(socket, (text) => handlePacket(socket, text));

  socket.on("close", () => {
    sockets.delete(socket);

    if (!socket.roomCode || !socket.clientId) return;

    const peers = roomSockets.get(socket.roomCode);

    if (peers && peers.get(socket.clientId) === socket) {
      peers.delete(socket.clientId);
    }
  });

  socket.on("error", () => {
    sockets.delete(socket);
  });
});

setInterval(cleanupExpiredRooms, 1000 * 60 * 15).unref();

server.listen(PORT, HOST, () => {
  console.log(`Chaturanga room server listening on ${HOST}:${PORT}`);
});
