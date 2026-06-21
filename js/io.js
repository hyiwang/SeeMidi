async function loadBackgroundFromFile(file) {
  backgroundImageInput.blur();
  backgroundImageState.textContent = t("readingBackground");
  backgroundImageRemoveButton.hidden = true;
  let objectUrl = "";

  try {
    objectUrl = URL.createObjectURL(file);
    const [image, dataUrl] = await Promise.all([
      loadImageFromUrl(objectUrl),
      readFileAsDataUrl(file),
    ]);

    if (state.backgroundImageObjectUrl) {
      URL.revokeObjectURL(state.backgroundImageObjectUrl);
    }

    state.backgroundImage = image;
    state.backgroundImageObjectUrl = objectUrl;
    state.backgroundImageDataUrl = dataUrl;
    state.backgroundFileName = file.name;
    state.backgroundWidth = image.naturalWidth;
    state.backgroundHeight = image.naturalHeight;
    syncBackgroundImageControls();
    render();
    requestAnimationFrame(render);
  } catch (error) {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    console.error(error);
    backgroundImageState.textContent = t("backgroundFailed");
    backgroundImageRemoveButton.hidden = !state.backgroundImage;
    alert(`${t("backgroundFailed")}：${error.message}`);
  }
}

async function loadMidiFromFile(file) {
  stopPlayback(true);

  try {
    const buffer = await file.arrayBuffer();
    const song = parseMidi(buffer);
    playStateEl.textContent = t("preparingSamples");
    await ensureAudio();
    if (state.sfzLoadingPromise) {
      await state.sfzLoadingPromise;
    }
    if (state.sfzReady) {
      await preloadSamplesForSong(song);
    }
    state.song = song;
    state.midiFile = file;
    state.midiBytes = buffer.slice(0);
    fileNameEl.textContent = file.name;
    durationEl.textContent = `${song.duration.toFixed(2)}s`;
    playStateEl.textContent = t("loadedReady");
    toggleButton.disabled = false;
    restartButton.disabled = false;
    exportButton.disabled = false;
    updateSaveMenuAvailability();
    state.pauseOffset = 0;
    syncPlaybackProgress(0);
    render();
    await startPlayback();
  } catch (error) {
    console.error(error);
    state.song = null;
    state.midiFile = null;
    state.midiBytes = null;
    playStateEl.textContent = t("parseFailed");
    fileNameEl.textContent = file.name;
    durationEl.textContent = "0.00s";
    toggleButton.disabled = true;
    restartButton.disabled = true;
    exportButton.disabled = true;
    updateSaveMenuAvailability();
    alert(`MIDI ${t("parseFailed")}：${error.message}`);
  }
}

async function exportAnimation() {
  if (!state.song || state.recording) {
    return;
  }

  const exportMode = getSelectedExportMode();
  const fps = getSelectedExportFps();

  if (exportMode === "backend" && !state.backendAvailable) {
    return;
  }

  if (exportMode === "browser") {
    await exportAnimationWithBrowserRecorder(fps);
    return;
  }

  exportButton.disabled = true;
  exportStateEl.textContent = t("backendGenerating", { fps });

  try {
    await exportMp4ViaBackend(fps);
    exportStateEl.textContent = t("mp4Done");
  } catch (error) {
    console.error("MP4 backend export failed.", error);
    const message = error?.message || t("videoExportFailed");
    exportStateEl.textContent = `${t("videoExportFailed")}: ${message}`;
    alert(`${t("videoExportFailed")}: ${message}`);
  } finally {
    exportButton.disabled = false;
  }
}

async function exportMp4ViaBackend(fps) {
  if (!state.midiFile || !state.song) {
    throw new Error(t("noExportMidi"));
  }

  const exportId = createExportId();
  const exportResolution = getSelectedExportResolution();
  const payload = {
    exportId,
    fileName: state.midiFile.name,
    fps,
    width: exportResolution.width,
    height: exportResolution.height,
    autoSustain: autoSustainToggle.checked,
    autoSustainSeconds: getAutoSustainSeconds(),
    hasBackgroundImage: Boolean(state.backgroundImage),
    backgroundImage: createExportBackgroundDataUrl(exportResolution.width, exportResolution.height),
    backgroundOpacity: getBackgroundOpacity(),
    backgroundBase: state.backgroundBase,
    noteColor: state.noteColor,
    showGrid: state.showGrid,
    visualEffect: state.visualEffect,
    fogQuality: state.fogQuality,
    duration: state.song.duration,
    playbackDuration: getSongPlaybackDuration(),
    notes: state.song.notes.map((note) => ({
      midi: note.midi,
      velocity: note.velocity,
      start: note.start,
      end: note.end,
      playbackEnd: getNotePlaybackEnd(note, autoSustainToggle.checked, getAutoSustainSeconds()),
    })),
  };

  if (payload.hasBackgroundImage && !payload.backgroundImage) {
    throw new Error(t("backgroundNotReady"));
  }
  if (payload.hasBackgroundImage) {
    exportStateEl.textContent = t("sendingBackground", { kb: Math.round(payload.backgroundImage.length / 1024) });
  }

  startExportProgressPolling(exportId);

  let response;
  try {
    response = await fetch("/api/export-mp4", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } finally {
    stopExportProgressPolling();
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `后端返回 ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new Error("后端生成了空文件");
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = fileNameEl.textContent.replace(/\.[^.]+$/, "") || "piano-waterfall";
  link.href = url;
  link.download = `${baseName}-waterfall.mp4`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function createExportId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function startExportProgressPolling(exportId) {
  stopExportProgressPolling();

  const update = async () => {
    try {
      const response = await fetch(`/api/export-progress?id=${encodeURIComponent(exportId)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        return;
      }
      const progress = await response.json();
      if (progress.phase === "unknown") {
        return;
      }
      if (progress.phase === "video") {
        exportStateEl.textContent = `${t("progressVideo", {
          done: progress.doneFrames ?? 0,
          total: progress.totalFrames ?? 0,
        })} (${progress.percent}%)`;
      } else {
        exportStateEl.textContent = t(`progress_${progress.phase}`) || progress.message;
      }
    } catch (error) {
      console.warn("Failed to read export progress.", error);
    }
  };

  update();
  state.exportProgressTimer = window.setInterval(update, 1000);
}

function stopExportProgressPolling() {
  if (state.exportProgressTimer) {
    clearInterval(state.exportProgressTimer);
    state.exportProgressTimer = 0;
  }
}

async function toggleExamplePanel(type) {
  const panel = type === "midi" ? midiExamplePanel : imageExamplePanel;
  const otherPanel = type === "midi" ? imageExamplePanel : midiExamplePanel;
  otherPanel.hidden = true;

  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }

  try {
    await ensureExamplesLoaded();
    renderExampleList(type);
  } catch (error) {
    console.error(error);
    renderExampleError(type);
  }
  panel.hidden = false;
}

async function ensureExamplesLoaded() {
  if (state.examples) {
    return state.examples;
  }

  let response = await fetch("/api/examples", { cache: "no-store" });
  if (!response.ok) {
    response = await fetch("assets/examples/examples.json", { cache: "no-store" });
  }
  if (!response.ok) {
    throw new Error(`examples ${response.status}`);
  }
  state.examples = await response.json();
  return state.examples;
}

function renderExampleList(type) {
  const list = type === "midi" ? midiExampleList : imageExampleList;
  const files = state.examples?.[type] || [];
  list.textContent = "";

  if (!files.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = t("noExamples");
    row.appendChild(cell);
    list.appendChild(row);
    return;
  }

  for (const file of files) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const sizeCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = file.name;
    button.addEventListener("click", async () => {
      await loadExampleFile(type, file);
    });
    nameCell.appendChild(button);
    sizeCell.textContent = formatFileSize(file.size);
    row.append(nameCell, sizeCell);
    list.appendChild(row);
  }
}

function renderExampleError(type) {
  const list = type === "midi" ? midiExampleList : imageExampleList;
  list.textContent = "";
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 2;
  cell.textContent = t("exampleLoadFailed");
  row.appendChild(cell);
  list.appendChild(row);
}

async function loadExampleFile(type, file) {
  const response = await fetch(file.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`example ${response.status}`);
  }
  const blob = await response.blob();
  const exampleFile = new File([blob], file.name, { type: blob.type || getExampleMimeType(file.name) });

  if (type === "midi") {
    midiExamplePanel.hidden = true;
    await loadMidiFromFile(exampleFile);
  } else {
    imageExamplePanel.hidden = true;
    await loadBackgroundFromFile(exampleFile);
  }
}

function getExampleMimeType(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "mid" || extension === "midi") {
    return "audio/midi";
  }
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  if (extension === "avif") {
    return "image/avif";
  }
  return "application/octet-stream";
}

function formatFileSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function exportAnimationWithBrowserRecorder(fps = 60) {
  if (!state.song || state.recording) {
    return;
  }

  if (!canvas.captureStream || typeof MediaRecorder === "undefined") {
    alert(t("recordingUnsupported"));
    return;
  }

  try {
    await ensureAudio();
    if (state.sfzLoadingPromise) {
      await state.sfzLoadingPromise;
    }
    if (state.sfzReady) {
      exportStateEl.textContent = t("checkingSamples");
      await preloadSamplesForSong(state.song);
    }

    const mimeType = getSupportedRecordingMimeType();
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = 1600;
    exportCanvas.height = 900;
    const exportCtx = exportCanvas.getContext("2d");
    const exportAudio = createExportAudioGraph();
    const canvasStream = exportCanvas.captureStream(fps);
    const mixedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...exportAudio.destination.stream.getAudioTracks(),
    ]);

    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);
    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.recordedChunks.push(event.data);
      }
    });
    state.mediaRecorder.addEventListener("stop", () => {
      downloadRecording(mimeType || "video/webm");
      mixedStream.getTracks().forEach((track) => track.stop());
      exportAudio.context.close();
    }, { once: true });

    state.recording = true;
    exportButton.disabled = true;
    exportStateEl.textContent = t("browserRecording", { fps });

    state.mediaRecorder.start(250);
    await exportAudio.context.resume();
    const startAt = exportAudio.context.currentTime + 0.25;
    const autoSustain = autoSustainToggle.checked;
    const autoSustainSeconds = getAutoSustainSeconds();
    scheduleExportAudio(exportAudio, startAt, autoSustain, autoSustainSeconds);
    await recordExportFrames(exportCtx, exportCanvas.width, exportCanvas.height, startAt, exportAudio.context, autoSustain, autoSustainSeconds);

    state.recording = false;
    if (state.mediaRecorder?.state !== "inactive") {
      state.mediaRecorder.stop();
    }
    exportStateEl.textContent = t("done");
  } catch (error) {
    console.error(error);
    state.recording = false;
    exportStateEl.textContent = t("failed");
    alert(`${t("videoExportFailed")}：${error.message}`);
  } finally {
    exportButton.disabled = false;
  }
}

async function checkBackendAvailability() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`health check failed: ${response.status}`);
    }
    state.backendAvailable = true;
    backendExportMode.disabled = false;
    backendModeLabel.textContent = t("backendMp4");
    exportStateEl.textContent = t("backendAvailable");
  } catch (error) {
    console.warn("Backend export is unavailable.", error);
    state.backendAvailable = false;
    backendExportMode.disabled = true;
    backendExportMode.checked = false;
    backendModeLabel.textContent = t("backendMp4Unavailable");
    browserExportMode.checked = true;
    exportStateEl.textContent = t("backendUnavailable");
  }
}

function getSelectedExportMode() {
  return backendExportMode.checked ? "backend" : "browser";
}

function getSelectedExportFps() {
  const selected = document.querySelector("input[name='exportFps']:checked");
  return Number(selected?.value || 60);
}

function getSelectedExportResolution() {
  const selected = document.querySelector("input[name='exportResolution']:checked");
  const value = selected?.value || "1600x900";
  return value === "1280x720"
    ? { width: 1280, height: 720 }
    : { width: 1600, height: 900 };
}

function getBackgroundOpacity() {
  return Math.min(1, Math.max(0, Number(backgroundOpacity.value) || 0));
}

function createExportBackgroundDataUrl(width, height) {
  if (!state.backgroundImage) {
    return "";
  }

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;
  const exportCtx = exportCanvas.getContext("2d");
  const image = state.backgroundImage;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;

  // Send a normalized frame-sized image to the backend so MP4 export matches preview reliably.
  exportCtx.drawImage(image, x, y, drawWidth, drawHeight);
  return exportCanvas.toDataURL("image/jpeg", 0.9);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error("FileReader failed")));
    reader.readAsDataURL(file);
  });
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("无法解码图片")), { once: true });
    image.src = url;
  });
}

function getSupportedRecordingMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function downloadRecording(mimeType) {
  const blob = new Blob(state.recordedChunks, { type: mimeType });
  if (!blob.size) {
    exportStateEl.textContent = t("failed");
    alert(t("emptyRecording"));
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = fileNameEl.textContent.replace(/\.[^.]+$/, "") || "piano-waterfall";
  link.href = url;
  link.download = `${baseName}-waterfall.webm`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function recordExportFrames(exportCtx, width, height, startAt, audioContext, autoSustain = autoSustainToggle.checked, autoSustainSeconds = getAutoSustainSeconds()) {
  return new Promise((resolve) => {
    const duration = getSongPlaybackDuration(autoSustain, autoSustainSeconds) + 0.25;

    function drawFrame() {
      const currentTime = Math.max(0, audioContext.currentTime - startAt);
      const activeVelocities = getActiveVelocitiesAt(currentTime);
      renderAt(exportCtx, width, height, currentTime, activeVelocities);

      if (currentTime >= duration) {
        resolve();
        return;
      }

      requestAnimationFrame(drawFrame);
    }

    drawFrame();
  });
}

function parseMidi(arrayBuffer) {
  const reader = new MidiReader(arrayBuffer);
  const headerId = reader.readString(4);
  if (headerId !== "MThd") {
    throw new Error("文件不是标准 MIDI 格式。");
  }

  const headerLength = reader.readUint32();
  const format = reader.readUint16();
  const trackCount = reader.readUint16();
  const division = reader.readUint16();

  if (division & 0x8000) {
    throw new Error("暂不支持 SMPTE 时间格式的 MIDI。");
  }

  reader.skip(headerLength - 6);

  const ticksPerQuarter = division;
  const tempoEvents = [{ tick: 0, microsecondsPerQuarter: 500000 }];
  const channelEvents = [];
  let eventSequence = 0;
  let songEndTick = 0;

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const trackId = reader.readString(4);
    if (trackId !== "MTrk") {
      throw new Error("MIDI 轨道块损坏。");
    }

    const trackLength = reader.readUint32();
    const trackEnd = reader.position + trackLength;
    let tick = 0;
    let runningStatus = 0;

    while (reader.position < trackEnd) {
      tick += reader.readVarInt();
      songEndTick = Math.max(songEndTick, tick);
      let status = reader.peekUint8();

      if (status & 0x80) {
        status = reader.readUint8();
        runningStatus = status;
      } else {
        status = runningStatus;
      }

      if (status === 0xff) {
        const metaType = reader.readUint8();
        const length = reader.readVarInt();

        if (metaType === 0x51 && length === 3) {
          const tempo = (reader.readUint8() << 16) | (reader.readUint8() << 8) | reader.readUint8();
          tempoEvents.push({ tick, microsecondsPerQuarter: tempo });
        } else {
          reader.skip(length);
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const length = reader.readVarInt();
        reader.skip(length);
        continue;
      }

      const eventType = status >> 4;
      const channel = status & 0x0f;
      const noteNumber = reader.readUint8();
      const value = eventType === 0xc || eventType === 0xd ? null : reader.readUint8();

      if (eventType === 0x9 && value > 0) {
        channelEvents.push({
          tick,
          sequence: eventSequence++,
          type: "noteOn",
          channel,
          noteNumber,
          velocity: value,
        });
      } else if (eventType === 0x8 || (eventType === 0x9 && value === 0)) {
        channelEvents.push({
          tick,
          sequence: eventSequence++,
          type: "noteOff",
          channel,
          noteNumber,
        });
      } else if (eventType === 0xb && noteNumber === 64) {
        channelEvents.push({
          tick,
          sequence: eventSequence++,
          type: "sustain",
          channel,
          value,
          isDown: value >= 64,
        });
      }
    }

    reader.position = trackEnd;
  }

  const noteEvents = applySustainPedal(channelEvents, songEndTick);

  tempoEvents.sort((a, b) => a.tick - b.tick);
  const tempoTimeline = buildTempoTimeline(tempoEvents, ticksPerQuarter);

  const notes = noteEvents
    .map((note, index) => ({
      id: `${note.channel}-${note.startTick}-${note.endTick}-${note.midi}-${index}`,
      midi: note.midi,
      velocity: note.velocity,
      startTick: note.startTick,
      endTick: note.endTick,
      playbackEndTick: note.playbackEndTick,
      start: tickToSeconds(note.startTick, tempoTimeline, ticksPerQuarter),
      end: tickToSeconds(note.endTick, tempoTimeline, ticksPerQuarter),
      playbackEnd: tickToSeconds(note.playbackEndTick, tempoTimeline, ticksPerQuarter),
    }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  const duration = notes.length ? Math.max(...notes.map((note) => note.end)) : 0;
  const playbackDuration = notes.length ? Math.max(...notes.map((note) => note.playbackEnd)) : duration;
  return { format, ticksPerQuarter, notes, duration, playbackDuration };
}

function applySustainPedal(channelEvents, songEndTick) {
  const sortedEvents = [...channelEvents].sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
  const activeNotes = new Map();
  const sustainedNotes = new Map();
  const sustainByChannel = new Map();
  const noteEvents = [];

  for (const event of sortedEvents) {
    const noteKey = `${event.channel}:${event.noteNumber}`;

    if (event.type === "noteOn") {
      if (!activeNotes.has(noteKey)) {
        activeNotes.set(noteKey, []);
      }
      activeNotes.get(noteKey).push({
        channel: event.channel,
        midi: event.noteNumber,
        velocity: event.velocity,
        startTick: event.tick,
      });
      continue;
    }

    if (event.type === "noteOff") {
      const stack = activeNotes.get(noteKey);
      if (!stack?.length) {
        continue;
      }

      const note = stack.pop();
      if (sustainByChannel.get(event.channel)) {
        if (!sustainedNotes.has(event.channel)) {
          sustainedNotes.set(event.channel, []);
        }
        sustainedNotes.get(event.channel).push({
          ...note,
          endTick: event.tick,
        });
      } else if (event.tick > note.startTick && note.midi >= MIDI_MIN && note.midi <= MIDI_MAX) {
        noteEvents.push({
          channel: note.channel,
          midi: note.midi,
          velocity: note.velocity,
          startTick: note.startTick,
          endTick: event.tick,
          playbackEndTick: event.tick,
        });
      }
      continue;
    }

    if (event.type === "sustain") {
      sustainByChannel.set(event.channel, event.isDown);
      if (!event.isDown) {
        const pendingNotes = sustainedNotes.get(event.channel) || [];
        for (const note of pendingNotes) {
          if (event.tick > note.startTick && note.midi >= MIDI_MIN && note.midi <= MIDI_MAX) {
            noteEvents.push({
              channel: note.channel,
              midi: note.midi,
              velocity: note.velocity,
              startTick: note.startTick,
              endTick: note.endTick,
              playbackEndTick: event.tick,
            });
          }
        }
        sustainedNotes.set(event.channel, []);
      }
      continue;
    }
  }

  // 文件结束时仍未释放的音符，按最后一个事件时间收束
  for (const stack of activeNotes.values()) {
    for (const note of stack) {
      if (songEndTick > note.startTick && note.midi >= MIDI_MIN && note.midi <= MIDI_MAX) {
        noteEvents.push({
          channel: note.channel,
          midi: note.midi,
          velocity: note.velocity,
          startTick: note.startTick,
          endTick: songEndTick,
          playbackEndTick: songEndTick,
        });
      }
    }
  }

  for (const pendingNotes of sustainedNotes.values()) {
    for (const note of pendingNotes) {
      if (songEndTick > note.startTick && note.midi >= MIDI_MIN && note.midi <= MIDI_MAX) {
        noteEvents.push({
          channel: note.channel,
          midi: note.midi,
          velocity: note.velocity,
          startTick: note.startTick,
          endTick: note.endTick,
          playbackEndTick: songEndTick,
        });
      }
    }
  }

  return noteEvents;
}

function buildTempoTimeline(tempoEvents, ticksPerQuarter) {
  const timeline = [];
  let lastTick = 0;
  let seconds = 0;
  let currentTempo = tempoEvents[0]?.microsecondsPerQuarter || 500000;

  timeline.push({ tick: 0, seconds: 0, microsecondsPerQuarter: currentTempo });

  for (let index = 1; index < tempoEvents.length; index += 1) {
    const event = tempoEvents[index];
    const deltaTicks = event.tick - lastTick;
    seconds += (deltaTicks * currentTempo) / (ticksPerQuarter * 1000000);
    timeline.push({ tick: event.tick, seconds, microsecondsPerQuarter: event.microsecondsPerQuarter });
    lastTick = event.tick;
    currentTempo = event.microsecondsPerQuarter;
  }

  return timeline;
}

function tickToSeconds(targetTick, timeline, ticksPerQuarter) {
  let current = timeline[0];

  for (const point of timeline) {
    if (point.tick > targetTick) {
      break;
    }
    current = point;
  }

  return current.seconds + ((targetTick - current.tick) * current.microsecondsPerQuarter) / (ticksPerQuarter * 1000000);
}

class MidiReader {
  constructor(buffer) {
    this.data = new Uint8Array(buffer);
    this.position = 0;
  }

  readUint8() {
    return this.data[this.position++];
  }

  peekUint8() {
    return this.data[this.position];
  }

  readUint16() {
    const value = (this.readUint8() << 8) | this.readUint8();
    return value >>> 0;
  }

  readUint32() {
    const value =
      (this.readUint8() << 24) |
      (this.readUint8() << 16) |
      (this.readUint8() << 8) |
      this.readUint8();
    return value >>> 0;
  }

  readString(length) {
    let result = "";
    for (let index = 0; index < length; index += 1) {
      result += String.fromCharCode(this.readUint8());
    }
    return result;
  }

  readVarInt() {
    let value = 0;
    while (true) {
      const byte = this.readUint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        return value >>> 0;
      }
    }
  }

  skip(length) {
    this.position += length;
  }
}
