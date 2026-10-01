"use strict";

const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const Shared = require("./public/shared.js");

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  transports: ["websocket", "polling"],
  pingTimeout: 10000,
  pingInterval: 15000
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));
app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

const rooms = new Map();
const CHECKPOINTS = Shared.checkpointIndices();
const TRACK_LENGTH = Shared.TRACK_SAMPLES.length;
const PALETTE = ["#ff4d6d", "#4cc9f0", "#f9c74f", "#8cff66", "#b388ff", "#ff8c42", "#ffffff", "#ff66e3"];
const POWER_UP_LAYOUT = [
  { progress: 0.14, offset: -24, type: "boost" },
  { progress: 0.36, offset: 24, type: "lightning" },
  { progress: 0.61, offset: -24, type: "boost" },
  { progress: 0.84, offset: 24, type: "lightning" }
];

function cleanText(value, fallback, maxLength) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, " ");
  return normalized.slice(0, maxLength) || fallback;
}

function cleanRoom(value) {
  return cleanText(value, "oficina", 18).toLowerCase().replace(/\s+/g, "-");
}

function cleanColor(value) {
  const color = String(value || "").toLowerCase();
  return PALETTE.includes(color) ? color : PALETTE[0];
}

function createPowerUps() {
  return POWER_UP_LAYOUT.map((item, index) => {
    const sampleIndex = Math.floor(Shared.TRACK_SAMPLES.length * item.progress);
    const point = Shared.TRACK_SAMPLES[sampleIndex];
    const next = Shared.TRACK_SAMPLES[(sampleIndex + 1) % Shared.TRACK_SAMPLES.length];
    const tangentLength = Math.hypot(next.x - point.x, next.y - point.y) || 1;
    const normalX = -(next.y - point.y) / tangentLength;
    const normalY = (next.x - point.x) / tangentLength;
    return {
      id: "star-" + (index + 1),
      type: item.type,
      x: Math.round((point.x + normalX * item.offset) * 10) / 10,
      y: Math.round((point.y + normalY * item.offset) * 10) / 10,
      active: true,
      respawnsAt: 0
    };
  });
}

function resetPowerUps(room) {
  room.powerUps.forEach((powerUp) => {
    powerUp.active = true;
    powerUp.respawnsAt = 0;
  });
}

function createRoom(code) {
  return {
    code,
    state: "lobby",
    hostId: null,
    players: new Map(),
    countdownEndsAt: 0,
    raceStartedAt: 0,
    raceEndsAt: 0,
    finishDeadline: 0,
    winnerId: null,
    powerUps: createPowerUps(),
    lastSnapshotAt: 0,
    createdAt: Date.now()
  };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    ready: player.ready,
    lap: player.lap,
    finished: player.finished,
    finishPlace: player.finishPlace,
    finishTime: player.finishTime,
    connected: player.connected
  };
}

function roomSummary(room) {
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    laps: Shared.LAPS,
    maxPlayers: Shared.MAX_PLAYERS,
    countdownEndsAt: room.countdownEndsAt,
    raceStartedAt: room.raceStartedAt,
    players: Array.from(room.players.values()).map(publicPlayer)
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room", roomSummary(room));
}

function makePlayer(socket, name, color) {
  return {
    id: socket.id,
    socket,
    name,
    color,
    ready: false,
    connected: true,
    input: { up: false, down: false, left: false, right: false, handbrake: false, sequence: 0 },
    x: 0,
    y: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    steer: 0,
    lap: 0,
    nextCheckpoint: 0,
    progress: 0,
    finished: false,
    finishPlace: 0,
    finishTime: 0,
    lastCrashAt: 0,
    wrongWaySince: 0,
    wrongWay: false,
    boostUntil: 0,
    slowUntil: 0,
    speedMultiplier: 1
  };
}

function startingTransform(index) {
  const samples = Shared.TRACK_SAMPLES;
  const baseIndex = (samples.length - 3 - Math.floor(index / 2) * 9 + samples.length) % samples.length;
  const point = samples[baseIndex];
  const next = samples[(baseIndex + 1) % samples.length];
  const tangentX = next.x - point.x;
  const tangentY = next.y - point.y;
  const tangentLength = Math.hypot(tangentX, tangentY) || 1;
  const side = index % 2 === 0 ? -18 : 18;
  return {
    x: point.x + (-tangentY / tangentLength) * side,
    y: point.y + (tangentX / tangentLength) * side,
    angle: Math.atan2(tangentY, tangentX)
  };
}

function resetPlayer(player, index) {
  const start = startingTransform(index);
  Object.assign(player, start, {
    vx: 0,
    vy: 0,
    steer: 0,
    lap: 0,
    nextCheckpoint: 0,
    progress: 0,
    finished: false,
    finishPlace: 0,
    finishTime: 0,
    wrongWay: false,
    wrongWaySince: 0,
    boostUntil: 0,
    slowUntil: 0,
    speedMultiplier: 1
  });
}

function canStart(room) {
  const players = Array.from(room.players.values());
  return room.state === "lobby" && players.length > 0 && players.every((player) => player.ready);
}

function beginCountdown(room) {
  if (!canStart(room)) return false;
  room.state = "countdown";
  room.countdownEndsAt = Date.now() + 4000;
  room.raceStartedAt = room.countdownEndsAt;
  room.raceEndsAt = room.raceStartedAt + 5 * 60 * 1000;
  room.finishDeadline = 0;
  room.winnerId = null;
  resetPowerUps(room);
  Array.from(room.players.values()).forEach(resetPlayer);
  broadcastRoom(room);
  io.to(room.code).emit("countdown", { endsAt: room.countdownEndsAt });
  return true;
}

function startRace(room) {
  if (room.state !== "countdown") return;
  room.state = "racing";
  io.to(room.code).emit("race:start", { startedAt: room.raceStartedAt });
  broadcastRoom(room);
}

function finishRace(room) {
  if (room.state !== "racing") return;
  room.state = "finished";
  const now = Date.now();
  const ordered = orderedPlayers(room);
  for (const player of ordered) {
    if (!player.finished) {
      player.finishTime = now - room.raceStartedAt;
      player.finishPlace = ordered.indexOf(player) + 1;
    }
  }
  const results = ordered.map((player, index) => ({
    ...publicPlayer(player),
    finishPlace: player.finishPlace || index + 1
  }));
  io.to(room.code).emit("race:finished", { results });
  broadcastRoom(room);
}

function orderedPlayers(room) {
  return Array.from(room.players.values()).sort((a, b) => {
    if (a.finished && b.finished) return a.finishPlace - b.finishPlace;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return (b.lap + b.progress) - (a.lap + a.progress);
  });
}

function emitCrash(player, strength) {
  const now = Date.now();
  if (now - player.lastCrashAt < 250) return;
  player.lastCrashAt = now;
  player.socket.emit("sfx", { type: "crash", strength: Shared.clamp(strength / 250, 0.15, 1) });
}

function activatePowerUp(room, powerUp, collector, now) {
  powerUp.active = false;
  powerUp.respawnsAt = now + Shared.POWER_UPS.RESPAWN_TIME;

  let duration;
  if (powerUp.type === "boost") {
    duration = Shared.POWER_UPS.BOOST_DURATION;
    collector.boostUntil = now + duration;
  } else {
    duration = Shared.POWER_UPS.SLOW_DURATION;
    for (const player of room.players.values()) {
      if (player.id !== collector.id && !player.finished) player.slowUntil = now + duration;
    }
  }

  const event = {
    type: powerUp.type,
    playerId: collector.id,
    playerName: collector.name,
    duration
  };
  io.to(room.code).emit("powerup", event);
  return event;
}

function updatePowerUps(room, players, now) {
  for (const powerUp of room.powerUps) {
    if (!powerUp.active && now >= powerUp.respawnsAt) {
      powerUp.active = true;
      powerUp.respawnsAt = 0;
    }
    if (!powerUp.active) continue;

    for (const player of players) {
      if (player.finished) continue;
      const distance = Math.hypot(player.x - powerUp.x, player.y - powerUp.y);
      if (distance > Shared.CAR_RADIUS + Shared.POWER_UPS.PICKUP_RADIUS) continue;
      activatePowerUp(room, powerUp, player, now);
      break;
    }
  }
}

function updateCheckpoints(room, player, info, now) {
  if (player.finished || info.distance > Shared.ROAD_HALF_WIDTH) return;
  const checkpoint = CHECKPOINTS[player.nextCheckpoint];
  if (Shared.circularIndexDistance(info.index, checkpoint, TRACK_LENGTH) > 5) return;

  if (player.nextCheckpoint < CHECKPOINTS.length - 1) {
    player.nextCheckpoint += 1;
    if (player.nextCheckpoint === CHECKPOINTS.length - 1) {
      player.socket.emit("sfx", { type: "checkpoint" });
    }
    return;
  }

  player.nextCheckpoint = 0;
  player.lap += 1;
  if (player.lap >= Shared.LAPS) {
    player.finished = true;
    player.finishPlace = Array.from(room.players.values()).filter((item) => item.finished).length;
    player.finishTime = now - room.raceStartedAt;
    player.vx *= 0.4;
    player.vy *= 0.4;
    if (!room.winnerId) {
      room.winnerId = player.id;
      room.finishDeadline = now + 20000;
    }
    io.to(room.code).emit("player:finished", {
      id: player.id,
      name: player.name,
      place: player.finishPlace,
      time: player.finishTime
    });
    player.socket.emit("sfx", { type: "finish" });
  } else {
    player.socket.emit("lap", { lap: player.lap + 1, total: Shared.LAPS });
  }
}

function updatePlayer(room, player, dt, now) {
  // La física vive en shared.js para que el cliente pueda predecirla igual.
  player.speedMultiplier = Shared.powerMultiplier(player.boostUntil, player.slowUntil, now);
  const { info, impact } = Shared.stepCar(player, player.input, dt);
  if (!info) return;
  if (impact > 0) emitCrash(player, impact);
  player.progress = info.progress;
  updateCheckpoints(room, player, info, now);

  const forwardAlongTrack = player.vx * info.tangentX + player.vy * info.tangentY;
  if (forwardAlongTrack < -45 && Math.hypot(player.vx, player.vy) > 70) {
    if (!player.wrongWaySince) player.wrongWaySince = now;
    player.wrongWay = now - player.wrongWaySince > 900;
  } else {
    player.wrongWaySince = 0;
    player.wrongWay = false;
  }
}

function resolveCarCollisions(players) {
  const minDistance = Shared.CAR_RADIUS * 2;
  for (let aIndex = 0; aIndex < players.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < players.length; bIndex += 1) {
      const a = players[aIndex];
      const b = players[bIndex];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.001;
      if (distance >= minDistance) continue;

      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = minDistance - distance;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;

      const relativeVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relativeVelocity < 0) {
        const impulse = -(1.25 * relativeVelocity) / 2;
        a.vx -= impulse * nx;
        a.vy -= impulse * ny;
        b.vx += impulse * nx;
        b.vy += impulse * ny;
        emitCrash(a, Math.abs(relativeVelocity));
        emitCrash(b, Math.abs(relativeVelocity));
      }
    }
  }
}

function snapshot(room, now) {
  return {
    serverTime: now,
    state: room.state,
    raceStartedAt: room.raceStartedAt,
    powerUps: room.powerUps.map((powerUp) => ({ ...powerUp })),
    players: orderedPlayers(room).map((player, index) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      x: Math.round(player.x * 10) / 10,
      y: Math.round(player.y * 10) / 10,
      angle: Math.round(player.angle * 1000) / 1000,
      steer: Math.round(player.steer * 1000) / 1000,
      vx: Math.round(player.vx * 10) / 10,
      vy: Math.round(player.vy * 10) / 10,
      speed: Math.round(Math.hypot(player.vx, player.vy)),
      lap: player.lap,
      place: index + 1,
      finished: player.finished,
      finishPlace: player.finishPlace,
      wrongWay: player.wrongWay,
      boostUntil: player.boostUntil,
      slowUntil: player.slowUntil,
      inputSequence: player.input.sequence
    }))
  };
}

function simulationTick() {
  const now = Date.now();
  const dt = 1 / Shared.TICK_RATE;
  for (const room of rooms.values()) {
    if (room.state === "countdown" && now >= room.countdownEndsAt) startRace(room);
    if (room.state === "racing") {
      const activePlayers = Array.from(room.players.values());
      for (const player of activePlayers) updatePlayer(room, player, dt, now);
      resolveCarCollisions(activePlayers);
      updatePowerUps(room, activePlayers, now);
      if (activePlayers.length === 0 || activePlayers.every((player) => player.finished) ||
          now >= room.raceEndsAt || (room.finishDeadline && now >= room.finishDeadline)) {
        finishRace(room);
      }
    }
    if ((room.state === "countdown" || room.state === "racing") &&
        now - room.lastSnapshotAt >= 1000 / Shared.SNAPSHOT_RATE) {
      room.lastSnapshotAt = now;
      io.to(room.code).volatile.emit("snapshot", snapshot(room, now));
    }
  }
}

setInterval(simulationTick, 1000 / Shared.TICK_RATE).unref();

io.on("connection", (socket) => {
  socket.on("join", (payload, acknowledge) => {
    if (socket.data.roomCode) {
      acknowledge?.({ ok: false, error: "Ya estás en una sala." });
      return;
    }
    const roomCode = cleanRoom(payload?.room);
    let room = rooms.get(roomCode);
    if (!room) {
      room = createRoom(roomCode);
      rooms.set(roomCode, room);
    }
    if (room.state !== "lobby") {
      acknowledge?.({ ok: false, error: "La carrera ya empezó o está mostrando el podio. Esperá la revancha." });
      return;
    }
    if (room.players.size >= Shared.MAX_PLAYERS) {
      acknowledge?.({ ok: false, error: "La sala está llena." });
      return;
    }

    const name = cleanText(payload?.name, "Piloto", 16);
    const desiredColor = cleanColor(payload?.color);
    const usedColors = new Set(Array.from(room.players.values()).map((player) => player.color));
    const color = usedColors.has(desiredColor)
      ? PALETTE.find((candidate) => !usedColors.has(candidate)) || desiredColor
      : desiredColor;
    const player = makePlayer(socket, name, color);
    room.players.set(socket.id, player);
    if (!room.hostId) room.hostId = socket.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);
    acknowledge?.({ ok: true, id: socket.id, room: roomSummary(room) });
    broadcastRoom(room);
  });

  socket.on("ready", (ready) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.state !== "lobby") return;
    player.ready = Boolean(ready);
    broadcastRoom(room);
  });

  socket.on("start", (acknowledge) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) {
      acknowledge?.({ ok: false, error: "Solo quien creó la sala puede iniciar." });
      return;
    }
    const started = beginCountdown(room);
    acknowledge?.(started
      ? { ok: true }
      : { ok: false, error: "Todos los pilotos tienen que estar listos." });
  });

  socket.on("input", (input) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.state !== "racing") return;
    player.input = {
      up: Boolean(input?.up),
      down: Boolean(input?.down),
      left: Boolean(input?.left),
      right: Boolean(input?.right),
      handbrake: Boolean(input?.handbrake),
      sequence: Number.isSafeInteger(input?.sequence) ? input.sequence : player.input.sequence
    };
  });

  // Eco vacío: le sirve al cliente para medir su RTT y saber cuánto rebobinar.
  socket.on("rtt", (_payload, acknowledge) => acknowledge?.());

  socket.on("restart", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.state !== "finished") return;
    room.state = "lobby";
    room.countdownEndsAt = 0;
    room.raceStartedAt = 0;
    room.finishDeadline = 0;
    room.winnerId = null;
    resetPowerUps(room);
    room.players.forEach((player) => {
      player.ready = false;
      resetPlayer(player, 0);
    });
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value || null;
    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.state === "countdown") {
      room.state = "lobby";
      room.players.forEach((player) => { player.ready = false; });
    }
    broadcastRoom(room);
  });
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Grand Prix listo en http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  rooms,
  cleanText,
  cleanRoom,
  cleanColor,
  startingTransform,
  createPowerUps,
  activatePowerUp
};
