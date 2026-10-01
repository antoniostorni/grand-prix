"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { io: createClient } = require("socket.io-client");
const { server, rooms } = require("../server.js");

function waitFor(socket, event, predicate = () => true, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout esperando ${event}`));
    }, timeout);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test("dos pilotos pueden entrar, largar y acelerar sincronizados", { timeout: 12000 }, async (context) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { transports: ["websocket"], forceNew: true };
  const host = createClient(url, options);
  const guest = createClient(url, options);
  context.after(() => {
    host.disconnect();
    guest.disconnect();
    server.close();
  });

  await Promise.all([waitFor(host, "connect"), waitFor(guest, "connect")]);
  const roomCode = `test-${Date.now()}`;
  const hostJoin = await emitAck(host, "join", { name: "Ada", room: roomCode, color: "#ff4d6d" });
  const guestJoin = await emitAck(guest, "join", { name: "Linus", room: roomCode, color: "#4cc9f0" });
  assert.equal(hostJoin.ok, true);
  assert.equal(guestJoin.ok, true);
  assert.equal(hostJoin.room.hostId, host.id);

  const everyoneReady = waitFor(host, "room", (room) =>
    room.players.length === 2 && room.players.every((player) => player.ready));
  host.emit("ready", true);
  guest.emit("ready", true);
  await everyoneReady;

  const countdown = waitFor(host, "countdown");
  const raceStarted = waitFor(host, "race:start");
  const startReply = await new Promise((resolve) => host.emit("start", resolve));
  assert.equal(startReply.ok, true);
  assert.ok((await countdown).endsAt > Date.now());
  await raceStarted;

  const movingSnapshot = waitFor(host, "snapshot", (snapshot) =>
    snapshot.state === "racing" && snapshot.players.some((player) => player.id === host.id && player.speed > 15));
  host.emit("input", { up: true, sequence: 1 });
  const snapshot = await movingSnapshot;
  const room = rooms.get(roomCode);
  const boost = room.powerUps.find((powerUp) => powerUp.type === "boost");
  const serverPlayer = room.players.get(host.id);
  const powerEvent = waitFor(host, "powerup", (event) => event.type === "boost");
  const poweredSnapshot = waitFor(host, "snapshot", (next) =>
    next.players.some((player) => player.id === host.id && player.boostUntil > next.serverTime));
  boost.x = serverPlayer.x;
  boost.y = serverPlayer.y;
  const event = await powerEvent;
  assert.equal(event.duration, 8000);
  const powered = await poweredSnapshot;
  assert.ok(powered.powerUps.some((powerUp) => powerUp.type === "boost" && !powerUp.active));

  assert.equal(snapshot.players.length, 2);
});
