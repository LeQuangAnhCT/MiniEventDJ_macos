const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const functions = source.slice(source.indexOf('function graphFor('), source.indexOf('function setGain('));
const parameter = value => ({ value, setTargetAtTime(next) { this.value = next; } });
const node = () => ({ connections: [], connect(next) { this.connections.push(next); return next; } });
class AudioContextMock {
  constructor() { this.destination = node(); this.currentTime = 0; this.sampleRate = 48000; }
  createMediaElementSource() { return node(); }
  createGain() { return { ...node(), gain: parameter(1) }; }
  createBiquadFilter() { return { ...node(), frequency: parameter(0), Q: parameter(1), gain: parameter(0) }; }
  createChannelSplitter() { return node(); }
  createAnalyser() { return { ...node(), fftSize: 1024, frequencyBinCount: 8192 }; }
  createDynamicsCompressor() { return { ...node(), threshold: parameter(0), knee: parameter(0), ratio: parameter(0), attack: parameter(0), release: parameter(0) }; }
}
const bands = Array.from({ length: 5 }, () => ({ type: 'peaking', frequency: 1000, q: 1, gain: 0 }));
const context = { AudioContext: AudioContextMock, audioContext: null, outputLimiter: null, graphs: new WeakMap(), activeDeck: {}, standbyDeck: {}, state: { eq: { bands }, masterVolume: 100 }, OUTPUT_GAIN_CEILING: 1 };
vm.createContext(context); vm.runInContext(functions, context);
context.applyTone();
const a = context.graphFor(context.activeDeck), b = context.graphFor(context.standbyDeck);
assert.equal(a.headroom.gain.value, .5);
assert.equal(a.makeup.gain.value, 2);
assert.equal(a.headroom.gain.value * a.makeup.gain.value, 1, 'neutral EQ retains original level');
assert.equal(a.gain.connections[0], b.gain.connections[0], 'both decks share the output compressor');
const limiter = a.gain.connections[0];
assert.equal(limiter.connections[0], context.audioContext.destination);
assert.equal(limiter.ratio.value, 20);
bands[0].gain = 12; bands[1].gain = 6;
context.applyTone();
for (const graph of [a, b]) {
  assert.equal(graph.headroom.gain.value, .5, 'EQ boost does not automatically reduce input gain');
  assert.equal(graph.filters[0].gain.value, 12);
  assert.equal(graph.filters[1].gain.value, 6);
}
console.log('eq-headroom: OK');
