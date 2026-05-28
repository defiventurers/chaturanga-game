const ROOM_KEY_PREFIX = "arctic-dominion:room:";
const ROOM_TTL_SECONDS = 24 * 60 * 60;
const CODE_PATTERN = /^[A-Z0-9]{4,6}$/;
const MEMORY_STORE_GLOBAL_KEY = "__arcticDominionRoomStore";

function getMemoryStore() {
  if (!globalThis[MEMORY_STORE_GLOBAL_KEY]) {
    globalThis[MEMORY_STORE_GLOBAL_KEY] = new Map();
  }
  return globalThis[MEMORY_STORE_GLOBAL_KEY];
}

function getMemoryRecord(key) {
  const store = getMemoryStore();
  const record = store.get(key);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return record.value;
}

function setMemoryRecord(key, value, ttlSeconds = ROOM_TTL_SECONDS) {
  getMemoryStore().set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000
  });
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

function roomKey(roomCode) {
  return `${ROOM_KEY_PREFIX}${normalizeRoomCode(roomCode)}`;
}

function sendJson(res, statusCode, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(statusCode).json(payload);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

async function roomStorageCommand(command) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    const [operation, key, value, _ex, ttlSeconds] = command;
    if (operation === "GET") return getMemoryRecord(key);
    if (operation === "SET") {
      setMemoryRecord(key, value, Number(ttlSeconds) || ROOM_TTL_SECONDS);
      return "OK";
    }
    const error = new Error(`Unsupported in-memory room storage command: ${operation}`);
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([command])
  });

  if (!response.ok) {
    const error = new Error(`Room storage request failed with ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }

  const [result] = await response.json();
  if (result?.error) {
    const error = new Error(result.error);
    error.statusCode = 502;
    throw error;
  }
  return result?.result;
}

function parseRedisJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

async function getRoom(roomCode) {
  const code = normalizeRoomCode(roomCode);
  if (!CODE_PATTERN.test(code)) return null;
  return parseRedisJson(await roomStorageCommand(["GET", roomKey(code)]));
}

async function saveRoom(room) {
  const code = normalizeRoomCode(room?.roomCode);
  if (!CODE_PATTERN.test(code)) {
    const error = new Error("Room code must be 4 to 6 uppercase letters or numbers.");
    error.statusCode = 400;
    throw error;
  }

  const existingRoom = await getRoom(code);
  const mergedPlayers = {
    ...(existingRoom?.players || {}),
    ...(room.players || {})
  };
  const gameStarted = !!(existingRoom?.gameStarted || room.gameStarted);
  const stampedRoom = {
    ...(existingRoom || {}),
    ...room,
    roomCode: code,
    hostClientId: existingRoom?.hostClientId || room.hostClientId,
    players: mergedPlayers,
    gameStarted,
    gameStateSnapshot: room.gameStateSnapshot || existingRoom?.gameStateSnapshot || null,
    updatedAt: Date.now()
  };

  await roomStorageCommand(["SET", roomKey(code), JSON.stringify(stampedRoom), "EX", ROOM_TTL_SECONDS]);
  return stampedRoom;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      const room = await getRoom(req.query.roomCode);
      sendJson(res, 200, { ok: true, room });
      return;
    }

    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed.");
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body.action !== "save") {
      sendError(res, 400, "Unsupported room action.");
      return;
    }

    const room = await saveRoom(body.room);
    sendJson(res, 200, { ok: true, room });
  } catch (error) {
    sendError(res, error.statusCode || 500, error.message || "Room service failed.");
  }
};
