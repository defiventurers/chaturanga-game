const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// IMPORTANT: Render uses process.env.PORT
const PORT = process.env.PORT || 10000;

/* =========================
   In-memory store (simple)
========================= */

const rooms = new Map();

/*
room = {
  id,
  hostId,
  maxPlayers,
  players: [{ id, name, ready }],
  state: "lobby" | "countdown" | "playing",
  gameState: {} // authoritative state
}
*/

/* =========================
   Utility
========================= */

function send(ws, type, payload) {
  ws.send(JSON.stringify({ type, payload }));
}

function broadcast(room, type, payload) {
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      send(p.ws, type, payload);
    }
  });
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

/* =========================
   HTTP health check
========================= */

app.get("/", (_req, res) => {
  res.send("Chaturanga server running");
});

/* =========================
   WebSocket logic
========================= */

wss.on("connection", (ws) => {
  const playerId = uuidv4();

  ws.playerId = playerId;
  ws.roomId = null;

  send(ws, "connected", { playerId });

  ws.on("message", (message) => {
    let data;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const { type, payload } = data;

    switch (type) {
      case "create_room":
        handleCreateRoom(ws, payload);
        break;

      case "join_room":
        handleJoinRoom(ws, payload);
        break;

      case "set_ready":
        handleReady(ws);
        break;

      case "game_action":
        handleGameAction(ws, payload);
        break;

      case "leave":
        handleLeave(ws);
        break;
    }
  });

  ws.on("close", () => {
    handleLeave(ws);
  });
});

/* =========================
   Room Handlers
========================= */

function handleCreateRoom(ws, { maxPlayers }) {
  const roomId = generateRoomId();

  const room = {
    id: roomId,
    hostId: ws.playerId,
    maxPlayers,
    players: [],
    state: "lobby",
    gameState: null
  };

  rooms.set(roomId, room);

  joinRoom(ws, room);
}

function handleJoinRoom(ws, { roomId, name }) {
  const room = getRoom(roomId);
  if (!room) {
    send(ws, "error", { message: "Room not found" });
    return;
  }

  if (room.players.length >= room.maxPlayers) {
    send(ws, "error", { message: "Room full" });
    return;
  }

  joinRoom(ws, room, name);
}

function joinRoom(ws, room, name = "Player") {
  ws.roomId = room.id;

  const player = {
    id: ws.playerId,
    name,
    ready: false,
    ws
  };

  room.players.push(player);

  send(ws, "room_joined", {
    roomId: room.id,
    playerId: player.id
  });

  updateLobby(room);
}

function handleReady(ws) {
  const room = getRoom(ws.roomId);
  if (!room) return;

  const player = room.players.find(p => p.id === ws.playerId);
  if (!player) return;

  player.ready = !player.ready;

  updateLobby(room);

  const allReady =
    room.players.length === room.maxPlayers &&
    room.players.every(p => p.ready);

  if (allReady) startCountdown(room);
}

function updateLobby(room) {
  broadcast(room, "lobby_update", {
    roomId: room.id,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready
    })),
    maxPlayers: room.maxPlayers
  });
}

/* =========================
   Countdown + Game Start
========================= */

function startCountdown(room) {
  room.state = "countdown";

  let count = 3;

  const interval = setInterval(() => {
    broadcast(room, "countdown", { count });

    count--;

    if (count < 0) {
      clearInterval(interval);
      startGame(room);
    }
  }, 1000);
}

function startGame(room) {
  room.state = "playing";

  room.gameState = {
    turnIndex: 0,
    players: room.players.map(p => p.id),
    // plug your real game state here
  };

  broadcast(room, "game_start", room.gameState);
}

/* =========================
   Game Logic (IMPORTANT)
========================= */

function handleGameAction(ws, action) {
  const room = getRoom(ws.roomId);
  if (!room || room.state !== "playing") return;

  const state = room.gameState;

  const currentPlayerId = state.players[state.turnIndex];

  // 🔒 HARD LOCK: enforce turn
  if (ws.playerId !== currentPlayerId) {
    send(ws, "error", { message: "Not your turn" });
    return;
  }

  // TODO: validate action properly
  // This is where your GameCore should run on server

  // Example turn advance:
  state.turnIndex =
    (state.turnIndex + 1) % state.players.length;

  broadcast(room, "game_state", state);
}

/* =========================
   Leave Handling
========================= */

function handleLeave(ws) {
  const room = getRoom(ws.roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== ws.playerId);

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  // reassign host if needed
  if (room.hostId === ws.playerId) {
    room.hostId = room.players[0].id;
  }

  updateLobby(room);
}

/* =========================
   Helpers
========================= */

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* =========================
   Start server
========================= */

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
