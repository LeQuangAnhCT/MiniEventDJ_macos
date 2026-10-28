// Run with npm run test:long-audio. Uses isolated silent audio files and never touches the user's library.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medj-long-test-'));
const paths = [];
let reads = 0;
function makeLongWav(file) {
  const rate = 8000, length = rate * 305 * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(length, 40);
  const fd = fs.openSync(file, 'w'); fs.writeSync(fd, header); fs.ftruncateSync(fd, 44 + length); fs.closeSync(fd);
}
app.whenReady().then(async () => {
  let window;
  try {
    for (let i = 0; i < 4; i++) { const file = path.join(fixtureDir, `long-${i}.wav`); makeLongWav(file); paths.push(file); }
    ipcMain.handle('fixture-paths', () => paths);
    ipcMain.handle('fixture-meta', (_event, file) => { const stat = fs.statSync(file); return { size: stat.size, mtimeMs: stat.mtimeMs }; });
    ipcMain.handle('fixture-read', (_event, file) => { reads++; return fs.readFileSync(file); });
    window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(__dirname, 'long-track-preload.js'), contextIsolation: true } });
    let crash = null;
    window.webContents.on('render-process-gone', (_event, details) => { crash = details; });
    await window.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
    await window.webContents.executeJavaScript("document.querySelectorAll('.nav-item')[1].click(); document.querySelector('#add-files').click();");
    const deadline = Date.now() + 15000;
    let result;
    while (Date.now() < deadline && !crash) {
      await new Promise(resolve => setTimeout(resolve, 250));
      result = await window.webContents.executeJavaScript("({ rows:document.querySelectorAll('#library .track').length, toast:document.querySelector('#toast').textContent })");
      if (result.toast.includes('4 bài dài')) break;
    }
    assert.equal(crash, null, 'renderer crashed while adding long tracks');
    assert.equal(result?.rows, 4, 'all four tracks should remain visible');
    assert.match(result?.toast || '', /4 bài dài/, 'all tracks should finish bounded analysis');
    assert.equal(reads, 0, 'long tracks must not be loaded fully into memory');
    await window.webContents.executeJavaScript("document.querySelector('#library .track').click(); document.querySelector('#queue-selected').click();");
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript("document.querySelector('#queue .play-track').click();");
    await new Promise(resolve => setTimeout(resolve, 1200));
    const playback = await window.webContents.executeJavaScript("({status: document.querySelector('#status-text').textContent, title: document.querySelector('#track-title').textContent, progress: document.querySelector('.long-track-progress-fill')?.style.width, waveformDisplay: getComputedStyle(document.querySelector('.wave-wrap')).display})");
    assert.equal(playback.status, 'PLAYING', 'a long track should remain playable');
    assert.match(playback.title, /long-/);
    assert.match(playback.progress || '', /%$/, 'long tracks should expose a live progress bar');
    assert.equal(playback.waveformDisplay, 'none', 'long tracks should hide the empty waveform frame');
    await window.webContents.executeJavaScript(`
      const bar = document.querySelector('.long-track-progress');
      bar.getBoundingClientRect = () => ({ left: 0, width: 400 });
      bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 300, pointerId: 9 }));
      bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, pointerId: 9 }));
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    const seekProgress = await window.webContents.executeJavaScript("Number(document.querySelector('.long-track-progress-fill').style.width.replace('%', ''))");
    assert.ok(seekProgress >= 70 && seekProgress <= 80, 'clicking a long-track progress bar should seek to its position');
    assert.equal(reads, 0, 'playback should also avoid a full analysis read');
    console.log('long-track-regression: OK');
    window.destroy(); fs.rmSync(fixtureDir, { recursive: true, force: true }); app.exit(0);
  } catch (error) {
    console.error(error); if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(fixtureDir, { recursive: true, force: true }); app.exit(1);
  }
});
