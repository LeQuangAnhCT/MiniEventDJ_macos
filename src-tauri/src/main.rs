#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, sync::Mutex, time::{Duration, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent};
use tauri::ipc::Response;
use tauri_plugin_dialog::DialogExt;
use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error as DecodeError, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};

#[derive(Default)]
struct PlaybackState(Mutex<Value>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioMeta {
    mtime_ms: f64,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformSamples {
    sample_rate: u32,
    samples: Vec<f32>,
}

// Decode a long track in bounded chunks and send only 100 peak samples per second.
// Playback continues to stream the original file independently.
#[tauri::command]
async fn waveform_samples(path: String) -> Result<WaveformSamples, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = Path::new(&path);
        if !is_audio(file_path) { return Err("Định dạng không hỗ trợ".into()); }
        let file = fs::File::open(file_path).map_err(|e| e.to_string())?;
        let mut hint = Hint::new();
        if let Some(ext) = file_path.extension().and_then(|s| s.to_str()) { hint.with_extension(ext); }
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let probe = symphonia::default::get_probe().format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default()).map_err(|e| e.to_string())?;
        let mut format = probe.format;
        let track = format.default_track().ok_or("Không tìm thấy luồng âm thanh")?;
        let track_id = track.id;
        let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|e| e.to_string())?;
        let mut samples = Vec::with_capacity(180_000);
        let mut peak = 0f32;
        let mut frames_in_bucket = 0usize;
        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(DecodeError::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.to_string()),
            };
            if packet.track_id() != track_id { continue; }
            let decoded = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(DecodeError::DecodeError(_)) => continue,
                Err(error) => return Err(error.to_string()),
            };
            let spec = *decoded.spec();
            let channels = spec.channels.count();
            let frames_per_bucket = (spec.rate as usize / 100).max(1);
            let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            buffer.copy_interleaved_ref(decoded);
            for frame in buffer.samples().chunks(channels) {
                peak = peak.max(frame[0].abs());
                frames_in_bucket += 1;
                if frames_in_bucket >= frames_per_bucket {
                    samples.push(peak);
                    if samples.len() > 180_100 { return Err("Bài nhạc dài hơn 30 phút".into()); }
                    peak = 0.; frames_in_bucket = 0;
                }
            }
        }
        if frames_in_bucket > 0 { samples.push(peak); }
        if samples.is_empty() { return Err("Không đọc được dữ liệu âm thanh".into()); }
        Ok(WaveformSamples { sample_rate: 100, samples })
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
struct SplashProgress {
    percent: u8,
    status: &'static str,
    step: &'static str,
    indeterminate: bool,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|x| matches!(x.to_ascii_lowercase().as_str(),
            "mp3" | "wav" | "m4a" | "aac" | "wma" | "ogg" | "flac"))
        .unwrap_or(false)
}

fn allow_track(app: &AppHandle, path: &Path) -> Result<(), String> {
    if !is_audio(path) || !path.is_file() {
        return Err(format!("Không tồn tại hoặc không phải file nhạc: {}", path.display()));
    }
    // Unlike Electron's file:// URL, Tauri requires an explicit asset-protocol scope.
    // Only files in the actual music library are exposed, not the whole user disk.
    app.asset_protocol_scope().allow_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn register_paths(app: AppHandle, paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| allow_track(&app, Path::new(p)).is_ok()).collect()
}

#[tauri::command]
fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = app.dialog().file()
        .add_filter("Âm thanh", &["mp3", "wav", "m4a", "aac", "wma", "ogg", "flac"])
        .blocking_pick_files();
    let mut output = Vec::new();
    for selected in picked.unwrap_or_default() {
        if let Ok(path) = selected.into_path() {
            if allow_track(&app, &path).is_ok() {
                output.push(path.to_string_lossy().into_owned());
            }
        }
    }
    Ok(output)
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Result<Vec<String>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(vec![]); };
    let root = folder.into_path().map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(dir) else { continue; };
        for item in entries.flatten() {
            let Ok(kind) = item.file_type() else { continue; };
            // Don't follow directory symlinks / junctions in recursive scans.
            if kind.is_symlink() { continue; }
            if kind.is_dir() { stack.push(item.path()); }
            else if kind.is_file() && is_audio(&item.path()) {
                let path = item.path();
                if allow_track(&app, &path).is_ok() {
                    found.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    found.sort();
    Ok(found)
}

fn library_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|p| p.join("library.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    let target = library_file(&app)?;
    // Preserve libraries saved by the original Electron version on Windows.
    let mut candidates = vec![target];
    if let Some(roaming) = std::env::var_os("APPDATA") {
        for name in ["minieventdj-electron", "MiniEventDJ", "minieventdj"] {
            candidates.push(PathBuf::from(roaming.clone()).join(name).join("library.json"));
        }
    }
    for path in candidates {
        if let Ok(body) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str(&body) { return Ok(Some(value)); }
        }
    }
    Ok(None)
}

#[tauri::command]
fn save_state(app: AppHandle, state: Value) -> Result<(), String> {
    let file = library_file(&app)?;
    if let Some(dir) = file.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let contents = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    fs::write(&file, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn audio_meta(path: String) -> Result<AudioMeta, String> {
    let file = Path::new(&path);
    if !is_audio(file) { return Err("Định dạng không hỗ trợ".into()); }
    let info = fs::metadata(file).map_err(|e| e.to_string())?;
    let timestamp = info.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|x| x.as_secs_f64() * 1000.0).unwrap_or(0.0);
    Ok(AudioMeta { mtime_ms: timestamp, size: info.len() })
}

#[tauri::command]
fn read_audio(path: String) -> Result<Response, String> {
    let file = Path::new(&path);
    if !is_audio(file) { return Err("Định dạng không hỗ trợ".into()); }
    // The full byte buffer is ONLY for waveform/BPM analysis; streaming playback
    // uses the WebView asset protocol and does not read the whole song into IPC.
    let size = fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size > 24 * 1024 * 1024 { return Err("File quá lớn để phân tích".into()); }
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

fn progress(app: &AppHandle, percent: u8, status: &'static str, step: &'static str, indeterminate: bool) {
    let _ = app.emit_to("splash", "splash-progress", SplashProgress {percent, status, step, indeterminate});
}

#[tauri::command]
fn startup_phase(app: AppHandle, phase: String) {
    match phase.as_str() {
        "audio" => progress(&app, 68, "KHỞI TẠO ÂM THANH", "audio", false),
        "interface" => {
            progress(&app, 90, "HOÀN TẤT GIAO DIỆN", "interface", false);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(2400));
                let _ = app.emit_to("splash", "splash-complete", ());
                std::thread::sleep(Duration::from_millis(250));
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Some(splash) = app.get_webview_window("splash") { let _ = splash.close(); }
            });
        }
        _ => {}
    }
}

#[tauri::command]
fn quick_control_state(app: AppHandle, state: Value, playback: State<'_, PlaybackState>) {
    if let Ok(mut current) = playback.0.lock() { *current = state.clone(); }
    let _ = app.emit_to("quick", "quick-control-state", state);
}

#[tauri::command]
fn get_quick_control_state(playback: State<'_, PlaybackState>) -> Value {
    playback.0.lock().map(|v| v.clone()).unwrap_or(Value::Null)
}

#[tauri::command]
fn quick_control_action(app: AppHandle, action: String) {
    if action == "open" {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        if let Some(quick) = app.get_webview_window("quick") { let _ = quick.hide(); }
    } else if matches!(action.as_str(), "toggle" | "next") {
        let _ = app.emit_to("main", "quick-action", action);
    }
}

fn position_quick(app: &AppHandle) {
    let (Some(main), Some(quick)) = (app.get_webview_window("main"), app.get_webview_window("quick")) else {return};
    let Ok(Some(monitor)) = main.current_monitor() else {return};
    let work = monitor.work_area();
    let Ok(size) = quick.outer_size() else {return};
    let pos = PhysicalPosition::new(
        work.position.x + work.size.width as i32 - size.width as i32 - 18,
        work.position.y + work.size.height as i32 - size.height as i32 - 18,
    );
    let _ = quick.set_position(pos);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize(); let _ = main.show(); let _ = main.set_focus();
            }
            if let Some(quick) = app.get_webview_window("quick") { let _ = quick.hide(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(PlaybackState::default())
        .invoke_handler(tauri::generate_handler![
            register_paths, pick_files, pick_folder, load_state, save_state,
            read_audio, waveform_samples, audio_meta, startup_phase, quick_control_action,
            quick_control_state, get_quick_control_state
        ])
        .setup(|app| {
            position_quick(app.handle());
            progress(app.handle(), 12, "HỆ THỐNG SẴN SÀNG", "system", false);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            match event {
                WindowEvent::Resized(_) => {
                    let Some(quick) = window.app_handle().get_webview_window("quick") else {return};
                    if window.is_minimized().unwrap_or(false) {
                        position_quick(window.app_handle());
                        let _ = quick.show();
                    } else { let _ = quick.hide(); }
                }
                WindowEvent::Focused(true) => {
                    if let Some(quick) = window.app_handle().get_webview_window("quick") { let _ = quick.hide(); }
                }
                WindowEvent::CloseRequested { .. } => window.app_handle().exit(0),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("Không khởi động được MiniEventDJ Tauri 2");
}
