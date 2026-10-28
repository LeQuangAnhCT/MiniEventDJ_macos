const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const code = source.slice(source.indexOf('function fadePreview('), source.indexOf('async function togglePreview('));
let now = 0, id = 0;
const timers = new Map();
const deck = { volume: 0, paused: false, pause() { this.paused = true; } };
const context = { previewDeck: deck, previewToken: 1, previewFadeFrame: 0, ui: { previewPlaying: true }, state: { fadeDuration: .5, previewVolume: 50 }, saveSoon() {}, performance: { now: () => now }, setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id) };
vm.createContext(context); vm.runInContext(code, context);
function tick(ms) { now += ms; const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }
context.fadePreview(.5, 1); tick(250); assert.equal(deck.volume, .25); tick(250); assert.equal(deck.volume, .5);
context.stopPreview(true); assert.equal(deck.paused, false); tick(250); assert.equal(deck.volume, .25); tick(250); assert.equal(deck.volume, 0); assert.equal(deck.paused, true);
deck.paused = false; context.ui.previewPlaying = true; context.setPreviewVolume(80); tick(40); assert.equal(deck.volume, .8); assert.equal(context.state.previewVolume, 80);
context.setPreviewVolume(0); tick(40); assert.equal(deck.volume, 0); assert.equal(context.state.previewVolume, 0);
console.log('preview-fade: OK');
