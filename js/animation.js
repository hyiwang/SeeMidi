function buildKeyboard() {
  const keys = [];
  let whiteIndex = 0;

  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi += 1) {
    const noteClass = midi % 12;
    const isWhite = WHITE_PATTERN.has(noteClass);
    const entry = {
      midi,
      isWhite,
      whiteIndex: isWhite ? whiteIndex : whiteIndex - 1,
      x: 0,
      width: 0,
    };

    keys.push(entry);

    if (isWhite) {
      whiteIndex += 1;
    }
  }

  return keys;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function scheduleCanvasResize() {
  cancelAnimationFrame(resizeObserverFrame);
  resizeObserverFrame = requestAnimationFrame(() => {
    resizeObserverFrame = 0;
    resizeCanvas();
    render();
  });
}

function getVelocityNoteColor(velocity, midi = 60, currentTime = getDisplaySongTime()) {
  const base = hexToHsl(state.noteColor);
  const colorShift = hasVisualEffect("colorShift")
    ? Math.sin(currentTime * 1.15 + midi * 0.17) * 17 + Math.sin(currentTime * 0.42 + midi * 0.09) * 7
    : 0;
  const hue = (base.h + colorShift) % 360;
  const saturation = clamp(base.s, 30, 96);
  const lightness = clamp(base.l, 24, 96);

  return {
    hue,
    saturation,
    topLightness: clamp(lightness + 8, 0, 92),
    bottomLightness: clamp(lightness - 7, 12, 86),
  };
}

function normalizeHexColor(color) {
  if (!/^#[0-9a-fA-F]{6}$/.test(color || "")) {
    return "";
  }
  return color.toLowerCase();
}

function hexToHsl(hex) {
  const normalized = normalizeHexColor(hex) || "#2de1b4";
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h *= 60;
  }

  return { h, s: s * 100, l: l * 100 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderAt(targetCtx, width, height, currentTime, activeVelocities) {
  const previousCtx = ctx;
  const previousActiveVelocities = state.activeVelocities;
  const previousKeyboardLayout = keyboard.map((key) => ({
    key,
    x: key.x,
    width: key.width,
  }));

  ctx = targetCtx;
  state.activeVelocities = activeVelocities;

  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawBackground(width, height);

    const pianoHeight = getPianoHeight(width, height);
    const waterfallHeight = height - pianoHeight;
    const pixelsPerSecond = Math.max(110, waterfallHeight / 4.2);

    layoutKeyboard(width);
    if (state.showGrid) {
      drawGrid(width, waterfallHeight, pixelsPerSecond);
    }
    drawNotes(waterfallHeight, pianoHeight, pixelsPerSecond, currentTime);
    drawKeyboard(waterfallHeight, pianoHeight);
    drawTimeCursor(width, waterfallHeight);
  } finally {
    for (const item of previousKeyboardLayout) {
      item.key.x = item.x;
      item.key.width = item.width;
    }
    state.activeVelocities = previousActiveVelocities;
    ctx = previousCtx;
  }
}

function getActiveVelocitiesAt(currentTime) {
  const activeVelocities = new Map();

  for (const note of state.song.notes) {
    if (note.start <= currentTime && note.end >= currentTime) {
      const velocity = note.velocity / 127;
      const previous = activeVelocities.get(note.midi) || 0;
      activeVelocities.set(note.midi, Math.max(previous, velocity));
    }
  }

  return activeVelocities;
}

function animate() {
  render();
  syncPlaybackProgress();
  state.rafId = requestAnimationFrame(animate);
}

function render() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  drawBackground(width, height);

  if (!state.song) {
    drawEmptyState(width, height);
    return;
  }

  const pianoHeight = getPianoHeight(width, height);
  const waterfallHeight = height - pianoHeight;
  const currentTime = state.playing ? getCurrentSongTime() : state.pauseOffset;
  const pixelsPerSecond = Math.max(110, waterfallHeight / 4.2);

  layoutKeyboard(width);
  updateActiveVelocities(currentTime);
  if (state.showGrid) {
    drawGrid(width, waterfallHeight, pixelsPerSecond);
  }
  drawNotes(waterfallHeight, pianoHeight, pixelsPerSecond, currentTime);
  drawKeyboard(waterfallHeight, pianoHeight);
  drawTimeCursor(width, waterfallHeight);
}

function drawBackground(width, height) {
  if (state.backgroundBase === "black") {
    ctx.fillStyle = "#000000";
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#07111f");
    gradient.addColorStop(1, "#153051");
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);

  drawBackgroundImage(width, height);

  if (state.backgroundBase !== "black") {
    const glow = ctx.createRadialGradient(width * 0.5, height * 0.18, 20, width * 0.5, height * 0.18, width * 0.55);
    glow.addColorStop(0, "rgba(77, 208, 225, 0.16)");
    glow.addColorStop(1, "rgba(77, 208, 225, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }
}

function getPianoHeight(width, height) {
  // Tie keyboard height to canvas width so the piano keeps its shape on narrow phones.
  const idealHeight = width * 0.1125;
  return Math.max(44, Math.min(190, idealHeight, height * 0.24));
}

function drawBackgroundImage(width, height) {
  if (!state.backgroundImage) {
    return;
  }

  const opacity = getBackgroundOpacity();
  if (opacity <= 0) {
    return;
  }

  const image = state.backgroundImage;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(image, x, y, drawWidth, drawHeight);
  ctx.restore();

  // Keep notes and the grid readable on bright images.
  ctx.fillStyle = `rgba(7, 17, 31, ${0.08 + opacity * 0.12})`;
  ctx.fillRect(0, 0, width, height);
}

function drawEmptyState(width, height) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "600 28px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(t("emptyTitle"), width / 2, height / 2 - 10);
  ctx.fillStyle = "rgba(173, 194, 226, 0.9)";
  ctx.font = "18px Segoe UI";
  ctx.fillText(t("emptySubtitle"), width / 2, height / 2 + 28);
}

function drawGrid(width, waterfallHeight, pixelsPerSecond) {
  ctx.save();
  ctx.strokeStyle = state.backgroundBase === "black"
    ? "rgba(255, 255, 255, 0.16)"
    : "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (const key of keyboard) {
    if (!key.isWhite) {
      continue;
    }

    ctx.moveTo(key.x, 0);
    ctx.lineTo(key.x, waterfallHeight);
  }

  const beatSpacing = pixelsPerSecond;
  for (let y = waterfallHeight; y > 0; y -= beatSpacing) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }

  ctx.stroke();
  ctx.restore();
}

function drawNotes(waterfallHeight, pianoHeight, pixelsPerSecond, currentTime) {
  const minVisibleTime = currentTime - 0.25;
  const maxVisibleTime = currentTime + waterfallHeight / pixelsPerSecond + 0.4;

  for (const note of state.song.notes) {
    if (note.end < minVisibleTime || note.start > maxVisibleTime) {
      continue;
    }

    const key = keyboard[note.midi - MIDI_MIN];
    const noteLane = getNoteLane(key);
    const velocity = note.velocity / 127;
    const noteTop = waterfallHeight - (note.end - currentTime) * pixelsPerSecond;
    const noteBottom = waterfallHeight - (note.start - currentTime) * pixelsPerSecond;
    const y = Math.max(0, noteTop);
    const h = Math.min(waterfallHeight, noteBottom) - y;

    if (h <= 0) {
      continue;
    }

    const color = getVelocityNoteColor(velocity, note.midi, currentTime);
    if (hasVisualEffect("trail")) {
      drawNoteTrail(noteLane, y, h, waterfallHeight, velocity, color);
    }

    const fill = ctx.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, `hsl(${color.hue}, ${color.saturation}%, ${color.topLightness}%)`);
    fill.addColorStop(1, `hsl(${color.hue + 8}, ${color.saturation}%, ${color.bottomLightness}%)`);

    if (hasVisualEffect("glow")) {
      ctx.save();
      ctx.shadowColor = `hsla(${color.hue}, ${color.saturation}%, ${color.topLightness}%, ${0.42 + velocity * 0.28})`;
      ctx.shadowBlur = 10 + velocity * 18;
    }

    const noteWidth = Math.max(2, noteLane.width - 2);
    const noteRadius = Math.min(8, noteLane.width / 3, h / 2, noteWidth / 2);

    ctx.fillStyle = fill;
    roundRect(ctx, noteLane.x + 1, y, noteWidth, h, noteRadius);
    ctx.fill();

    if (hasVisualEffect("glow")) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `hsla(${color.hue}, ${color.saturation}%, ${clamp(color.topLightness + 10, 0, 96)}%, ${0.38 + velocity * 0.32})`;
      ctx.lineWidth = Math.min(Math.max(1, Math.min(3, noteLane.width * 0.12)), Math.max(1, h * 0.45));
      ctx.stroke();
      ctx.restore();
    }

    if (noteBottom >= waterfallHeight && note.start <= currentTime && currentTime <= note.end) {
      ctx.fillStyle = `rgba(255,255,255,${0.12 + velocity * 0.25})`;
      ctx.fillRect(noteLane.x + 1, waterfallHeight - 4, Math.max(2, noteLane.width - 2), 4);
    }
  }

  if (hasVisualEffect("fog")) {
    drawImpactFogs(waterfallHeight, currentTime);
  }
  if (hasVisualEffect("stream")) {
    drawImpactStreams(waterfallHeight, currentTime);
  }
}

function hasVisualEffect(effect) {
  return Array.isArray(state.visualEffect)
    ? state.visualEffect.includes(effect)
    : state.visualEffect === effect;
}

function drawNoteTrail(noteLane, y, h, waterfallHeight, velocity, color) {
  const laneWidth = Math.max(2, noteLane.width - 2);
  const x = noteLane.x + 1;
  const centerX = x + laneWidth / 2;
  const noteRadius = Math.min(8, noteLane.width / 3);
  const attachOverlap = Math.min(Math.max(4, noteRadius + 2), Math.max(4, h));
  const trailLength = clamp(42 + velocity * 120, 36, Math.min(180, waterfallHeight * 0.34));
  const trailTop = Math.max(0, y - trailLength);
  const trailJoin = y;
  const trailBottom = Math.min(waterfallHeight, y + attachOverlap);

  if (trailJoin <= trailTop) {
    return;
  }

  const visibleTrailLength = trailJoin - trailTop;
  const coreWidth = clamp(laneWidth * 0.42, 2, 9);
  const glowWidth = clamp(laneWidth * 0.9, 3, 18);
  const alpha = 0.14 + velocity * 0.28;
  const gradient = ctx.createLinearGradient(0, trailTop, 0, trailJoin);
  gradient.addColorStop(0, `hsla(${color.hue}, ${color.saturation}%, ${color.topLightness}%, 0)`);
  gradient.addColorStop(0.34, `hsla(${color.hue}, ${color.saturation}%, ${color.topLightness}%, 0)`);
  gradient.addColorStop(0.74, `hsla(${color.hue}, ${color.saturation}%, ${color.topLightness}%, ${alpha * 0.22})`);
  gradient.addColorStop(0.9, `hsla(${color.hue}, ${color.saturation}%, ${color.topLightness}%, ${alpha * 0.58})`);
  gradient.addColorStop(1, `hsla(${color.hue + 8}, ${color.saturation}%, ${color.bottomLightness}%, ${alpha})`);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = gradient;
  roundRect(ctx, x, trailTop, laneWidth, trailBottom - trailTop, glowWidth / 2, glowWidth / 2, 0, 0);
  ctx.fill();

  ctx.strokeStyle = gradient;
  ctx.lineCap = "round";
  ctx.lineWidth = coreWidth;
  ctx.beginPath();
  ctx.moveTo(centerX, trailTop);
  ctx.bezierCurveTo(
    centerX - laneWidth * 0.16,
    trailTop + visibleTrailLength * 0.35,
    centerX + laneWidth * 0.18,
    trailJoin - visibleTrailLength * 0.28,
    centerX,
    trailJoin,
  );
  ctx.stroke();

  const connector = ctx.createLinearGradient(0, y, 0, trailBottom);
  connector.addColorStop(0, `hsla(${color.hue + 8}, ${color.saturation}%, ${color.bottomLightness}%, ${alpha * 0.9})`);
  connector.addColorStop(1, `hsla(${color.hue + 8}, ${color.saturation}%, ${color.bottomLightness}%, ${alpha * 0.45})`);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = connector;
  ctx.fillRect(x, y, laneWidth, Math.max(1, trailBottom - y));

  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.34;
  ctx.lineWidth = Math.max(1, coreWidth * 0.45);
  ctx.beginPath();
  ctx.moveTo(centerX - laneWidth * 0.22, trailTop + visibleTrailLength * 0.18);
  ctx.quadraticCurveTo(centerX - laneWidth * 0.38, trailTop + visibleTrailLength * 0.64, centerX - laneWidth * 0.12, trailJoin);
  ctx.moveTo(centerX + laneWidth * 0.22, trailTop + visibleTrailLength * 0.14);
  ctx.quadraticCurveTo(centerX + laneWidth * 0.42, trailTop + visibleTrailLength * 0.58, centerX + laneWidth * 0.1, trailJoin);
  ctx.stroke();
  ctx.restore();
}

function drawImpactFogs(waterfallHeight, currentTime) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const fogQuality = getFogQualitySettings();

  for (const note of state.song.notes) {
    const key = keyboard[note.midi - MIDI_MIN];
    const noteLane = getNoteLane(key);
    const velocity = note.velocity / 127;
    const color = getVelocityNoteColor(velocity, note.midi, currentTime);
    const laneWidth = Math.max(2, noteLane.width - 2);
    const originX = noteLane.x + 1 + laneWidth / 2;
    const originY = waterfallHeight + 8;
    const noteDuration = Math.max(0, note.end - note.start);
    const windSeed = Math.sin((note.midi * 17.71 + note.start * 83.33) * 12.9898) * 43758.5453;
    const windRandom = windSeed - Math.floor(windSeed);
    const windDirection = (windRandom - 0.5) * laneWidth * 1.65;
    const releaseInterval = fogQuality.releaseInterval;
    const releaseCount = 1 + Math.max(0, Math.floor(Math.max(0, noteDuration - 0.45) / releaseInterval));

    for (let releaseIndex = 0; releaseIndex < releaseCount; releaseIndex += 1) {
      const releaseTime = note.start + releaseIndex * releaseInterval;
      if (releaseTime > note.end) {
        continue;
      }
      const releaseAge = currentTime - releaseTime;
      const releaseSeed = Math.sin((note.midi * 31.37 + releaseTime * 113.9 + releaseIndex * 7.91) * 12.9898) * 43758.5453;
      const releaseRandom = releaseSeed - Math.floor(releaseSeed);
      const isImpact = releaseIndex === 0;
      const particleCount = isImpact
        ? Math.max(fogQuality.impactMin, Math.min(fogQuality.impactMax, Math.round((12 + velocity * 14) * fogQuality.particleFactor)))
        : Math.max(fogQuality.sustainMin, Math.min(fogQuality.sustainMax, Math.round((3 + velocity * 5) * fogQuality.particleFactor)));

      if (releaseAge >= 0) {
        const veilDuration = isImpact ? 1.65 : 1.15;
        const veilLife = releaseAge / veilDuration;
        if (veilLife >= 0 && veilLife <= 1) {
          const veilSpread = easeOutCubic(veilLife);
          const veilX = originX + windDirection * veilSpread * 0.34 + (releaseRandom - 0.5) * laneWidth * 0.8;
          const veilY = originY - (isImpact ? 22 : 12) * veilSpread - velocity * 18 * veilSpread;
          const veilRadius = laneWidth * (1.2 + velocity * 0.7) + veilSpread * (52 + velocity * 26);
          const veilAlpha = (0.02 + velocity * 0.035) * Math.sin(Math.PI * veilLife) * (isImpact ? 1 : 0.52);
          if (veilAlpha > 0.002) {
            drawSoftFogPuff(veilX, veilY, veilRadius, veilAlpha, color, releaseSeed + 101.7, fogQuality.veilLobes);
          }
        }
      }

      for (let index = 0; index < particleCount; index += 1) {
        const seed = Math.sin((note.midi * 41.17 + releaseTime * 127.3 + index * 19.91 + releaseIndex * 13.7) * 12.9898) * 43758.5453;
        const randomA = seed - Math.floor(seed);
        const randomB = Math.sin(seed * 1.37) * 0.5 + 0.5;
        const randomC = Math.sin(seed * 2.11) * 0.5 + 0.5;
        const randomD = Math.sin(seed * 2.87) * 0.5 + 0.5;
        const particleDuration = 0.9 + randomD * 1.9 + (isImpact ? 0.25 : 0);
        if (releaseAge < 0 || releaseAge > particleDuration) {
          continue;
        }

        const life = releaseAge / particleDuration;
        const typeRoll = (randomA + releaseRandom * 0.37) % 1;
        const spread = easeOutCubic(life);
        let px = originX + (randomA - 0.5) * laneWidth * 0.7;
        let py = originY + (randomB - 0.5) * laneWidth * 0.18;
        if (typeRoll < 0.34) {
          px += (randomA - 0.5) * laneWidth * (2.4 + spread * 4.2) + windDirection * spread * 0.24;
          py += (randomB - 0.5) * laneWidth * 0.8 - spread * laneWidth * (0.25 + randomC * 0.5);
        } else if (typeRoll < 0.72) {
          px += windDirection * spread * (0.35 + randomC * 0.55) + Math.sin((life * 1.4 + randomB) * Math.PI) * laneWidth * (0.25 + randomD * 0.35);
          py -= (42 + randomB * 122 + velocity * 52) * spread;
        } else {
          const side = randomA < 0.5 ? -1 : 1;
          px += side * laneWidth * (1.2 + randomC * 4.8) * spread + windDirection * spread * 0.42;
          py -= (14 + randomB * 52) * spread;
        }
        const radius = clamp(laneWidth * (0.28 + randomC * 0.78) + spread * (30 + randomD * 36), 7, 68);
        const alpha = (0.045 + velocity * 0.095) * Math.sin(Math.PI * life) * (0.72 + randomC * 0.34) * (isImpact ? 1 : 0.56);
        if (alpha <= 0.002) {
          continue;
        }
        drawSoftFogPuff(px, py, radius, alpha, color, seed, fogQuality.particleLobes);
      }
    }
  }

  ctx.restore();
}

function getFogQualitySettings() {
  if (state.fogQuality === "low") {
    return {
      particleFactor: 0.42,
      impactMin: 5,
      impactMax: 11,
      sustainMin: 1,
      sustainMax: 3,
      releaseInterval: 0.58,
      veilLobes: 3,
      particleLobes: 2,
    };
  }
  if (state.fogQuality === "medium") {
    return {
      particleFactor: 0.68,
      impactMin: 8,
      impactMax: 17,
      sustainMin: 2,
      sustainMax: 5,
      releaseInterval: 0.46,
      veilLobes: 5,
      particleLobes: 3,
    };
  }
  return {
    particleFactor: 1,
    impactMin: 12,
    impactMax: 26,
    sustainMin: 3,
    sustainMax: 8,
    releaseInterval: 0.38,
    veilLobes: 8,
    particleLobes: 5,
  };
}

function drawSoftFogPuff(px, py, radius, alpha, color, seed, lobeCount = 5) {
  for (let lobe = 0; lobe < lobeCount; lobe += 1) {
    const lobeSeed = Math.sin(seed * (1.17 + lobe * 0.37)) * 43758.5453;
    const randomA = lobeSeed - Math.floor(lobeSeed);
    const randomB = Math.sin(lobeSeed * 1.91) * 0.5 + 0.5;
    const randomC = Math.sin(lobeSeed * 2.47) * 0.5 + 0.5;
    const angle = randomA * Math.PI * 2;
    const offset = radius * (lobe === 0 ? 0 : 0.2 + randomB * 0.48);
    const cx = px + Math.cos(angle) * offset;
    const cy = py + Math.sin(angle) * offset * 0.72;
    const rx = radius * (0.58 + randomB * 0.62) * (lobe === 0 ? 1.12 : 0.9);
    const ry = radius * (0.36 + randomC * 0.68) * (lobe === 0 ? 1.04 : 0.82);
    const rotation = angle + randomC * Math.PI;
    const lobeAlpha = alpha * (lobe === 0 ? 0.58 : 0.26 + randomC * 0.22);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
    const fog = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry));
    fog.addColorStop(0, `hsla(${color.hue}, ${Math.max(18, color.saturation * 0.48)}%, ${clamp(color.topLightness + 18, 0, 96)}%, ${lobeAlpha})`);
    fog.addColorStop(0.48, `hsla(${color.hue}, ${Math.max(16, color.saturation * 0.42)}%, ${clamp(color.topLightness + 8, 0, 92)}%, ${lobeAlpha * 0.32})`);
    fog.addColorStop(1, `hsla(${color.hue}, ${Math.max(12, color.saturation * 0.34)}%, ${color.bottomLightness}%, 0)`);
    ctx.fillStyle = fog;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawImpactStreams(waterfallHeight, currentTime) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const note of state.song.notes) {
    const noteDuration = Math.max(0, note.end - note.start);
    if (noteDuration < 0.18) {
      continue;
    }

    const streamInterval = 0.48;
    const streamDuration = 1.15;
    const streamCount = Math.max(1, Math.min(10, Math.floor((noteDuration - 0.18) / streamInterval) + 1));

    const key = keyboard[note.midi - MIDI_MIN];
    const noteLane = getNoteLane(key);
    const velocity = note.velocity / 127;
    const color = getVelocityNoteColor(velocity, note.midi, currentTime);
    const laneWidth = Math.max(2, noteLane.width - 2);
    const originX = noteLane.x + 1 + laneWidth / 2;
    const originY = waterfallHeight + 3;

    for (let index = 0; index < streamCount; index += 1) {
      const emitOffset = Math.min(noteDuration * 0.86, index * streamInterval);
      const emitTime = note.start + emitOffset;
      const age = currentTime - emitTime;
      if (age < 0 || age > streamDuration) {
        continue;
      }

      const life = age / streamDuration;
      const fade = Math.sin(Math.PI * life);
      const seed = Math.sin((note.midi * 53.11 + emitTime * 97.7 + index * 23.31) * 12.9898) * 43758.5453;
      const randomA = seed - Math.floor(seed);
      const randomB = Math.sin(seed * 1.91) * 0.5 + 0.5;
      const randomC = Math.sin(seed * 2.73) * 0.5 + 0.5;
      const randomD = Math.sin(seed * 3.47) * 0.5 + 0.5;
      const randomE = Math.sin(seed * 4.19) * 0.5 + 0.5;
      const side = randomA < 0.5 ? -1 : 1;
      const baseOffset = (randomB - 0.5) * laneWidth * 1.65;
      const alpha = Math.min(0.96, (0.42 + velocity * 0.58) * fade * (0.88 + randomC * 0.34));
      const lineWidth = Math.max(1.1, Math.min(2.8, laneWidth * (0.055 + velocity * 0.045 + randomD * 0.038)));
      const points = [];
      const steps = 34;
      const trailSpan = 0.34 + randomE * 0.18;
      const travelDistance = 150 + randomC * 220 + velocity * 116;
      const curl = side * laneWidth * (0.42 + randomD * 1.05);
      const flutter = laneWidth * (0.1 + randomB * 0.34);
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const progress = clamp(life - trailSpan * (1 - t), 0, 1);
        const progressDrift = progress * progress * (3 - 2 * progress);
        const drift = side * laneWidth * (0.45 + randomC * 1.35) * progressDrift;
        const sway = Math.sin((progress * (0.55 + randomC * 0.55) + randomD) * Math.PI) * laneWidth * (0.16 + randomB * 0.42);
        const pathCurl = Math.sin((progress * (1.35 + randomE * 0.8) + randomA) * Math.PI * 2) * curl * (0.22 + progress * 0.62);
        const pathFlutter = Math.sin((progress * (2.15 + randomC * 1.2) + randomD) * Math.PI * 2) * flutter * (0.25 + progress * 0.75);
        points.push({
          x: originX + baseOffset + drift + sway + pathCurl + pathFlutter,
          y: originY - travelDistance * progress,
        });
      }
      const gradient = ctx.createLinearGradient(points[0].x, points[0].y, points[points.length - 1].x, points[points.length - 1].y);
      gradient.addColorStop(0, `hsla(${color.hue + 8}, ${color.saturation}%, ${color.bottomLightness}%, 0)`);
      gradient.addColorStop(0.18, `hsla(${color.hue + 8}, ${color.saturation}%, ${color.bottomLightness}%, ${alpha * 0.82})`);
      gradient.addColorStop(0.72, `hsla(${color.hue}, ${color.saturation}%, ${clamp(color.topLightness + 26, 0, 98)}%, ${alpha})`);
      gradient.addColorStop(1, `hsla(${color.hue}, ${color.saturation}%, ${clamp(color.topLightness + 32, 0, 99)}%, 0)`);

      ctx.strokeStyle = gradient;
      ctx.lineCap = "butt";
      for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
        const t = pointIndex / Math.max(1, points.length - 2);
        const timeFade = clamp((1.08 - life - t * 0.42) / 0.36, 0, 1);
        ctx.globalAlpha = timeFade;
        ctx.lineWidth = lineWidth * (0.12 + Math.pow(Math.sin(Math.PI * t), 2.1) * 2.15);
        ctx.beginPath();
        ctx.moveTo(points[pointIndex].x, points[pointIndex].y);
        ctx.lineTo(points[pointIndex + 1].x, points[pointIndex + 1].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineCap = "round";

      if (life < 0.18) {
        const baseGlow = ctx.createRadialGradient(originX, waterfallHeight, 0, originX, waterfallHeight, laneWidth * (0.8 + velocity * 0.5));
        baseGlow.addColorStop(0, `hsla(${color.hue}, ${color.saturation}%, ${clamp(color.topLightness + 20, 0, 98)}%, ${(1 - life / 0.18) * (0.08 + velocity * 0.1)})`);
        baseGlow.addColorStop(1, `hsla(${color.hue}, ${color.saturation}%, ${color.bottomLightness}%, 0)`);
        ctx.fillStyle = baseGlow;
        ctx.beginPath();
        ctx.arc(originX, waterfallHeight, laneWidth * (0.8 + velocity * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - clamp(value, 0, 1), 3);
}

function drawKeyboard(waterfallHeight, pianoHeight) {
  ctx.save();
  ctx.translate(0, waterfallHeight);

  for (const key of keyboard) {
    if (!key.isWhite) {
      continue;
    }

    const activeVelocity = state.activeVelocities.get(key.midi) || 0;
    const keyColor = activeVelocity ? getVelocityNoteColor(activeVelocity, key.midi) : null;
    ctx.fillStyle = keyColor
      ? `hsla(${keyColor.hue}, ${keyColor.saturation}%, ${clamp(keyColor.topLightness + 6, 0, 96)}%, 1)`
      : "#f9fbff";
    ctx.strokeStyle = "rgba(13, 26, 45, 0.55)";
    ctx.lineWidth = 1;
    ctx.fillRect(key.x, 0, key.width, pianoHeight);
    ctx.strokeRect(key.x, 0, key.width, pianoHeight);
  }

  for (const key of keyboard) {
    if (key.isWhite) {
      continue;
    }

    const noteLane = getNoteLane(key);
    const blackWidth = noteLane.width;
    const blackHeight = pianoHeight * 0.63;
    const x = noteLane.x;
    const activeVelocity = state.activeVelocities.get(key.midi) || 0;
    const blackGradient = ctx.createLinearGradient(0, 0, 0, blackHeight);
    if (activeVelocity) {
      const keyColor = getVelocityNoteColor(activeVelocity, key.midi);
      blackGradient.addColorStop(0, `hsla(${keyColor.hue}, ${keyColor.saturation}%, ${clamp(keyColor.bottomLightness + 6, 16, 78)}%, 1)`);
      blackGradient.addColorStop(1, `hsla(${keyColor.hue + 8}, ${keyColor.saturation}%, ${clamp(keyColor.bottomLightness - 24, 8, 42)}%, 1)`);
    } else {
      blackGradient.addColorStop(0, "#314052");
      blackGradient.addColorStop(1, "#08111f");
    }

    ctx.fillStyle = blackGradient;
    roundRect(ctx, x, 0, blackWidth, blackHeight, 0, 0, 7, 7);
    ctx.fill();
  }

  ctx.restore();
}

function drawTimeCursor(width, waterfallHeight) {
  ctx.save();
  ctx.strokeStyle = getTimeCursorColor();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, waterfallHeight);
  ctx.lineTo(width, waterfallHeight);
  ctx.stroke();
  ctx.restore();
}

function getTimeCursorColor() {
  const base = hexToHsl(state.noteColor);
  const hue = base.h;
  const saturation = clamp(base.s, 32, 96);
  const lightness = clamp(base.l + 24, 62, 96);
  return `hsla(${hue}, ${saturation}%, ${lightness}%, 0.86)`;
}

function layoutKeyboard(width) {
  const whiteKeys = keyboard.filter((key) => key.isWhite);
  const whiteWidth = width / whiteKeys.length;

  for (const key of keyboard) {
    if (key.isWhite) {
      key.x = key.whiteIndex * whiteWidth;
      key.width = whiteWidth;
    } else {
      key.x = (key.whiteIndex + 1) * whiteWidth - whiteWidth * 0.5;
      key.width = whiteWidth;
    }
  }
}

function getNoteLane(key) {
  if (key.isWhite) {
    return { x: key.x, width: key.width };
  }

  const blackWidth = key.width * 0.64;
  const centerX = key.x + key.width / 2;
  return {
    x: centerX - blackWidth / 2,
    width: blackWidth,
  };
}

function updateActiveVelocities(currentTime) {
  state.activeVelocities.clear();

  for (const note of state.song.notes) {
    if (note.start <= currentTime && note.end >= currentTime) {
      const velocity = note.velocity / 127;
      const previous = state.activeVelocities.get(note.midi) || 0;
      state.activeVelocities.set(note.midi, Math.max(previous, velocity));
    }
  }
}

function roundRect(context, x, y, width, height, radiusTopLeft, radiusTopRight, radiusBottomRight, radiusBottomLeft) {
  const maxRadius = Math.max(0, Math.min(width / 2, height / 2));
  const rtl = clamp(radiusTopLeft ?? 8, 0, maxRadius);
  const rtr = clamp(radiusTopRight ?? rtl, 0, maxRadius);
  const rbr = clamp(radiusBottomRight ?? rtl, 0, maxRadius);
  const rbl = clamp(radiusBottomLeft ?? rtr, 0, maxRadius);

  context.beginPath();
  context.moveTo(x + rtl, y);
  context.lineTo(x + width - rtr, y);
  context.quadraticCurveTo(x + width, y, x + width, y + rtr);
  context.lineTo(x + width, y + height - rbr);
  context.quadraticCurveTo(x + width, y + height, x + width - rbr, y + height);
  context.lineTo(x + rbl, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - rbl);
  context.lineTo(x, y + rtl);
  context.quadraticCurveTo(x, y, x + rtl, y);
  context.closePath();
}
