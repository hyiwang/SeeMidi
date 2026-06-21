const canvas = document.getElementById("visualizer");
let ctx = canvas.getContext("2d");

const midiInput = document.getElementById("midiInput");
const toggleButton = document.getElementById("toggleButton");
const restartButton = document.getElementById("restartButton");
const exportButton = document.getElementById("exportButton");
const backendExportMode = document.getElementById("backendExportMode");
const browserExportMode = document.getElementById("browserExportMode");
const backendModeLabel = document.getElementById("backendModeLabel");
const visualEffectInputs = Array.from(document.querySelectorAll("input[name='visualEffect']"));
const fogQualityFieldset = document.getElementById("fogQualityFieldset");
const fogQualityInputs = Array.from(document.querySelectorAll("input[name='fogQuality']"));
const autoSustainToggle = document.getElementById("autoSustainToggle");
const autoSustainDuration = document.getElementById("autoSustainDuration");
const autoSustainDurationValue = document.getElementById("autoSustainDurationValue");
const autoSustainDurationOption = document.getElementById("autoSustainDurationOption");
const backgroundImageButton = document.getElementById("backgroundImageButton");
const backgroundImageInput = document.getElementById("backgroundImageInput");
const backgroundImageState = document.getElementById("backgroundImageState");
const backgroundImageRemoveButton = document.getElementById("backgroundImageRemoveButton");
const backgroundOpacityOption = document.getElementById("backgroundOpacityOption");
const backgroundOpacity = document.getElementById("backgroundOpacity");
const backgroundOpacityValue = document.getElementById("backgroundOpacityValue");
const showGridToggle = document.getElementById("showGridToggle");
const backgroundBaseInputs = Array.from(document.querySelectorAll("input[name='backgroundBase']"));
const noteColorPicker = document.getElementById("noteColorPicker");
const colorPresetButtons = Array.from(document.querySelectorAll(".color-preset"));
const themeModeInputs = Array.from(document.querySelectorAll("input[name='themeMode']"));
const languageModeInputs = Array.from(document.querySelectorAll("input[name='languageMode']"));
const midiExamplesButton = document.getElementById("midiExamplesButton");
const midiExamplePanel = document.getElementById("midiExamplePanel");
const midiExampleList = document.getElementById("midiExampleList");
const imageExamplesButton = document.getElementById("imageExamplesButton");
const imageExamplePanel = document.getElementById("imageExamplePanel");
const imageExampleList = document.getElementById("imageExampleList");
const visualizerCard = document.getElementById("visualizerCard");
const visualizerStage = document.querySelector(".visualizer-stage");
const playbackControls = document.getElementById("playbackControls");
const playbackProgress = document.getElementById("playbackProgress");
const fullscreenButton = document.getElementById("fullscreenButton");
const fileNameEl = document.getElementById("fileName");
const sampleStateEl = document.getElementById("sampleState");
const playStateEl = document.getElementById("playState");
const exportStateEl = document.getElementById("exportState");
const durationEl = document.getElementById("duration");
const menuToggleButton = document.getElementById("menuToggleButton");
const uploadToggleButton = document.getElementById("uploadToggleButton");
const customToggleButton = document.getElementById("customToggleButton");
const saveToggleButton = document.getElementById("saveToggleButton");
const settingsMenu = document.getElementById("settingsMenu");
const uploadPanel = document.getElementById("uploadPanel");
const customPanel = document.getElementById("customPanel");
const savePanel = document.getElementById("savePanel");
const menuOverlay = document.getElementById("menuOverlay");
const saveMenuSection = document.getElementById("saveMenuSection");
const announcementToggleButton = document.getElementById("announcementToggleButton");
const announcementPanel = document.getElementById("announcementPanel");
const announcementList = document.getElementById("announcementList");
const announcementDialog = document.getElementById("announcementDialog");
const announcementDialogClose = document.getElementById("announcementDialogClose");
const announcementDialogTitle = document.getElementById("announcementDialogTitle");
const announcementDialogDate = document.getElementById("announcementDialogDate");
const announcementDialogContent = document.getElementById("announcementDialogContent");
const menuState = {
  pinned: false,
};
const uploadState = {
  open: false,
};
const customState = {
  open: false,
};
const saveState = {
  open: false,
};
const announcementState = {
  open: false,
  items: [],
};
let resizeObserverFrame = 0;

const MIDI_MIN = 21;
const MIDI_MAX = 108;
const WHITE_PATTERN = new Set([0, 2, 4, 5, 7, 9, 11]);
const SCHEDULE_AHEAD_TIME = 0.18;
const SCHEDULER_INTERVAL_MS = 25;
const SFZ_URL = "assets/Salamander/sfz_minimum/Accurate-SalamanderGrandPiano_flat.Recommended.sfz";
const THEME_STORAGE_KEY = "piano-waterfall-theme";
const LANGUAGE_STORAGE_KEY = "piano-waterfall-language";

const I18N = {
  zh: {
    eyebrow: "MIDI Piano Waterfall",
    title: "见音 - Midi 钢琴瀑布流可视化",
    theme: "主题",
    language: "语言",
    system: "系统",
    light: "亮",
    dark: "暗",
    uploadMidi: "上传 MIDI 文件",
    loadMidiExample: "加载 MIDI 示例",
    loadImageExample: "加载背景示例",
    exampleName: "名称",
    exampleSize: "大小",
    noExamples: "没有可用示例",
    exampleLoadFailed: "示例列表读取失败",
    fullscreen: "全屏",
    progress: "播放进度",
    exitFullscreen: "退出全屏",
    fullscreenUnsupported: "当前浏览器不支持全屏播放",
    fullscreenFailed: "进入全屏失败",
    playPause: "播放 / 暂停",
    restart: "重新开始",
    exportMode: "导出方式",
    backendMp4: "后端生成 MP4",
    backendMp4Unavailable: "后端生成 MP4（不可用）",
    browserWebm: "浏览器录屏 WebM",
    fps: "帧率",
    exportResolution: "分辨率",
    fogQuality: "雾气质量",
    qualityLow: "低",
    qualityMedium: "中",
    qualityHigh: "高",
    customSection: "自定义",
    effectSection: "特效",
    effectParameterSection: "特效参数",
    effectNone: "无",
    effectTrail: "拖尾",
    effectGlow: "发光边缘",
    effectFog: "雾气",
    effectStream: "流光",
    effectColorShift: "变色",
    effectExportNote: "特效可能导致掉帧，且会使后端导出时间变长",
    autoSustain: "自动延音",
    sustainDuration: "延音时长",
    noteColor: "音符颜色",
    showGrid: "显示网格",
    backgroundBase: "背景底色",
    backgroundBaseDefault: "默认",
    backgroundBaseBlack: "纯黑",
    chooseNoteColor: "选择音符颜色",
    recommendedColors: "推荐音符颜色",
    backgroundImageOptional: "背景图片（可选）",
    uploadBackground: "上传背景图片",
    changeBackground: "更换背景图片",
    noBackground: "未选择背景图片",
    readingBackground: "正在读取背景图片...",
    backgroundLoaded: "已加载：{name} ({width}x{height})",
    removeBackground: "删除背景图片",
    backgroundFailed: "背景图片读取失败",
    backgroundOpacity: "背景不透明度",
    saveAnimation: "保存动画到本地",
    fileLabel: "文件：",
    soundLabel: "音色：",
    stateLabel: "状态：",
    exportLabel: "导出：",
    durationLabel: "时长：",
    notLoaded: "未加载",
    synthSound: "合成音色",
    waitingUpload: "等待上传",
    idle: "空闲",
    spaceHint: "空格键可暂停 / 继续",
    velocityHint: "力度影响声音和部分特效强度",
    emptyTitle: "上传MIDI文件后开始生成钢琴瀑布流",
    emptySubtitle: "支持空格暂停 / 继续",
    preparingSamples: "正在准备音源",
    loadedReady: "已加载，准备播放",
    parseFailed: "解析失败",
    playing: "播放中",
    paused: "已暂停",
    ended: "播放结束",
    backendGenerating: "后端生成 {fps} FPS",
    mp4Done: "MP4 完成",
    backendFailedFallback: "后端失败，改用录制",
    sendingBackground: "发送背景图 ({kb} KB)",
    noExportMidi: "没有可导出的 MIDI 数据",
    backgroundNotReady: "背景图片还没有准备好，无法后端导出",
    recordingUnsupported: "当前浏览器不支持录制画布动画。请使用 Chrome、Edge 或 Firefox。",
    videoExportFailed: "视频导出失败",
    emptyRecording: "视频导出失败：录制结果为空。",
    checkingSamples: "检查采样",
    browserRecording: "录屏生成 {fps} FPS",
    done: "完成",
    failed: "失败",
    backendAvailable: "后端可用",
    backendUnavailable: "后端不可用",
    progressPrepare: "正在解析导出数据",
    progress_prepare: "正在解析导出数据",
    progressAudio: "正在合成音频",
    progress_audio: "正在合成音频",
    progressVideo: "正在渲染视频帧 {done}/{total}",
    progressFinalize: "正在打包 MP4",
    progress_finalize: "正在打包 MP4",
    progressDone: "MP4 生成完成",
    progress_done: "MP4 生成完成",
    readingSalamander: "正在读取本地 Salamander 音源",
    noSampleMapping: "未找到可用音源映射",
    salamanderFallback: "Salamander 音源读取失败，回退合成音色",
    sampleFallback: "Salamander 采样读取失败，已回退",
    samplePreload: "Salamander 预加载中 ({count} 个样本)",
    sampleReady: "Salamander 音源已就绪 ({count} 个样本)",
  },
  en: {
    eyebrow: "MIDI Piano Waterfall",
    title: "SeeMidi - Midi Piano Waterfall Visualizer",
    theme: "Theme",
    language: "Language",
    system: "System",
    light: "Light",
    dark: "Dark",
    uploadMidi: "Upload MIDI File",
    loadMidiExample: "Load MIDI Example",
    loadImageExample: "Load Background Example",
    exampleName: "Name",
    exampleSize: "Size",
    noExamples: "No examples available",
    exampleLoadFailed: "Failed to load examples",
    fullscreen: "Fullscreen",
    progress: "Playback progress",
    exitFullscreen: "Exit Fullscreen",
    fullscreenUnsupported: "This browser does not support fullscreen playback",
    fullscreenFailed: "Failed to enter fullscreen",
    playPause: "Play / Pause",
    restart: "Restart",
    exportMode: "Export",
    backendMp4: "Backend MP4",
    backendMp4Unavailable: "Backend MP4 (Unavailable)",
    browserWebm: "Browser WebM",
    fps: "FPS",
    exportResolution: "Resolution",
    fogQuality: "Fog quality",
    qualityLow: "Low",
    qualityMedium: "Medium",
    qualityHigh: "High",
    customSection: "Custom",
    effectSection: "Effects",
    effectParameterSection: "Effect parameters",
    effectNone: "None",
    effectTrail: "Trail",
    effectGlow: "Glow edge",
    effectFog: "Fog",
    effectStream: "Light streams",
    effectColorShift: "Color shift",
    effectExportNote: "Effects may cause dropped frames and will increase backend export time.",
    autoSustain: "Auto sustain",
    sustainDuration: "Sustain",
    noteColor: "Note color",
    showGrid: "Show grid",
    backgroundBase: "Background",
    backgroundBaseDefault: "Default",
    backgroundBaseBlack: "Black",
    chooseNoteColor: "Choose note color",
    recommendedColors: "Recommended note colors",
    backgroundImageOptional: "Background Image (Optional)",
    uploadBackground: "Upload Background",
    changeBackground: "Change Background",
    noBackground: "No background selected",
    readingBackground: "Reading background image...",
    backgroundLoaded: "Loaded: {name} ({width}x{height})",
    removeBackground: "Remove background image",
    backgroundFailed: "Failed to read background image",
    backgroundOpacity: "Background opacity",
    saveAnimation: "Save Animation Locally",
    fileLabel: "File:",
    soundLabel: "Sound:",
    stateLabel: "State:",
    exportLabel: "Export:",
    durationLabel: "Duration:",
    notLoaded: "Not loaded",
    synthSound: "Synth sound",
    waitingUpload: "Waiting for upload",
    idle: "Idle",
    spaceHint: "Press Space to pause / resume",
    velocityHint: "Velocity affects sound and some effect intensity",
    emptyTitle: "Upload a MIDI file to generate a MIDI piano waterfall",
    emptySubtitle: "Press Space to pause / resume",
    preparingSamples: "Preparing sound source",
    loadedReady: "Loaded, ready to play",
    parseFailed: "Parse failed",
    playing: "Playing",
    paused: "Paused",
    ended: "Playback ended",
    backendGenerating: "Backend export {fps} FPS",
    mp4Done: "MP4 complete",
    backendFailedFallback: "Backend failed, using recorder",
    sendingBackground: "Sending background ({kb} KB)",
    noExportMidi: "No MIDI data available for export",
    backgroundNotReady: "Background image is not ready for backend export",
    recordingUnsupported: "This browser does not support canvas recording. Use Chrome, Edge, or Firefox.",
    videoExportFailed: "Video export failed",
    emptyRecording: "Video export failed: recording is empty.",
    checkingSamples: "Checking samples",
    browserRecording: "Recording {fps} FPS",
    done: "Done",
    failed: "Failed",
    backendAvailable: "Backend available",
    backendUnavailable: "Backend unavailable",
    progressPrepare: "Preparing export data",
    progress_prepare: "Preparing export data",
    progressAudio: "Synthesizing audio",
    progress_audio: "Synthesizing audio",
    progressVideo: "Rendering frames {done}/{total}",
    progressFinalize: "Muxing MP4",
    progress_finalize: "Muxing MP4",
    progressDone: "MP4 export complete",
    progress_done: "MP4 export complete",
    readingSalamander: "Reading local Salamander source",
    noSampleMapping: "No usable sample mapping found",
    salamanderFallback: "Failed to read Salamander, using synth fallback",
    sampleFallback: "Failed to read Salamander sample, fallback enabled",
    samplePreload: "Preloading Salamander ({count} samples)",
    sampleReady: "Salamander ready ({count} samples)",
  },
};

const state = {
  song: null,
  audioContext: null,
  masterGain: null,
  masterCompressor: null,
  playing: false,
  recording: false,
  mediaRecorder: null,
  recordedChunks: [],
  sustainRefreshTimer: 0,
  exportProgressTimer: 0,
  rafId: 0,
  schedulerId: 0,
  startAudioTime: 0,
  playbackStopTime: 0,
  pauseOffset: 0,
  nextNoteIndex: 0,
  activeVoices: new Map(),
  activeVelocities: new Map(),
  sampleBuffers: new Map(),
  midiFile: null,
  midiBytes: null,
  sfzRegions: [],
  sfzReady: false,
  sfzLoadingPromise: null,
  sampleWarmupPromise: null,
  backendAvailable: false,
  backgroundImage: null,
  backgroundImageObjectUrl: "",
  backgroundImageDataUrl: "",
  backgroundFileName: "",
  backgroundWidth: 0,
  backgroundHeight: 0,
  backgroundBase: "default",
  noteColor: "#2de1b4",
  showGrid: false,
  visualEffect: [],
  fogQuality: "medium",
  examples: null,
  seeking: false,
  seekResumeAfterDrag: false,
  progressHideTimer: 0,
  progressMobileShowTimer: 0,
  lastPointerMoveAt: 0,
};

const keyboard = buildKeyboard();
const systemThemeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

if (typeof ResizeObserver !== "undefined") {
  const visualizerResizeObserver = new ResizeObserver(scheduleCanvasResize);
  visualizerResizeObserver.observe(canvas);
  visualizerResizeObserver.observe(visualizerCard);
}

window.addEventListener("resize", () => {
  syncMobileFullscreenAvailability();
  resizeCanvas();
  render();
});
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    syncMobileFullscreenAvailability();
    resizeCanvas();
    render();
  }, 120);
});
document.addEventListener("fullscreenchange", () => {
  updateFullscreenButtonText();
  resizeCanvas();
  render();
});
document.addEventListener("webkitfullscreenchange", () => {
  updateFullscreenButtonText();
  resizeCanvas();
  render();
});
menuToggleButton.addEventListener("click", () => {
  menuState.pinned = !menuState.pinned;
  if (menuState.pinned) {
    uploadState.open = false;
    customState.open = false;
    saveState.open = false;
    announcementState.open = false;
  }
  syncMenuState();
  syncUploadState();
  syncCustomState();
  syncSaveState();
  syncAnnouncementState();
});
menuOverlay.addEventListener("click", () => {
  menuState.pinned = false;
  syncMenuState({ focusToggle: true });
});
uploadToggleButton.addEventListener("click", () => {
  uploadState.open = !uploadState.open;
  if (uploadState.open) {
    menuState.pinned = false;
    customState.open = false;
    saveState.open = false;
    announcementState.open = false;
  }
  syncMenuState({ focusToggle: false });
  syncUploadState();
  syncCustomState();
  syncSaveState();
  syncAnnouncementState();
});
customToggleButton.addEventListener("click", () => {
  customState.open = !customState.open;
  if (customState.open) {
    menuState.pinned = false;
    uploadState.open = false;
    saveState.open = false;
    announcementState.open = false;
  }
  syncMenuState({ focusToggle: false });
  syncUploadState();
  syncCustomState();
  syncSaveState();
  syncAnnouncementState();
});
saveToggleButton.addEventListener("click", () => {
  saveState.open = !saveState.open;
  if (saveState.open) {
    menuState.pinned = false;
    uploadState.open = false;
    customState.open = false;
    announcementState.open = false;
  }
  syncMenuState({ focusToggle: false });
  syncUploadState();
  syncCustomState();
  syncSaveState();
  syncAnnouncementState();
});
announcementToggleButton.addEventListener("click", async () => {
  announcementState.open = !announcementState.open;
  if (announcementState.open) {
    menuState.pinned = false;
    uploadState.open = false;
    customState.open = false;
    saveState.open = false;
    syncMenuState({ focusToggle: false });
    syncUploadState();
    syncCustomState();
    syncSaveState();
    await ensureAnnouncementsLoaded();
  }
  syncAnnouncementState();
});
announcementDialogClose.addEventListener("click", () => {
  closeAnnouncementDialog();
});
announcementDialog.addEventListener("click", (event) => {
  if (event.target.classList.contains("announcement-dialog-backdrop")) {
    closeAnnouncementDialog();
  }
});
initTheme();
initLanguage();
syncMenuState({ focusToggle: false });
syncUploadState();
syncCustomState();
syncSaveState();
syncAnnouncementState();
syncAutoSustainControls();
syncEffectParameterControls();
ensureAnnouncementsLoaded();
updateSaveMenuAvailability();
resizeCanvas();
syncMobileFullscreenAvailability();
loadBundledPianoSource();
checkBackendAvailability();

for (const input of visualEffectInputs) {
  input.addEventListener("change", () => {
    setVisualEffect(input.value);
  });
}

for (const input of fogQualityInputs) {
  input.addEventListener("change", () => {
    state.fogQuality = normalizeFogQuality(input.value);
    syncEffectParameterControls();
    render();
  });
}

autoSustainToggle.addEventListener("change", () => {
  syncAutoSustainControls();
  refreshPlaybackForSustainChange();
});

autoSustainDuration.addEventListener("input", () => {
  autoSustainDurationValue.textContent = `${getAutoSustainSeconds().toFixed(2)}s`;
  queueSustainRefresh();
});

autoSustainDuration.addEventListener("change", () => {
  refreshPlaybackForSustainChange();
});

backgroundImageInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  await loadBackgroundFromFile(file);
});

backgroundImageInput.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    event.stopPropagation();
    backgroundImageInput.blur();
  }
});

backgroundImageInput.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    event.stopPropagation();
    backgroundImageInput.blur();
  }
});

backgroundImageRemoveButton.addEventListener("click", () => {
  clearBackgroundImage();
});

backgroundOpacity.addEventListener("input", () => {
  backgroundOpacityValue.textContent = getBackgroundOpacity().toFixed(2);
  render();
});

showGridToggle.addEventListener("change", () => {
  state.showGrid = showGridToggle.checked;
  render();
});

for (const input of backgroundBaseInputs) {
  input.addEventListener("change", () => {
    state.backgroundBase = normalizeBackgroundBase(input.value);
    syncBackgroundBaseControls();
    render();
  });
}

noteColorPicker.addEventListener("input", () => {
  setNoteColor(noteColorPicker.value);
});

for (const button of colorPresetButtons) {
  button.addEventListener("click", () => {
    setNoteColor(button.dataset.color || "#2de1b4");
  });
}

for (const input of themeModeInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      setThemePreference(input.value);
    }
  });
}

if (systemThemeQuery) {
  systemThemeQuery.addEventListener("change", () => {
    if (getThemePreference() === "system") {
      applyThemePreference("system");
    }
  });
}

for (const input of languageModeInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      setLanguagePreference(input.value);
    }
  });
}

midiExamplesButton.addEventListener("click", async () => {
  await toggleExamplePanel("midi");
});

imageExamplesButton.addEventListener("click", async () => {
  await toggleExamplePanel("image");
});

fullscreenButton.addEventListener("click", async () => {
  await toggleFullscreen();
});

visualizerStage.addEventListener("pointermove", () => {
  if (isMobileDevice()) {
    return;
  }
  state.lastPointerMoveAt = Date.now();
  showPlaybackControls();
  schedulePlaybackControlsHide(1000);
});

visualizerStage.addEventListener("pointerleave", () => {
  if (!isMobileDevice() && !state.seeking) {
    hidePlaybackControls();
  }
});

visualizerStage.addEventListener("pointerdown", () => {
  if (!isMobileDevice()) {
    return;
  }
  clearTimeout(state.progressMobileShowTimer);
  state.progressMobileShowTimer = window.setTimeout(() => {
    showPlaybackControls();
    schedulePlaybackControlsHide(2500);
  }, 200);
});

playbackControls.addEventListener("pointerenter", () => {
  if (!isMobileDevice()) {
    showPlaybackControls();
    clearTimeout(state.progressHideTimer);
  }
});

playbackControls.addEventListener("pointerleave", () => {
  if (!isMobileDevice() && !state.seeking) {
    schedulePlaybackControlsHide(1000);
  }
});

playbackProgress.addEventListener("input", () => {
  seekToProgress(Number(playbackProgress.value), { previewOnly: true });
});

playbackProgress.addEventListener("change", async () => {
  await commitProgressSeek(Number(playbackProgress.value));
});

playbackProgress.addEventListener("pointerdown", () => {
  if (!state.song) {
    return;
  }
  state.seeking = true;
  state.seekResumeAfterDrag = state.playing;
  stopPlayback(false);
  showPlaybackControls();
  clearTimeout(state.progressHideTimer);
});

playbackProgress.addEventListener("pointerup", async () => {
  if (!state.seeking) {
    return;
  }
  await commitProgressSeek(Number(playbackProgress.value));
});

playbackProgress.addEventListener("pointercancel", async () => {
  if (!state.seeking) {
    return;
  }
  await commitProgressSeek(Number(playbackProgress.value));
});

midiInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  await loadMidiFromFile(file);
});

toggleButton.addEventListener("click", () => {
  togglePlayback();
});

restartButton.addEventListener("click", async () => {
  if (!state.song) {
    return;
  }

  stopPlayback(false);
  state.pauseOffset = 0;
  syncPlaybackProgress(0);
  await startPlayback();
});

exportButton.addEventListener("click", async () => {
  await exportAnimation();
});

window.addEventListener("keydown", async (event) => {
  if (event.code === "Escape" && isMobilePseudoFullscreen()) {
    exitMobilePseudoFullscreen();
    return;
  }

  if (event.code === "Escape" && !announcementDialog.hidden) {
    closeAnnouncementDialog();
    return;
  }

  if (event.code === "Escape" && document.body.classList.contains("announcement-expanded")) {
    announcementState.open = false;
    syncAnnouncementState({ focusToggle: true });
    return;
  }

  if (event.code === "Escape" && document.body.classList.contains("save-expanded")) {
    saveState.open = false;
    syncSaveState({ focusToggle: true });
    return;
  }

  if (event.code === "Escape" && document.body.classList.contains("custom-expanded")) {
    customState.open = false;
    syncCustomState({ focusToggle: true });
    return;
  }

  if (event.code === "Escape" && document.body.classList.contains("upload-expanded")) {
    uploadState.open = false;
    syncUploadState({ focusToggle: true });
    return;
  }

  if (event.code === "Escape" && document.body.classList.contains("menu-expanded")) {
    menuState.pinned = false;
    syncMenuState({ focusToggle: true });
    return;
  }

  if (event.code !== "Space") {
    return;
  }

  const targetTag = event.target?.tagName;
  if (targetTag === "INPUT" || targetTag === "TEXTAREA" || event.repeat) {
    return;
  }

  event.preventDefault();
  await togglePlayback();
});

function syncMenuState(options = {}) {
  const isOpen = menuState.pinned;
  settingsMenu.hidden = false;
  menuOverlay.hidden = true;
  document.body.classList.toggle("menu-expanded", isOpen);
  document.body.classList.toggle("menu-pinned", menuState.pinned);
  menuToggleButton.setAttribute("aria-expanded", String(isOpen));
  menuToggleButton.setAttribute("aria-pressed", String(menuState.pinned));

  if (isOpen) {
    return;
  }
  if (options.focusToggle !== false) {
    menuToggleButton.focus();
  }
}

function syncUploadState(options = {}) {
  const isOpen = uploadState.open;
  uploadPanel.hidden = false;
  document.body.classList.toggle("upload-expanded", isOpen);
  uploadToggleButton.setAttribute("aria-expanded", String(isOpen));
  uploadToggleButton.setAttribute("aria-pressed", String(isOpen));

  if (isOpen) {
    return;
  }
  if (options.focusToggle) {
    uploadToggleButton.focus();
  }
}

function syncCustomState(options = {}) {
  const isOpen = customState.open;
  customPanel.hidden = false;
  document.body.classList.toggle("custom-expanded", isOpen);
  customToggleButton.setAttribute("aria-expanded", String(isOpen));
  customToggleButton.setAttribute("aria-pressed", String(isOpen));

  if (isOpen) {
    return;
  }
  if (options.focusToggle) {
    customToggleButton.focus();
  }
}

function syncSaveState(options = {}) {
  const isOpen = saveState.open;
  savePanel.hidden = false;
  document.body.classList.toggle("save-expanded", isOpen);
  saveToggleButton.setAttribute("aria-expanded", String(isOpen));
  saveToggleButton.setAttribute("aria-pressed", String(isOpen));

  if (isOpen) {
    return;
  }
  if (options.focusToggle) {
    saveToggleButton.focus();
  }
}

function syncAnnouncementState(options = {}) {
  const isOpen = announcementState.open;
  announcementPanel.hidden = false;
  document.body.classList.toggle("announcement-expanded", isOpen);
  announcementToggleButton.setAttribute("aria-expanded", String(isOpen));
  announcementToggleButton.setAttribute("aria-pressed", String(isOpen));

  if (isOpen) {
    return;
  }
  if (options.focusToggle) {
    announcementToggleButton.focus();
  }
}

async function ensureAnnouncementsLoaded() {
  if (announcementState.items.length) {
    return announcementState.items;
  }

  try {
    const response = await fetch("assets/announcement/announcements.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`announcements ${response.status}`);
    }
    const data = await response.json();
    announcementState.items = normalizeAnnouncements(data);
    renderAnnouncementList();
  } catch (error) {
    console.error("Failed to load announcements.", error);
    announcementList.innerHTML = '<p class="announcement-empty">公告读取失败</p>';
  }

  return announcementState.items;
}

function normalizeAnnouncements(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((item) => item && item.valid === true)
    .map((item) => ({
      id: String(item.id || ""),
      title: String(item.title || "未命名公告"),
      content: String(item.content || ""),
      date: String(item.date || ""),
    }))
    .sort((a, b) => getAnnouncementTime(b.date) - getAnnouncementTime(a.date));
}

function getAnnouncementTime(date) {
  const time = Date.parse(date);
  return Number.isFinite(time) ? time : 0;
}

function renderAnnouncementList() {
  announcementList.textContent = "";

  if (!announcementState.items.length) {
    const empty = document.createElement("p");
    empty.className = "announcement-empty";
    empty.textContent = "暂无有效公告";
    announcementList.appendChild(empty);
    return;
  }

  for (const announcement of announcementState.items) {
    const button = document.createElement("button");
    button.className = "announcement-item";
    button.type = "button";
    button.dataset.announcementId = announcement.id;

    const title = document.createElement("span");
    title.className = "announcement-item-title";
    title.textContent = announcement.title;

    const date = document.createElement("time");
    date.className = "announcement-item-date";
    date.dateTime = announcement.date;
    date.textContent = announcement.date;

    button.append(title, date);
    button.addEventListener("click", () => {
      openAnnouncementDialog(announcement.id);
    });
    announcementList.appendChild(button);
  }
}

function openAnnouncementDialog(id) {
  const announcement = announcementState.items.find((item) => item.id === id);
  if (!announcement) {
    return;
  }

  announcementDialogTitle.textContent = announcement.title;
  announcementDialogDate.textContent = announcement.date;
  announcementDialogDate.dateTime = announcement.date;
  announcementDialogContent.textContent = announcement.content;
  announcementDialog.hidden = false;
  announcementDialogClose.focus();
}

function closeAnnouncementDialog() {
  announcementDialog.hidden = true;
  if (document.body.classList.contains("announcement-expanded")) {
    announcementToggleButton.focus();
  }
}

function updateSaveMenuAvailability() {
  const canSave = Boolean(state.midiFile && state.song);
  saveMenuSection.disabled = !canSave;
  exportButton.disabled = !canSave;
}

function syncAutoSustainControls() {
  const enabled = autoSustainToggle.checked;
  autoSustainDuration.disabled = !enabled;
  autoSustainDurationOption.classList.toggle("is-disabled", !enabled);
  autoSustainDurationOption.setAttribute("aria-disabled", String(!enabled));
  autoSustainDurationValue.textContent = `${getAutoSustainSeconds().toFixed(2)}s`;
}

function showPlaybackControls() {
  playbackControls.classList.add("is-visible");
  playbackControls.setAttribute("aria-hidden", "false");
}

function hidePlaybackControls() {
  if (state.seeking) {
    return;
  }
  playbackControls.classList.remove("is-visible");
  playbackControls.setAttribute("aria-hidden", "true");
  clearTimeout(state.progressHideTimer);
}

function schedulePlaybackControlsHide(delay) {
  clearTimeout(state.progressHideTimer);
  state.progressHideTimer = window.setTimeout(() => {
    if (state.seeking) {
      return;
    }
    if (!isMobileDevice() && Date.now() - state.lastPointerMoveAt < delay - 16) {
      schedulePlaybackControlsHide(delay);
      return;
    }
    hidePlaybackControls();
  }, delay);
}

function syncPlaybackProgress(currentTime = getDisplaySongTime()) {
  const duration = getSongPlaybackDuration();
  playbackProgress.max = duration ? duration.toFixed(2) : "0";
  playbackProgress.disabled = !state.song;
  if (!state.seeking) {
    playbackProgress.value = Math.min(duration, Math.max(0, currentTime)).toFixed(2);
  }
}

function getDisplaySongTime() {
  if (!state.song) {
    return 0;
  }
  return state.playing ? getCurrentSongTime() : state.pauseOffset;
}

function seekToProgress(time, { previewOnly = false } = {}) {
  if (!state.song) {
    return;
  }
  const duration = getSongPlaybackDuration();
  const nextTime = Math.min(duration, Math.max(0, Number(time) || 0));
  state.pauseOffset = nextTime;
  state.activeVelocities = getActiveVelocitiesAt(nextTime);
  syncPlaybackProgress(nextTime);
  render();
  if (!previewOnly && state.seekResumeAfterDrag) {
    return startPlayback();
  }
  return Promise.resolve();
}

async function commitProgressSeek(time) {
  const shouldResume = state.seekResumeAfterDrag;
  state.seeking = false;
  state.seekResumeAfterDrag = false;
  seekToProgress(time, { previewOnly: true });
  if (shouldResume) {
    await startPlayback();
  }
  showPlaybackControls();
  schedulePlaybackControlsHide(isMobileDevice() ? 2500 : 1000);
}

function initTheme() {
  const preference = getThemePreference();
  for (const input of themeModeInputs) {
    input.checked = input.value === preference;
  }
  applyThemePreference(preference);
}

function getThemePreference() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return ["system", "light", "dark"].includes(stored) ? stored : "system";
}

function setThemePreference(preference) {
  const normalized = ["system", "light", "dark"].includes(preference) ? preference : "system";
  localStorage.setItem(THEME_STORAGE_KEY, normalized);
  applyThemePreference(normalized);
}

function applyThemePreference(preference) {
  const resolvedTheme = resolveTheme(preference);
  document.documentElement.dataset.theme = resolvedTheme;
}

function resolveTheme(preference) {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  if (!systemThemeQuery) {
    return "light";
  }
  return systemThemeQuery.matches ? "dark" : "light";
}

function initLanguage() {
  const preference = getLanguagePreference();
  for (const input of languageModeInputs) {
    input.checked = input.value === preference;
  }
  applyLanguagePreference(preference);
}

function getLanguagePreference() {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return ["system", "zh", "en"].includes(stored) ? stored : "system";
}

function setLanguagePreference(preference) {
  const normalized = ["system", "zh", "en"].includes(preference) ? preference : "system";
  localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  applyLanguagePreference(normalized);
}

function applyLanguagePreference(preference) {
  const language = resolveLanguage(preference);
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.language = language;
  translateStaticText();
  refreshDynamicLanguageText();
  render();
}

function resolveLanguage(preference) {
  if (preference === "zh" || preference === "en") {
    return preference;
  }
  const browserLanguage = navigator.language || navigator.userLanguage || "";
  if (!browserLanguage) {
    return "zh";
  }
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(key, params = {}) {
  const language = document.documentElement.dataset.language || "zh";
  const template = I18N[language]?.[key] || I18N.zh[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? "");
}

function translateStaticText() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }

  for (const element of document.querySelectorAll("[data-i18n-attr]")) {
    const pairs = element.dataset.i18nAttr.split(",");
    for (const pair of pairs) {
      const [attribute, key] = pair.split(":").map((value) => value.trim());
      if (attribute && key) {
        element.setAttribute(attribute, t(key));
      }
    }
  }
}

function refreshDynamicLanguageText() {
  if (!state.midiFile) {
    fileNameEl.textContent = t("notLoaded");
  }
  if (!state.song) {
    playStateEl.textContent = t("waitingUpload");
    durationEl.textContent = "0.00s";
  }
  syncBackgroundImageControls();
  if (state.examples) {
    if (!midiExamplePanel.hidden) {
      renderExampleList("midi");
    }
    if (!imageExamplePanel.hidden) {
      renderExampleList("image");
    }
  }
  updateFullscreenButtonText();
}

function syncBackgroundImageControls() {
  const hasBackgroundImage = Boolean(state.backgroundImage);
  backgroundImageButton.textContent = hasBackgroundImage ? t("changeBackground") : t("uploadBackground");
  backgroundImageRemoveButton.hidden = !hasBackgroundImage;
  backgroundOpacity.disabled = !hasBackgroundImage;
  backgroundOpacityOption.classList.toggle("is-disabled", !hasBackgroundImage);
  backgroundOpacityOption.setAttribute("aria-disabled", String(!hasBackgroundImage));

  if (!hasBackgroundImage) {
    backgroundImageState.textContent = t("noBackground");
    return;
  }

  backgroundImageState.textContent = t("backgroundLoaded", {
    name: state.backgroundFileName,
    width: state.backgroundWidth,
    height: state.backgroundHeight,
  });
}

function normalizeBackgroundBase(value) {
  return value === "black" ? "black" : "default";
}

function syncBackgroundBaseControls() {
  state.backgroundBase = normalizeBackgroundBase(state.backgroundBase);
  for (const input of backgroundBaseInputs) {
    input.checked = input.value === state.backgroundBase;
  }
}

function clearBackgroundImage() {
  if (state.backgroundImageObjectUrl) {
    URL.revokeObjectURL(state.backgroundImageObjectUrl);
  }

  state.backgroundImage = null;
  state.backgroundImageObjectUrl = "";
  state.backgroundImageDataUrl = "";
  state.backgroundFileName = "";
  state.backgroundWidth = 0;
  state.backgroundHeight = 0;
  backgroundImageInput.value = "";
  syncBackgroundImageControls();
  render();
  requestAnimationFrame(render);
}

async function toggleFullscreen() {
  try {
    if (isMobilePseudoFullscreen()) {
      exitMobilePseudoFullscreen();
      return;
    }

    if (isMobileDevice()) {
      if (!isLandscapeViewport()) {
        syncMobileFullscreenAvailability();
        return;
      }
      await enterMobilePseudoFullscreen();
      return;
    }

    if (!getFullscreenElement()) {
      const requestFullscreen =
        visualizerCard.requestFullscreen ||
        visualizerCard.webkitRequestFullscreen ||
        visualizerCard.msRequestFullscreen;
      if (!requestFullscreen) {
        alert(t("fullscreenUnsupported"));
        return;
      }
      await requestFullscreen.call(visualizerCard);
      return;
    }

    const exitFullscreen =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.msExitFullscreen;
    if (exitFullscreen) {
      await exitFullscreen.call(document);
    }
  } catch (error) {
    console.error(error);
    alert(`${t("fullscreenFailed")}：${error.message}`);
  }
}

function updateFullscreenButtonText() {
  fullscreenButton.setAttribute("aria-label", getFullscreenElement() || isMobilePseudoFullscreen() ? t("exitFullscreen") : t("fullscreen"));
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
}

function isMobileDevice() {
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  const narrowScreen = Math.min(window.innerWidth, window.innerHeight) <= 820;
  const mobileAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return Boolean((coarsePointer && narrowScreen) || mobileAgent);
}

async function enterMobilePseudoFullscreen() {
  if (!isLandscapeViewport()) {
    syncMobileFullscreenAvailability();
    return;
  }

  document.body.classList.add("mobile-fullscreen-active");
  visualizerCard.classList.add("is-mobile-fullscreen");
  updateFullscreenButtonText();
  requestAnimationFrame(() => {
    resizeCanvas();
    render();
  });
}

function exitMobilePseudoFullscreen() {
  document.body.classList.remove("mobile-fullscreen-active");
  visualizerCard.classList.remove("is-mobile-fullscreen");
  updateFullscreenButtonText();
  requestAnimationFrame(() => {
    resizeCanvas();
    render();
  });
}

function isMobilePseudoFullscreen() {
  return visualizerCard.classList.contains("is-mobile-fullscreen");
}

function isLandscapeViewport() {
  return window.innerWidth > window.innerHeight;
}

function syncMobileFullscreenAvailability() {
  if (!isMobileDevice()) {
    fullscreenButton.hidden = false;
    return;
  }

  const canUseMobileFullscreen = isLandscapeViewport();
  fullscreenButton.hidden = !canUseMobileFullscreen;

  if (!canUseMobileFullscreen && isMobilePseudoFullscreen()) {
    exitMobilePseudoFullscreen();
  }
}

function setNoteColor(color) {
  const normalizedColor = normalizeHexColor(color) || "#2de1b4";
  state.noteColor = normalizedColor;
  noteColorPicker.value = normalizedColor;
  playbackProgress.style.accentColor = normalizedColor;

  for (const button of colorPresetButtons) {
    button.classList.toggle("is-selected", button.dataset.color?.toLowerCase() === normalizedColor);
  }

  render();
}

function setVisualEffect(effect) {
  const allowedEffects = ["trail", "glow", "fog", "stream", "colorShift"];
  if (effect === "none") {
    state.visualEffect = [];
  } else {
    const selected = new Set(normalizeVisualEffects(state.visualEffect));
    if (allowedEffects.includes(effect)) {
      if (selected.has(effect)) {
        selected.delete(effect);
      } else {
        selected.add(effect);
      }
    }
    state.visualEffect = Array.from(selected);
  }
  for (const input of visualEffectInputs) {
    input.checked = input.value === "none"
      ? state.visualEffect.length === 0
      : state.visualEffect.includes(input.value);
  }
  syncEffectParameterControls();
  render();
}

function normalizeFogQuality(value) {
  return ["low", "medium", "high"].includes(value) ? value : "high";
}

function syncEffectParameterControls() {
  state.fogQuality = normalizeFogQuality(state.fogQuality);
  const fogEnabled = normalizeVisualEffects(state.visualEffect).includes("fog");
  if (fogQualityFieldset) {
    fogQualityFieldset.disabled = !fogEnabled;
  }
  for (const input of fogQualityInputs) {
    input.checked = input.value === state.fogQuality;
  }
}

function normalizeVisualEffects(effects) {
  const allowedEffects = new Set(["trail", "glow", "fog", "stream", "colorShift"]);
  if (Array.isArray(effects)) {
    return effects.filter((effect) => allowedEffects.has(effect));
  }
  return allowedEffects.has(effects) ? [effects] : [];
}

syncPlaybackProgress(0);
render();
