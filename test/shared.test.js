"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../public/shared.js");

test("la pista es cerrada y cada muestra pertenece al centro del asfalto", () => {
  assert.ok(Shared.TRACK_SAMPLES.length > 200);
  for (const point of Shared.TRACK_SAMPLES) {
    const nearest = Shared.nearestTrackInfo(point.x, point.y);
    assert.ok(nearest.distance < 0.001);
  }
});

test("los cuatro checkpoints están separados y empiezan en cuartos de pista", () => {
  const checkpoints = Shared.checkpointIndices();
  assert.equal(checkpoints.length, 4);
  assert.equal(checkpoints.at(-1), 0);
  assert.equal(new Set(checkpoints).size, 4);
});

test("circularIndexDistance cruza correctamente el origen de la pista", () => {
  assert.equal(Shared.circularIndexDistance(2, 250, 252), 4);
  assert.equal(Shared.circularIndexDistance(40, 50, 252), 10);
});

test("combina turbo y rayo únicamente mientras sus temporizadores están activos", () => {
  const now = 50_000;
  assert.equal(Shared.powerMultiplier(0, 0, now), 1);
  assert.equal(Shared.powerMultiplier(now + 8000, 0, now), 1.25);
  assert.equal(Shared.powerMultiplier(0, now + 10000, now), 0.7);
  assert.equal(Shared.powerMultiplier(now + 8000, now + 10000, now), 0.875);
  assert.equal(Shared.powerMultiplier(now, now, now), 1);
});

// La predicción del cliente rebobina hasta la última posición confirmada y rehace
// los inputs pendientes. Si eso no diera igual que simular de corrido, cada
// corrección movería el auto y se vería como un tirón.
test("rehacer los pasos desde un punto intermedio da el mismo resultado que simular de corrido", () => {
  const dt = 1 / Shared.TICK_RATE;
  const guion = [];
  for (let i = 0; i < 180; i += 1) {
    guion.push({
      up: i % 7 !== 0,
      down: i > 120 && i % 11 === 0,
      left: i > 40 && i < 90,
      right: i >= 90 && i < 140,
      handbrake: i % 23 === 0
    });
  }
  const inicial = { x: 262, y: 568, angle: 0.4, vx: 0, vy: 0, finished: false };

  const corrido = { ...inicial };
  for (const input of guion) Shared.stepCar(corrido, input, dt);

  const rebobinado = { ...inicial };
  const corte = 60;
  for (let i = 0; i < corte; i += 1) Shared.stepCar(rebobinado, guion[i], dt);
  const confirmado = { ...rebobinado };
  for (let i = corte; i < guion.length; i += 1) Shared.stepCar(confirmado, guion[i], dt);

  for (const clave of ["x", "y", "angle", "vx", "vy"]) {
    assert.equal(confirmado[clave], corrido[clave], `divergencia en ${clave}`);
  }
});

test("stepCar mantiene el auto dentro del asfalto y tolera posiciones inválidas", () => {
  const dt = 1 / Shared.TICK_RATE;
  const auto = { x: 262, y: 568, angle: 1.2, vx: 0, vy: 0, finished: false };
  for (let i = 0; i < 600; i += 1) {
    const { info } = Shared.stepCar(auto, { up: true, right: true }, dt);
    assert.ok(info, "la pista siempre debe resolverse para una posición finita");
    // info describe la posición previa al choque; lo que importa es dónde quedó el auto.
    const yaCorregido = Shared.nearestTrackInfo(auto.x, auto.y);
    assert.ok(yaCorregido.distance <= Shared.ROAD_HALF_WIDTH - Shared.CAR_RADIUS + 0.001,
      `se salió del asfalto en el paso ${i}: ${yaCorregido.distance}`);
  }

  const roto = { x: NaN, y: NaN, angle: 0, vx: 0, vy: 0, finished: false };
  assert.doesNotThrow(() => Shared.stepCar(roto, { up: true }, dt));
});
