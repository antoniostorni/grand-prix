"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../public/shared.js");
const { server, cleanText, cleanRoom, cleanColor, startingTransform, createPowerUps, activatePowerUp } = require("../server.js");

test.after(() => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.close(resolve);
}));

test("sanea nombres, salas y colores recibidos por red", () => {
  assert.equal(cleanText("  Ana <script>  ", "Piloto", 16), "Ana script");
  assert.equal(cleanRoom(" Mi Oficina!! "), "mi-oficina");
  assert.equal(cleanColor("#4CC9F0"), "#4cc9f0");
  assert.equal(cleanColor("red"), "#ff4d6d");
});

test("toda la grilla de largada queda dentro de la pista", () => {
  for (let index = 0; index < Shared.MAX_PLAYERS; index += 1) {
    const start = startingTransform(index);
    assert.ok(Shared.nearestTrackInfo(start.x, start.y).distance < Shared.ROAD_HALF_WIDTH - Shared.CAR_RADIUS);
  }
});

test("crea estrellas turbo y rayo dentro de la pista", () => {
  const powerUps = createPowerUps();
  assert.equal(powerUps.length, 4);
  assert.deepEqual(powerUps.map((powerUp) => powerUp.type), ["boost", "lightning", "boost", "lightning"]);
  for (const powerUp of powerUps) {
    assert.ok(Shared.nearestTrackInfo(powerUp.x, powerUp.y).distance < Shared.ROAD_HALF_WIDTH);
  }
});

test("turbo dura 8 segundos y rayo ralentiza al resto durante 10", () => {
  const now = 1_000_000;
  const collector = { id: "a", name: "Ada", boostUntil: 0, slowUntil: 0, finished: false };
  const rival = { id: "b", name: "Linus", boostUntil: 0, slowUntil: 0, finished: false };
  const room = { code: "unit-test", players: new Map([[collector.id, collector], [rival.id, rival]]) };

  const boost = { type: "boost", active: true, respawnsAt: 0 };
  const boostEvent = activatePowerUp(room, boost, collector, now);
  assert.equal(boostEvent.duration, 8000);
  assert.equal(collector.boostUntil, now + 8000);
  assert.equal(boost.active, false);
  assert.equal(boost.respawnsAt, now + Shared.POWER_UPS.RESPAWN_TIME);

  const lightning = { type: "lightning", active: true, respawnsAt: 0 };
  const lightningEvent = activatePowerUp(room, lightning, collector, now);
  assert.equal(lightningEvent.duration, 10000);
  assert.equal(collector.slowUntil, 0);
  assert.equal(rival.slowUntil, now + 10000);
});

test("expone health check y archivos del cliente", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Software Grand Prix/);
});
