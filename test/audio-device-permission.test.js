const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const handlers = source.slice(source.indexOf('async function refreshOutputDevices('), source.indexOf('async function routeOutput('));
let live = false, stopped = false;
const ui = { outputBusy: false, outputError: '', outputDevices: [] };
const navigator = { mediaDevices: {
  async getUserMedia(options) { assert.equal(options.audio, true); assert.equal(options.video, false); live = true; return { getTracks: () => [{ stop() { live = false; stopped = true; } }] }; },
  async enumerateDevices() { return live ? [{ kind: 'audiooutput', deviceId: 'default', label: 'Default' }, { kind: 'audiooutput', deviceId: 'speaker', label: 'Loa' }, { kind: 'audiooutput', deviceId: 'headphones', label: 'Tai nghe' }] : [{ kind: 'audiooutput', deviceId: 'default', label: 'Default' }]; },
  async selectAudioOutput() { return { deviceId: 'usb', label: 'USB' }; }
} };
const context = { navigator, ui, console: { warn() {} }, toast() {} };
vm.createContext(context); vm.runInContext(handlers, context);
(async () => {
  await context.refreshOutputDevices(); assert.equal(ui.outputDevices.length, 0);
  await context.requestAudioDevices(); assert.equal(ui.outputDevices.length, 2); assert.equal(stopped, true); assert.equal(ui.outputBusy, false);
  await context.pickAudioDevice(); assert.equal(ui.outputDevices[0].id, 'usb');
  navigator.mediaDevices.getUserMedia = async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; };
  await context.requestAudioDevices(); assert.match(ui.outputError, /microphone/); assert.equal(ui.outputBusy, false);
  console.log('audio-device-permission: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
