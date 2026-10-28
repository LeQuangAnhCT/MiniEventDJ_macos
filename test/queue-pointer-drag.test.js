const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const code = source.slice(source.indexOf('function dropIntoQueue('), source.indexOf('function enableCrossListDrops('))
  + source.slice(source.indexOf('function clearPointerQueueTarget('), source.indexOf('function queueDropAfter('));
const state = { queue: ['a', 'b', 'c'].map(path => ({ path })), library: [] };
const classes = () => {
  const values = new Set();
  return { add: (...names) => names.forEach(name => values.add(name)), remove: (...names) => names.forEach(name => values.delete(name)), has: name => values.has(name) };
};
const targetRow = { dataset: { queuePath: 'b' }, classList: classes(), closest: () => targetRow, getBoundingClientRect: () => ({ top: 100, height: 40 }) };
const sourceRow = { dataset: { queuePath: 'a' }, classList: classes() };
const handle = { closest: () => sourceRow, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} };
const context = {
  state, draggedItem: null, queuePointerDrag: null, volumeAdjusting: false,
  getTrack: (tracks, trackPath) => tracks.find(item => item.path === trackPath), makeTrack: trackPath => ({ path: trackPath }),
  saveSoon() {}, toast() {},
  document: { querySelectorAll: () => [targetRow], elementFromPoint: () => targetRow },
  window: { addEventListener() {}, removeEventListener() {} }
};
vm.createContext(context); vm.runInContext(code, context);

const start = { button: 0, pointerId: 7, clientX: 20, clientY: 20, currentTarget: handle, preventDefault() {}, stopPropagation() {} };
context.beginQueuePointerDrag(start, state.queue[0]);
context.moveQueuePointerDrag({ pointerId: 7, clientX: 20, clientY: 130, preventDefault() {} });
context.finishQueuePointerDrag({ pointerId: 7 });

assert.equal(state.queue.map(item => item.path).join(''), 'bac', 'pointer drag moves a queue row after its target');
assert.equal(sourceRow.classList.has('is-dragging'), false, 'pointer drag cleans its source state');
assert.equal(targetRow.classList.has('pointer-drop-after'), false, 'pointer drag clears its insertion marker');
console.log('queue-pointer-drag: OK');
