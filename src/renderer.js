const $ = selector => document.querySelector(selector);
const audioLogic = window.AudioControlLogic;
// Bump whenever silence detection changes so old cue points are never reused.
const analysisVersion = 5;
// Full decoding expands compressed audio dramatically. Keep the analysis bounded.
const maxAnalysisBytes = 24 * 1024 * 1024;
const maxUnknownDurationBytes = 8 * 1024 * 1024;
const fileUrl = filePath => window.dj.fileUrl(filePath);
const formatTime = seconds => {
  seconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};
const nameOf = filePath => filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
const makeTrack = path => ({ path, name: nameOf(path), volume: 100, repeat: false, pinned: false, duration: 0, addedAt: Date.now(), cuePosition: null, manualCue: false });
const normalizeTrack = item => ({ ...makeTrack(item.path || item), ...item, addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : 0, cuePosition: Number.isFinite(item.cuePosition) ? item.cuePosition : null, manualCue: Boolean(item.manualCue) });
function sortLibrary() {
  const direction = state.librarySortDirection === 'desc' ? -1 : 1;
  state.library.sort((a, b) => {
    const pinned = Number(b.pinned) - Number(a.pinned);
    if (pinned) return pinned;
    const compared = state.librarySort === 'date'
      ? (Number(a.addedAt) - Number(b.addedAt))
      : state.librarySort === 'duration'
        ? ((Number(a.duration) || Number.MAX_SAFE_INTEGER) - (Number(b.duration) || Number.MAX_SAFE_INTEGER))
        : a.name.localeCompare(b.name, 'vi');
    return compared * direction || a.name.localeCompare(b.name, 'vi');
  });
}

const state = Vue.reactive({
  library: [], queue: [], selectedLibraryTrackId: null, selectedQueueTrackId: null,
  previewTrackId: null, playingTrackId: null, active: null, playbackState: 'stopped',
  previewAnalysis: null, activeAnalysis: null, audioCache: Vue.markRaw({}), sync: false, autoTrim: true,
  pitch: true, tempo: 100, masterVolume: 100, previewVolume: 50, fadeDuration: .45, waveformMinutes: 30, panelSplit: .5, librarySort: 'name', librarySortDirection: 'asc',
  eq: { bands: [80, 250, 1000, 4000, 10000].map((frequency, i) => ({ frequency, gain: 0, q: 1, type: i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking' })) }, outputMain: 'default', outputNext: 'default'
});
let activeDeck = new Audio();
let standbyDeck = new Audio();
const previewDeck = new Audio();
previewDeck.preload = 'metadata';
previewDeck.volume = .5;
let previewToken = 0, previewLoadedPath = null, mainOutputApplied = null, previewFadeFrame = 0;
let mainOutputBridge = null;
let audioContext, outputLimiter, meterFrame = 0, visualDecayFrame = 0, visualRiseFrame = 0, waveformPulseFrame = 0, toastTimer, fadeTimer, draggedItem = null, volumeAdjusting = false, queuePointerDrag = null;
let spectrumFadeLevel = 0;
const transitionGuard = new PlaybackTransitionGuard();
let crossfadeTimer = 0;
let waveformScrubTime = null;
let longTrackScrubTime = null;
let previewCueScrubTime = null;
let eqDragBand = null;
let eqFrame = 0;
const OUTPUT_GAIN_CEILING = 1; // 0 dB — never amplify above the original file level.
const graphs = new WeakMap();
const analysisPromises = new Map();
const backgroundPreload = { queue: [], queuedPaths: new Set(), running: false, completed: 0, total: 0 };
const analyzerWorker = new Worker('analyzer-worker.js');
let workerSequence = 0;
const workerRequests = new Map();
analyzerWorker.onmessage = ({ data }) => {
  const request = workerRequests.get(data.id);
  if (!request) return;
  workerRequests.delete(data.id);
  request.resolve(data);
};
analyzerWorker.onerror = error => {
  for (const { reject } of workerRequests.values()) reject(error);
  workerRequests.clear();
};

[activeDeck, standbyDeck].forEach(deck => { deck.preload = 'auto'; deck.crossOrigin = 'anonymous'; });

function getTrack(collection, path) { return collection.find(item => item.path === path) || null; }
function getQueueTrack(path) { return getTrack(state.queue, path); }
function cacheFor(path) { return state.audioCache[path] || null; }
function saveSoon() { clearTimeout(saveSoon.timer); saveSoon.timer = setTimeout(saveState, 180); }
async function saveState() {
  await window.dj.saveState(JSON.parse(JSON.stringify({
    library: state.library, queue: state.queue, audioCache: state.audioCache, tempo: state.tempo,
    autoTrim: state.autoTrim, sync: state.sync, pitch: state.pitch, masterVolume: state.masterVolume, previewVolume: state.previewVolume, fadeDuration: state.fadeDuration, waveformMinutes: state.waveformMinutes, panelSplit: state.panelSplit, librarySort: state.librarySort, librarySortDirection: state.librarySortDirection, eq: state.eq, outputMain: state.outputMain, outputNext: state.outputNext
  })));
}
function setStatus(label, kind = state.playbackState) {
  ui.status = label; ui.statusKind = kind;
}
function toast(message, duration = 1800) {
  clearTimeout(toastTimer); ui.toast = message;
  if (duration > 0) toastTimer = setTimeout(() => { ui.toast = ''; }, duration);
}

function graphFor(deck) {
  audioContext ??= new AudioContext();
  if (graphs.has(deck)) return graphs.get(deck);
  if (!outputLimiter) {
    outputLimiter = audioContext.createDynamicsCompressor();
    outputLimiter.threshold.value = -2; outputLimiter.knee.value = 0;
    outputLimiter.ratio.value = 20; outputLimiter.attack.value = .003; outputLimiter.release.value = .12;
    outputLimiter.connect(mainOutputBridge?.connected ? mainOutputBridge.destination : audioContext.destination);
  }
  const source = audioContext.createMediaElementSource(deck);
  const filters = [audioContext.createBiquadFilter(), audioContext.createBiquadFilter(), audioContext.createBiquadFilter(), audioContext.createBiquadFilter(), audioContext.createBiquadFilter()];
  const headroom = audioContext.createGain(), makeup = audioContext.createGain(), gain = audioContext.createGain(), splitter = audioContext.createChannelSplitter(2);
  const left = audioContext.createAnalyser(), right = audioContext.createAnalyser();
  const spectrum = audioContext.createAnalyser(); spectrum.fftSize = 16384; spectrum.smoothingTimeConstant = .8;
  left.fftSize = right.fftSize = 1024; left.smoothingTimeConstant = right.smoothingTimeConstant = .78;
  // A new GainNode defaults to 1. Start silent so no full-volume audio can
  // escape while the saved master/track volume is still being restored.
  gain.gain.value = 0;
  headroom.gain.value = .5; makeup.gain.value = 2;
  let tail = source.connect(headroom); filters.forEach(filter => { tail = tail.connect(filter); }); tail.connect(makeup); makeup.connect(spectrum); makeup.connect(gain).connect(outputLimiter);
  gain.connect(splitter); splitter.connect(left, 0); splitter.connect(right, 1);
  const graph = { headroom, makeup, gain, filters, spectrum, spectrumData: new Float32Array(spectrum.frequencyBinCount), left, right, leftData: new Uint8Array(left.fftSize), rightData: new Uint8Array(right.fftSize), peaks: [0, 0] };
  graphs.set(deck, graph); return graph;
}
function targetGain(track) {
  const requested = ((track?.volume ?? 100) / 100) * (state.masterVolume / 100);
  return Math.max(0, Math.min(OUTPUT_GAIN_CEILING, requested));
}
function applyTone() {
  for (const deck of [activeDeck, standbyDeck]) {
    const graph = graphFor(deck);
    const now = audioContext.currentTime;
    graph.filters.forEach((filter, index) => {
      const band = state.eq.bands[index];
      filter.type = band.type;
      filter.frequency.setTargetAtTime(Math.min(band.frequency, audioContext.sampleRate / 2), now, .02);
      filter.Q.setTargetAtTime(band.q, now, .02);
      filter.gain.setTargetAtTime(band.gain, now, .02);
    });
  }
}
function setGain(deck, value, ramp = .04) {
  const gain = graphFor(deck).gain.gain, now = audioContext.currentTime;
  const safeValue = Math.max(0, Math.min(OUTPUT_GAIN_CEILING, value));
  gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); gain.linearRampToValueAtTime(safeValue, now + ramp);
}
function runAnalysisWorker(samples, sampleRate) {
  return new Promise((resolve, reject) => {
    const id = ++workerSequence; workerRequests.set(id, { resolve, reject });
    analyzerWorker.postMessage({ id, samples, sampleRate }, [samples]);
  });
}
function readTrackDuration(path) {
  return new Promise(resolve => {
    const probe = new Audio();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      probe.removeAttribute('src');
      probe.load();
      resolve(duration);
    };
    const timer = setTimeout(finish, 8000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = finish;
    probe.onerror = finish;
    probe.src = fileUrl(path);
  });
}
async function analyzeTrack(track) {
  if (!track?.path) return null;
  if (analysisPromises.has(track.path)) return analysisPromises.get(track.path);
  const job = (async () => {
    try {
      const meta = await window.dj.audioMeta(track.path);
      const cached = cacheFor(track.path);
      if (cached && cached.analysisVersion === analysisVersion && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size && (cached.limitedReason !== 'duration' || cached.duration > state.waveformMinutes * 60) && (cached.analysisLimited || !(cached.duration > state.waveformMinutes * 60))) {
        track.duration = cached.duration || track.duration;
        track.bpm = cached.bpm || track.bpm || null;
        return Vue.markRaw(cached);
      }
      const duration = (cached?.mtimeMs === meta.mtimeMs && cached?.size === meta.size && cached.duration) || await readTrackDuration(track.path);
      const tooLarge = duration > state.waveformMinutes * 60 || (!duration && meta.size > maxUnknownDurationBytes);
      if (tooLarge) {
        const limited = Vue.markRaw({ analysisVersion, mtimeMs: meta.mtimeMs, size: meta.size,
          duration: duration || track.duration || 0, audibleStart: 0, audibleEnd: duration || track.duration || 0,
          bpm: null, peaks: [], analysisLimited: true, limitedReason: duration ? 'duration' : 'unknown' });
        state.audioCache[track.path] = limited;
        track.duration = limited.duration;
        saveSoon();
        return limited;
      }
      let result, decodedDuration;
      if (duration > 300 || meta.size > maxAnalysisBytes) {
        const compact = await window.dj.waveformSamples(track.path);
        const channel = Float32Array.from(compact.samples);
        result = await runAnalysisWorker(channel.buffer, compact.sampleRate);
        decodedDuration = duration || channel.length / compact.sampleRate;
        // Coarse peaks are suited to waveform drawing, not precise automatic trim.
        result.audibleStart = 0; result.audibleEnd = decodedDuration;
      } else {
        audioContext ??= new AudioContext();
        const raw = await window.dj.readAudio(track.path);
        const exact = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw;
        const decoded = await audioContext.decodeAudioData(exact);
        const channel = decoded.getChannelData(0).slice().buffer;
        result = await runAnalysisWorker(channel, decoded.sampleRate);
        decodedDuration = decoded.duration;
      }
      const analysis = { ...result, analysisVersion, duration: decodedDuration, mtimeMs: meta.mtimeMs, size: meta.size };
      Vue.markRaw(analysis);
      state.audioCache[track.path] = analysis;
      track.duration = decodedDuration; track.bpm = result.bpm || track.bpm || null;
      saveSoon();
      return analysis;
    } catch (error) {
      console.warn('Không thể phân tích audio:', track.path, error);
      return { peaks: [], analysisLimited: true, duration: track.duration || 0, audibleStart: 0, audibleEnd: track.duration || 0, bpm: track.bpm || null };
    } finally { analysisPromises.delete(track.path); }
  })();
  analysisPromises.set(track.path, job); return job;
}

function drawWaveform() {
  const canvas = $('#waveform'), rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr)), pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  // Resetting dimensions clears a canvas, so resize only after a real layout/DPI change.
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  const analysis = state.activeAnalysis;
  const peaks = analysis?.peaks || [];
  const width = rect.width, height = rect.height, mid = height / 2;
  ctx.fillStyle = '#111111'; ctx.fillRect(0, 0, width, height);
  if (!peaks.length) return;
  const columns = Math.min(164, peaks.length), bar = width / columns;
  const visibleTime = waveformScrubTime ?? activeDeck.currentTime;
  const progressX = activeDeck.duration ? Math.min(width, Math.max(0, visibleTime / activeDeck.duration * width)) : 0;
  ctx.fillStyle = '#d9d9d9';
  for (let index = 0; index < columns; index++) {
    const sourceIndex = Math.floor(index / columns * peaks.length);
    const peak = peaks[sourceIndex] || 0;
    const h = Math.max(2.5, peak * (height - 26)), barWidth = Math.min(4, bar * .48);
    const x = index * bar + (bar - barWidth) / 2;
    ctx.beginPath(); ctx.roundRect(x, mid - h / 2, barWidth, h, barWidth / 2); ctx.fill();
  }
  // Paint the progress light above the waveform so its white breathing is
  // visible on the bars themselves, not hidden behind opaque pixels.
  if (progressX > 0) {
    const breath = .15 + ((Math.sin(performance.now() / 500) + 1) / 2) * .16;
    const progressGlow = ctx.createLinearGradient(0, 0, progressX, 0);
    progressGlow.addColorStop(0, `rgba(255,255,255,${breath * .22})`);
    progressGlow.addColorStop(.68, `rgba(255,255,255,${breath * .58})`);
    progressGlow.addColorStop(1, `rgba(255,255,255,${breath})`);
    ctx.save(); ctx.fillStyle = progressGlow; ctx.shadowColor = `rgba(255,255,255,${breath * .9})`; ctx.shadowBlur = 14;
    ctx.fillRect(0, 0, progressX, height); ctx.restore();
  }
  if (activeDeck.duration) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(progressX, 0); ctx.lineTo(progressX, height); ctx.stroke();
  }
}
function updateTime(visibleTime = activeDeck.currentTime) {
  const duration = Number.isFinite(activeDeck.duration) ? activeDeck.duration : (state.active?.duration || 0);
  ui.elapsedText = formatTime(visibleTime);
  ui.durationText = formatTime(duration);
  ui.time = ui.elapsedText + ' / ' + ui.durationText;
  ui.playbackProgress = duration > 0 ? Math.max(0, Math.min(100, visibleTime / duration * 100)) : 0;
}
function updateWaveHeader() { updateTime(); }
function updatePreviewHeader() {
 const preview=state.previewTrackId ? getQueueTrack(state.previewTrackId) : null; const analysis=state.previewAnalysis;
 const cue=Number.isFinite(previewCueScrubTime) ? previewCueScrubTime : ui.previewPlaying && previewLoadedPath === preview?.path ? previewDeck.currentTime : preview ? ((preview.manualCue ? preview.cuePosition : (state.autoTrim ? analysis?.audibleStart : 0)) || 0) : 0;
 const duration = analysis?.duration || preview?.duration || 0;
 ui.previewTime = formatTime(cue) + ' / ' + formatTime(duration);
 ui.previewProgress = duration > 0 ? Math.max(0, Math.min(100, cue / duration * 100)) : 0;
}
function drawPreviewWaveform() {
  const canvas = $('#preview-waveform'), rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr)), pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  const preview = state.previewTrackId ? getQueueTrack(state.previewTrackId) : null;
  const peaks = state.previewAnalysis?.peaks || [], width = rect.width, height = rect.height, mid = height / 2;
  ctx.fillStyle = '#121212'; ctx.fillRect(0, 0, width, height);
  if (!peaks.length) return;
  const columns = Math.min(164, peaks.length), bar = width / columns;
  ctx.fillStyle = '#a9a9a9';
  for (let index = 0; index < columns; index++) {
    const peak = peaks[Math.floor(index / columns * peaks.length)] || 0;
    const h = Math.max(2.5, peak * (height - 20)), barWidth = Math.min(4, bar * .48), x = index * bar + (bar - barWidth) / 2;
    ctx.beginPath(); ctx.roundRect(x, mid - h / 2, barWidth, h, barWidth / 2); ctx.fill();
  }
  if (preview) {
    const cue = Number.isFinite(previewCueScrubTime) ? previewCueScrubTime : ((preview.manualCue ? preview.cuePosition : (state.autoTrim ? state.previewAnalysis?.audibleStart : 0)) || 0);
    const duration = state.previewAnalysis?.duration || preview.duration;
    if (duration) {
      const x = Math.min(width, Math.max(0, cue / duration * width));
      if (x > 0) {
        const breath = .15 + ((Math.sin(performance.now() / 500) + 1) / 2) * .16;
        const progressGlow = ctx.createLinearGradient(0, 0, x, 0);
        progressGlow.addColorStop(0, `rgba(255,255,255,${breath * .22})`);
        progressGlow.addColorStop(.68, `rgba(255,255,255,${breath * .58})`);
        progressGlow.addColorStop(1, `rgba(255,255,255,${breath})`);
        ctx.save(); ctx.fillStyle = progressGlow; ctx.shadowColor = `rgba(255,255,255,${breath * .9})`; ctx.shadowBlur = 12;
        ctx.fillRect(0, 0, x, height); ctx.restore();
      }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
  }
}

function renderControls() { window.dj.setQuickControlState({ playbackState: state.playbackState, hasTrack: Boolean(state.active) }); }
function renderAll() { renderControls(); updateWaveHeader(); updatePreviewHeader(); drawWaveform(); drawPreviewWaveform(); drawEqCurve(); }
// Vue v-show updates in a microtask. Redraw a newly revealed waveform after the
// DOM has its final width even if playback is paused (no animation loop running).
Vue.watch(() => state.activeAnalysis?.peaks?.length || 0, () => { Vue.nextTick(drawWaveform); });
Vue.watch(() => state.previewAnalysis?.peaks?.length || 0, () => { Vue.nextTick(drawPreviewWaveform); });

async function previewQueue(item) {
  if (state.previewTrackId !== item.path) stopPreview();
  state.selectedQueueTrackId = item.path; state.previewTrackId = item.path; state.previewAnalysis = null;
  updatePreviewHeader(); drawPreviewWaveform();
  const analysis = await analyzeTrack(item);
  if (state.previewTrackId !== item.path) return;
  state.previewAnalysis = analysis; item.duration = analysis.duration || item.duration; item.bpm = analysis.bpm || item.bpm;
  updatePreviewHeader(); drawPreviewWaveform(); saveSoon();
}
function nextQueueItem(currentPath) {
  if (!state.queue.length) return null;
  const index = state.queue.findIndex(item => item.path === currentPath);
  return state.queue[index < 0 ? 0 : (index + 1) % state.queue.length];
}
async function showNextPreview(currentPath) {
  stopPreview();
  const next = nextQueueItem(currentPath);
  state.previewTrackId = next?.path || null; state.previewAnalysis = null;
  updatePreviewHeader(); drawPreviewWaveform(); 
  if (!next) return;
  const analysis = await analyzeTrack(next);
  if (state.previewTrackId !== next.path) return;
  state.previewAnalysis = analysis; next.duration = analysis.duration || next.duration; next.bpm = analysis.bpm || next.bpm;
  updatePreviewHeader(); drawPreviewWaveform(); saveSoon();
}
function cuePositionFor(item, analysis) {
  return audioLogic.cuePosition(item, analysis, state.autoTrim);
}
function trimEndFor(item, analysis, duration) {
  return audioLogic.trimEnd(analysis, duration || item?.duration || 0, state.autoTrim);
}
function applyTrimToActiveTrack() {
  if (!state.active || !state.autoTrim) return false;
  const start = cuePositionFor(state.active, state.activeAnalysis);
  if (start <= activeDeck.currentTime + .05) return false;
  activeDeck.currentTime = Math.min(start, Math.max(0, activeDeck.duration - .02));
  updateTime(); drawWaveform();
  return true;
}
async function prepareDeck(deck, item, start) {
  deck.src = fileUrl(item.path); deck.load();
  await new Promise((resolve, reject) => { deck.addEventListener('loadedmetadata', resolve, { once: true }); deck.addEventListener('error', () => reject(new Error('Không thể mở file nhạc')), { once: true }); });
  deck.__trimEndHandled = false;
  deck.currentTime = Math.min(Math.max(0, start), Math.max(0, deck.duration - .02)); deck.playbackRate = state.tempo / 100; deck.loop = Boolean(item.repeat);
}
function fadePreview(to, token, finish, durationSeconds = state.fadeDuration) {
  clearTimeout(previewFadeFrame);
  const from = previewDeck.volume, start = performance.now(), duration = durationSeconds * 1000;
  const step = () => {
    if (token !== previewToken) return;
    const ratio = Math.min(1, (performance.now() - start) / duration);
    previewDeck.volume = Math.max(0, Math.min(1, from + (to - from) * ratio));
    if (ratio < 1) previewFadeFrame = setTimeout(step, 16);
    else { previewFadeFrame = 0; if (finish) finish(); }
  };
  previewFadeFrame = setTimeout(step, 16);
}
function stopPreview(fade = false) {
  const token = ++previewToken;
  clearTimeout(previewFadeFrame); previewFadeFrame = 0;
  if (fade && !previewDeck.paused) fadePreview(0, token, () => previewDeck.pause());
  else previewDeck.pause();
  ui.previewPlaying = false;
}
function setPreviewVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return;
  state.previewVolume = Math.max(0, Math.min(100, Math.round(volume)));
  if (ui.previewPlaying) fadePreview(state.previewVolume / 100, previewToken, null, .04);
  saveSoon();
}
async function togglePreview() {
  if (ui.previewPlaying) { stopPreview(true); return; }
  const item = state.previewTrackId && getQueueTrack(state.previewTrackId);
  if (!item) { toast('Hãy chọn bài nghe thử trong hàng chờ'); return; }
  const token = ++previewToken;
  clearTimeout(previewFadeFrame); previewFadeFrame = 0;
  try {
    await routeOutput(previewDeck, state.outputNext);
    if (token !== previewToken) return;
    if (previewLoadedPath !== item.path || !previewDeck.src) {
      previewLoadedPath = null;
      await prepareDeck(previewDeck, item, cuePositionFor(item, state.previewAnalysis));
      if (token !== previewToken) return;
      previewLoadedPath = item.path;
    }
    previewDeck.loop = false;
    if (previewDeck.paused) previewDeck.volume = 0;
    await previewDeck.play();
    if (token !== previewToken) { previewDeck.pause(); return; }
    ui.previewPlaying = true;
    fadePreview(state.previewVolume / 100, token);
  } catch (error) {
    if (token !== previewToken) return;
    console.warn('Không thể nghe thử', error);
    toast('Không nghe thử được: kiểm tra thiết bị phát và file nhạc', 3500);
  }
}
async function playItem(item) {
  if (!item) return;
  const transitionToken = transitionGuard.begin();
  clearTimeout(crossfadeTimer);
  const switching = state.active?.path !== item.path;
  try {
    setStatus('LOADING', 'loading');
    const analysis = await analyzeTrack(item);
    if (!transitionGuard.isCurrent(transitionToken)) return;
    if (!switching && activeDeck.src) { await resumePlayback(); return; }
    // Each new song begins at its original speed. BPM detection is display-only, never allowed to change tempo.
    if (switching) state.tempo = 100;
    const start = cuePositionFor(item, analysis);
    audioContext ??= new AudioContext(); await restoreMainOutput(); await audioContext.resume();
    if (!transitionGuard.isCurrent(transitionToken)) return;
    applyTone();
    if (state.playbackState === 'playing' && state.active) {
      const previous = activeDeck, incoming = standbyDeck;
      await prepareDeck(incoming, item, start);
      if (!transitionGuard.isCurrent(transitionToken)) return;
      setGain(incoming, 0, .01); await incoming.play();
      if (!transitionGuard.isCurrent(transitionToken)) { incoming.pause(); return; }
      const now = audioContext.currentTime; const outgoingGain = graphFor(previous).gain.gain, incomingGain = graphFor(incoming).gain.gain;
      outgoingGain.cancelScheduledValues(now); incomingGain.cancelScheduledValues(now);
      outgoingGain.setValueAtTime(outgoingGain.value, now); incomingGain.setValueAtTime(0, now);
      outgoingGain.linearRampToValueAtTime(0, now + state.fadeDuration); incomingGain.linearRampToValueAtTime(targetGain(item), now + state.fadeDuration);
      crossfadeTimer = transitionGuard.schedule(transitionToken, () => {
        previous.pause(); previous.currentTime = 0;
      }, state.fadeDuration * 1000 + 30);
      activeDeck = incoming; standbyDeck = previous;
    } else {
      await prepareDeck(activeDeck, item, start);
      if (!transitionGuard.isCurrent(transitionToken)) return;
      setGain(activeDeck, 0, .01); await activeDeck.play();
      if (!transitionGuard.isCurrent(transitionToken)) { activeDeck.pause(); return; }
      setGain(activeDeck, targetGain(item), state.fadeDuration);
    }
    if (!transitionGuard.isCurrent(transitionToken)) return;
    state.active = item; state.activeAnalysis = analysis; state.playingTrackId = item.path; state.previewTrackId = null; state.previewAnalysis = null; state.playbackState = 'playing';
    state.selectedQueueTrackId = item.path; setStatus('PLAYING', 'playing'); renderControls(); updateWaveHeader(); updatePreviewHeader(); drawWaveform(); drawPreviewWaveform(); startMeter(); saveSoon(); toast(`Đang phát: ${item.name}`);
    void showNextPreview(item.path);
  } catch (error) {
    // A superseded request may reject while its deck is being reused by the
    // newer request. It must never reset the playback state of that request.
    if (!transitionGuard.isCurrent(transitionToken)) return;
    console.error(error); state.playbackState = 'stopped'; setStatus('Không thể phát file', 'stopped'); toast('Không thể phát bài này'); renderControls();
  }
}
async function resumePlayback() {
  if (!state.active) return;
  try { clearTimeout(fadeTimer); audioContext ??= new AudioContext(); await restoreMainOutput(); await audioContext.resume(); applyTone(); activeDeck.playbackRate = state.tempo / 100; setGain(activeDeck, 0, .01); await activeDeck.play(); setGain(activeDeck, targetGain(state.active), state.fadeDuration); state.playbackState = 'playing'; setStatus('PLAYING', 'playing'); renderControls(); startMeter(); toast('Đã tiếp tục phát'); }
  catch { toast('Không thể tiếp tục phát'); }
}
function pausePlayback(notify = true) {
  if (!state.active) return;
  transitionGuard.begin(); clearTimeout(crossfadeTimer);
  clearTimeout(fadeTimer); audioContext ??= new AudioContext(); setGain(activeDeck, 0, state.fadeDuration);
  beginVisualDecay(state.fadeDuration);
  state.playbackState = 'paused'; setStatus('PAUSED', 'paused'); renderControls(); if (notify) toast('Đã tạm dừng');
  fadeTimer = setTimeout(() => { activeDeck.pause(); stopMeter(); saveSoon(); }, state.fadeDuration * 1000 + 15);
}
function restartTrack() {
  if (!state.active) return;
  transitionGuard.begin(); clearTimeout(crossfadeTimer); clearTimeout(fadeTimer); audioContext ??= new AudioContext();
  const wasPlaying = state.playbackState === 'playing';
  activeDeck.currentTime = 0; updateTime(0); drawWaveform(); saveSoon();
  if (wasPlaying) { setGain(activeDeck, targetGain(state.active), .02); setStatus('PLAYING', 'playing'); startMeter(); toast('Đã quay về đầu bài và tiếp tục phát'); }
  else { setStatus('PAUSED', 'paused'); toast('Đã quay về đầu bài'); }
  renderControls();
}
function playPreviousTrack() {
  if (!state.queue.length) return toast('Hàng chờ đang trống');
  const currentPath = state.active?.path || state.selectedQueueTrackId;
  const currentIndex = state.queue.findIndex(item => item.path === currentPath);
  const previous = state.queue[currentIndex < 0 ? state.queue.length - 1 : (currentIndex - 1 + state.queue.length) % state.queue.length];
  if (previous) playItem(previous);
}
function playNextTrack() {
  if (!state.queue.length) return toast('Hàng chờ đang trống');
  const next = getQueueTrack(state.previewTrackId) || nextQueueItem(state.active?.path || state.selectedQueueTrackId);
  if (!next) return toast('Không tìm thấy bài kế tiếp');
  // Promote the exact preview playhead when the user accepts the preview.
  // Otherwise playItem() falls back to the trim/start position and appears
  // to jump back or wait for one beat before the selected cue.
  if (previewLoadedPath === next.path && !previewDeck.paused && Number.isFinite(previewDeck.currentTime)) {
    next.cuePosition = previewDeck.currentTime;
    next.manualCue = true;
  }
  stopPreview();
  playItem(next);
}
function stopPlayback() { pausePlayback(false); }
function togglePlay() { return state.playbackState === 'playing' ? pausePlayback() : (state.active ? resumePlayback() : playItem(getQueueTrack(state.selectedQueueTrackId) || state.queue[0])); }
function dropIntoQueue(targetPath = null, insertAfter = false) {
  if (!draggedItem) return;
  const targetIndex = targetPath ? state.queue.findIndex(item => item.path === targetPath) : state.queue.length;
  const destination = targetIndex < 0 ? state.queue.length : targetIndex + (targetPath && insertAfter ? 1 : 0);
  if (draggedItem.source === 'library') {
    if (state.queue.some(item => item.path === draggedItem.path)) { toast('Bài này đã có trong hàng chờ'); draggedItem = null; return; }
    const libraryItem = getTrack(state.library, draggedItem.path);
    if (libraryItem) state.queue.splice(destination, 0, { ...makeTrack(libraryItem.path), volume: libraryItem.volume ?? 100, pinned: libraryItem.pinned ?? false });
  } else {
    const from = state.queue.findIndex(item => item.path === draggedItem.path);
    if (from < 0) return;
    const [moved] = state.queue.splice(from, 1);
    state.queue.splice(from < destination ? destination - 1 : destination, 0, moved);
  }
  draggedItem = null; saveSoon();
}
function enableCrossListDrops() {
  const libraryRoot = $('#library');
  libraryRoot.ondragover = event => { if (draggedItem?.source === 'queue') { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
  libraryRoot.ondrop = event => {
    if (draggedItem?.source !== 'queue') return;
    event.preventDefault(); removeFromQueue(draggedItem.path); draggedItem = null; toast('Đã trả bài về thư viện');
  };
}
function removeFromQueue(path) { state.queue = state.queue.filter(item => item.path !== path); if (state.previewTrackId === path) { stopPreview(); state.previewTrackId = null; state.previewAnalysis = null; updatePreviewHeader(); drawPreviewWaveform(); } if (state.selectedQueueTrackId === path) state.selectedQueueTrackId = null; saveSoon(); }
function addToQueue(items) {
  const existing = new Set(state.queue.map(item => item.path)); const added = items.filter(item => !existing.has(item.path)).map(item => ({ ...makeTrack(item.path), volume: item.volume ?? 100, pinned: item.pinned ?? false }));
  if (!added.length) return toast('Bài này đã có trong hàng chờ'); state.queue.push(...added); saveSoon(); toast(`Đã thêm ${added.length} bài vào hàng chờ`);
}
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function waitForIdle() {
  return new Promise(resolve => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 240 });
    else setTimeout(resolve, 120);
  });
}
function queueLibraryPreload(tracks) {
  // Use the reactive library entries so metadata updates appear immediately.
  const pending = tracks.map(track => getTrack(state.library, track.path))
    .filter(track => track?.path && !backgroundPreload.queuedPaths.has(track.path));
  if (!pending.length) return;
  pending.forEach(track => backgroundPreload.queuedPaths.add(track.path));
  backgroundPreload.queue.push(...pending); backgroundPreload.total += pending.length;
  if (!backgroundPreload.running) void runLibraryPreload();
}
async function restoreLibraryDurations() {
  let changed = false;
  for (const item of state.library) {
    // Libraries created before sort support have no addedAt. File modification
    // time is the most useful stable fallback for those existing tracks.
    if (!Number.isFinite(item.addedAt) || item.addedAt <= 0) {
      try {
        const meta = await window.dj.audioMeta(item.path);
        if (Number.isFinite(meta?.mtimeMs) && meta.mtimeMs > 0) { item.addedAt = meta.mtimeMs; changed = true; }
      } catch { /* Missing or moved tracks retain their existing order. */ }
    }
    if (Number.isFinite(item.duration) && item.duration > 0) continue;
    const cachedDuration = cacheFor(item.path)?.duration;
    if (Number.isFinite(cachedDuration) && cachedDuration > 0) {
      item.duration = cachedDuration;
      changed = true;
    }
  }
  for (const item of state.library) {
    if (Number.isFinite(item.duration) && item.duration > 0) continue;
    await waitForIdle();
    const duration = await readTrackDuration(item.path);
    if (duration > 0 && getTrack(state.library, item.path) === item) {
      item.duration = duration;
      changed = true;
    }
  }
  if (changed) { sortLibrary(); saveSoon(); }
}
async function runLibraryPreload() {
  backgroundPreload.running = true;
  let limitedCount = 0;
  while (backgroundPreload.queue.length) {
    // Decoding competes with audio playback. Never start another file while music is playing.
    if (state.playbackState === 'playing') { await wait(900); continue; }
    const track = backgroundPreload.queue.shift();
    if (!track) continue;
    const position = backgroundPreload.completed + 1;
    toast(`Đang tải sóng ${position}/${backgroundPreload.total}: ${track.name}`);
    await waitForIdle();
    try {
      const analysis = await analyzeTrack(track);
      if (analysis) {
        if (analysis.analysisLimited) limitedCount++;
        track.duration = analysis.duration || track.duration;
        track.bpm = analysis.bpm || track.bpm || null;
      }
    } catch (error) { console.warn('Không thể tải trước bài:', track.path, error); }
    backgroundPreload.queuedPaths.delete(track.path); backgroundPreload.completed += 1;
    // Return a little time to drawing, user input, and the audio engine before the next file.
    await wait(180);
  }
  if (backgroundPreload.completed) toast(limitedCount ? `Đã thêm nhạc; ${limitedCount} bài dài không tạo sóng để tiết kiệm bộ nhớ` : `Đã tải sẵn ${backgroundPreload.completed}/${backgroundPreload.total} bài`, limitedCount ? 5000 : 1800);
  backgroundPreload.running = false; backgroundPreload.completed = 0; backgroundPreload.total = 0;
}
function addToLibrary(paths) {
  const have = new Set(state.library.map(item => item.path));
  const added = paths.filter(path => !have.has(path)).map(makeTrack);
  state.library.push(...added); sortLibrary(); saveSoon();
  if (added.length) queueLibraryPreload(added);
  toast(added.length ? `Đã thêm ${added.length} bài, đang tải sóng nền` : 'Các bài này đã có trong thư viện');
}

function panelSplitBounds() {
  const panels = $('.collections');
  const splitterWidth = $('#panel-splitter')?.offsetWidth || 10;
  const usableWidth = Math.max(1, panels.clientWidth - splitterWidth);
  // The queue needs room for duration, volume, play and delete controls.
  // Calculate the allowed drag range from real available width instead of
  // switching to a different layout at narrow desktop sizes.
  const min = Math.max(.3, 300 / usableWidth);
  const max = Math.min(.7, 1 - (340 / usableWidth));
  return { min: Math.min(min, max), max: Math.max(min, max) };
}
function applyPanelSplit() {
  const panels = $('.collections');
  if (!panels.clientWidth) return;
  if (innerWidth <= 760) { panels.style.removeProperty('grid-template-columns'); return; }
  const { min, max } = panelSplitBounds();
  const ratio = Math.max(min, Math.min(max, Number(state.panelSplit) || .5));
  state.panelSplit = ratio;
  panels.style.gridTemplateColumns = `minmax(300px, ${ratio}fr) 10px minmax(340px, ${1 - ratio}fr)`;
}
function enablePanelSplitter() {
  const splitter = $('#panel-splitter'), panels = $('.collections');
  let pointerId = null;
  const update = clientX => {
    const bounds = panels.getBoundingClientRect();
    const usableWidth = Math.max(1, bounds.width - splitter.offsetWidth);
    const { min, max } = panelSplitBounds();
    state.panelSplit = Math.max(min, Math.min(max, (clientX - bounds.left) / usableWidth));
    applyPanelSplit();
  };
  splitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || innerWidth <= 760) return;
    event.preventDefault(); const { min, max } = panelSplitBounds();
    state.panelSplit = Math.max(min, Math.min(max, state.panelSplit + (event.key === 'ArrowLeft' ? -.02 : .02)));
    applyPanelSplit(); saveSoon();
  });
  splitter.addEventListener('pointerdown', event => {
    if (innerWidth <= 760) return;
    pointerId = event.pointerId; splitter.setPointerCapture(pointerId); splitter.classList.add('dragging'); update(event.clientX); event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => { if (event.pointerId === pointerId) update(event.clientX); });
  const finish = event => {
    if (event.pointerId !== pointerId) return;
    splitter.releasePointerCapture(pointerId); pointerId = null; splitter.classList.remove('dragging'); saveSoon();
  };
  splitter.addEventListener('pointerup', finish); splitter.addEventListener('pointercancel', finish);
  window.addEventListener('resize', applyPanelSplit);
}

function rms(data) { let total = 0; for (const item of data) { const n = (item - 128) / 128; total += n * n; } return Math.sqrt(total / data.length); }
function drawMeter(leftValue, rightValue) {
  // The two independent channel values are derived from the existing audio graph.
  // The meter is white/gray at rest. Only lit segments above 70% turn red;
  // the red is a visual warning, not an audio limiter or clipping detector.
  const canvas = $('#meter');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width, height = canvas.height;
  const segments = 20, warningStart = 14; // exactly 70% white, 30% red
  const columnWidth = 25, gap = 1.8;
  const ledHeight = (height - 10 - gap * (segments - 1)) / segments;
  const xPositions = [15, width - 15 - columnWidth];
  ctx.clearRect(0, 0, width, height);
  [leftValue, rightValue].forEach((level, channel) => {
    const active = Math.round(Math.max(0, Math.min(1, Number(level) || 0)) * segments);
    for (let i = 0; i < segments; i++) {
      const y = height - 5 - (i + 1) * ledHeight - i * gap;
      const inRedZone = i >= warningStart;
      const on = i < active;
      ctx.fillStyle = on ? (inRedZone ? '#ef4444' : '#f5f5f5') : '#686868';
      ctx.beginPath();
      ctx.roundRect(xPositions[channel], y, columnWidth, ledHeight, Math.min(2, ledHeight / 2));
      ctx.fill();
    }
  });
}
function meterLoop() {
  if (state.playbackState !== 'playing') { meterFrame = 0; beginVisualDecay(); return; }
  const graph = graphFor(activeDeck); graph.left.getByteTimeDomainData(graph.leftData); graph.right.getByteTimeDomainData(graph.rightData);
  const left = rms(graph.leftData), right = rms(graph.rightData); graph.peaks[0] = Math.max(left, graph.peaks[0] * .92); graph.peaks[1] = Math.max(right, graph.peaks[1] * .92);
  drawMeter(Math.min(1, graph.peaks[0] * 1.65), Math.min(1, graph.peaks[1] * 1.65)); meterFrame = requestAnimationFrame(meterLoop);
}
function beginVisualDecay(durationSeconds = state.fadeDuration) {
  if (visualDecayFrame) return;
  spectrumFadeLevel = Math.max(spectrumFadeLevel, .01);
  const frameFactor = Math.pow(.05, 1 / Math.max(1, durationSeconds * 60));
  const decay = () => {
    const graph = graphs.get(activeDeck);
    if (graph) {
      graph.peaks[0] *= frameFactor; graph.peaks[1] *= frameFactor;
      drawMeter(graph.peaks[0] * 1.65, graph.peaks[1] * 1.65);
    }
    spectrumFadeLevel *= frameFactor;
    drawEqCurve();
    if (spectrumFadeLevel > .01 || graph?.peaks?.some(value => value > .01)) visualDecayFrame = requestAnimationFrame(decay);
    else { visualDecayFrame = 0; spectrumFadeLevel = 0; drawMeter(0, 0); drawEqCurve(); }
  };
  visualDecayFrame = requestAnimationFrame(decay);
}
function beginVisualRise(durationSeconds = state.fadeDuration) {
  if (visualRiseFrame) cancelAnimationFrame(visualRiseFrame);
  if (visualDecayFrame) cancelAnimationFrame(visualDecayFrame);
  visualDecayFrame = 0; spectrumFadeLevel = 0;
  const step = () => {
    spectrumFadeLevel = Math.min(1, spectrumFadeLevel + 1 / Math.max(1, durationSeconds * 60));
    drawEqCurve();
    if (spectrumFadeLevel < 1) visualRiseFrame = requestAnimationFrame(step);
    else visualRiseFrame = 0;
  };
  visualRiseFrame = requestAnimationFrame(step);
}
function pulseWaveform() {
  if (state.playbackState !== 'playing') { waveformPulseFrame = 0; drawWaveform(); drawPreviewWaveform(); return; }
  if (ui.page === 'player') { if (state.activeAnalysis?.peaks?.length) drawWaveform(); if (state.previewAnalysis?.peaks?.length) drawPreviewWaveform(); }
  waveformPulseFrame = requestAnimationFrame(pulseWaveform);
}
function startWaveformPulse() { if (!waveformPulseFrame) waveformPulseFrame = requestAnimationFrame(pulseWaveform); }
function stopWaveformPulse() { if (waveformPulseFrame) cancelAnimationFrame(waveformPulseFrame); waveformPulseFrame = 0; }
function startMeter() { beginVisualRise(state.fadeDuration); if (!meterFrame) meterFrame = requestAnimationFrame(meterLoop); startWaveformPulse(); if (!eqFrame && (ui.page === 'player' || ui.page === 'eq')) eqFrame = requestAnimationFrame(eqLoop); }
function stopMeter() { if (meterFrame) cancelAnimationFrame(meterFrame); meterFrame = 0; stopWaveformPulse(); }

function advanceQueueAfter(deck) {
  if (deck !== activeDeck) return;
  const next = nextQueueItem(state.active?.path);
  if (!next) return stopPlayback();
  if (next.path === state.active?.path) {
    deck.__trimEndHandled = false;
    activeDeck.currentTime = cuePositionFor(next, state.activeAnalysis); activeDeck.play();
    return;
  }
  playItem(next);
}
function wireDeck(deck) {
  deck.addEventListener('timeupdate', () => {
    if (deck !== activeDeck) return;
    updateTime(longTrackScrubTime ?? waveformScrubTime ?? deck.currentTime); drawWaveform();
    const trimEnd = trimEndFor(state.active, state.activeAnalysis, deck.duration);
    if (state.autoTrim && trimEnd > 0 && trimEnd < deck.duration - .05 && deck.currentTime >= trimEnd && !deck.__trimEndHandled) {
      deck.__trimEndHandled = true;
      deck.currentTime = trimEnd;
      advanceQueueAfter(deck);
    }
  });
  deck.addEventListener('ended', () => {
    advanceQueueAfter(deck);
  });
}
const sidebarStoredCollapsed = (() => { try { return localStorage.getItem('medj-sidebar-collapsed') === '1'; } catch { return false; } })();
const ui = Vue.reactive({sidebarCollapsed:sidebarStoredCollapsed,queueFocus:false,page:'player', eqOpen:false, eqOrigin:{x:innerWidth / 2,y:innerHeight / 2}, eqSelected: 0, previewPlaying:false, outputBusy:false, outputError:'', outputPickerSupported:typeof navigator.mediaDevices?.selectAudioOutput === 'function', status:'READY', statusKind:'stopped', toast:'', time:'00:00 / 00:00', elapsedText:'00:00', durationText:'00:00', seekHintVisible:false, seekHintText:'00:00', seekHintPercent:0, playbackProgress:0, previewProgress:0, previewTime:'00:00 / 00:00', libraryQuery:'', queueQuery:'', playerQueueQuery:'', outputDevices: []});
function toggleSidebar() {
  ui.sidebarCollapsed = !ui.sidebarCollapsed;
  try { localStorage.setItem('medj-sidebar-collapsed', ui.sidebarCollapsed ? '1' : '0'); } catch {}
  // Canvas dimensions depend on the workspace width; redraw after the rail animates.
  Vue.nextTick(() => {
    drawWaveform(); drawPreviewWaveform(); drawEqCurve();
    window.setTimeout(() => { drawWaveform(); drawPreviewWaveform(); drawEqCurve(); }, 340);
  });
}
function openLibrarySearch() {
  setPage('library');
  Vue.nextTick(() => document.getElementById('library-search')?.focus({ preventScroll: true }));
}
function goToQueue() {
  if (ui.page !== 'player' || ui.eqOpen) setPage('player');
  ui.queueFocus = true;
  Vue.nextTick(() => {
    const queue = document.querySelector('.player-queue-card');
    queue?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      block: 'start'
    });
    window.setTimeout(() => queue?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
  });
}
function goToHome() {
  if (ui.page !== 'player' || ui.eqOpen) setPage('player');
  ui.queueFocus = false;
  const revealHome = () => {
    const content = document.querySelector('.content');
    if (!content) return;
    content.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    content.classList.remove('home-return-fade');
    void content.offsetWidth;
    content.classList.add('home-return-fade');
    window.setTimeout(() => content.classList.remove('home-return-fade'), 360);
  };
  Vue.nextTick(revealHome);
  window.setTimeout(revealHome, 40);
}
function openEq(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (rect) ui.eqOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  setPage('eq');
}
function setPage(page) {
  if (page !== 'eq') ui.queueFocus = false;
  ui.eqOpen = page === 'eq';
  ui.page = page === 'eq' ? 'player' : page;
  Vue.nextTick(() => {
    if (page === 'library') applyPanelSplit();
    if (page === 'player') { drawWaveform(); drawPreviewWaveform(); drawEqCurve(); }
    if (page === 'player' && !ui.queueFocus) document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'instant' });
    if (page === 'eq') { applyTone(); drawEqCurve(); }
    if ((page === 'player' || page === 'eq') && state.playbackState === 'playing' && !eqFrame) eqFrame = requestAnimationFrame(eqLoop);
  });
}
function eqLoop() {
  eqFrame = 0;
  if ((ui.page !== 'eq' && ui.page !== 'player') || state.playbackState !== 'playing') { drawEqCurve(); return; }
  drawEqCurve();
  eqFrame = requestAnimationFrame(eqLoop);
}
function eqCurveMetrics(canvas) {
  const rect = canvas.getBoundingClientRect();
  const pad = { left: 30, right: 16, top: 38, bottom: 12 };
  const innerW = rect.width - pad.left - pad.right, innerH = rect.height - pad.top - pad.bottom;
  const logMin = Math.log10(20), logSpan = Math.log10(20000) - logMin;
  return {
    rect, pad, innerW, innerH,
    xFor: frequency => pad.left + (Math.log10(frequency) - logMin) / logSpan * innerW,
    yFor: db => pad.top + (12 - Math.max(-12, Math.min(12, db))) / 24 * innerH,
    dbForY: y => Math.max(-12, Math.min(12, 12 - ((y - pad.top) / innerH) * 24))
  };
}
function drawPlayerSpectrum() {
  // A true monochrome spectrum analyser: grayscale stepped LED bars,
  // derived from real WebAudio frequency data (not pre-rendered decoration).
  const canvas = $('#player-eq-curve'); if (!canvas) return;
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  const w = rect.width, h = rect.height, left = 1, top = 1, plotW = Math.max(1, w - 2), plotH = Math.max(1, h - 15);
  const xFor = freq => left + Math.log10(freq / 20) / 3 * plotW;
  ctx.strokeStyle = 'rgba(186,186,186,.19)'; ctx.lineWidth = 1;
  ctx.strokeRect(left + .5, top + .5, plotW - 1, plotH - 1);
  ctx.beginPath();
  for (let row = 1; row <= 4; row++) {const y = top + row * plotH / 5;ctx.moveTo(left,y);ctx.lineTo(left + plotW,y);}
  [30,40,50,60,80,100,200,300,400,500,600,800,1000,2000,3000,4000,5000,6000,8000,10000].forEach(freq => {
    const x = xFor(freq); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH);
  });
  ctx.stroke();
  ctx.fillStyle = '#a3a3a3';ctx.font = '9px system-ui';
  [[20,'20'],[100,'100'],[1000,'1k'],[10000,'10k'],[20000,'20k']].forEach(([freq,label],index) => {
    ctx.textAlign = index===0?'left':index===4?'right':'center';ctx.fillText(label,xFor(freq),h-2);
  });
  const graph = graphs.get(activeDeck);
  const visualLevel = typeof spectrumFadeLevel === 'number' ? spectrumFadeLevel : (state.playbackState === 'playing' ? 1 : 0);
  if (!graph || (state.playbackState !== 'playing' && visualLevel <= .01) || !audioContext) return;
  if (state.playbackState === 'playing' && typeof spectrumFadeLevel === 'number') spectrumFadeLevel = Math.max(spectrumFadeLevel, .01);
  graph.spectrum.getFloatFrequencyData(graph.spectrumData);
  const spectrumAt = frequency => {
    const bin = Math.min(graph.spectrumData.length - 1, frequency * graph.spectrum.fftSize / audioContext.sampleRate);
    const lower = Math.floor(bin), upper = Math.min(graph.spectrumData.length - 1, lower + 1), portion = bin - lower;
    const lo = graph.spectrumData[lower], hi = graph.spectrumData[upper];
    return (Number.isFinite(lo)?lo:-110)*(1-portion)+(Number.isFinite(hi)?hi:-110)*portion;
  };
  const columns = Math.max(28, Math.min(68, Math.floor(plotW / 7)));
  const segmentCount = 11, spacing = 1.2, barW = plotW / columns, segmentH = (plotH - 4) / segmentCount;
  for (let i = 0; i < columns; i++) {
    const freq = 20 * 1000 ** ((i + .5) / columns);
    const db = (spectrumAt(freq / 1.08) + 2*spectrumAt(freq) + spectrumAt(freq*1.08))/4;
    const level = Math.max(0,Math.min(1,(db+100)/84)) * visualLevel;
    const lit = Math.round(level * segmentCount);
    for (let j = 0; j < lit; j++) {
      ctx.fillStyle = j > 8 ? '#ffffff' : '#e5e5e5';
      const x = left + i*barW + Math.max(1,barW*.13);
      const y = top + plotH - (j+1)*segmentH + spacing/2;
      ctx.fillRect(x,y,Math.max(1,barW*.73),Math.max(1,segmentH-spacing));
    }
  }
}
function drawEqCurve() {
  if (!ui.eqOpen) { if (ui.page === 'player') drawPlayerSpectrum(); return; }
  const canvas = $('#eq-curve'); if (!canvas) return;
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height, { pad, innerW, innerH, xFor, yFor } = eqCurveMetrics(canvas);
  const logMin = Math.log10(20), logSpan = Math.log10(20000) - logMin;
  ctx.fillStyle = '#0c0d0e'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(210,214,215,.18)'; ctx.lineWidth = 1;
  for (let db = -12; db <= 12; db += 3) { const y = yFor(db); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke(); }
  [20,30,40,50,60,80,100,200,300,400,500,600,800,1000,2000,3000,4000,5000,6000,8000,10000,20000].forEach(freq => { const x = xFor(freq); ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke(); });
  ctx.strokeStyle = 'rgba(255,255,255,.52)'; ctx.beginPath(); ctx.moveTo(pad.left, yFor(0)); ctx.lineTo(w - pad.right, yFor(0)); ctx.stroke();
  const graph = graphs.get(activeDeck);
  // Live spectrum behind the EQ response. This is intentionally separate
  // from the white filter-response line, so playback remains visible while
  // the EQ curve stays mathematically flat at 0 dB.
  if (graph && (state.playbackState === 'playing' || spectrumFadeLevel > .01)) {
    if (state.playbackState === 'playing') spectrumFadeLevel = 1;
    graph.spectrum.getFloatFrequencyData(graph.spectrumData);
    const spectrumAt = frequency => {
      const bin = Math.min(graph.spectrumData.length - 1, frequency * graph.spectrum.fftSize / audioContext.sampleRate);
      const lower = Math.floor(bin), upper = Math.min(graph.spectrumData.length - 1, lower + 1), fraction = bin - lower;
      const a = graph.spectrumData[lower], b = graph.spectrumData[upper];
      return (Number.isFinite(a) ? a : -100) * (1 - fraction) + (Number.isFinite(b) ? b : -100) * fraction;
    };
    const points = [];
    const pointCount = Math.max(40, Math.min(160, Math.round(innerW / 4)));
    for (let i = 0; i <= pointCount; i++) {
      const frequency = 10 ** (logMin + i / pointCount * logSpan);
      const db = (spectrumAt(frequency / 1.03) + 2 * spectrumAt(frequency) + spectrumAt(frequency * 1.03)) / 4 + (spectrumFadeLevel < 1 ? 20 * Math.log10(Math.max(.001, spectrumFadeLevel)) : 0);
      const level = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 100) / 85)) : 0;
      points.push({ x: pad.left + i / pointCount * innerW, y: pad.top + (1 - level) * innerH });
    }
    ctx.beginPath(); ctx.moveTo(pad.left, h - pad.bottom); ctx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(w - pad.right, h - pad.bottom); ctx.closePath(); ctx.fillStyle = 'rgba(245,245,245,.10)'; ctx.fill(); ctx.strokeStyle = 'rgba(245,245,245,.58)'; ctx.stroke();
  }
  const count = Math.max(2, Math.floor(innerW) + 1), frequencies = new Float32Array(count), response = new Float32Array(count), magnitude = new Float32Array(count), phase = new Float32Array(count);
  for (let i = 0; i < count; i++) frequencies[i] = Math.min(10 ** (logMin + i / (count - 1) * logSpan), (audioContext?.sampleRate || 44100) / 2);
  if (graph) graph.filters.forEach(filter => { filter.getFrequencyResponse(frequencies, magnitude, phase); for (let i = 0; i < count; i++) response[i] += 20 * Math.log10(Math.max(magnitude[i], 0.000001)); });
  const responseAt = i => response[i];
  ctx.beginPath(); for (let i = 0; i < count; i++) { const x = pad.left + i / (count - 1) * innerW, y = yFor(responseAt(i)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.lineTo(w - pad.right, yFor(0)); ctx.lineTo(pad.left, yFor(0)); ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,.27)'; ctx.fill();
  ctx.beginPath(); for (let i = 0; i < count; i++) { const x = pad.left + i / (count - 1) * innerW, y = yFor(responseAt(i)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.strokeStyle = '#f1f1f1'; ctx.lineWidth = 1.5; ctx.stroke();
  const colors = ['#bdbdbd','#d9d9d9','#f8f8f8','#a6a6a6','#e5e5e5'];
  state.eq.bands.forEach((band, index) => {
    const x = xFor(band.frequency), y = yFor(band.type === 'highpass' || band.type === 'lowpass' ? 0 : band.gain);
    ctx.fillStyle = colors[index]; ctx.beginPath(); ctx.arc(x, y, ui.eqSelected === index ? 13 : 11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0c0d0e'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#111'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(index + 1), x, y + 4);
    if (ui.eqSelected === index) {
      const isCut = band.type === 'highpass' || band.type === 'lowpass';
      const isShelf = band.type === 'lowshelf' || band.type === 'highshelf';
      const frequency = band.frequency >= 1000 ? `${(band.frequency / 1000).toFixed(2)} kHz` : `${Math.round(band.frequency)} Hz`;
      const level = isCut ? 'CUT' : `${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB`;
      const label = `${frequency}  ·  ${level}${isShelf ? '' : `  ·  Q ${band.q.toFixed(1)}`}`;
      ctx.font = '600 11px system-ui';
      const boxWidth = ctx.measureText(label).width + 16, boxX = Math.max(2, Math.min(w - boxWidth - 2, x - boxWidth / 2)), boxY = Math.max(2, y - 37);
      ctx.fillStyle = '#282828'; ctx.fillRect(boxX, boxY, boxWidth, 22);
      ctx.fillStyle = '#f7f7f7'; ctx.textAlign = 'left'; ctx.fillText(label, boxX + 8, boxY + 15);
    }
  });
}
function beginEqDrag(event) {
  const canvas = event.currentTarget, metrics = eqCurveMetrics(canvas), x = event.clientX - metrics.rect.left, y = event.clientY - metrics.rect.top;
  const closest = state.eq.bands.map((band, index) => ({ index, distance: Math.hypot(x - metrics.xFor(band.frequency), y - metrics.yFor(band.type === 'highpass' || band.type === 'lowpass' ? 0 : band.gain)) })).sort((a, b) => a.distance - b.distance)[0];
  if (!closest || closest.distance > 24) return;
  eqDragBand = closest.index;
  ui.eqSelected = closest.index;
  canvas.focus();
  drawEqCurve();
  canvas.setPointerCapture?.(event.pointerId);
}
function moveEqDrag(event) {
  if (eqDragBand === null) return;
  const metrics = eqCurveMetrics(event.currentTarget), y = event.clientY - metrics.rect.top, x = event.clientX - metrics.rect.left;
  const frequency = 20 * 1000 ** Math.max(0, Math.min(1, (x - metrics.pad.left) / metrics.innerW));
  const band = state.eq.bands[eqDragBand];
  band.frequency = Math.round(frequency);
  if (band.type !== 'highpass' && band.type !== 'lowpass') band.gain = Math.round(metrics.dbForY(y) * 2) / 2;
  applyTone(); drawEqCurve(); saveSoon();
}
function endEqDrag(event) {
  if (eqDragBand === null) return;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  eqDragBand = null;
}
async function refreshOutputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) { ui.outputError = 'Không thể lấy danh sách thiết bị phát trên máy này.'; return; }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    ui.outputDevices = devices.filter(device => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default').map((device, index) => ({ id: device.deviceId, label: device.label || `Thiết bị âm thanh ${index + 1}` }));
  } catch (error) { console.warn('Không thể lấy thiết bị phát', error); ui.outputError = 'Không thể lấy danh sách thiết bị phát.'; }
}
async function requestAudioDevices() {
  if (!navigator.mediaDevices?.getUserMedia) {
    ui.outputError = 'Trình duyệt hệ thống không hỗ trợ yêu cầu quyền thiết bị âm thanh.'; return;
  }
  if (ui.outputBusy) return;
  ui.outputBusy = true; ui.outputError = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await refreshOutputDevices();
    if (ui.outputDevices.length) toast(`Đã tìm thấy ${ui.outputDevices.length} thiết bị phát`);
    else ui.outputError = 'Chưa tìm thấy thiết bị phát riêng. Kiểm tra loa hoặc tai nghe đã kết nối và bật trong cài đặt Âm thanh của macOS.';
  } catch (error) {
    console.warn('Không thể lấy quyền thiết bị âm thanh', error);
    if (typeof window !== 'undefined') window.dj.audioDiagnostic?.({ secure: window.isSecureContext, origin: location.origin, name: error.name, message: error.message, mediaDevices: typeof navigator.mediaDevices, elementSink: typeof HTMLMediaElement.prototype.setSinkId, contextSink: typeof AudioContext.prototype.setSinkId });
    ui.outputError = error.name === 'NotFoundError' ? 'Không tìm thấy microphone. Hãy kết nối microphone để mở danh sách, hoặc chọn thiết bị trong cài đặt Âm thanh của macOS.' : 'Không được cấp quyền microphone. Hãy cho phép microphone cho ứng dụng máy tính trong Cài đặt quyền riêng tư macOS, rồi thử lại.';
  } finally {
    if (stream) stream.getTracks().forEach(track => track.stop());
    ui.outputBusy = false;
  }
}
async function pickAudioDevice() {
  if (ui.outputBusy || !navigator.mediaDevices?.selectAudioOutput) return;
  ui.outputBusy = true;
  try {
    const device = await navigator.mediaDevices.selectAudioOutput();
    await refreshOutputDevices();
    if (device.deviceId && !ui.outputDevices.some(item => item.id === device.deviceId)) ui.outputDevices.push({ id: device.deviceId, label: device.label || 'Thiết bị đã chọn' });
    ui.outputError = ''; toast('Đã thêm thiết bị, hãy chọn cho nhạc chính hoặc nghe thử');
  } catch (error) {
    if (error.name !== 'NotAllowedError') ui.outputError = 'Không thể mở danh sách thiết bị phát của macOS.';
  } finally { ui.outputBusy = false; }
}
async function routeOutput(target, output) {
  const sink = output === 'default' ? '' : output;
  if (typeof target.setSinkId === 'function') {
    await target.setSinkId(sink);
    return;
  }
  // WebKit supports per-element speaker selection before AudioContext routing.
  // Keep EQ, gain, crossfades and limiting in the shared graph, then route its
  // stream through a dedicated element. The preview element stays independent.
  if (target === audioContext && typeof target.createMediaStreamDestination === 'function') {
    if (!sink) {
      if (mainOutputBridge?.connected) {
        outputLimiter?.disconnect(mainOutputBridge.destination);
        outputLimiter?.connect(audioContext.destination);
        mainOutputBridge.connected = false;
        mainOutputBridge.audio.pause();
      }
      return;
    }
    if (typeof HTMLMediaElement === 'undefined' || typeof HTMLMediaElement.prototype.setSinkId !== 'function') {
      throw new Error('macOS này chưa hỗ trợ chọn loa riêng trong ứng dụng');
    }
    if (!mainOutputBridge) {
      const destination = audioContext.createMediaStreamDestination();
      const audio = new Audio(); audio.srcObject = destination.stream;
      mainOutputBridge = { destination, audio, connected: false };
    }
    const bridge = mainOutputBridge, previousSink = bridge.audio.sinkId;
    try {
      await bridge.audio.setSinkId(sink);
      await audioContext.resume();
      await bridge.audio.play();
    } catch (error) {
      if (previousSink !== undefined) await bridge.audio.setSinkId(previousSink).catch(() => {});
      throw error;
    }
    if (!bridge.connected) {
      outputLimiter?.disconnect(audioContext.destination);
      outputLimiter?.connect(bridge.destination);
      bridge.connected = true;
    }
    return;
  }
  if (sink) throw new Error('Thiết bị này không hỗ trợ chọn đầu ra riêng');
}
async function restoreMainOutput() {
  if (mainOutputApplied === state.outputMain) return;
  try {
    await routeOutput(audioContext, state.outputMain);
    mainOutputApplied = state.outputMain;
  } catch (error) {
    console.warn('Không thể khôi phục thiết bị nhạc chính', error);
    ui.outputError = 'Thiết bị nhạc chính đã lưu không khả dụng. Đang dùng thiết bị mặc định của macOS.';
    mainOutputApplied = null;
  }
}
async function setOutput(role, value, select) {
  if (ui.outputBusy) return;
  const key = role === 'main' ? 'outputMain' : 'outputNext';
  const previous = state[key];
  ui.outputBusy = true;
  try {
    if (role === 'main') {
      audioContext ??= new AudioContext();
      await routeOutput(audioContext, value);
      mainOutputApplied = value;
    } else await routeOutput(previewDeck, value);
    state[key] = value; ui.outputError = '';
    saveSoon(); toast('Đã đổi thiết bị phát');
  } catch (error) {
    console.warn('Không thể đổi thiết bị phát', error);
    if (select) select.value = previous;
    ui.outputError = 'Không đổi được thiết bị phát. Kiểm tra thiết bị đã kết nối và hỗ trợ chọn đầu ra.';
    toast(ui.outputError, 4000);
  } finally { ui.outputBusy = false; }
}
function setEqParameter(key, value) {
  const band = state.eq.bands[ui.eqSelected];
  if (key === 'type') {
    const allowed = ['peaking', 'lowshelf', 'highshelf', ...([0, 4].includes(ui.eqSelected) ? ['highpass', 'lowpass'] : [])];
    if (!allowed.includes(value)) return;
    band.type = value;
  } else if (key === 'frequency') band.frequency = Math.max(20, Math.min(20000, Number(value) || 20));
  else if (key === 'gain') band.gain = Math.max(-12, Math.min(12, Number(value) || 0));
  else if (key === 'q') {
    const q = Number(value);
    if (!Number.isFinite(q)) return;
    band.q = Math.max(.1, Math.min(10, q));
  }
  applyTone(); drawEqCurve(); saveSoon();
}
function wheelEqParameter(event, key) {
  if (document.activeElement !== event.currentTarget || !event.deltaY) return;
  const band = state.eq.bands[ui.eqSelected];
  if (key === 'q' && (band.type === 'lowshelf' || band.type === 'highshelf')) return;
  if (key === 'gain' && (band.type === 'highpass' || band.type === 'lowpass')) return;
  event.preventDefault();
  const step = key === 'q' ? .1 : .5;
  const value = Math.round((band[key] + (event.deltaY < 0 ? step : -step)) * 10) / 10;
  setEqParameter(key, value);
}
const libraryItems=Vue.computed(()=>state.library.map((item,index)=>({item,index:String(index+1).padStart(2,'0')})).filter(row=>row.item.name.toLowerCase().includes(ui.libraryQuery.trim().toLowerCase())));
const queueItems=Vue.computed(()=>state.queue.map((item,index)=>({item,index:String(index+1).padStart(2,'0')})).filter(row=>row.item.name.toLowerCase().includes(ui.queueQuery.trim().toLowerCase())));
const playerQueueItems=Vue.computed(()=>state.queue.map((item,index)=>({item,index:String(index+1).padStart(2,'0')})).filter(row=>row.item.name.toLowerCase().includes(ui.playerQueueQuery.trim().toLowerCase())));
const previewTrack=Vue.computed(()=>state.previewTrackId ? getQueueTrack(state.previewTrackId) : null);
function selectLibrary(item) { state.selectedLibraryTrackId=item.path; }
function setLibrarySort(sort) {
  if (state.librarySort === sort) state.librarySortDirection = state.librarySortDirection === 'asc' ? 'desc' : 'asc';
  else { state.librarySort = sort; state.librarySortDirection = sort === 'date' ? 'desc' : 'asc'; }
  sortLibrary(); saveSoon();
  const label = sort === 'date' ? 'ngày thêm' : 'thời lượng';
  toast(`Sắp xếp theo ${label}: ${state.librarySortDirection === 'asc' ? 'tăng dần' : 'giảm dần'}`);
}
function pinTrack(item) { item.pinned=!item.pinned; sortLibrary(); saveSoon(); toast(item.pinned ? 'Đã ghim bài lên đầu thư viện' : 'Đã bỏ ghim bài hát'); }
function dragLibrary(event,item) { draggedItem={source:'library',path:item.path}; event.dataTransfer.effectAllowed='copy'; event.dataTransfer.setData('text/plain', item.path); }
function dragQueue(event,item) { if(volumeAdjusting || event.target.closest('.track-volume')) { event.preventDefault(); return; } draggedItem={source:'queue',path:item.path}; event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain', item.path); event.currentTarget.classList.add('is-dragging'); }
function clearPointerQueueTarget() {
  document.querySelectorAll('.queue-track.pointer-drop-before,.queue-track.pointer-drop-after').forEach(row => row.classList.remove('pointer-drop-before', 'pointer-drop-after'));
}
function finishQueuePointerDrag(event, cancelled = false) {
  const drag = queuePointerDrag;
  if (!drag) return;
  queuePointerDrag = null;
  drag.row.classList.remove('is-dragging', 'pointer-dragging');
  clearPointerQueueTarget();
  try { if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId); } catch { /* pointer capture already released */ }
  if (!cancelled && drag.moved && drag.targetPath && drag.targetPath !== drag.path) {
    draggedItem = { source: 'queue', path: drag.path };
    dropIntoQueue(drag.targetPath, drag.insertAfter);
    toast('Đã thay đổi thứ tự hàng chờ', 900);
  }
  window.removeEventListener('pointermove', moveQueuePointerDrag);
  window.removeEventListener('pointerup', finishQueuePointerDrag);
  window.removeEventListener('pointercancel', cancelQueuePointerDrag);
}
function cancelQueuePointerDrag(event) { finishQueuePointerDrag(event, true); }
function moveQueuePointerDrag(event) {
  const drag = queuePointerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (Math.abs(event.clientY - drag.startY) > 3 || Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.queue-track');
  clearPointerQueueTarget();
  drag.targetPath = target?.dataset.queuePath || null;
  if (target && drag.targetPath !== drag.path) {
    const rect = target.getBoundingClientRect();
    drag.insertAfter = event.clientY >= rect.top + rect.height / 2;
    target.classList.add(drag.insertAfter ? 'pointer-drop-after' : 'pointer-drop-before');
  }
  event.preventDefault();
}
function beginQueuePointerDrag(event, item) {
  if (event.button !== 0 || volumeAdjusting) return;
  const row = event.currentTarget.closest('.queue-track');
  if (!row) return;
  event.preventDefault(); event.stopPropagation();
  queuePointerDrag = { path:item.path, pointerId:event.pointerId, row, handle:event.currentTarget, startX:event.clientX, startY:event.clientY, moved:false, targetPath:null, insertAfter:false };
  row.classList.add('is-dragging', 'pointer-dragging');
  event.currentTarget.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', moveQueuePointerDrag, { passive:false });
  window.addEventListener('pointerup', finishQueuePointerDrag, { once:true });
  window.addEventListener('pointercancel', cancelQueuePointerDrag, { once:true });
}
function queueDropAfter(event, path) {
  const rect = event.currentTarget.getBoundingClientRect();
  const offset = (event.clientY - rect.top) / Math.max(1, rect.height);
  if (offset >= .35 && offset <= .65 && draggedItem?.source === 'queue') {
    const from = state.queue.findIndex(item => item.path === draggedItem.path);
    const to = state.queue.findIndex(item => item.path === path);
    if (from !== to && from >= 0 && to >= 0) return from < to;
  }
  return offset >= .5;
}
function overQueue(event) {
  if (!draggedItem) return;
  event.preventDefault(); event.dataTransfer.dropEffect=draggedItem.source==='library'?'copy':'move';
  const row = event.currentTarget;
  if (row.classList.contains('queue-track')) {
    const after = queueDropAfter(event, row.dataset.queuePath);
    row.classList.toggle('drop-before', !after); row.classList.toggle('drop-after', after);
  }
}
function clearQueueDropHint(event) {
  // Moving over child cells of the same row fires dragleave too; keep the
  // insertion marker until the pointer actually leaves that row.
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('drop-before', 'drop-after');
}
function dropQueue(event,item) { event.preventDefault(); event.stopPropagation(); const after = queueDropAfter(event, item.path); clearQueueDropHint(event); dropIntoQueue(item.path, after); }
function dropQueueEnd(event) { event.preventDefault(); dropIntoQueue(); }
function endQueueDrag(event) { event.currentTarget.classList.remove('is-dragging'); draggedItem = null; }
function lockVolume(event) { event.stopPropagation(); volumeAdjusting=true; const row=event.target.closest('.track'); row.draggable=false; const unlock=()=>{volumeAdjusting=false;row.draggable=true;}; window.addEventListener('pointerup',unlock,{once:true}); window.addEventListener('pointercancel',unlock,{once:true}); window.addEventListener('blur',unlock,{once:true}); }
function setTrackVolume(event,item) { item.volume=+event.target.value; if(state.active?.path===item.path) setGain(activeDeck,targetGain(item)); saveSoon(); }
const QueueList = {
  props: { items: { type: Array, required: true } },
  setup() { return { state, formatTime, previewQueue, playItem, dragQueue, beginQueuePointerDrag, endQueueDrag, clearQueueDropHint, overQueue, dropQueue, dropQueueEnd, lockVolume, setTrackVolume, removeFromQueue }; },
  template: document.querySelector('#queue-list-template').innerHTML
};
Vue.createApp({components:{QueueList},setup(){return {state,ui,setPage,goToHome,openEq,goToQueue,openLibrarySearch,toggleSidebar,libraryItems,queueItems,playerQueueItems,previewTrack,formatTime,togglePlay,togglePreview,setPreviewVolume,restartTrack,playPreviousTrack,playNextTrack,toggleRepeat,addFiles,addFolder,queueSelected,clearLibrary,clearQueue,toggleTrim,setMasterVolume,setFade,setWaveformMinutes,setTempo,selectLibrary,setLibrarySort,pinTrack,dragLibrary,dragQueue,overQueue,dropQueue,lockVolume,setTrackVolume,addToQueue,previewQueue,playItem,removeFromQueue,seekActiveBy,seekLongTrackTo,beginLongTrackSeek,moveLongTrackSeek,endLongTrackSeek,cancelLongTrackSeek,hideSeekHint,drawEqCurve,setEqParameter,wheelEqParameter,beginEqDrag,moveEqDrag,endEqDrag,setOutput,refreshOutputDevices,requestAudioDevices,pickAudioDevice};},template:document.querySelector('#app-template').innerHTML}).mount('#app');
wireDeck(activeDeck); wireDeck(standbyDeck);
previewDeck.addEventListener('timeupdate', updatePreviewHeader);
previewDeck.addEventListener('ended', () => { ui.previewPlaying = false; updatePreviewHeader(); });

window.dj.onQuickAction(action => {
  if (action === 'toggle') togglePlay();
  if (action === 'next') playNextTrack();
});
function toggleRepeat() {
  if (!state.active) return toast('Hãy phát một bài trước');
  state.active.repeat = !state.active.repeat; activeDeck.loop = state.active.repeat;
  renderControls(); saveSoon(); toast(state.active.repeat ? 'Đã bật lặp lại bài' : 'Đã tắt lặp lại bài');
};
async function addFiles() { try { const paths = await window.dj.pickFiles(); if (paths.length) addToLibrary(paths); } catch (error) { console.error(error); toast('Không mở được file nhạc. Vui lòng thử lại.', 4000); } }
async function addFolder() { try { const paths = await window.dj.pickFolder(); if (paths.length) addToLibrary(paths); } catch (error) { console.error(error); toast('Không đọc được thư mục nhạc. Vui lòng thử lại.', 4000); } }
function queueSelected() { const item = getTrack(state.library, state.selectedLibraryTrackId); if (item) addToQueue([item]); else toast('Hãy chọn bài trong thư viện'); };
function clearLibrary() { if (confirm('Xóa toàn bộ thư viện?')) { state.library = []; state.selectedLibraryTrackId = null; saveSoon(); } };
function clearQueue() { if (confirm('Xóa toàn bộ hàng chờ?')) { stopPreview(); state.queue = []; state.selectedQueueTrackId = null; state.previewTrackId = null; updatePreviewHeader(); drawPreviewWaveform(); saveSoon(); } };
async function setWaveformMinutes(value) {
  const minutes = Math.max(1, Math.min(30, Math.round(Number(value) || 1)));
  if (state.waveformMinutes === minutes) return;
  state.waveformMinutes = minutes; saveSoon();
  const analyzeForLimit = async item => {
    let analysis = await analyzeTrack(item);
    if ((analysis?.limitedReason === 'duration' && analysis.duration <= state.waveformMinutes * 60) || (!analysis?.analysisLimited && analysis?.duration > state.waveformMinutes * 60)) analysis = await analyzeTrack(item);
    return analysis;
  };
  const active = state.active, preview = state.previewTrackId && getQueueTrack(state.previewTrackId);
  if (active) {
    const analysis = await analyzeForLimit(active);
    if (state.active?.path === active.path && state.waveformMinutes === minutes) { state.activeAnalysis = analysis; drawWaveform(); }
  }
  if (preview) {
    const analysis = await analyzeForLimit(preview);
    if (state.previewTrackId === preview.path && state.waveformMinutes === minutes) { state.previewAnalysis = analysis; updatePreviewHeader(); drawPreviewWaveform(); }
  }
}
async function toggleTrim() {
  state.autoTrim = !state.autoTrim;
  if (state.autoTrim && state.active) {
    toast('TRIM đang dò lại đoạn im lặng…');
    state.activeAnalysis = await analyzeTrack(state.active);
  }
  const applied = applyTrimToActiveTrack();
  updatePreviewHeader(); drawPreviewWaveform(); renderControls(); saveSoon();
  toast(state.autoTrim ? (applied ? 'TRIM ON — đã bỏ phần im lặng đầu bài' : 'TRIM ON') : 'TRIM OFF');
};
function toggleTone() {
  state.tone = !state.tone;
  applyTone(); renderControls(); saveSoon();
  toast(state.tone ? 'TONE ON — tăng độ ấm và độ rõ' : 'TONE OFF — âm thanh nguyên bản');
};
function setMasterVolume(value, notify = false) {
  state.masterVolume = Math.max(0, Math.min(100, Number(value) || 0));
  if (state.active) setGain(activeDeck, targetGain(state.active));
  saveSoon();
  if (notify) toast(`Âm lượng tổng: ${state.masterVolume}%`, 900);
}
let longTrackSeekPointerId = null;
function updateSeekHint(event) {
  const duration = Number.isFinite(activeDeck.duration) ? activeDeck.duration : 0;
  const rect = event.currentTarget.getBoundingClientRect();
  if (!state.active || duration <= 0 || rect.width <= 0) { ui.seekHintVisible = false; return null; }
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  ui.seekHintPercent = ratio * 100;
  ui.seekHintText = formatTime(duration * ratio);
  ui.seekHintVisible = true;
  return duration * ratio;
}
function hideSeekHint() {
  if (longTrackSeekPointerId === null) ui.seekHintVisible = false;
}
function seekLongTrackTo(ratio) {
  if (!state.active || !Number.isFinite(activeDeck.duration) || activeDeck.duration <= 0) return false;
  const target = Math.max(0, Math.min(activeDeck.duration, activeDeck.duration * ratio));
  activeDeck.currentTime = target;
  waveformScrubTime = null;
  updateTime(target);
  return true;
}
function seekLongTrackFromPointer(event) {
  const target = updateSeekHint(event);
  if (target === null) return false;
  longTrackScrubTime = target;
  updateTime(longTrackScrubTime);
  return true;
}
function beginLongTrackSeek(event) {
  if (!seekLongTrackFromPointer(event)) return;
  longTrackSeekPointerId = event.pointerId;
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add('is-scrubbing');
  event.preventDefault();
}
function moveLongTrackSeek(event) {
  updateSeekHint(event);
  if (event.pointerId !== longTrackSeekPointerId) return;
  seekLongTrackFromPointer(event);
  event.preventDefault();
}
function endLongTrackSeek(event) {
  if (event.pointerId !== longTrackSeekPointerId) return;
  seekLongTrackFromPointer(event);
  if (Number.isFinite(longTrackScrubTime)) activeDeck.currentTime = longTrackScrubTime;
  longTrackScrubTime = null;
  longTrackSeekPointerId = null;
  event.currentTarget.classList.remove('is-scrubbing');
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  updateTime();
  toast(`Đã tua đến ${formatTime(activeDeck.currentTime)}`, 900);
}
function cancelLongTrackSeek(event) {
  if (event.pointerId !== longTrackSeekPointerId) return;
  longTrackSeekPointerId = null;
  longTrackScrubTime = null;
  event.currentTarget.classList.remove('is-scrubbing');
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  ui.seekHintVisible = false;
  updateTime();
}
function seekActiveBy(seconds) {
  if (!state.active || !Number.isFinite(activeDeck.duration)) return toast('Hãy phát một bài trước');
  const target = Math.max(0, Math.min(activeDeck.duration, activeDeck.currentTime + seconds));
  activeDeck.currentTime = target; waveformScrubTime = null;
  updateTime(); drawWaveform();
  toast(`Tua: ${formatTime(target)} / ${formatTime(activeDeck.duration)}`, 900);
}
function setFade(value) { state.fadeDuration = Math.max(.15, Math.min(2, +value / 1000)); renderControls(); saveSoon(); }
function setTempo(value) { state.tempo = Math.max(80, Math.min(120, value)); activeDeck.playbackRate = standbyDeck.playbackRate = state.tempo / 100; renderControls(); saveSoon(); }

window.addEventListener('keydown', event => {
  if (ui.eqOpen && event.key === 'Escape') { event.preventDefault(); setPage('player'); return; }
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.matches('input, textarea, select, [contenteditable="true"]') || target.isContentEditable);
  if (!typing && (event.ctrlKey || event.metaKey) && event.code === 'KeyK') { event.preventDefault(); openLibrarySearch(); return; }
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  const discrete = ['Space', 'KeyN', 'KeyR', 'KeyL', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious'];
  if (event.repeat && discrete.includes(event.code)) return;
  switch (event.code) {
    case 'Space': event.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': event.preventDefault(); seekActiveBy(event.shiftKey ? -15 : -5); break;
    case 'ArrowRight': event.preventDefault(); seekActiveBy(event.shiftKey ? 15 : 5); break;
    case 'ArrowUp': event.preventDefault(); setMasterVolume(state.masterVolume + 5, true); break;
    case 'ArrowDown': event.preventDefault(); setMasterVolume(state.masterVolume - 5, true); break;
    case 'Equal': case 'NumpadAdd': event.preventDefault(); setMasterVolume(state.masterVolume + 5, true); break;
    case 'Minus': case 'NumpadSubtract': event.preventDefault(); setMasterVolume(state.masterVolume - 5, true); break;
    case 'KeyN': event.preventDefault(); playNextTrack(); break;
    case 'KeyR': event.preventDefault(); restartTrack(); break;
    case 'KeyL': event.preventDefault(); toggleRepeat(); break;
    case 'MediaPlayPause': event.preventDefault(); togglePlay(); break;
    case 'MediaTrackNext': event.preventDefault(); playNextTrack(); break;
    case 'MediaTrackPrevious': event.preventDefault(); restartTrack(); break;
    case 'MediaFastForward': event.preventDefault(); seekActiveBy(10); break;
    case 'MediaRewind': event.preventDefault(); seekActiveBy(-10); break;
    case 'AudioVolumeUp': event.preventDefault(); setMasterVolume(state.masterVolume + 5, true); break;
    case 'AudioVolumeDown': event.preventDefault(); setMasterVolume(state.masterVolume - 5, true); break;
  }
});
{
  const waveform = $('#waveform');
  let scrubPointerId = null;
  const previewSeekFromPointer = event => {
    if (!Number.isFinite(activeDeck.duration) || activeDeck.duration <= 0) return false;
    const rect = waveform.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    waveformScrubTime = activeDeck.duration * ratio;
    updateTime(waveformScrubTime); drawWaveform();
    toast(`Tua đến: ${formatTime(waveformScrubTime)} / ${formatTime(activeDeck.duration)}`, 0);
    return waveformScrubTime;
  };
  const finishScrub = event => {
    if (event.pointerId !== scrubPointerId) return;
    const targetTime = previewSeekFromPointer(event);
    scrubPointerId = null;
    waveform.classList.remove('is-scrubbing');
    if (waveform.hasPointerCapture(event.pointerId)) waveform.releasePointerCapture(event.pointerId);
    if (targetTime === false) return;
    // Do not disturb playback while dragging. Commit the seek only on release.
    activeDeck.currentTime = targetTime;
    waveformScrubTime = null;
    updateTime(); drawWaveform();
    toast(`Đã tua đến ${formatTime(targetTime)}`, 1200);
  };
  waveform.addEventListener('pointerdown', event => {
    if (previewSeekFromPointer(event) === false) return;
    scrubPointerId = event.pointerId;
    waveform.setPointerCapture(event.pointerId);
    waveform.classList.add('is-scrubbing');
    event.preventDefault();
  });
  waveform.addEventListener('pointermove', event => {
    if (event.pointerId === scrubPointerId) { previewSeekFromPointer(event); event.preventDefault(); }
  });
  waveform.addEventListener('pointerup', finishScrub);
  waveform.addEventListener('pointercancel', event => {
    if (event.pointerId !== scrubPointerId) return;
    scrubPointerId = null; waveformScrubTime = null;
    waveform.classList.remove('is-scrubbing');
    updateTime(); drawWaveform();
  });
}
{
  const previewWaveform = $('#preview-waveform'), previewProgress = $('#preview-long-track');
  let cuePointerId = null;
  let cueTarget = null;
  const setCueFromPointer = event => {
    const preview = state.previewTrackId ? getQueueTrack(state.previewTrackId) : null;
    const duration = state.previewAnalysis?.duration || preview?.duration;
    if (!preview || !Number.isFinite(duration) || duration <= 0) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    previewCueScrubTime = duration * ratio;
    updatePreviewHeader(); drawPreviewWaveform(); saveSoon();
    toast(`Điểm phát: ${formatTime(previewCueScrubTime)} / ${formatTime(duration)}`, 0);
    return true;
  };
  const finishCue = event => {
    if (event.pointerId !== cuePointerId) return;
    setCueFromPointer(event);
    const preview = state.previewTrackId ? getQueueTrack(state.previewTrackId) : null;
    if (preview && Number.isFinite(previewCueScrubTime)) {
      preview.cuePosition = previewCueScrubTime; preview.manualCue = true;
      if (previewLoadedPath === preview.path && previewDeck.readyState >= 1) previewDeck.currentTime = previewCueScrubTime;
    }
    previewCueScrubTime = null;
    cuePointerId = null;
    cueTarget.classList.remove('is-scrubbing');
    if (cueTarget.hasPointerCapture(event.pointerId)) cueTarget.releasePointerCapture(event.pointerId);
    cueTarget = null;
    if (preview) toast(`Đã đặt điểm phát: ${formatTime(preview.cuePosition)}`, 1200);
  };
  [previewWaveform, previewProgress].forEach(target => {
  target.addEventListener('pointerdown', event => {
    if (!setCueFromPointer(event)) return;
    cuePointerId = event.pointerId;
    cueTarget = target; target.setPointerCapture(event.pointerId);
    target.classList.add('is-scrubbing');
    event.preventDefault();
  });
  target.addEventListener('pointermove', event => {
    if (event.pointerId === cuePointerId) { setCueFromPointer(event); event.preventDefault(); }
  });
  target.addEventListener('pointerup', finishCue);
  target.addEventListener('pointercancel', finishCue);
  });
  previewProgress.addEventListener('keydown', event => {
    const preview = state.previewTrackId && getQueueTrack(state.previewTrackId);
    const duration = state.previewAnalysis?.duration || preview?.duration;
    if (!preview || !Number.isFinite(duration) || duration <= 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const position = previewLoadedPath === preview.path && ui.previewPlaying ? previewDeck.currentTime : (preview.cuePosition || 0);
    preview.cuePosition = event.key === 'Home' ? 0 : event.key === 'End' ? duration : Math.max(0, Math.min(duration, position + (event.key === 'ArrowRight' ? 5 : -5)));
    preview.manualCue = true;
    if (previewLoadedPath === preview.path && previewDeck.readyState >= 1) previewDeck.currentTime = preview.cuePosition;
    updatePreviewHeader(); saveSoon(); event.preventDefault();
  });
}

window.addEventListener('beforeunload', () => { previewDeck.pause(); stopMeter(); analyzerWorker.terminate(); });
navigator.mediaDevices?.addEventListener?.('devicechange', () => { void refreshOutputDevices(); });
enableCrossListDrops();
enablePanelSplitter();
(async () => {
  const saved = await window.dj.loadState();
  if (saved) {
    state.library = Array.isArray(saved.library) ? saved.library.map(normalizeTrack) : [];
    state.queue = Array.isArray(saved.queue) ? saved.queue.map(normalizeTrack) : [];
    state.librarySort = ['name', 'date', 'duration'].includes(saved.librarySort) ? saved.librarySort : 'name';
    state.librarySortDirection = saved.librarySortDirection === 'desc' ? 'desc' : 'asc';
    sortLibrary();
    state.audioCache = Vue.markRaw(saved.audioCache || {}); state.tempo = Number(saved.tempo) || 100;
    state.autoTrim = saved.autoTrim !== false; state.sync = false; state.tone = saved.tone !== false; state.pitch = saved.pitch !== false; state.masterVolume = Number.isFinite(Number(saved.masterVolume)) ? Number(saved.masterVolume) : 100; state.fadeDuration = Math.max(.15, Math.min(2, Number(saved.fadeDuration) || .45)); state.waveformMinutes = Math.max(1, Math.min(30, Math.round(Number(saved.waveformMinutes) || 30))); state.panelSplit = Math.max(.3, Math.min(.7, Number(saved.panelSplit) || .5));
    if (saved.previewVolume != null && Number.isFinite(Number(saved.previewVolume))) state.previewVolume = Math.max(0, Math.min(100, Math.round(Number(saved.previewVolume))));
  }
  state.eq.bands = state.eq.bands.map((defaults, i) => {
    const old = saved?.eq?.bands?.[i];
    if (typeof old === 'number') {
      if (i === 0 && Number(saved.eq.lowCut) > 20) return { ...defaults, type: 'highpass', frequency: Math.min(20000, Number(saved.eq.lowCut)) };
      if (i === 4 && Number(saved.eq.highCut) > 0 && Number(saved.eq.highCut) < 20000) return { ...defaults, type: 'lowpass', frequency: Math.max(20, Number(saved.eq.highCut)) };
      return { ...defaults, gain: Math.max(-12, Math.min(12, old)) };
    }
    if (!old || typeof old !== 'object') return defaults;
    const types = ['peaking', 'lowshelf', 'highshelf', ...([0, 4].includes(i) ? ['highpass', 'lowpass'] : [])];
    return { type: types.includes(old.type) ? old.type : defaults.type, frequency: Math.max(20, Math.min(20000, Number(old.frequency) || defaults.frequency)), gain: Math.max(-12, Math.min(12, Number(old.gain) || 0)), q: Math.max(.1, Math.min(10, Number(old.q) || 1)) };
  });
  state.outputMain = saved?.outputMain || 'default'; state.outputNext = saved?.outputNext || 'default';
  await refreshOutputDevices();
  window.dj.startupPhase('audio');
  applyTone(); applyPanelSplit(); renderAll(); setStatus('READY', 'stopped'); drawMeter(0, 0);
  window.dj.startupPhase('interface');
  void restoreLibraryDurations();
})();
