const assert = require('node:assert/strict');
const PlaybackTransitionGuard = require('../src/playback-transition.js');

const callbacks = [];
const guard = new PlaybackTransitionGuard();
let stoppedDeck = null;
const schedule = callback => callbacks.push(callback);

// Simulate five fast Next presses. Every old crossfade completion must become inert.
for (const deck of ['A', 'B', 'A', 'B', 'A']) {
  const token = guard.begin();
  guard.schedule(token, () => { stoppedDeck = deck; }, 450, schedule);
}
callbacks.forEach(callback => callback());

assert.equal(stoppedDeck, 'A', 'only the final Next transition may stop its outgoing deck');
assert.equal(callbacks.length, 5, 'the regression test must exercise every queued fade callback');
console.log('playback-transition: OK');
