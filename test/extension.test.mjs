import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJson } from '../src/storage.mjs';

const ACTIVE = Symbol.for('omo-herdr-dag.activeController');

test('a new extension generation retires the previous one; a stale ctx stops its own generation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omo-dag-extension-'));
  const stateDir = join(dir, 'state'), failFlag = join(dir, 'hc-fails');
  await mkdir(stateDir);
  // Fake herdr-core: no terminals; `ls` fails while the flag file exists.
  const hc = join(dir, 'herdr-core');
  await writeFile(hc, `#!${process.execPath}\nconst fs = require('node:fs');\nconst [command] = process.argv.slice(2);\n` +
    `if (command === 'ls' && fs.existsSync(${JSON.stringify(failFlag)})) { process.stderr.write('{"error":{"kind":"io","message":"hc is down"}}\\n'); process.exit(3); }\n` +
    `console.log(JSON.stringify(command === 'ls' ? { terminals: [] } : {}));\n`);
  await chmod(hc, 0o755);
  await writeFile(join(dir, 'hc.sock'), '');
  const keys = ['HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_BIN_PATH', 'HC_APP_BIN_PATH', 'HERDR_ENV', 'OMO_HERDR_DAG_STATE_DIR', 'OMO_HERDR_DAG_TASK_STATE_DIR'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HC_TERMINAL_ID: 't0', HC_TERMINAL_SOCKET: join(dir, 'hc.sock'), HC_BIN_PATH: hc,
    HC_APP_BIN_PATH: join(dir, 'no-herdr-app'), HERDR_ENV: '', OMO_HERDR_DAG_STATE_DIR: stateDir, OMO_HERDR_DAG_TASK_STATE_DIR: join(dir, 'tasks') });
  t.after(async () => {
    await globalThis[ACTIVE]?.();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(dir, { recursive: true, force: true });
  });

  let generation = 0;
  const startSession = async (sessionId, notify = () => {}) => {
    // A fresh module instance per generation, as a reload loads one.
    const extension = (await import(`../extension.mjs?generation=${++generation}`)).default;
    const handlers = {};
    extension({ cwd: dir, on: (name, handler) => { handlers[name] = handler; }, events: { on: () => () => {} }, registerCommand() {} });
    await handlers.session_start({}, { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(dir, `${sessionId}.jsonl`) },
      ui: { notify } });
  };
  const stateOf = async sessionId => {
    for (const file of await readdir(stateDir)) {
      if (!file.endsWith('.json') || file.endsWith('.pane.json') || file.endsWith('.view.json')) continue;
      const state = await readJson(join(stateDir, file));
      if (state?.sessionId === sessionId) return state;
    }
  };

  await startSession('session-1');
  assert.equal((await stateOf('session-1')).connected, true);
  await startSession('session-2');
  assert.equal((await stateOf('session-1')).connected, false);
  assert.equal((await stateOf('session-2')).connected, true);

  // The start-time legacy sweep fails and reports through a ctx that was retired meanwhile.
  await writeFile(failFlag, '');
  const stale = () => { throw new Error('This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.'); };
  await startSession('session-3', stale);
  assert.equal((await stateOf('session-2')).connected, false);
  assert.equal(globalThis[ACTIVE], undefined, 'the stale generation retired itself instead of staying active');
});
