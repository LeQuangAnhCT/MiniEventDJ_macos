const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'tauri-bridge.js'), 'utf8');
const called = [];
const calls = { 
  load_state: { library: [{ path: 'C:\\Music\\song.mp3' }], queue: [{ path: 'C:\\Music\\song.mp3' }] },
  register_paths: ['C:\\Music\\song.mp3'],
  get_quick_control_state: null,
  pick_files: ['C:\\Music\\song.mp3'],
};
const ctx = { window: { __TAURI__: { core: { 
  invoke: async (name, args) => { called.push({name, args}); return calls[name]; },
  convertFileSrc: p => 'asset:' + p,
}, event: { listen: async () => () => {} } } }, console };
vm.runInNewContext(script, ctx);
(async () => {
  assert.equal(ctx.window.dj.fileUrl('hello.mp3'), 'asset:hello.mp3');
  const state = await ctx.window.dj.loadState();
  assert.equal(state.library[0].path, 'C:\\Music\\song.mp3');
  assert.equal(called.find(x => x.name === 'register_paths').args.paths.length, 1);
  assert.equal((await ctx.window.dj.pickFiles()).length, 1);
  let quickState;
  ctx.window.quickControl.onState(s => quickState = s);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(quickState.playbackState, 'stopped');
  console.log('tauri-bridge: OK');
})().catch(e => {console.error(e); process.exitCode = 1;});
