function refreshPlaybackForSustainChange() {
  clearTimeout(state.sustainRefreshTimer);
  if (!state.song) {
    return;
  }
  if (state.playing) {
    // 已经发声或已排队的音不重新调度，避免滑动时反复截断采样产生爆音
    state.playbackStopTime = Math.max(state.playbackStopTime, getSongPlaybackDuration());
    return;
  }
  render();
}

function queueSustainRefresh() {
  clearTimeout(state.sustainRefreshTimer);
  state.sustainRefreshTimer = window.setTimeout(() => {
    refreshPlaybackForSustainChange();
  }, 80);
}

async function togglePlayback() {
  if (!state.song) {
    return;
  }

  if (state.playing) {
    pausePlayback();
  } else {
    await startPlayback();
  }
}

async function ensureAudio() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
    state.masterCompressor = state.audioContext.createDynamicsCompressor();
    state.masterGain = state.audioContext.createGain();
    state.masterCompressor.threshold.value = -18;
    state.masterCompressor.knee.value = 18;
    state.masterCompressor.ratio.value = 10;
    state.masterCompressor.attack.value = 0.003;
    state.masterCompressor.release.value = 0.18;
    state.masterGain.gain.value = 0.3;
    state.masterGain.connect(state.masterCompressor);
    state.masterCompressor.connect(state.audioContext.destination);
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

async function startPlayback() {
  if (!state.song) {
    return;
  }

  await ensureAudio();

  const song = state.song;
  const resumeTime = Math.min(state.pauseOffset, song.duration);

  clearInterval(state.schedulerId);
  cancelAnimationFrame(state.rafId);
  state.activeVoices.clear();
  state.activeVelocities.clear();

  state.nextNoteIndex = findFirstSchedulableNote(song.notes, resumeTime);
  state.startAudioTime = state.audioContext.currentTime - resumeTime;
  state.playbackStopTime = getSongPlaybackDuration();
  state.playing = true;
  playStateEl.textContent = t("playing");

  schedulerTick();
  state.schedulerId = window.setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
  animate();
}

function pausePlayback() {
  if (!state.playing) {
    return;
  }

  state.pauseOffset = getCurrentSongTime();
  state.playing = false;
  clearInterval(state.schedulerId);
  cancelAnimationFrame(state.rafId);
  stopAllVoices();
  playStateEl.textContent = t("paused");
  syncPlaybackProgress();
  render();
}

function stopPlayback(resetOffset) {
  state.playing = false;
  clearInterval(state.schedulerId);
  cancelAnimationFrame(state.rafId);
  stopAllVoices();

  if (resetOffset) {
    state.pauseOffset = 0;
  }
  syncPlaybackProgress();
}

function stopAllVoices() {
  for (const voice of state.activeVoices.values()) {
    try {
      const now = state.audioContext?.currentTime || 0;
      voice.output.gain.cancelScheduledValues(now);
      voice.output.gain.setValueAtTime(0, now);

      for (const oscillator of voice.oscillators || []) {
        oscillator.stop(now);
      }

      if (voice.noiseSource) {
        voice.noiseSource.stop(now);
      }

      if (voice.sampleSource) {
        voice.sampleSource.stop(now);
      }
    } catch (error) {
      // 某些节点可能已经停止，这里静默忽略即可
    }
  }

  state.activeVoices.clear();
  state.activeVelocities.clear();
}

function schedulerTick() {
  if (!state.song || !state.playing) {
    return;
  }

  const songTime = getCurrentSongTime();
  const scheduleUntil = songTime + SCHEDULE_AHEAD_TIME;
  const notes = state.song.notes;

  while (state.nextNoteIndex < notes.length && notes[state.nextNoteIndex].start <= scheduleUntil) {
    const note = notes[state.nextNoteIndex];
    if (getNotePlaybackEnd(note) >= songTime - 0.02) {
      scheduleNote(note);
    }
    state.nextNoteIndex += 1;
  }

  if (songTime >= state.playbackStopTime + 0.1) {
    stopPlayback(false);
    state.pauseOffset = 0;
    syncPlaybackProgress(0);
    playStateEl.textContent = t("ended");
    render();
  }
}

function createExportAudioGraph() {
  const context = new AudioContext();
  const compressor = context.createDynamicsCompressor();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();

  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;
  gain.gain.value = 0.3;
  gain.connect(compressor);
  compressor.connect(destination);

  return { context, gain, destination };
}

function scheduleExportAudio(exportAudio, startAt, autoSustain = autoSustainToggle.checked, autoSustainSeconds = getAutoSustainSeconds()) {
  for (const note of state.song.notes) {
    if (state.sfzReady) {
      scheduleExportSfzNote(note, exportAudio, startAt, autoSustain, autoSustainSeconds);
    } else {
      scheduleExportSynthNote(note, exportAudio, startAt, autoSustain, autoSustainSeconds);
    }
  }
}

function scheduleExportSfzNote(note, exportAudio, startAt, autoSustain, autoSustainSeconds) {
  const region = findSfzRegion(note.midi, note.velocity);
  const sampleBuffer = region ? state.sampleBuffers.get(region.sample) : null;
  if (!region || !sampleBuffer) {
    scheduleExportSynthNote(note, exportAudio, startAt, autoSustain, autoSustainSeconds);
    return;
  }

  const context = exportAudio.context;
  const actualStart = startAt + note.start;
  const actualEnd = startAt + getNotePlaybackEnd(note, autoSustain, autoSustainSeconds);
  const velocity = note.velocity / 127;
  const output = context.createGain();
  const sampleSource = context.createBufferSource();
  const playbackRate =
    Math.pow(2, (note.midi - region.pitchKeycenter) / 12) *
    Math.pow(2, region.tune / 1200);
  const sampleOffset = Math.max(0, region.offset / sampleBuffer.sampleRate);
  const availableDuration = Math.max(0.02, (sampleBuffer.duration - sampleOffset) / playbackRate);
  const naturalStop = actualStart + availableDuration;
  const releaseFade = 0.045;
  const targetStop = Math.min(naturalStop, actualEnd + releaseFade);
  const fadeStart = Math.max(actualStart + 0.01, targetStop - releaseFade);
  const regionGain = Math.pow(10, region.volume / 20);
  const startGain = Math.max(0.02, 0.06 + velocity * 0.18) * regionGain;

  sampleSource.buffer = sampleBuffer;
  sampleSource.playbackRate.setValueAtTime(playbackRate, actualStart);
  output.gain.setValueAtTime(0.0001, actualStart);
  output.gain.linearRampToValueAtTime(startGain, actualStart + 0.008);
  output.gain.setValueAtTime(startGain, fadeStart);
  output.gain.exponentialRampToValueAtTime(0.0001, targetStop);
  sampleSource.connect(output);
  output.connect(exportAudio.gain);
  sampleSource.start(actualStart, sampleOffset);
  sampleSource.stop(targetStop + 0.02);
}

function scheduleExportSynthNote(note, exportAudio, startAt, autoSustain, autoSustainSeconds) {
  const context = exportAudio.context;
  const actualStart = startAt + note.start;
  const actualEnd = startAt + getNotePlaybackEnd(note, autoSustain, autoSustainSeconds);
  const velocity = note.velocity / 127;
  const frequency = 440 * Math.pow(2, (note.midi - 69) / 12);
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, actualStart);
  gain.gain.setValueAtTime(0.0001, actualStart);
  gain.gain.linearRampToValueAtTime(0.03 + velocity * 0.1, actualStart + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, actualEnd + 0.05);
  oscillator.connect(gain);
  gain.connect(exportAudio.gain);
  oscillator.start(actualStart);
  oscillator.stop(actualEnd + 0.08);
}

function scheduleNote(note) {
  if (state.sfzReady) {
    scheduleSfzNote(note);
    return;
  }

  scheduleSynthNote(note);
}

async function loadBundledPianoSource() {
  if (state.sfzLoadingPromise) {
    return state.sfzLoadingPromise;
  }

  const source = getActiveSoundSource();
  const loadVersion = state.sfzLoadVersion;
  sampleStateEl.textContent = t("readingSoundSource", { source: source.label });
  state.sfzLoadingPromise = fetch(source.sfzUrl)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`无法读取 SFZ：${response.status}`);
      }
      return response.text();
    })
    .then((sfzText) => {
      if (loadVersion !== state.sfzLoadVersion || source !== getActiveSoundSource()) {
        return;
      }
      state.sfzRegions = parseSfzRegions(sfzText, source.sfzUrl);
      state.sfzReady = state.sfzRegions.length > 0;
      sampleStateEl.textContent = state.sfzReady
        ? source.label
        : t("noSampleMapping");
      if (state.sfzReady) {
        warmupCommonSamples();
      }
    })
    .catch((error) => {
      if (loadVersion !== state.sfzLoadVersion || source !== getActiveSoundSource()) {
        return;
      }
      console.error(error);
      state.sfzReady = false;
      sampleStateEl.textContent = t("soundSourceFallback", { source: source.label });
    });

  return state.sfzLoadingPromise;
}

function warmupCommonSamples() {
  if (state.sampleWarmupPromise || !state.sfzReady) {
    return state.sampleWarmupPromise;
  }

  const warmupMidis = [24, 30, 36, 42, 48, 54, 60, 64, 67, 72, 76, 79, 84, 90, 96];
  const samplePaths = [];
  const seen = new Set();

  for (const midi of warmupMidis) {
    const region = findSfzRegion(midi, 88);
    if (!region?.sample || seen.has(region.sample)) {
      continue;
    }
    seen.add(region.sample);
    samplePaths.push(region.sample);
  }

  if (!samplePaths.length) {
    return null;
  }

  state.sampleWarmupPromise = preloadWithConcurrency(samplePaths, 2)
    .catch((error) => {
      console.warn(`${getActiveSoundSource().label} warmup failed.`, error);
    });

  return state.sampleWarmupPromise;
}

function scheduleSfzNote(note) {
  const startAt = state.startAudioTime + note.start;
  const endAt = state.startAudioTime + getNotePlaybackEnd(note);
  const now = state.audioContext.currentTime;

  if (endAt <= now) {
    return;
  }

  const region = findSfzRegion(note.midi, note.velocity);
  if (!region) {
    scheduleSynthNote(note);
    return;
  }

  const safeStart = Math.max(now, startAt);
  const safeEnd = Math.max(safeStart + 0.05, endAt);

  resolveAudioBuffer(region.sample).then((sampleBuffer) => {
    if (!state.playing || !state.audioContext) {
      return;
    }

    const currentNow = state.audioContext.currentTime;
    const actualStart = Math.max(currentNow + 0.002, safeStart);
    const actualEnd = Math.max(actualStart + 0.05, safeEnd);
    const velocity = note.velocity / 127;
    const output = state.audioContext.createGain();
    const sampleSource = state.audioContext.createBufferSource();
    const playbackRate =
      Math.pow(2, (note.midi - region.pitchKeycenter) / 12) *
      Math.pow(2, region.tune / 1200);
    const sampleOffset = Math.max(0, region.offset / sampleBuffer.sampleRate);
    const availableDuration = Math.max(0.02, (sampleBuffer.duration - sampleOffset) / playbackRate);
    const naturalStop = actualStart + availableDuration;
    const releaseFade = 0.045;
    const targetStop = Math.min(naturalStop, actualEnd + releaseFade);
    const fadeStart = Math.max(actualStart + 0.01, targetStop - releaseFade);
    const regionGain = Math.pow(10, region.volume / 20);
    const startGain = Math.max(0.02, 0.06 + velocity * 0.18) * regionGain;

    sampleSource.buffer = sampleBuffer;
    sampleSource.playbackRate.setValueAtTime(playbackRate, actualStart);

    output.gain.setValueAtTime(0.0001, currentNow);
    output.gain.linearRampToValueAtTime(startGain, actualStart + 0.008);
    output.gain.setValueAtTime(startGain, fadeStart);
    output.gain.exponentialRampToValueAtTime(0.0001, targetStop);

    // 严格跟随 MIDI 时值，只保留极短淡出以避免点击声
    sampleSource.connect(output);
    output.connect(state.masterGain);

    sampleSource.start(actualStart, sampleOffset);
    sampleSource.stop(targetStop + 0.02);

    const voice = { sampleSource, output };
    state.activeVoices.set(note.id, voice);

    window.setTimeout(() => {
      state.activeVoices.delete(note.id);
    }, Math.max(0, (targetStop - currentNow + 0.08) * 1000));
  }).catch((error) => {
    console.error(error);
    sampleStateEl.textContent = t("sampleFallback");
    scheduleSynthNote(note);
  });
}

function scheduleSynthNote(note) {
  const startAt = state.startAudioTime + note.start;
  const endAt = state.startAudioTime + getNotePlaybackEnd(note);
  const now = state.audioContext.currentTime;

  if (endAt <= now) {
    return;
  }

  const velocity = note.velocity / 127;
  const frequency = 440 * Math.pow(2, (note.midi - 69) / 12);
  const safeStart = Math.max(now, startAt);
  const safeEnd = Math.max(safeStart + 0.04, endAt);
  const noteDuration = Math.max(0.06, safeEnd - safeStart);
  const output = state.audioContext.createGain();
  const toneFilter = state.audioContext.createBiquadFilter();
  const bodyFilter = state.audioContext.createBiquadFilter();
  const hammerGain = state.audioContext.createGain();
  const oscillators = [];

  const mainOscillator = state.audioContext.createOscillator();
  mainOscillator.type = "triangle";
  mainOscillator.frequency.setValueAtTime(frequency, safeStart);
  oscillators.push(mainOscillator);

  const bodyOscillator = state.audioContext.createOscillator();
  bodyOscillator.type = "sine";
  bodyOscillator.frequency.setValueAtTime(frequency * 2, safeStart);
  oscillators.push(bodyOscillator);

  toneFilter.type = "lowpass";
  toneFilter.Q.value = 1.4;
  toneFilter.frequency.setValueAtTime(2200 + velocity * 2800, safeStart);
  toneFilter.frequency.exponentialRampToValueAtTime(850 + velocity * 1000, safeEnd);

  bodyFilter.type = "peaking";
  bodyFilter.frequency.value = Math.min(1200, frequency * 2);
  bodyFilter.Q.value = 0.9;
  bodyFilter.gain.value = 4 + velocity * 2;

  output.gain.setValueAtTime(0.0001, now);

  // 模拟钢琴击弦的快速起音、短暂衰减和轻微延音
  const attackLevel = 0.12 + velocity * 0.2;
  const sustainLevel = attackLevel * (0.34 + noteDuration * 0.06);
  const releaseStart = Math.max(safeStart + 0.05, safeEnd - 0.08);

  output.gain.linearRampToValueAtTime(attackLevel, safeStart + 0.006);
  output.gain.exponentialRampToValueAtTime(Math.max(0.012, sustainLevel), Math.min(safeEnd, safeStart + 0.18));
  output.gain.setValueAtTime(Math.max(0.012, sustainLevel), releaseStart);
  output.gain.exponentialRampToValueAtTime(0.0001, safeEnd + 0.09);

  const partialMix = [
    { oscillator: mainOscillator, gain: 0.84 },
    { oscillator: bodyOscillator, gain: 0.18 + velocity * 0.05 },
  ];

  for (const partial of partialMix) {
    const partialGain = state.audioContext.createGain();
    partialGain.gain.value = partial.gain;
    partial.oscillator.connect(partialGain);
    partialGain.connect(toneFilter);
  }

  toneFilter.connect(bodyFilter);
  bodyFilter.connect(output);

  const noiseSource = createNoiseSource();
  hammerGain.gain.setValueAtTime(0.0001, now);
  hammerGain.gain.linearRampToValueAtTime(0.05 + velocity * 0.05, safeStart + 0.002);
  hammerGain.gain.exponentialRampToValueAtTime(0.0001, safeStart + 0.03);
  noiseSource.connect(hammerGain);
  hammerGain.connect(toneFilter);

  output.connect(state.masterGain);

  for (const oscillator of oscillators) {
    oscillator.start(safeStart);
    oscillator.stop(safeEnd + 0.1);
  }

  noiseSource.start(safeStart);
  noiseSource.stop(safeStart + 0.035);

  const voice = { oscillators, noiseSource, output };
  state.activeVoices.set(note.id, voice);

  window.setTimeout(() => {
    state.activeVoices.delete(note.id);
  }, Math.max(0, (safeEnd - now + 0.2) * 1000));
}

function createNoiseSource() {
  const frameCount = Math.max(512, Math.floor(state.audioContext.sampleRate * 0.04));
  const buffer = state.audioContext.createBuffer(1, frameCount, state.audioContext.sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = (Math.random() * 2 - 1) * (1 - index / channel.length);
  }

  const noiseSource = state.audioContext.createBufferSource();
  noiseSource.buffer = buffer;
  return noiseSource;
}

function parseSfzRegions(sfzText, sfzUrl) {
  const lines = sfzText
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/g, "").trim())
    .filter(Boolean);

  const baseUrl = new URL(sfzUrl, window.location.href);
  const regions = [];
  let currentTag = "";
  let groupOpcodes = {};

  for (const line of lines) {
    if (line.startsWith("<")) {
      const tagMatches = [...line.matchAll(/<([^>]+)>/g)];
      if (!tagMatches.length) {
        continue;
      }

      currentTag = tagMatches[tagMatches.length - 1][1].toLowerCase();
      const opcodeText = line.replace(/<[^>]+>/g, " ").trim();
      const parsedOpcodes = parseSfzOpcodeText(opcodeText);

      if (currentTag === "group") {
        groupOpcodes = parsedOpcodes;
      } else if (currentTag === "region") {
        const merged = { ...groupOpcodes, ...parsedOpcodes };
        const sampleValue = merged.sample;
        regions.push({
          sample: sampleValue ? buildSampleUrl(sampleValue, baseUrl) : "",
          lokey: Number(merged.lokey ?? merged.key ?? MIDI_MIN),
          hikey: Number(merged.hikey ?? merged.key ?? MIDI_MAX),
          lovel: Number(merged.lovel ?? 1),
          hivel: Number(merged.hivel ?? 127),
          pitchKeycenter: Number(merged.pitch_keycenter ?? merged.key ?? merged.lokey ?? MIDI_MIN),
          volume: Number(merged.volume ?? 0),
          tune: Number(merged.tune ?? 0),
          offset: Number(merged.offset ?? 0),
        });
      }
      continue;
    }

    if (currentTag === "group") {
      groupOpcodes = { ...groupOpcodes, ...parseSfzOpcodeText(line) };
    } else if (currentTag === "region") {
      const previous = regions[regions.length - 1];
      if (previous) {
        Object.assign(previous, normalizeRegionFields(parseSfzOpcodeText(line), previous, baseUrl));
      }
    }
  }

  return regions.filter((region) => region.sample);
}

function parseSfzOpcodeText(text) {
  const opcodes = {};
  const matches = text.match(/([a-zA-Z0-9_]+)=([^\s]+)/g) || [];
  for (const token of matches) {
    const [key, value] = token.split("=");
    opcodes[key.toLowerCase()] = value;
  }
  return opcodes;
}

function normalizeRegionFields(opcodes, region, baseUrl) {
  const next = {};
  if (opcodes.sample) {
    next.sample = opcodes.sample;
  }
  if (opcodes.lokey) {
    next.lokey = Number(opcodes.lokey);
  }
  if (opcodes.hikey) {
    next.hikey = Number(opcodes.hikey);
  }
  if (opcodes.key) {
    const key = Number(opcodes.key);
    next.lokey = key;
    next.hikey = key;
    next.pitchKeycenter = key;
  }
  if (opcodes.lovel) {
    next.lovel = Number(opcodes.lovel);
  }
  if (opcodes.hivel) {
    next.hivel = Number(opcodes.hivel);
  }
  if (opcodes.pitch_keycenter) {
    next.pitchKeycenter = Number(opcodes.pitch_keycenter);
  }
  if (opcodes.volume) {
    next.volume = Number(opcodes.volume);
  }
  if (opcodes.tune) {
    next.tune = Number(opcodes.tune);
  }
  if (opcodes.offset) {
    next.offset = Number(opcodes.offset);
  }

  if (next.sample) {
    next.sample = buildSampleUrl(next.sample, baseUrl);
  } else {
    next.sample = region.sample;
  }

  return next;
}

function findSfzRegion(midi, velocity) {
  return state.sfzRegions.find((region) =>
    midi >= region.lokey &&
    midi <= region.hikey &&
    velocity >= region.lovel &&
    velocity <= region.hivel
  ) || null;
}

async function resolveAudioBuffer(samplePath) {
  if (state.sampleBuffers.has(samplePath)) {
    return state.sampleBuffers.get(samplePath);
  }

  const response = await fetch(samplePath);
  if (!response.ok) {
    throw new Error(`无法读取采样文件：${samplePath}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer.slice(0));
  state.sampleBuffers.set(samplePath, audioBuffer);
  return audioBuffer;
}

function buildSampleUrl(sampleValue, baseUrl) {
  const normalizedPath = sampleValue
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.replace(/#/g, "%23"))
    .join("/");

  return new URL(normalizedPath, baseUrl).href;
}

async function preloadSamplesForSong(song) {
  const uniqueSamplePaths = new Set();

  for (const note of song.notes) {
    const region = findSfzRegion(note.midi, note.velocity);
    if (region?.sample) {
      uniqueSamplePaths.add(region.sample);
    }
  }

  const samplePaths = Array.from(uniqueSamplePaths)
    .filter((samplePath) => !state.sampleBuffers.has(samplePath));
  if (!samplePaths.length) {
    sampleStateEl.textContent = getActiveSoundSource().label;
    return;
  }

  sampleStateEl.textContent = t("samplePreload", {
    source: getActiveSoundSource().label,
    count: samplePaths.length,
  });

  await preloadWithConcurrency(samplePaths, 4);

  sampleStateEl.textContent = t("sampleReady", {
    source: getActiveSoundSource().label,
    count: samplePaths.length,
  });
}

async function preloadWithConcurrency(samplePaths, concurrency) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < samplePaths.length) {
      const samplePath = samplePaths[nextIndex];
      nextIndex += 1;
      await resolveAudioBuffer(samplePath);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, samplePaths.length) },
    () => worker()
  );
  await Promise.all(workers);
}

function getCurrentSongTime() {
  return Math.min(getSongPlaybackDuration(), Math.max(0, state.audioContext.currentTime - state.startAudioTime));
}

function getSongPlaybackDuration(forceAutoSustain = autoSustainToggle.checked, autoSustainSeconds = getAutoSustainSeconds()) {
  if (!state.song) {
    return 0;
  }

  if (!forceAutoSustain) {
    return state.song.playbackDuration ?? state.song.duration ?? 0;
  }

  return Math.max(...state.song.notes.map((note) => getNotePlaybackEnd(note, true, autoSustainSeconds)), state.song.duration ?? 0);
}

function getNotePlaybackEnd(note, forceAutoSustain = autoSustainToggle.checked, autoSustainSeconds = getAutoSustainSeconds()) {
  const midiPlaybackEnd = note.playbackEnd ?? note.end;
  if (!forceAutoSustain) {
    return midiPlaybackEnd;
  }

  return Math.max(midiPlaybackEnd, note.end + autoSustainSeconds);
}

function getAutoSustainSeconds() {
  return Math.min(1, Math.max(0, Number(autoSustainDuration.value) || 0));
}

function findFirstSchedulableNote(notes, time) {
  const threshold = time - 0.02;
  for (let index = 0; index < notes.length; index += 1) {
    if (getNotePlaybackEnd(notes[index]) >= threshold) {
      return index;
    }
  }
  return notes.length;
}
