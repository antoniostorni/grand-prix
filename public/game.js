(() => {
  "use strict";

  const S = window.RaceShared;
  const socket = window.io({ transports: ["websocket", "polling"] });
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const elements = Object.fromEntries([
    "joinPanel", "lobbyPanel", "resultsPanel", "joinForm", "nameInput", "roomInput", "joinButton",
    "joinError", "colorPicker", "roomCode", "playerGrid", "shareButton", "readyButton", "startButton",
    "lobbyHint", "restartButton", "exitButton", "podium", "resultsList", "resultTitle", "hud",
    "hudPosition", "hudLap", "hudTime", "hudSpeed", "speedBar", "leaderboard", "wrongWay", "hudPowerStatus",
    "countdown", "announcement", "toast", "audioButton", "fullscreenButton", "connectionBadge",
    "mobileControls"
  ].map((id) => [id, document.querySelector(`#${id}`)]));

  const COLORS = ["#ff4d6d", "#4cc9f0", "#f9c74f", "#8cff66", "#b388ff", "#ff8c42", "#ffffff", "#ff66e3"];
  const state = {
    joined: false,
    myId: null,
    room: null,
    selectedColor: COLORS[0],
    snapshots: new Map(),
    visuals: new Map(),
    powerUps: [],
    inputs: { up: false, down: false, left: false, right: false, handbrake: false },
    inputSequence: 0,
    predicted: null,
    predictionError: { x: 0, y: 0, angle: 0 },
    inputHistory: [],
    snapshotBuffer: [],
    stepAccumulator: 0,
    clockReady: false,
    rtt: 0,
    rttReady: false,
    raceStartAt: 0,
    serverOffset: 0,
    countdownValue: null,
    lastFrame: performance.now(),
    lastSkidAt: 0,
    skidMarks: [],
    particles: [],
    confetti: [],
    announcementTimer: 0,
    toastTimer: 0,
    raceFinished: false
  };

  const decor = createDecor();
  const trackPath = makeTrackPath();

  class RaceAudio {
    constructor() {
      this.context = null;
      this.master = null;
      this.engine = null;
      this.engineGain = null;
      this.musicTimer = null;
      this.step = 0;
      this.muted = false;
    }

    unlock() {
      if (!this.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0.42;
        this.master.connect(this.context.destination);
        this.createEngine();
        this.startMusic();
      }
      if (this.context.state === "suspended") this.context.resume();
    }

    createEngine() {
      this.engine = this.context.createOscillator();
      this.engineGain = this.context.createGain();
      const filter = this.context.createBiquadFilter();
      this.engine.type = "sawtooth";
      this.engine.frequency.value = 52;
      this.engineGain.gain.value = 0;
      filter.type = "lowpass";
      filter.frequency.value = 520;
      this.engine.connect(filter).connect(this.engineGain).connect(this.master);
      this.engine.start();
    }

    updateEngine(speed, active, accelerating) {
      if (!this.context || !this.engine) return;
      const now = this.context.currentTime;
      const targetGain = active ? 0.025 + Math.min(speed / 400, 1) * 0.045 : 0;
      this.engineGain.gain.setTargetAtTime(targetGain, now, 0.06);
      this.engine.frequency.setTargetAtTime(48 + speed * 0.7 + (accelerating ? 18 : 0), now, 0.05);
    }

    tone(frequency, duration = 0.1, volume = 0.08, type = "square", delay = 0) {
      if (!this.context || this.muted) return;
      const time = this.context.currentTime + delay;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, time);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(volume, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(time);
      oscillator.stop(time + duration + 0.02);
    }

    noise(strength = 0.5) {
      if (!this.context || this.muted) return;
      const length = Math.floor(this.context.sampleRate * 0.15);
      const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      filter.type = "lowpass";
      filter.frequency.value = 420;
      gain.gain.value = 0.08 + strength * 0.13;
      source.buffer = buffer;
      source.connect(filter).connect(gain).connect(this.master);
      source.start();
    }

    sfx(type, strength = 0.5) {
      this.unlock();
      if (type === "count") this.tone(330, 0.12, 0.1, "square");
      if (type === "go") {
        this.tone(660, 0.28, 0.11, "square");
        this.tone(990, 0.22, 0.07, "square", 0.08);
      }
      if (type === "checkpoint") this.tone(540, 0.07, 0.045, "sine");
      if (type === "lap") {
        this.tone(520, 0.1, 0.07, "square");
        this.tone(780, 0.16, 0.07, "square", 0.1);
      }
      if (type === "crash") this.noise(strength);
      if (type === "boost") {
        [440, 660, 880, 1100].forEach((note, index) =>
          this.tone(note, 0.22, 0.065, "sawtooth", index * 0.055));
      }
      if (type === "lightning") {
        this.noise(0.7);
        [180, 120, 80].forEach((note, index) =>
          this.tone(note, 0.28, 0.075, "square", index * 0.07));
      }
      if (type === "finish") {
        [523, 659, 784, 1047].forEach((note, index) => this.tone(note, 0.28, 0.085, "square", index * 0.11));
      }
    }

    startMusic() {
      if (this.musicTimer) return;
      const bass = [110, 110, 146.8, 110, 164.8, 146.8, 98, 110];
      const lead = [440, 0, 523.3, 0, 659.3, 0, 523.3, 587.3, 0, 440, 0, 392, 440, 0, 523.3, 0];
      this.musicTimer = window.setInterval(() => {
        if (!this.context || this.context.state !== "running" || this.muted || !state.joined) return;
        const isRacing = state.room?.state === "racing" || state.room?.state === "countdown";
        const step = this.step++;
        this.tone(bass[step % bass.length], 0.14, isRacing ? 0.026 : 0.015, "triangle");
        const note = lead[step % lead.length];
        if (note && step % 2 === 0) this.tone(note, 0.09, isRacing ? 0.018 : 0.01, "square");
      }, 180);
    }

    toggle() {
      this.unlock();
      this.muted = !this.muted;
      if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.42, this.context.currentTime, 0.03);
      return this.muted;
    }
  }

  const audio = new RaceAudio();

  function makeTrackPath() {
    const path = new Path2D();
    const samples = S.TRACK_SAMPLES;
    path.moveTo(samples[0].x, samples[0].y);
    for (let i = 1; i < samples.length; i += 1) path.lineTo(samples[i].x, samples[i].y);
    path.closePath();
    return path;
  }

  function createDecor() {
    const result = [];
    let seed = 83921;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 100; i += 1) {
      const x = 35 + random() * (S.WORLD.width - 70);
      const y = 35 + random() * (S.WORLD.height - 70);
      if (S.nearestTrackInfo(x, y).distance > S.ROAD_HALF_WIDTH + 34) {
        result.push({ x, y, radius: 7 + random() * 9, hue: random(), type: random() > 0.18 ? "tree" : "flag" });
      }
    }
    return result;
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * ratio);
    canvas.height = Math.floor(innerHeight * ratio);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
  }

  function viewportTransform() {
    const scale = Math.min(canvas.width / S.WORLD.width, canvas.height / S.WORLD.height);
    return {
      scale,
      x: (canvas.width - S.WORLD.width * scale) / 2,
      y: (canvas.height - S.WORLD.height * scale) / 2
    };
  }

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
    context.beginPath();
    context.roundRect(x, y, width, height, r);
  }

  function drawBackground() {
    const gradient = ctx.createLinearGradient(0, 0, S.WORLD.width, S.WORLD.height);
    gradient.addColorStop(0, "#091737");
    gradient.addColorStop(0.52, "#07132e");
    gradient.addColorStop(1, "#040d24");
    ctx.fillStyle = gradient;
    ctx.fillRect(-50, -50, S.WORLD.width + 100, S.WORLD.height + 100);

    ctx.globalAlpha = 0.09;
    ctx.fillStyle = "#426ac8";
    for (let x = -50; x < S.WORLD.width + 50; x += 34) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(-0.12);
      ctx.fillRect(0, -100, 14, S.WORLD.height + 200);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    drawDecor();
  }

  function drawDecor() {
    for (const item of decor) {
      if (item.type === "tree") {
        ctx.fillStyle = "rgba(0,0,0,0.24)";
        ctx.beginPath();
        ctx.ellipse(item.x + 5, item.y + 8, item.radius, item.radius * 0.7, 0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = item.hue > 0.45 ? "#276b3a" : "#1e5832";
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(124,220,105,0.26)";
        ctx.beginPath();
        ctx.arc(item.x - item.radius * 0.25, item.y - item.radius * 0.28, item.radius * 0.48, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = "#b7c4d7";
        ctx.fillRect(item.x, item.y, 2, item.radius + 6);
        ctx.fillStyle = item.hue > 0.5 ? "#53e3ff" : "#d8ff44";
        ctx.beginPath();
        ctx.moveTo(item.x + 2, item.y);
        ctx.lineTo(item.x + item.radius + 6, item.y + 4);
        ctx.lineTo(item.x + 2, item.y + 8);
        ctx.fill();
      }
    }

    drawGrandstand(63, 601, "DEV TEAM");
    drawGrandstand(1020, 74, "QA CURVE");
    drawBillboard(462, 77, "SOFTWARE // GP", "#4387ff");
    drawBillboard(1080, 640, "NO MEETINGS", "#53e3ff");
  }

  function drawGrandstand(x, y, label) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(7, 7, 130, 34);
    ctx.fillStyle = "#293544";
    ctx.fillRect(0, 0, 130, 34);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 13; col += 1) {
        ctx.fillStyle = ["#ff4d6d", "#4cc9f0", "#f9c74f", "#d7e2ef"][(row * 13 + col) % 4];
        ctx.fillRect(5 + col * 9.5, 5 + row * 7, 4, 4);
      }
    }
    ctx.fillStyle = "#0b101a";
    ctx.font = "900 7px system-ui";
    ctx.fillText(label, 42, 31);
    ctx.restore();
  }

  function drawBillboard(x, y, text, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(4, 5, 89, 24);
    ctx.fillStyle = "#101722";
    ctx.fillRect(0, 0, 89, 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 89, 24);
    ctx.fillStyle = color;
    ctx.font = "900 italic 9px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(text, 44, 15);
    ctx.restore();
  }

  function strokeTrack(color, width, dash = []) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dash);
    ctx.stroke(trackPath);
    ctx.setLineDash([]);
  }

  function drawTrack() {
    ctx.save();
    ctx.translate(7, 10);
    strokeTrack("rgba(0,0,0,0.38)", S.ROAD_HALF_WIDTH * 2 + 30);
    ctx.restore();
    strokeTrack("#0b1017", S.ROAD_HALF_WIDTH * 2 + 22);
    strokeTrack("#f04e57", S.ROAD_HALF_WIDTH * 2 + 13);
    strokeTrack("#ece6d9", S.ROAD_HALF_WIDTH * 2 + 13, [20, 20]);
    strokeTrack("#303742", S.ROAD_HALF_WIDTH * 2);
    strokeTrack("rgba(255,255,255,0.035)", S.ROAD_HALF_WIDTH * 2 - 10, [3, 8]);
    strokeTrack("rgba(225,235,245,0.24)", 2, [13, 18]);

    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = "#090c11";
    ctx.lineWidth = 2;
    for (let offset = -34; offset <= 34; offset += 68) {
      ctx.save();
      ctx.translate(0, offset);
      ctx.stroke(trackPath);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    drawStartLine();
    drawStartingGrid();
  }

  function drawStartLine() {
    const point = S.TRACK_SAMPLES[0];
    const next = S.TRACK_SAMPLES[1];
    const angle = Math.atan2(next.y - point.y, next.x - point.x);
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(angle);
    const tile = 11;
    for (let row = -6; row < 6; row += 1) {
      for (let col = -1; col < 1; col += 1) {
        ctx.fillStyle = (row + col) % 2 === 0 ? "#f5f3ec" : "#11151c";
        ctx.fillRect(col * tile, row * tile, tile, tile);
      }
    }
    ctx.restore();
  }

  function drawStartingGrid() {
    const samples = S.TRACK_SAMPLES;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    for (let index = 0; index < S.MAX_PLAYERS; index += 1) {
      const sampleIndex = (samples.length - 3 - Math.floor(index / 2) * 9 + samples.length) % samples.length;
      const point = samples[sampleIndex];
      const next = samples[(sampleIndex + 1) % samples.length];
      const angle = Math.atan2(next.y - point.y, next.x - point.x);
      const side = index % 2 === 0 ? -18 : 18;
      ctx.save();
      ctx.translate(point.x - Math.sin(angle) * side, point.y + Math.cos(angle) * side);
      ctx.rotate(angle);
      ctx.strokeRect(-18, -12, 36, 24);
      ctx.restore();
    }
  }

  function traceStar(context, outerRadius, innerRadius) {
    context.beginPath();
    for (let point = 0; point < 10; point += 1) {
      const angle = -Math.PI / 2 + point * Math.PI / 5;
      const radius = point % 2 === 0 ? outerRadius : innerRadius;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (point === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
  }

  function drawPowerUps(timestamp) {
    if (state.room?.state !== "countdown" && state.room?.state !== "racing") return;
    const now = timestamp || performance.now();
    state.powerUps.forEach((powerUp, index) => {
      if (!powerUp.active) return;
      const isBoost = powerUp.type === "boost";
      const color = isBoost ? "#ffe45b" : "#b388ff";
      const bob = Math.sin(now / 210 + index * 1.7) * 3;
      const pulse = 1 + Math.sin(now / 150 + index) * 0.09;

      ctx.save();
      ctx.translate(powerUp.x, powerUp.y + bob);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 27 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.rotate(Math.sin(now / 430 + index) * 0.2);
      ctx.fillStyle = color;
      traceStar(ctx, 18 * pulse, 8.5 * pulse);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();

      ctx.save();
      ctx.translate(powerUp.x, powerUp.y + bob);
      ctx.fillStyle = isBoost ? "#412f00" : "#ffffff";
      ctx.font = "1000 15px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(isBoost ? "»" : "⚡", 0, 1);
      ctx.font = "1000 7px system-ui";
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(isBoost ? "TURBO" : "RAYO", 0, 29 - bob);
      ctx.restore();
    });
  }

  function drawSkids() {
    ctx.lineCap = "round";
    for (const mark of state.skidMarks) {
      ctx.globalAlpha = Math.max(0, mark.life) * 0.22;
      ctx.strokeStyle = "#080b10";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(mark.x1, mark.y1);
      ctx.lineTo(mark.x2, mark.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles(dt) {
    for (const particle of state.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt * 1.7;
      particle.radius += dt * 5;
      ctx.globalAlpha = Math.max(0, particle.life) * 0.5;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    state.particles = state.particles.filter((particle) => particle.life > 0);
    ctx.globalAlpha = 1;
  }

  function drawCarPowerEffect(player) {
    const now = serverNow();
    const boosted = player.boostUntil > now;
    const slowed = player.slowUntil > now;
    if (!boosted && !slowed) return;

    if (boosted) {
      const flicker = 5 + Math.sin(performance.now() / 55) * 3;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#ffe45b";
      ctx.beginPath();
      ctx.moveTo(-20, -6);
      ctx.lineTo(-34 - flicker, 0);
      ctx.lineTo(-20, 6);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = "#53e3ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, 29, 18, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (slowed) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "#cbb5ff";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.ellipse(0, 0, 27, 17, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f1eaff";
      ctx.beginPath();
      ctx.moveTo(-3, -23);
      ctx.lineTo(5, -23);
      ctx.lineTo(0, -15);
      ctx.lineTo(7, -15);
      ctx.lineTo(-4, -3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawCar(player, isMe) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    drawCarPowerEffect(player);

    if (isMe) {
      const aura = ctx.createRadialGradient(0, 0, 9, 0, 0, 27);
      aura.addColorStop(0, "rgba(255,255,255,0)");
      aura.addColorStop(0.68, "rgba(255,255,255,0.04)");
      aura.addColorStop(1, player.color);
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.ellipse(0, 0, 28, 19, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowColor = player.color;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = "rgba(255,255,255,0.76)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(0, 0, 24, 16, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.save();
    ctx.translate(-1, 4);
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    roundedRect(ctx, -20, -10, 42, 23, 8);
    ctx.fill();
    ctx.restore();

    const wheels = [
      [-13, -13], [8, -13],
      [-13, 9], [8, 9]
    ];
    wheels.forEach(([x, y]) => {
      ctx.fillStyle = "#05070c";
      roundedRect(ctx, x, y, 9, 5, 2);
      ctx.fill();
      ctx.fillStyle = "#4c5a6c";
      roundedRect(ctx, x + 2, y + 1, 5, 3, 1);
      ctx.fill();
    });

    ctx.fillStyle = "#080b12";
    roundedRect(ctx, -21, -10, 4, 20, 2);
    ctx.fill();
    ctx.fillStyle = "#293349";
    ctx.fillRect(-22, -8, 2, 16);

    const bodyGradient = ctx.createLinearGradient(0, -12, 0, 12);
    bodyGradient.addColorStop(0, shadeColor(player.color, 30));
    bodyGradient.addColorStop(0.22, player.color);
    bodyGradient.addColorStop(0.7, shadeColor(player.color, -10));
    bodyGradient.addColorStop(1, shadeColor(player.color, -38));
    ctx.fillStyle = bodyGradient;
    ctx.beginPath();
    ctx.moveTo(-18, -9);
    ctx.quadraticCurveTo(-21, -7, -21, -3);
    ctx.lineTo(-21, 3);
    ctx.quadraticCurveTo(-21, 7, -18, 9);
    ctx.lineTo(10, 11);
    ctx.quadraticCurveTo(18, 9, 21, 4);
    ctx.lineTo(21, -4);
    ctx.quadraticCurveTo(18, -9, 10, -11);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const noseGradient = ctx.createLinearGradient(8, 0, 21, 0);
    noseGradient.addColorStop(0, "rgba(255,255,255,0.04)");
    noseGradient.addColorStop(1, "rgba(255,255,255,0.25)");
    ctx.fillStyle = noseGradient;
    ctx.beginPath();
    ctx.moveTo(8, -9);
    ctx.lineTo(17, -7);
    ctx.quadraticCurveTo(20, -4, 20, 0);
    ctx.quadraticCurveTo(20, 4, 17, 7);
    ctx.lineTo(8, 9);
    ctx.closePath();
    ctx.fill();

    const glassGradient = ctx.createLinearGradient(-7, -7, 8, 7);
    glassGradient.addColorStop(0, "#75cfff");
    glassGradient.addColorStop(0.12, "#d9f6ff");
    glassGradient.addColorStop(0.24, "#173a5b");
    glassGradient.addColorStop(1, "#071427");
    ctx.fillStyle = glassGradient;
    roundedRect(ctx, -7, -7, 15, 14, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(210,244,255,0.52)";
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.strokeStyle = "rgba(151,218,255,0.52)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-1, -6);
    ctx.lineTo(-1, 6);
    ctx.moveTo(5, -5);
    ctx.lineTo(5, 5);
    ctx.stroke();

    ctx.fillStyle = "rgba(4,10,20,0.58)";
    roundedRect(ctx, -2, -10, 7, 2.4, 1);
    ctx.fill();
    roundedRect(ctx, -2, 7.6, 7, 2.4, 1);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.fillRect(-17, -1.8, 25, 1.2);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(-17, 0.8, 25, 1);

    ctx.shadowBlur = 7;
    ctx.shadowColor = "#bff4ff";
    ctx.fillStyle = "#dffaff";
    roundedRect(ctx, 16, -7, 3.5, 4.5, 1.2);
    ctx.fill();
    roundedRect(ctx, 16, 2.5, 3.5, 4.5, 1.2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.shadowBlur = 5;
    ctx.shadowColor = "#ff315e";
    ctx.fillStyle = "#ff315e";
    roundedRect(ctx, -20, -6.5, 2.3, 4, 0.8);
    ctx.fill();
    roundedRect(ctx, -20, 2.5, 2.3, 4, 0.8);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(6,10,18,0.75)";
    roundedRect(ctx, 15, -1.7, 4.5, 3.4, 1);
    ctx.fill();

    const colorIndex = Math.max(0, COLORS.indexOf(String(player.color).toLowerCase()));
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(11, 0, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0a1020";
    ctx.font = "1000 4.8px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(colorIndex + 1), 11, 0.2);

    ctx.strokeStyle = "rgba(255,255,255,0.42)";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(-15, -8.2);
    ctx.quadraticCurveTo(3, -11, 14, -8);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(player.x, player.y - 25);
    ctx.font = `${isMe ? "900" : "700"} 9px system-ui`;
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(5,8,14,0.9)";
    ctx.strokeText(player.name, 0, 0);
    ctx.fillStyle = isMe ? "#ffffff" : "#d8e2f0";
    ctx.fillText(player.name, 0, 0);
    ctx.restore();
  }

  function shadeColor(hex, amount) {
    const clean = hex.replace("#", "");
    const number = Number.parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
    const r = Math.max(0, Math.min(255, (number >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((number >> 8) & 255) + amount));
    const b = Math.max(0, Math.min(255, (number & 255) + amount));
    return `rgb(${r},${g},${b})`;
  }

  // ---- Netcode: predicción local y reconciliación con el server ----
  // El server manda 20 snapshots por segundo y está a ~100 ms de distancia. Dibujando
  // solo lo que llega, cada maniobra se siente con ~300 ms de atraso. Así que el auto
  // propio se simula acá con la misma física de shared.js y se corrige contra la
  // verdad del server, mientras que a los rivales se los interpola en el pasado.
  const FIXED_DT = 1 / S.TICK_RATE;
  const MAX_CATCHUP_STEPS = 6;
  const INTERPOLATION_DELAY = 110;
  const RESYNC_DISTANCE = 90;

  function serverNow() {
    return Date.now() + state.serverOffset;
  }

  function shortestAngle(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  // Cuánto tarda un ida y vuelta. Define cuánto historial hay que rehacer en cada
  // corrección, así que conviene que sea estable: se promedia y se acota.
  function measureRtt() {
    if (!state.joined) return;
    const sentAt = Date.now();
    socket.emit("rtt", null, () => {
      const sample = S.clamp(Date.now() - sentAt, 0, 600);
      state.rtt = state.rttReady ? state.rtt * 0.8 + sample * 0.2 : sample;
      state.rttReady = true;
    });
  }

  function resetPrediction() {
    state.predicted = null;
    state.inputHistory.length = 0;
    state.snapshotBuffer.length = 0;
    state.predictionError.x = 0;
    state.predictionError.y = 0;
    state.predictionError.angle = 0;
    state.stepAccumulator = 0;
  }

  // Avanza mi auto en pasos fijos de 1/60 s, iguales a los del server, y guarda cada
  // input aplicado para poder rehacerlos cuando llegue la corrección.
  function predictedCarFromSnapshot(player) {
    const boostUntil = player.boostUntil || 0;
    const slowUntil = player.slowUntil || 0;
    return {
      x: player.x,
      y: player.y,
      angle: player.angle,
      vx: player.vx,
      vy: player.vy,
      steer: player.steer || 0,
      finished: player.finished,
      boostUntil,
      slowUntil,
      speedMultiplier: S.powerMultiplier(boostUntil, slowUntil, serverNow())
    };
  }

  function predictLocal(dt) {
    if (!state.predicted || state.room?.state !== "racing") return;
    state.stepAccumulator = Math.min(state.stepAccumulator + dt, FIXED_DT * MAX_CATCHUP_STEPS);
    while (state.stepAccumulator >= FIXED_DT) {
      state.stepAccumulator -= FIXED_DT;
      const input = { ...state.inputs };
      state.inputHistory.push({ t: Date.now(), dt: FIXED_DT, input });
      state.predicted.speedMultiplier = S.powerMultiplier(state.predicted.boostUntil, state.predicted.slowUntil, serverNow());
      S.stepCar(state.predicted, input, FIXED_DT);
    }
    const maxHistory = S.TICK_RATE * 2;
    if (state.inputHistory.length > maxHistory) {
      state.inputHistory.splice(0, state.inputHistory.length - maxHistory);
    }
  }

  // Rebobina a la última posición confirmada y vuelve a aplicar los inputs que el
  // server todavía no llegó a procesar. El error que queda se disuelve de a poco en
  // pantalla, así la corrección no se ve como un salto.
  function reconcile(snapshot, mine) {
    if (!state.predicted) {
      state.predicted = predictedCarFromSnapshot(mine);
      state.inputHistory.length = 0;
      return;
    }

    const previousX = state.predicted.x + state.predictionError.x;
    const previousY = state.predicted.y + state.predictionError.y;
    const previousAngle = state.predicted.angle + state.predictionError.angle;

    // Este snapshot refleja los inputs que el server tenía hace medio viaje de ida,
    // y que salieron de acá medio viaje antes: hay que rehacer un RTT completo.
    const replayFrom = Date.now() - state.rtt;
    const car = predictedCarFromSnapshot(mine);
    state.inputHistory = state.inputHistory.filter((step) => step.t >= replayFrom);
    for (const step of state.inputHistory) {
      car.speedMultiplier = S.powerMultiplier(car.boostUntil, car.slowUntil, step.t + state.serverOffset);
      S.stepCar(car, step.input, step.dt);
    }
    state.predicted = car;

    const errorX = previousX - car.x;
    const errorY = previousY - car.y;
    if (Math.hypot(errorX, errorY) > RESYNC_DISTANCE) {
      // Choque fuerte o reposición: disimularlo mentiría, mostramos la verdad de una.
      state.predictionError.x = 0;
      state.predictionError.y = 0;
      state.predictionError.angle = 0;
      return;
    }
    state.predictionError.x = errorX;
    state.predictionError.y = errorY;
    state.predictionError.angle = shortestAngle(car.angle, previousAngle);
  }

  // Dibuja a los rivales ~110 ms en el pasado, entre dos snapshots reales: es más fiel
  // que perseguir el último dato y no inventa posiciones que después haya que desdecir.
  function sampleRemote(id, renderTime) {
    const buffer = state.snapshotBuffer;
    for (let i = buffer.length - 1; i > 0; i -= 1) {
      const older = buffer[i - 1];
      const newer = buffer[i];
      if (older.serverTime > renderTime || newer.serverTime < renderTime) continue;
      const a = older.players.get(id);
      const b = newer.players.get(id);
      if (!a || !b) continue;
      const span = newer.serverTime - older.serverTime || 1;
      const ratio = S.clamp((renderTime - older.serverTime) / span, 0, 1);
      return {
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
        angle: a.angle + shortestAngle(a.angle, b.angle) * ratio
      };
    }
    return null;
  }

  function updateVisuals(dt) {
    const errorDecay = Math.exp(-11 * dt);
    state.predictionError.x *= errorDecay;
    state.predictionError.y *= errorDecay;
    state.predictionError.angle *= errorDecay;

    const renderTime = serverNow() - INTERPOLATION_DELAY;
    const smoothing = 1 - Math.exp(-14 * dt);

    for (const [id, target] of state.snapshots) {
      let visual = state.visuals.get(id);
      if (!visual) {
        visual = { ...target };
        state.visuals.set(id, visual);
      }
      Object.assign(visual, {
        name: target.name,
        color: target.color,
        speed: target.speed,
        vx: target.vx,
        vy: target.vy,
        lap: target.lap,
        place: target.place,
        finished: target.finished,
        wrongWay: target.wrongWay,
        boostUntil: target.boostUntil,
        slowUntil: target.slowUntil
      });

      if (id === state.myId && state.predicted) {
        visual.x = state.predicted.x + state.predictionError.x;
        visual.y = state.predicted.y + state.predictionError.y;
        visual.angle = state.predicted.angle + state.predictionError.angle;
        visual.vx = state.predicted.vx;
        visual.vy = state.predicted.vy;
        visual.speed = Math.round(Math.hypot(state.predicted.vx, state.predicted.vy));
        continue;
      }

      const sample = sampleRemote(id, renderTime);
      if (sample) {
        visual.x = sample.x;
        visual.y = sample.y;
        visual.angle = sample.angle;
      } else {
        // Todavía no hay dos snapshots para interpolar: seguimos al último con suavizado.
        visual.x += ((target.x + target.vx * 0.025) - visual.x) * smoothing;
        visual.y += ((target.y + target.vy * 0.025) - visual.y) * smoothing;
        visual.angle += shortestAngle(visual.angle, target.angle) * smoothing;
      }
    }

    for (const id of state.visuals.keys()) {
      if (!state.snapshots.has(id)) state.visuals.delete(id);
    }
  }

  function addDrivingEffects(now) {
    const player = state.visuals.get(state.myId);
    if (!player || state.room?.state !== "racing" || player.finished) return;
    if (state.inputs.handbrake && player.speed > 85 && now - state.lastSkidAt > 35) {
      state.lastSkidAt = now;
      const rearX = player.x - Math.cos(player.angle) * 13;
      const rearY = player.y - Math.sin(player.angle) * 13;
      const normalX = -Math.sin(player.angle) * 7;
      const normalY = Math.cos(player.angle) * 7;
      for (const side of [-1, 1]) {
        state.skidMarks.push({
          x1: rearX + normalX * side,
          y1: rearY + normalY * side,
          x2: rearX + normalX * side - player.vx * 0.045,
          y2: rearY + normalY * side - player.vy * 0.045,
          life: 1
        });
      }
      state.particles.push({
        x: rearX,
        y: rearY,
        vx: -player.vx * 0.08 + (Math.random() - 0.5) * 12,
        vy: -player.vy * 0.08 + (Math.random() - 0.5) * 12,
        radius: 3,
        life: 0.7,
        color: "#c9d1d5"
      });
    }
    if (state.skidMarks.length > 230) state.skidMarks.splice(0, state.skidMarks.length - 230);
  }

  function drawConfetti(dt) {
    for (const piece of state.confetti) {
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;
      piece.vy += 80 * dt;
      piece.rotation += piece.spin * dt;
      piece.life -= dt;
      ctx.save();
      ctx.globalAlpha = Math.min(1, piece.life);
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rotation);
      ctx.fillStyle = piece.color;
      ctx.fillRect(-3, -2, 7, 4);
      ctx.restore();
    }
    state.confetti = state.confetti.filter((piece) => piece.life > 0);
    ctx.globalAlpha = 1;
  }

  function burstConfetti() {
    const point = S.TRACK_SAMPLES[0];
    for (let i = 0; i < 90; i += 1) {
      state.confetti.push({
        x: point.x + (Math.random() - 0.5) * 70,
        y: point.y + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 180,
        vy: -50 - Math.random() * 150,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 10,
        life: 2.4 + Math.random(),
        color: COLORS[Math.floor(Math.random() * COLORS.length)]
      });
    }
  }

  function render(timestamp) {
    const dt = Math.min((timestamp - state.lastFrame) / 1000, 0.05);
    state.lastFrame = timestamp;
    predictLocal(dt);
    updateVisuals(dt);
    addDrivingEffects(timestamp);
    state.skidMarks.forEach((mark) => { mark.life -= dt * 0.035; });
    state.skidMarks = state.skidMarks.filter((mark) => mark.life > 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const view = viewportTransform();
    ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
    drawBackground();
    drawTrack();
    drawPowerUps(timestamp);
    drawSkids();
    drawParticles(dt);
    const players = Array.from(state.visuals.values()).sort((a, b) => (a.id === state.myId ? 1 : 0) - (b.id === state.myId ? 1 : 0));
    players.forEach((player) => drawCar(player, player.id === state.myId));
    drawConfetti(dt);

    const me = state.visuals.get(state.myId);
    audio.updateEngine(me?.speed || 0, state.room?.state === "racing" && !me?.finished, state.inputs.up);
    updateClock();
    updatePowerStatus();
    updateCountdown();
    requestAnimationFrame(render);
  }

  function setPanel(activeId) {
    for (const id of ["joinPanel", "lobbyPanel", "resultsPanel"]) {
      elements[id].classList.toggle("active", id === activeId);
    }
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("active");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => elements.toast.classList.remove("active"), 2300);
  }

  function announce(message, duration = 1900) {
    elements.announcement.textContent = message;
    elements.announcement.classList.add("active");
    clearTimeout(state.announcementTimer);
    state.announcementTimer = setTimeout(() => elements.announcement.classList.remove("active"), duration);
  }

  function setConnected(connected) {
    elements.connectionBadge.classList.toggle("online", connected);
    elements.connectionBadge.classList.toggle("offline", !connected);
    elements.connectionBadge.querySelector("span").textContent = connected ? "EN LÍNEA" : "DESCONECTADO";
  }

  function renderLobby() {
    const room = state.room;
    if (!room) return;
    elements.roomCode.textContent = `#${room.code.toUpperCase()}`;
    elements.playerGrid.replaceChildren();
    for (let index = 0; index < room.maxPlayers; index += 1) {
      const player = room.players[index];
      if (!player) continue;
      const card = document.createElement("article");
      card.className = `player-card${player.ready ? " ready" : ""}`;
      card.style.setProperty("--car-color", player.color);
      const car = document.createElement("div");
      car.className = "player-car";
      const info = document.createElement("div");
      info.className = "player-info";
      const name = document.createElement("b");
      name.textContent = player.id === state.myId ? `${player.name} (vos)` : player.name;
      const status = document.createElement("small");
      status.textContent = player.id === room.hostId ? "ANFITRIÓN" : (player.ready ? "LISTO" : "AJUSTANDO MOTOR");
      if (player.id === room.hostId) status.className = "host-tag";
      const dot = document.createElement("i");
      dot.className = "ready-dot";
      info.append(name, status);
      card.append(car, info, dot);
      elements.playerGrid.append(card);
    }

    const me = room.players.find((player) => player.id === state.myId);
    const isHost = room.hostId === state.myId;
    const allReady = room.players.length > 0 && room.players.every((player) => player.ready);
    elements.readyButton.classList.toggle("active", Boolean(me?.ready));
    elements.readyButton.textContent = me?.ready ? "✓ ESTOY LISTO" : "MARCARME LISTO";
    elements.startButton.style.display = isHost ? "flex" : "none";
    elements.startButton.disabled = !allReady;
    elements.lobbyHint.textContent = isHost
      ? (allReady ? "Todo listo. Cuando quieras, largamos." : "La largada se habilita cuando todos estén listos.")
      : "Esperando que el anfitrión largue la carrera…";
  }

  function renderHud(snapshot) {
    const me = snapshot.players.find((player) => player.id === state.myId);
    if (!me) return;
    elements.hudPosition.innerHTML = `${me.place}<small>/${snapshot.players.length}</small>`;
    elements.hudLap.innerHTML = `${Math.min(me.lap + 1, S.LAPS)}<small>/${S.LAPS}</small>`;
    const kmh = Math.round(me.speed * 0.72);
    elements.hudSpeed.textContent = kmh;
    elements.speedBar.style.width = `${Math.min(kmh / 280, 1) * 100}%`;
    elements.wrongWay.classList.toggle("active", me.wrongWay);

    elements.leaderboard.replaceChildren();
    for (const player of snapshot.players) {
      const item = document.createElement("li");
      if (player.id === state.myId) item.className = "me";
      item.style.setProperty("--car-color", player.color);
      const position = document.createElement("b");
      position.textContent = player.place;
      const color = document.createElement("i");
      const name = document.createElement("span");
      name.textContent = player.name;
      const lap = document.createElement("small");
      lap.textContent = player.finished ? "FIN" : `V${Math.min(player.lap + 1, S.LAPS)}`;
      item.append(position, color, name, lap);
      elements.leaderboard.append(item);
    }
  }

  function updatePowerStatus() {
    const me = state.visuals.get(state.myId);
    const now = serverNow();
    const boostRemaining = Math.max(0, (me?.boostUntil || 0) - now);
    const slowRemaining = Math.max(0, (me?.slowUntil || 0) - now);
    if ((!boostRemaining && !slowRemaining) || state.room?.state !== "racing") {
      elements.hudPowerStatus.className = "power-status";
      elements.hudPowerStatus.textContent = "";
      return;
    }

    const parts = [];
    if (boostRemaining) parts.push("⭐ TURBO " + (boostRemaining / 1000).toFixed(1) + "s");
    if (slowRemaining) parts.push("⚡ RAYO " + (slowRemaining / 1000).toFixed(1) + "s");
    elements.hudPowerStatus.textContent = parts.join("  ·  ");
    const type = boostRemaining && slowRemaining ? "mixed" : (boostRemaining ? "boost" : "slow");
    elements.hudPowerStatus.className = "power-status active " + type;
  }

  function updateClock() {
    if (!state.raceStartAt || state.room?.state === "lobby") return;
    const elapsed = Math.max(0, Date.now() + state.serverOffset - state.raceStartAt);
    elements.hudTime.textContent = formatTime(elapsed);
  }

  function updateCountdown() {
    if (state.room?.state !== "countdown") {
      if (state.countdownValue !== null) {
        state.countdownValue = null;
        elements.countdown.className = "countdown";
        elements.countdown.textContent = "";
      }
      return;
    }
    const remaining = state.room.countdownEndsAt - (Date.now() + state.serverOffset);
    const value = remaining > 3000 ? 3 : remaining > 2000 ? 2 : remaining > 1000 ? 1 : "¡YA!";
    if (value === state.countdownValue) return;
    state.countdownValue = value;
    elements.countdown.textContent = value;
    elements.countdown.className = `countdown active${value === "¡YA!" ? " go" : ""}`;
    void elements.countdown.offsetWidth;
    elements.countdown.classList.add("active");
    audio.sfx(value === "¡YA!" ? "go" : "count");
  }

  function formatTime(milliseconds) {
    const value = Math.max(0, Math.floor(milliseconds));
    const minutes = Math.floor(value / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const millis = value % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function ordinal(value) {
    return `${value}º`;
  }

  function renderResults(results) {
    state.raceFinished = true;
    elements.hud.classList.remove("active");
    elements.mobileControls.style.display = "none";
    setPanel("resultsPanel");
    const me = results.find((player) => player.id === state.myId);
    elements.resultTitle.innerHTML = me?.finishPlace === 1 ? "SOS EL<br><em>CAMPEÓN.</em>" : "CARRERA<br><em>TERMINADA.</em>";
    elements.podium.replaceChildren();
    const podiumClasses = ["first", "second", "third"];
    for (let index = 0; index < Math.min(3, results.length); index += 1) {
      const player = results[index];
      const slot = document.createElement("div");
      slot.className = `podium-slot ${podiumClasses[index]}`;
      slot.style.setProperty("--car-color", player.color);
      const place = document.createElement("strong");
      place.textContent = ordinal(index + 1);
      const name = document.createElement("b");
      name.textContent = player.name;
      const time = document.createElement("small");
      time.textContent = formatTime(player.finishTime);
      slot.append(place, name, time);
      elements.podium.append(slot);
    }

    elements.resultsList.replaceChildren();
    results.slice(3).forEach((player, index) => {
      const row = document.createElement("div");
      row.className = "result-row";
      row.style.setProperty("--car-color", player.color);
      const place = document.createElement("b");
      place.textContent = ordinal(index + 4);
      const color = document.createElement("i");
      const name = document.createElement("span");
      name.textContent = player.name;
      const time = document.createElement("time");
      time.textContent = formatTime(player.finishTime);
      row.append(place, color, name, time);
      elements.resultsList.append(row);
    });
    elements.restartButton.style.display = state.room?.hostId === state.myId ? "flex" : "none";
    burstConfetti();
  }

  function sendInput(force = false) {
    if (!state.joined || state.room?.state !== "racing") return;
    state.inputSequence += 1;
    socket.emit("input", { ...state.inputs, sequence: state.inputSequence, force });
  }

  function setInput(control, pressed) {
    if (!(control in state.inputs) || state.inputs[control] === pressed) return;
    state.inputs[control] = pressed;
    sendInput(true);
  }

  function resetInputs() {
    for (const key of Object.keys(state.inputs)) state.inputs[key] = false;
    document.querySelectorAll("[data-control]").forEach((button) => button.classList.remove("pressed"));
    sendInput(true);
  }

  const keyMap = {
    ArrowUp: "up", KeyW: "up",
    ArrowDown: "down", KeyS: "down",
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    Space: "handbrake"
  };

  window.addEventListener("keydown", (event) => {
    const control = keyMap[event.code];
    if (!control || document.activeElement?.matches("input")) return;
    event.preventDefault();
    audio.unlock();
    setInput(control, true);
  });
  window.addEventListener("keyup", (event) => {
    const control = keyMap[event.code];
    if (!control) return;
    event.preventDefault();
    setInput(control, false);
  });
  window.addEventListener("blur", resetInputs);

  document.querySelectorAll("[data-control]").forEach((button) => {
    const control = button.dataset.control;
    const press = (event) => {
      event.preventDefault();
      audio.unlock();
      button.setPointerCapture?.(event.pointerId);
      button.classList.add("pressed");
      setInput(control, true);
    };
    const release = (event) => {
      event.preventDefault();
      button.classList.remove("pressed");
      setInput(control, false);
    };
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  });

  setInterval(() => sendInput(false), 100);

  function initializeColors() {
    COLORS.forEach((color, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `color-swatch${index === 0 ? " selected" : ""}`;
      const marker = document.createElement("span");
      marker.className = "swatch-check";
      marker.textContent = "✓";
      button.append(marker);
      button.style.setProperty("--car-color", color);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", index === 0 ? "true" : "false");
      button.setAttribute("aria-label", `Color ${index + 1}`);
      button.addEventListener("click", () => {
        state.selectedColor = color;
        document.querySelectorAll(".color-swatch").forEach((swatch) => {
          const selected = swatch === button;
          swatch.classList.toggle("selected", selected);
          swatch.setAttribute("aria-checked", String(selected));
        });
        audio.unlock();
        audio.tone(260 + index * 45, 0.06, 0.04, "square");
      });
      elements.colorPicker.append(button);
    });
  }

  elements.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    audio.unlock();
    elements.joinError.textContent = "";
    elements.joinButton.disabled = true;
    const name = elements.nameInput.value.trim();
    const room = elements.roomInput.value.trim();
    socket.emit("join", { name, room, color: state.selectedColor }, (response) => {
      elements.joinButton.disabled = false;
      if (!response?.ok) {
        elements.joinError.textContent = response?.error || "No pudimos entrar a la sala.";
        return;
      }
      state.joined = true;
      state.myId = response.id;
      measureRtt();
      state.room = response.room;
      localStorage.setItem("grand-prix-name", name);
      const url = new URL(location.href);
      url.searchParams.set("room", response.room.code);
      history.replaceState(null, "", url);
      renderLobby();
      setPanel("lobbyPanel");
    });
  });

  elements.readyButton.addEventListener("click", () => {
    audio.unlock();
    const me = state.room?.players.find((player) => player.id === state.myId);
    socket.emit("ready", !me?.ready);
    audio.tone(me?.ready ? 210 : 480, 0.07, 0.05, "square");
  });

  elements.startButton.addEventListener("click", () => {
    audio.unlock();
    socket.emit("start", (response) => {
      if (!response?.ok) showToast(response?.error || "Todavía no se puede largar.");
    });
  });

  elements.shareButton.addEventListener("click", async () => {
    const url = new URL(location.href);
    url.searchParams.set("room", state.room?.code || "oficina");
    const text = `Sumate al Grand Prix: ${url}`;
    try {
      if (navigator.share) await navigator.share({ title: "Software Grand Prix", text, url: String(url) });
      else await navigator.clipboard.writeText(text);
      showToast("Invitación copiada. ¡Que se sumen!");
    } catch (error) {
      if (error?.name !== "AbortError") showToast(`Compartí este link: ${url}`);
    }
  });

  elements.restartButton.addEventListener("click", () => socket.emit("restart"));
  elements.exitButton.addEventListener("click", () => location.assign("/"));
  elements.audioButton.addEventListener("click", () => {
    const muted = audio.toggle();
    elements.audioButton.classList.toggle("muted", muted);
    elements.audioButton.textContent = muted ? "×" : "♫";
    showToast(muted ? "Audio silenciado" : "Audio activado");
  });
  elements.fullscreenButton.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { showToast("Pantalla completa no disponible"); }
  });

  socket.on("connect", () => setConnected(true));
  socket.on("disconnect", () => {
    setConnected(false);
    if (state.joined) showToast("Se perdió la conexión. Intentando volver…");
  });

  socket.on("room", (room) => {
    state.room = room;
    if (!state.joined) return;
    if (room.state === "lobby") {
      state.raceFinished = false;
      state.snapshots.clear();
      state.visuals.clear();
      state.powerUps = [];
      resetPrediction();
      state.skidMarks = [];
      state.confetti = [];
      elements.hud.classList.remove("active");
      elements.mobileControls.style.removeProperty("display");
      renderLobby();
      setPanel("lobbyPanel");
    } else if (room.state === "countdown") {
      state.raceStartAt = room.raceStartedAt;
      setPanel(null);
      elements.hud.classList.add("active");
    }
  });

  socket.on("countdown", ({ endsAt }) => {
    if (state.room) {
      state.room.state = "countdown";
      state.room.countdownEndsAt = endsAt;
      state.raceStartAt = endsAt;
    }
    state.countdownValue = null;
    setPanel(null);
    elements.hud.classList.add("active");
  });

  socket.on("race:start", ({ startedAt }) => {
    if (state.room) state.room.state = "racing";
    state.raceStartAt = startedAt;
    state.countdownValue = null;
    elements.countdown.className = "countdown";
    announce("3 VUELTAS · TODO VALE");
  });

  socket.on("snapshot", (snapshot) => {
    // El primer snapshot fija el reloj; después se ajusta suave para no saltar.
    const offsetSample = snapshot.serverTime - Date.now();
    state.serverOffset = state.clockReady ? state.serverOffset * 0.9 + offsetSample * 0.1 : offsetSample;
    state.clockReady = true;
    state.raceStartAt = snapshot.raceStartedAt || state.raceStartAt;
    if (state.room) state.room.state = snapshot.state;
    state.powerUps = snapshot.powerUps || [];
    state.snapshots = new Map(snapshot.players.map((player) => [player.id, player]));

    state.snapshotBuffer.push({
      serverTime: snapshot.serverTime,
      players: new Map(snapshot.players.map((player) => [player.id, { x: player.x, y: player.y, angle: player.angle }]))
    });
    // A 20 snapshots por segundo, 20 entradas son un segundo de margen para interpolar.
    if (state.snapshotBuffer.length > 20) state.snapshotBuffer.shift();

    const mine = state.snapshots.get(state.myId);
    if (mine) reconcile(snapshot, mine);
    renderHud(snapshot);
  });

  socket.on("lap", ({ lap, total }) => {
    announce(`VUELTA ${lap} / ${total}`);
    audio.sfx("lap");
  });

  socket.on("powerup", ({ type, playerName, duration }) => {
    const seconds = Math.round(duration / 1000);
    if (type === "boost") {
      announce("⭐ " + playerName + " ACTIVÓ TURBO — " + seconds + " SEGUNDOS", 3200);
    } else {
      announce("⚡ " + playerName + " LANZÓ UN RAYO — ¡TODOS LENTOS " + seconds + " SEGUNDOS!", 3600);
    }
    audio.sfx(type);
  });

  socket.on("player:finished", ({ id, name, place }) => {
    if (id === state.myId) {
      announce(`¡LLEGASTE ${ordinal(place)}!`, 2600);
      burstConfetti();
    } else {
      announce(`${name} CRUZÓ LA META`, 1500);
    }
  });

  socket.on("race:finished", ({ results }) => {
    resetInputs();
    audio.sfx("finish");
    window.setTimeout(() => renderResults(results), 750);
  });

  socket.on("sfx", ({ type, strength }) => audio.sfx(type, strength));

  const params = new URLSearchParams(location.search);
  elements.roomInput.value = params.get("room")?.slice(0, 18) || "oficina";
  elements.nameInput.value = localStorage.getItem("grand-prix-name") || "";
  initializeColors();
  resize();
  window.addEventListener("resize", resize);
  window.setInterval(measureRtt, 1000);
  requestAnimationFrame(render);
})();
