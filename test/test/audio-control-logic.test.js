const assert = require('node:assert/strict');
const audioLogic = require('../src/audio-control-logic.js');

const analysedTrack = { manualCue: false, cuePosition: null };
assert.equal(audioLogic.cuePosition(analysedTrack, { audibleStart: 2.4 }, true), 2.4, 'TRIM ON must skip detected leading silence');
assert.equal(audioLogic.cuePosition(analysedTrack, { audibleStart: 2.4 }, false), 0, 'TRIM OFF must begin from the original start');
assert.equal(audioLogic.cuePosition({ manualCue: true, cuePosition: 6.8 }, { audibleStart: 2.4 }, false), 6.8, 'manual cue must take precedence');
assert.equal(audioLogic.trimEnd({ audibleEnd: 178 }, 180, true), 178, 'TRIM ON must skip detected trailing silence');
assert.equal(audioLogic.trimEnd({ audibleEnd: 178 }, 180, false), 180, 'TRIM OFF must preserve the full track duration');

const sampleRate = 1000;
const samples = new Float32Array(sampleRate * 4);
for (let index = sampleRate; index < sampleRate * 3; index++) samples[index] = .25 * Math.sin(index / 9);
const detected = audioLogic.detectSilenceBounds(samples, sampleRate);
assert.ok(detected.audibleStart >= .95 && detected.audibleStart <= 1.1, 'TRIM must find the real audio start after leading silence');
assert.ok(detected.audibleEnd >= 2.9 && detected.audibleEnd <= 3.1, 'TRIM must find the real audio end before trailing silence');

const longLeadIn = new Float32Array(sampleRate * 75);
for (let index = sampleRate * 60; index < longLeadIn.length; index += 1) longLeadIn[index] = .25 * Math.sin(index / 9);
const longLeadInBounds = audioLogic.detectSilenceBounds(longLeadIn, sampleRate);
assert.ok(longLeadInBounds.audibleStart >= 59.9 && longLeadInBounds.audibleStart <= 60.1, 'TRIM must scan beyond 15 seconds of leading silence');

const toneOn = audioLogic.toneProfile(true);
const toneOff = audioLogic.toneProfile(false);
assert.deepEqual(toneOff, { low: 0, presence: 0, high: 0 }, 'TONE OFF must be flat');
assert.ok(toneOn.low > 0 && toneOn.low <= 1.5 && toneOn.high > 0 && toneOn.high <= 1, 'TONE ON must use a gentle EQ profile with clipping headroom');

console.log('audio-control-logic: OK');
