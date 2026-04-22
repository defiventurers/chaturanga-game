const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const PLAYERS = ["green", "red", "blue", "yellow"];
const rooms = new Map();

function send(ws, type, payload = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload }));
}

function sendError(ws, message, code = "server_error") {
  send(ws, "error_notice", { message, code });
}

function getRoom(roomId) {
  return rooms.get(String(roomId || "").toUpperCase());
}

function roomViewFor(room, localPlayerId) {
  const localPlayer = room.players.find((p) => p.id === localPlayerId) || null;
  return {
    roomId: room.id,
    seatCount: room.seatCount,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      ready: !!p.ready,
      isHost: p.id === room.hostId,
    })),
    matchStarted: !!room.matchStarted,
    turnTeam: room.turnTeam,
    diceRolled: !!room.diceRolled,
    awaitingPromotionTeam: room.awaitingPromotionTeam,
    localPlayerId,
    localTeam: localPlayer ? localPlayer.team : null,
  };
}

function broadcastRoomState(room) {
  room.players.forEach((player) => {
    send(player.ws, "room_state", {
      room: roomViewFor(room, player.id),
      localPlayerId: player.id,
      localTeam: player.team,
    });
  });
}

function getMessageType(raw) {
  return String(raw?.type || "").trim();
}

function getPayload(raw) {
  if (raw && typeof raw.payload === "object" && raw.payload !== null) {
    return raw.payload;
  }
  return raw || {};
}

function normalizeWsUrlInput(value) {
  return String(value || "").trim().toUpperCase();
}

app.get("/", (_req, res) => {
  res.status(200).send("Chaturanga room server is healthy");
});

wss.on("connection", (ws) => {
  ws.playerId = uuidv4();
  ws.roomId = null;

  send(ws, "connected", { playerId: ws.playerId });

  ws.on("message", (buffer) => {
    let raw;
    try {
      raw = JSON.parse(buffer.toString());
    } catch {
      sendError(ws, "Invalid server response: malformed JSON message.", "invalid_json");
      return;
    }

    const type = getMessageType(raw);
    const payload = getPayload(raw);

    switch (type) {
      case "create_room":
        handleCreateRoom(ws, payload);
        break;
      case "join_room":
        handleJoinRoom(ws, payload);
        break;
      case "set_ready":
        handleSetReady(ws, payload);
        break;
      case "leave_room":
        handleLeave(ws);
        break;
      case "roll_dice":
        handleGameplayAction(ws, type);
        break;
      case "make_move":
        handleGameplayAction(ws, type, { move: payload.move || null });
        break;
      case "promotion_decision":
        handleGameplayAction(ws, type, { decision: payload.decision || null });
        break;
      case "end_turn":
        handleGameplayAction(ws, type);
        break;
      default:
        sendError(ws, `Unsupported message type: ${type || "(empty)"}.`, "unsupported_message_type");
        break;
    }
  });

  ws.on("close", () => {
    handleLeave(ws);
  });
});

function handleCreateRoom(ws, payload) {
  if (ws.roomId) {
    sendError(ws, "Leave your current room before creating another room.", "already_in_room");
    return;
  }

  const seatCount = Number(payload.seatCount);
  const safeSeatCount = Number.isInteger(seatCount) && seatCount >= 2 && seatCount <= 4 ? seatCount : 2;
  const roomId = generateRoomId();

  const room = {
    id: roomId,
    hostId: ws.playerId,
    seatCount: safeSeatCount,
    players: [],
    matchStarted: false,
    turnTeam: PLAYERS[0],
    diceRolled: false,
    awaitingPromotionTeam: null,
  };

  rooms.set(roomId, room);
  joinRoom(ws, room, payload.playerName || "Host");
}

function handleJoinRoom(ws, payload) {
  if (ws.roomId) {
    sendError(ws, "Leave your current room before joining a new room.", "already_in_room");
    return;
  }

  const roomId = normalizeWsUrlInput(payload.roomId);
  const room = getRoom(roomId);
  if (!room) {
    sendError(ws, "Room not found.", "room_not_found");
    return;
  }

  if (room.players.length >= room.seatCount) {
    sendError(ws, "Room is full.", "room_full");
    return;
  }

  if (room.matchStarted) {
    sendError(ws, "Match already started in this room.", "match_started");
    return;
  }

  joinRoom(ws, room, payload.playerName || "Player");
}

function joinRoom(ws, room, playerName) {
  const team = PLAYERS[room.players.length];
  const player = {
    id: ws.playerId,
    name: String(playerName || "Player").trim().slice(0, 28) || "Player",
    ready: false,
    team,
    ws,
  };

  ws.roomId = room.id;
  room.players.push(player);

  send(ws, "room_joined", {
    roomId: room.id,
    localPlayerId: player.id,
    localTeam: team,
  });
  broadcastRoomState(room);
}

function handleSetReady(ws, payload) {
  const room = getRoom(ws.roomId);
  if (!room) {
    sendError(ws, "Room not found for ready state update.", "room_not_found");
    return;
  }

  if (room.matchStarted) {
    sendError(ws, "Cannot toggle ready after match has started.", "match_started");
    return;
  }

  const player = room.players.find((p) => p.id === ws.playerId);
  if (!player) {
    sendError(ws, "Player is not part of this room.", "player_not_in_room");
    return;
  }

  if (typeof payload.ready === "boolean") {
    player.ready = payload.ready;
  } else {
    player.ready = !player.ready;
  }

  broadcastRoomState(room);

  const allReady = room.players.length === room.seatCount && room.players.every((p) => p.ready);
  if (allReady) {
    startCountdown(room);
  }
}

function startCountdown(room) {
  if (room.matchStarted || room.countdownTimer) return;

  let seconds = 3;
  room.countdownTimer = setInterval(() => {
    room.players.forEach((player) => send(player.ws, "countdown", { seconds }));
    seconds -= 1;
    if (seconds < 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      startMatch(room);
    }
  }, 1000);
}

function startMatch(room) {
  room.matchStarted = true;
  room.turnTeam = PLAYERS[0];
  room.diceRolled = false;
  room.awaitingPromotionTeam = null;
  room.players.forEach((player) => {
    send(player.ws, "match_started", {
      roomId: room.id,
      localPlayerId: player.id,
      localTeam: player.team,
      roomState: roomViewFor(room, player.id),
    });
  });
}

function handleGameplayAction(ws, type, payload = {}) {
  const room = getRoom(ws.roomId);
  if (!room) {
    sendError(ws, "Room not found.", "room_not_found");
    return;
  }

  if (!room.matchStarted) {
    sendError(ws, "Match has not started yet.", "match_not_started");
    return;
  }

  const actor = room.players.find((p) => p.id === ws.playerId);
  if (!actor) {
    sendError(ws, "Player is not part of this room.", "player_not_in_room");
    return;
  }

  if (room.turnTeam !== actor.team) {
    sendError(ws, "Not your turn.", "not_your_turn");
    return;
  }

  if (type === "roll_dice") {
    if (room.diceRolled) {
      sendError(ws, "Dice already rolled this turn.", "dice_already_rolled");
      return;
    }
    room.diceRolled = true;
    const dice = [randDie(), randDie()];
    broadcastMatchState(room, {
      action: {
        type,
        actorTeam: actor.team,
        dice,
      },
    });
    return;
  }

  if (type === "make_move") {
    if (!room.diceRolled) {
      sendError(ws, "Roll dice before making a move.", "roll_required");
      return;
    }
    if (!payload.move) {
      sendError(ws, "Move payload is required.", "invalid_move_payload");
      return;
    }
    broadcastMatchState(room, {
      action: {
        type,
        actorTeam: actor.team,
        move: payload.move,
      },
    });
    return;
  }

  if (type === "promotion_decision") {
    if (!["confirm", "decline"].includes(payload.decision)) {
      sendError(ws, "Promotion decision must be confirm or decline.", "invalid_promotion_decision");
      return;
    }
    room.awaitingPromotionTeam = null;
    broadcastMatchState(room, {
      action: {
        type,
        actorTeam: actor.team,
        decision: payload.decision,
      },
    });
    return;
  }

  if (type === "end_turn") {
    room.diceRolled = false;
    room.awaitingPromotionTeam = null;
    room.turnTeam = nextActiveTeam(room, room.turnTeam);
    broadcastMatchState(room, {
      action: {
        type,
        actorTeam: actor.team,
      },
    });
  }
}

function broadcastMatchState(room, extraPayload = {}) {
  room.players.forEach((player) => {
    send(player.ws, "match_state", {
      roomState: roomViewFor(room, player.id),
      localPlayerId: player.id,
      localTeam: player.team,
      ...extraPayload,
    });
  });
}

function nextActiveTeam(room, currentTeam) {
  const occupiedTeams = room.players.map((p) => p.team);
  let idx = PLAYERS.indexOf(currentTeam);
  for (let i = 0; i < PLAYERS.length; i += 1) {
    idx = (idx + 1) % PLAYERS.length;
    if (occupiedTeams.includes(PLAYERS[idx])) return PLAYERS[idx];
  }
  return currentTeam;
}

function handleLeave(ws) {
  if (!ws.roomId) return;

  const room = getRoom(ws.roomId);
  ws.roomId = null;
  if (!room) return;

  room.players = room.players.filter((p) => p.id !== ws.playerId);

  if (room.players.length === 0) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    rooms.delete(room.id);
    return;
  }

  if (room.hostId === ws.playerId) {
    room.hostId = room.players[0].id;
  }

  if (room.matchStarted) {
    room.matchStarted = false;
    room.diceRolled = false;
    room.awaitingPromotionTeam = null;
    room.players.forEach((player) => {
      sendError(player.ws, "A player left the match. Returning room to lobby.", "player_left_match");
    });
    room.players.forEach((player) => {
      player.ready = false;
    });
  }

  broadcastRoomState(room);
}

function randDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function generateRoomId() {
  let roomId = "";
  do {
    roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chaturanga room server listening on 0.0.0.0:${PORT}`);
});
