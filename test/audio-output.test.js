const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const handlers = source.slice(source.indexOf('async function routeOutput('), source.indexOf('function setEqParameter('));
const main = { calls: [], async setSinkId(id) { this.calls.push(id); if (id === 'missing') throw new Error('NotFound'); } };
const preview = { calls: [], async setSinkId(id) { this.calls.push(id); if (id === 'missing') throw new Error('NotFound'); } };
const state = { outputMain: 'default', outputNext: 'default' };
const ui = { outputBusy: false, outputError: '' };
const context = { state, ui, audioContext: main, previewDeck: preview, mainOutputApplied: null, saveSoon() {}, toast() {}, console: { warn() {} } };
vm.createContext(context); vm.runInContext(handlers, context);
(async () => {
  await context.setOutput('main', 'speakers', {});
  assert.equal(main.calls.at(-1), 'speakers');
  assert.equal(state.outputMain, 'speakers');
  assert.equal(preview.calls.length, 0, 'main output routes the AudioContext, not preview');
  await context.setOutput('next', 'headphones', {});
  assert.equal(preview.calls.at(-1), 'headphones');
  assert.equal(state.outputNext, 'headphones');
  const select = { value: 'missing' };
  await context.setOutput('main', 'missing', select);
  assert.equal(select.value, 'speakers'); assert.equal(state.outputMain, 'speakers'); assert.ok(ui.outputError);
  await context.setOutput('main', 'default', {});
  assert.equal(main.calls.at(-1), '', 'default maps to the Web Audio default device');
  state.outputMain = 'saved'; context.mainOutputApplied = null;
  await context.restoreMainOutput();
  assert.equal(main.calls.at(-1), 'saved', 'saved main output is applied before playback');
  state.outputMain = 'missing'; context.mainOutputApplied = null;
  await context.restoreMainOutput();
  assert.equal(state.outputMain, 'missing', 'preserve the saved selection if the device is temporarily unavailable'); assert.ok(ui.outputError);
  await assert.rejects(context.routeOutput({}, 'headphones'));
  await context.routeOutput({}, 'default');
  // WebKit: AudioContext lacks setSinkId, but HTML audio can select speakers.
  class OutputAudio {
    constructor() { this.sinkId = ''; this.paused = true; }
    async setSinkId(id) { if (id === 'missing') throw new Error('NotFound'); this.sinkId = id; }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const destination = {}, streamDestination = { stream: {} };
  const connections = new Set([destination]);
  context.mainOutputBridge = null;
  context.Audio = context.HTMLMediaElement = OutputAudio;
  context.audioContext = {
    destination, async resume() {},
    createMediaStreamDestination() { return streamDestination; }
  };
  context.outputLimiter = {
    connect(node) { connections.add(node); },
    disconnect(node) { connections.delete(node); }
  };
  const previewCalls = preview.calls.length;
  await context.setOutput('main', 'usb', {});
  assert.equal(context.mainOutputBridge.audio.sinkId, 'usb');
  assert.equal(context.mainOutputBridge.audio.paused, false);
  assert.equal(connections.has(destination), false, 'avoid playing main on two devices');
  assert.equal(connections.has(streamDestination), true);
  assert.equal(preview.calls.length, previewCalls, 'main bridge never reroutes preview');
  await context.setOutput('next', 'headphones', {});
  assert.equal(preview.calls.at(-1), 'headphones');
  await context.setOutput('main', 'missing', {});
  assert.equal(state.outputMain, 'usb', 'failed switch keeps the previous output');
  assert.equal(context.mainOutputBridge.audio.sinkId, 'usb');
  await context.setOutput('main', 'default', {});
  assert.equal(connections.has(destination), true);
  assert.equal(connections.has(streamDestination), false);
  assert.equal(context.mainOutputBridge.audio.paused, true);
  console.log('audio-output: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
