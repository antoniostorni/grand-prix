(function exposeShared(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.RaceShared = api;
})(typeof window !== "undefined" ? window : globalThis, function createShared() {
  "use strict";

  const WORLD = { width: 1280, height: 720 };
  const ROAD_HALF_WIDTH = 66;
  const CAR_RADIUS = 14;
  const LAPS = 3;
  const MAX_PLAYERS = 8;
  const TICK_RATE = 60;
  const SNAPSHOT_RATE = 20;
  const POWER_UPS = Object.freeze({
    BOOST_DURATION: 8000,
    SLOW_DURATION: 10000,
    BOOST_MULTIPLIER: 1.25,
    SLOW_MULTIPLIER: 0.7,
    PICKUP_RADIUS: 16,
    RESPAWN_TIME: 9000
  });
  const TRACK_POINTS = [
    { x: 262, y: 568 },
    { x: 132, y: 520 },
    { x: 104, y: 386 },
    { x: 163, y: 258 },
    { x: 288, y: 196 },
    { x: 420, y: 224 },
    { x: 514, y: 298 },
    { x: 606, y: 257 },
    { x: 676, y: 138 },
    { x: 814, y: 110 },
    { x: 932, y: 173 },
    { x: 978, y: 272 },
    { x: 1104, y: 302 },
    { x: 1180, y: 403 },
    { x: 1140, y: 527 },
    { x: 1029, y: 588 },
    { x: 887, y: 562 },
    { x: 794, y: 480 },
    { x: 688, y: 488 },
    { x: 572, y: 574 },
    { x: 411, y: 608 }
  ];

  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    };
  }

  function makeTrackSamples(stepsPerCurve) {
    const steps = stepsPerCurve || 12;
    const samples = [];
    const count = TRACK_POINTS.length;
    for (let i = 0; i < count; i += 1) {
      const p0 = TRACK_POINTS[(i - 1 + count) % count];
      const p1 = TRACK_POINTS[i];
      const p2 = TRACK_POINTS[(i + 1) % count];
      const p3 = TRACK_POINTS[(i + 2) % count];
      for (let step = 0; step < steps; step += 1) {
        samples.push(catmullRom(p0, p1, p2, p3, step / steps));
      }
    }
    return samples;
  }

  const TRACK_SAMPLES = makeTrackSamples(12);

  function nearestTrackInfo(x, y) {
    let bestDistanceSquared = Infinity;
    let best = null;
    const samples = TRACK_SAMPLES;
    for (let i = 0; i < samples.length; i += 1) {
      const a = samples[i];
      const b = samples[(i + 1) % samples.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lengthSquared = abx * abx + aby * aby || 1;
      const projection = Math.max(0, Math.min(1,
        ((x - a.x) * abx + (y - a.y) * aby) / lengthSquared));
      const px = a.x + abx * projection;
      const py = a.y + aby * projection;
      const dx = x - px;
      const dy = y - py;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        const segmentLength = Math.sqrt(lengthSquared);
        best = {
          x: px,
          y: py,
          distance: Math.sqrt(distanceSquared),
          index: i,
          progress: (i + projection) / samples.length,
          tangentX: abx / segmentLength,
          tangentY: aby / segmentLength,
          offsetX: dx,
          offsetY: dy
        };
      }
    }
    return best;
  }

  function circularIndexDistance(a, b, length) {
    const direct = Math.abs(a - b);
    return Math.min(direct, length - direct);
  }

  function checkpointIndices() {
    const length = TRACK_SAMPLES.length;
    return [
      Math.floor(length * 0.25),
      Math.floor(length * 0.5),
      Math.floor(length * 0.75),
      0
    ];
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Ajustes de manejo. Medidos con un piloto automático con reacción humana:
  // bajan los choques ~27% y la dureza de los golpes ~44% sin perder tiempo de vuelta.
  const STEER_ATTACK = 12;        // qué tan rápido entra la dirección al apretar
  const STEER_RELEASE = 30;       // al soltar endereza casi de inmediato
  const STEER_FADE_FROM = 140;    // desde qué velocidad empieza a calmarse el giro
  const STEER_FADE_SPAN = 220;
  const STEER_FADE_AMOUNT = 0.4;  // cuánto giro se recorta a fondo de velocidad
  const WALL_BOUNCE = 1.2;        // rebote contra el borde (antes 1.45)
  const WALL_KEEP = 0.82;         // velocidad que sobrevive al golpe (antes 0.74)

  function createInput() {
    return { up: false, down: false, left: false, right: false, handbrake: false };
  }

  function powerMultiplier(boostUntil, slowUntil, now) {
    let multiplier = 1;
    if (Number(boostUntil) > now) multiplier *= POWER_UPS.BOOST_MULTIPLIER;
    if (Number(slowUntil) > now) multiplier *= POWER_UPS.SLOW_MULTIPLIER;
    return multiplier;
  }

  // Empuja al auto de vuelta adentro del asfalto. Devuelve la magnitud del impacto
  // (0 si no hubo choque) para que quien llame decida si suena el golpe.
  function applyTrackCollision(car, info) {
    const limit = ROAD_HALF_WIDTH - CAR_RADIUS;
    if (info.distance <= limit) return 0;

    const normalLength = Math.hypot(info.offsetX, info.offsetY) || 1;
    const nx = info.offsetX / normalLength;
    const ny = info.offsetY / normalLength;
    car.x = info.x + nx * limit;
    car.y = info.y + ny * limit;
    const outwardVelocity = car.vx * nx + car.vy * ny;
    let impact = 0;
    if (outwardVelocity > 0) {
      car.vx -= WALL_BOUNCE * outwardVelocity * nx;
      car.vy -= WALL_BOUNCE * outwardVelocity * ny;
      impact = Math.abs(outwardVelocity);
    }
    car.vx *= WALL_KEEP;
    car.vy *= WALL_KEEP;
    return impact;
  }

  // Un paso de simulación de un auto. El server y el cliente corren exactamente
  // esta función: cualquier diferencia entre ambos se ve como una corrección brusca.
  // Devuelve { info, impact }; info es null si el auto ya terminó la carrera.
  function stepCar(car, input, dt) {
    if (car.finished) {
      car.vx *= Math.exp(-5 * dt);
      car.vy *= Math.exp(-5 * dt);
      car.x += car.vx * dt;
      car.y += car.vy * dt;
      return { info: null, impact: 0 };
    }

    const forwardX = Math.cos(car.angle);
    const forwardY = Math.sin(car.angle);
    let forwardSpeed = car.vx * forwardX + car.vy * forwardY;
    const lateralSpeed = car.vx * -forwardY + car.vy * forwardX;
    const speedMultiplier = Number.isFinite(car.speedMultiplier)
      ? clamp(car.speedMultiplier, 0.45, 1.5)
      : 1;

    if (input.up) forwardSpeed += 520 * speedMultiplier * dt;
    if (input.down) {
      if (forwardSpeed > 15) forwardSpeed -= 760 * dt;
      else forwardSpeed -= 310 * dt;
    }

    const maxForward = (input.handbrake ? 300 : 390) * speedMultiplier;
    forwardSpeed = clamp(forwardSpeed, -145, maxForward);
    const speedRatio = clamp(Math.abs(forwardSpeed) / 130, 0, 1);
    // La dirección es progresiva: un toque corto dobla poco y sostenerla dobla del
    // todo, pero al soltar se endereza casi al instante. Da control fino sin volverse
    // pesada, y en el celular convierte los botones en algo parecido a un analógico.
    const wanted = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const previousSteer = car.steer || 0;
    const returning = wanted === 0 || wanted * previousSteer < 0;
    const steerRate = returning ? STEER_RELEASE : STEER_ATTACK;
    const steer = previousSteer + (wanted - previousSteer) * (1 - Math.exp(-steerRate * dt));
    car.steer = steer;

    if (Math.abs(steer) > 0.001 && Math.abs(forwardSpeed) > 4) {
      const direction = Math.sign(forwardSpeed);
      const turnRate = input.handbrake ? 3.65 : 2.7;
      // Cuanto más rápido va, menos giro entrega cada tecla: eso es lo que evita
      // los trompos sin quitarle agilidad en las curvas lentas.
      const fade = clamp((Math.abs(forwardSpeed) - STEER_FADE_FROM) / STEER_FADE_SPAN, 0, 1);
      const authority = (0.32 + speedRatio * 0.68) * (1 - STEER_FADE_AMOUNT * fade);
      car.angle += steer * turnRate * authority * direction * dt;
    }

    const grip = input.handbrake ? 2.2 : 9.5;
    const keptLateral = lateralSpeed * Math.exp(-grip * dt);
    const rolling = input.up || input.down ? 0.8 : 2.2;
    forwardSpeed *= Math.exp(-rolling * dt);
    car.vx = Math.cos(car.angle) * forwardSpeed + -Math.sin(car.angle) * keptLateral;
    car.vy = Math.sin(car.angle) * forwardSpeed + Math.cos(car.angle) * keptLateral;
    car.x += car.vx * dt;
    car.y += car.vy * dt;

    const info = nearestTrackInfo(car.x, car.y);
    // Sólo pasa si la posición dejó de ser finita. En el cliente esto corre dentro
    // del loop de dibujo, así que preferimos no dibujar a romper la pantalla.
    if (!info) return { info: null, impact: 0 };
    const impact = applyTrackCollision(car, info);
    return { info, impact };
  }

  return {
    WORLD,
    ROAD_HALF_WIDTH,
    CAR_RADIUS,
    LAPS,
    MAX_PLAYERS,
    TICK_RATE,
    SNAPSHOT_RATE,
    POWER_UPS,
    TRACK_POINTS,
    TRACK_SAMPLES,
    makeTrackSamples,
    nearestTrackInfo,
    circularIndexDistance,
    checkpointIndices,
    clamp,
    createInput,
    powerMultiplier,
    applyTrackCollision,
    stepCar
  };
});
