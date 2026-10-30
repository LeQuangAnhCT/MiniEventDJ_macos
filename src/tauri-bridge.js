/* MiniEventDJ Tauri 2 bridge. Static Vue 3 frontend: no webpack/vite required. */
(() => {
  'use strict';
  const api = window.__TAURI__;
  if (!api?.core?.invoke || !api?.event?.listen) {
    console.error('MiniEventDJ phải được mở qua Tauri (npm run dev), không mở HTML trực tiếp.');
    return;
  }
  const invoke = api.core.invoke;
  const listen = api.event.listen;
  const fileUrl = path => api.core.convertFileSrc(path);

  // Renderer-compatible API, replacing contextBridge + Electron IPC.
  window.dj = Object.freeze({
    fileUrl,
    audioDiagnostic: report => invoke('audio_diagnostic', { report }).catch(console.error),
    pickFiles: () => invoke('pick_files'),
    pickFolder: () => invoke('pick_folder'),
    loadState: async () => {
      const saved = await invoke('load_state');
      if (saved) {
        const paths = [...(Array.isArray(saved.library) ? saved.library : []),
                       ...(Array.isArray(saved.queue) ? saved.queue : [])]
          .map(item => typeof item === 'string' ? item : item?.path)
          .filter(path => typeof path === 'string');
        // Scopes are temporary in Tauri 2; reauthorize saved tracks every launch.
        if (paths.length) await invoke('register_paths', { paths: [...new Set(paths)] });
      }
      return saved;
    },
    saveState: state => invoke('save_state', { state }),
    // Rust's Response returns raw ArrayBuffer instead of a huge JSON array.
    readAudio: async path => new Uint8Array(await invoke('read_audio', { path })),
    waveformSamples: path => invoke('waveform_samples', { path }),
    audioMeta: path => invoke('audio_meta', { path }),
    startupPhase: phase => invoke('startup_phase', { phase }).catch(console.error),
    onQuickAction: callback => {
      listen('quick-action', event => callback(event.payload)).catch(console.error);
    },
    setQuickControlState: state => invoke('quick_control_state', { state }).catch(console.error)
  });

  window.quickControl = Object.freeze({
    action: action => invoke('quick_control_action', { action }).catch(console.error),
    onState: callback => {
      invoke('get_quick_control_state').then(state => callback(state || { playbackState: 'stopped', hasTrack: false })).catch(console.error);
      listen('quick-control-state', event => callback(event.payload)).catch(console.error);
    }
  });

  window.splash = Object.freeze({
    logoUrl: 'logo.png',
    onProgress: callback => listen('splash-progress', event => callback(event.payload)).catch(console.error),
    onComplete: callback => listen('splash-complete', () => callback()).catch(console.error)
  });
})();
