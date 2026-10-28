// Usage: electron test/decode-track-diagnostic.js "C:\path\to\track.mp3"
// Decodes a real track with Chromium's AudioContext, exactly as the app does.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const trackPath = process.argv.at(-1);
if (!trackPath || !path.isAbsolute(trackPath)) throw new Error('Pass an absolute audio-file path.');
process.stdout.write(`TRIM_DIAGNOSTIC_START ${trackPath}\n`);

ipcMain.once('trim-diagnostic', (_event, result) => {
  process.stdout.write(`TRIM_DIAGNOSTIC_RESULT ${JSON.stringify(result)}\n`);
  app.exit(0);
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL('data:text/html,<title>trim diagnostic</title>');
  await window.webContents.executeJavaScript(`
    const fs = require('fs');
    const { ipcRenderer } = require('electron');
    const audioLogic = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'audio-control-logic.js'))});
    const bytes = fs.readFileSync(${JSON.stringify(trackPath)});
    const context = new AudioContext();
    context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).then(decoded => {
      const samples = decoded.getChannelData(0);
      const bounds = audioLogic.detectSilenceBounds(samples, decoded.sampleRate);
      const seconds = [];
      for (let second = 0; second < Math.min(90, Math.floor(decoded.duration)); second += 1) {
        const start = second * decoded.sampleRate;
        let sum = 0, peak = 0, changes = 0, previous = samples[start] || 0;
        for (let index = start; index < start + decoded.sampleRate; index += 1) {
          const value = samples[index] || 0; sum += value * value; peak = Math.max(peak, Math.abs(value));
          if ((value >= 0) !== (previous >= 0)) changes += 1;
          previous = value;
        }
        seconds.push({ second, rms: Math.sqrt(sum / decoded.sampleRate), peak, changes });
      }
      ipcRenderer.send('trim-diagnostic', { duration: decoded.duration, sampleRate: decoded.sampleRate, ...bounds, seconds });
    }).catch(error => ipcRenderer.send('trim-diagnostic', { error: error.message }));
  `);
});
