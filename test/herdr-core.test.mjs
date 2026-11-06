import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDagViewerPane } from '../src/controller.mjs';
import { createHc, createHerdr, hcSession, resolveHcBin, resolveHerdrAppBin } from '../src/herdr.mjs';

const session = '019a0000-aaaa-7000-8000-000000000001';
const argv = ['/usr/bin/node', '/tmp/viewer.mjs', '--state', '/tmp/s.json', '--owner-pid', '42'];

// Fake herdr-core and herdr-app CLIs sharing one JSON world: hc terminals plus
// the window's spaces/tabs/panes. Both append their argv to one call log.
// hc answers like `hc <cmd> --json` (errors as {"error":{kind}} on stderr, exit 3).
const HC = `
const [command, json, ...rest] = process.argv.slice(2);
log(['hc', command, json, ...rest]);
const fail = message => { process.stderr.write(JSON.stringify({ error: { kind: 'not_found', message } }) + '\\n'); process.exit(3); };
const terminal = address => db.terminals[address] ?? fail('no terminal ' + address);
const pairs = list => Object.fromEntries(list.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
const flags = name => rest.flatMap((value, index) => rest[index - 1] === name ? [value] : []);
if (command === 'ls') {
  const want = pairs(flags('--label'));
  const live = Object.values(db.terminals).filter(x => x.state === 'live'
    && Object.entries(want).every(([k, v]) => x.labels?.[k] === v));
  out({ terminals: live.map(({ labels, rm, ...x }) => x) });
} else if (command === 'get') { const { rm, ...x } = terminal(rest[0]); out(x); }
else if (command === 'label') { const x = terminal(rest[0]); x.labels = { ...x.labels, ...pairs(rest.slice(1)) }; save(); out(x); }
else if (command === 'kill') { const x = terminal(rest[0]); if (x.rm) delete db.terminals[rest[0]]; else x.state = 'finished'; save(); out({}); }
else if (command === 'rm') { const x = terminal(rest[0]); if (x.state === 'live') { process.stderr.write('{"error":{"kind":"live","message":"live"}}\\n'); process.exit(3); } delete db.terminals[rest[0]]; save(); out({}); }
else if (command === 'run') {
  const address = 't' + (db.next++);
  db.terminals[address] = { address, name: address, state: 'live', where: 'w', labels: pairs(flags('--label')), rm: rest.includes('--rm') };
  save(); out({ address, state: 'live' });
} else fail('unknown command ' + command);
`;

const APP = `
const args = process.argv.slice(2);
log(['app', ...args]);
if (!db.window) { out({ error: { message: 'no window' } }); process.exit(1); }
const tabs = db.window.spaces.flatMap(space => space.tabs);
if (args[0] === 'ls') out(db.window);
else if (args[0] === 'do' && args[1] === 'pane.split') {
  const { direction, pane, argv } = JSON.parse(args[2]);
  const tab = tabs.find(tab => tab.terminals.some(entry => entry.pane === pane));
  if (!tab || direction !== 'right') { out({ error: { message: 'bad split' } }); process.exit(1); }
  const address = 't' + (db.next++);
  db.terminals[address] = { address, name: address, state: 'live', where: 'w', labels: {}, argv };
  tab.terminals.push({ terminal: address, pane: 'p' + address });
  save(); out({ pane: 'p' + address, terminal: address });
} else if (args[0] === 'do' && args[1] === 'pane.close') {
  const { pane } = JSON.parse(args[2]);
  const tab = tabs.find(tab => tab.terminals.some(entry => entry.pane === pane));
  if (!tab) { out({ error: { message: 'no pane' } }); process.exit(1); }
  const entry = tab.terminals.find(entry => entry.pane === pane);
  tab.terminals = tab.terminals.filter(other => other !== entry);
  db.terminals[entry.terminal].state = 'finished';
  save(); out({ ok: true });
} else { out({ error: { message: 'unknown' } }); process.exit(1); }
`;

async function fakes(t, { window = true, app = true, parentLabels = { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' }, terminals = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hc-fake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const state = join(directory, 'state.json');
  const log = join(directory, 'calls.jsonl');
  await writeFile(state, JSON.stringify({ next: 1,
    terminals: { t0: { address: 't0', name: 'session', state: 'live', where: 'w', labels: parentLabels }, ...terminals },
    window: window ? { spaces: [{ id: 'sp1', name: 'S', tabs: [{ id: 'tb1', name: 'T',
      terminals: window === 'no-parent' ? [] : [{ terminal: 't0', pane: 'p0' }] }] }] } : null }));
  const prelude = `#!${process.execPath}
const fs = require('node:fs');
const db = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(db));
const out = value => console.log(JSON.stringify(value));
const log = call => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
`;
  const write = async (name, body) => { await writeFile(join(bin, name), prelude + body); chmodSync(join(bin, name), 0o755); };
  await write('herdr-core', HC);
  if (app) await write('herdr-app', APP);
  const socket = join(directory, 'hc.sock');
  await writeFile(socket, '');
  const env = { PATH: bin, HC_TERMINAL_ID: 't0', HC_TERMINAL_SOCKET: socket, HOME: directory };
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const world = async () => JSON.parse(await readFile(state, 'utf8'));
  return { bin, env, calls, world, directory };
}

test('hcSession requires a terminal id, a live socket and a herdr-core binary', async t => {
  const { bin, env } = await fakes(t);
  assert.equal(hcSession(env), true);
  assert.equal(resolveHcBin(env), join(bin, 'herdr-core'));
  assert.equal(hcSession({ ...env, HC_TERMINAL_ID: '' }), false);
  assert.equal(hcSession({ ...env, HC_TERMINAL_SOCKET: join(env.HOME, 'missing.sock') }), false);
  assert.equal(hcSession({ ...env, PATH: '', HOME: join(env.HOME, 'nowhere') }), false);
  assert.equal(hcSession({ ...env, HC_BIN_PATH: join(env.HOME, 'missing') }), false);
});

test('herdr-app resolves from HC_APP_BIN_PATH, then PATH, then ~/.local/bin', async t => {
  const { bin, env, directory } = await fakes(t);
  assert.equal(resolveHerdrAppBin(env), join(bin, 'herdr-app'));
  assert.equal(resolveHerdrAppBin({ ...env, HC_APP_BIN_PATH: join(bin, 'herdr-core') }), join(bin, 'herdr-core'));
  assert.equal(resolveHerdrAppBin({ ...env, HC_APP_BIN_PATH: join(directory, 'missing') }), null);
  assert.equal(resolveHerdrAppBin({ ...env, PATH: '' }), null);
  await mkdir(join(directory, '.local', 'bin'), { recursive: true });
  await writeFile(join(directory, '.local', 'bin', 'herdr-app'), '');
  assert.equal(resolveHerdrAppBin({ ...env, PATH: '' }), join(directory, '.local', 'bin', 'herdr-app'));
});

test('createHerdr stays the Herdr pane adapter even inside a herdr-core terminal', async t => {
  const { env } = await fakes(t);
  assert.equal(createHerdr(env).launch, undefined);
  assert.equal(typeof createHc(env).launch, 'function');
});

test('launch splits right of the parent pane with the viewer argv, then labels the new terminal', async t => {
  const { env, calls, world } = await fakes(t);
  const address = await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
  assert.equal(address, 't1');
  const log = await calls();
  const split = log.findIndex(call => call[0] === 'app' && call[2] === 'pane.split');
  const label = log.findIndex(call => call[0] === 'hc' && call[1] === 'label');
  assert.ok(split >= 0 && label > split);
  assert.deepEqual(JSON.parse(log[split][3]), { direction: 'right', pane: 'p0', argv });
  assert.deepEqual(log[label], ['hc', 'label', '--json', 't1', 'omo.dag=viewer', `omo.dag.session=${session}`]);
  assert.ok(!log.some(call => call[1] === 'run'));
  const { terminals } = await world();
  assert.deepEqual(terminals.t1.argv, argv);
  assert.deepEqual(terminals.t1.labels, { 'omo.dag': 'viewer', 'omo.dag.session': session });
});

test('launch falls back to hc run in the parent space and tab when the parent has no pane', async t => {
  const { env, calls } = await fakes(t, { window: 'no-parent' });
  assert.equal(await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv }), 't1');
  const log = await calls();
  assert.ok(!log.some(call => call[0] === 'app' && call[1] === 'do'));
  // --json goes before the program; everything after -- is the viewer's own argv.
  assert.deepEqual(log.find(call => call[1] === 'run'), ['hc', 'run', '--json', '--bg', '--no-parent', '--outlive-parent', '--rm',
    '--cwd', '/tmp/project', '--label', 'herdr.space=sp1', '--label', 'herdr.tab=tb1',
    '--label', 'omo.dag=viewer', '--label', `omo.dag.session=${session}`, '--', ...argv]);
});

test('launch falls back to hc run when herdr-app is absent or has no window', async t => {
  for (const options of [{ app: false, parentLabels: { 'herdr.space': 'sp1' } }, { window: false, parentLabels: { 'herdr.space': 'sp1' } }]) {
    const { env, calls } = await fakes(t, options);
    assert.equal(await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv }), 't1');
    assert.deepEqual((await calls()).find(call => call[1] === 'run'), ['hc', 'run', '--json', '--bg', '--no-parent', '--outlive-parent', '--rm',
      '--cwd', '/tmp/project', '--label', 'herdr.space=sp1',
      '--label', 'omo.dag=viewer', '--label', `omo.dag.session=${session}`, '--', ...argv]);
  }
});

test('list returns only live omo.dag=viewer terminals with their full session ids', async t => {
  const other = '019a0000-aaaa-7000-8000-000000000002';
  const { env } = await fakes(t, { terminals: {
    t1: { address: 't1', state: 'live', labels: { 'omo.dag': 'viewer', 'omo.dag.session': session } },
    t2: { address: 't2', state: 'live', labels: { 'omo.dag': 'viewer', 'omo.dag.session': other } },
    t3: { address: 't3', state: 'finished', labels: { 'omo.dag': 'viewer', 'omo.dag.session': session } },
    t4: { address: 't4', state: 'live', labels: { 'omo.dag': 'other', 'omo.dag.session': session } },
  } });
  const { panes } = await createHc(env)('list');
  assert.deepEqual(panes, [
    { pane_id: 't1', session, label: `DAG · ${session.slice(0, 8)}` },
    { pane_id: 't2', session: other, label: `DAG · ${other.slice(0, 8)}` },
  ]);
  assert.ok(panes.every(isDagViewerPane));
});

test('close uses pane.close for a viewer with a pane and hc kill otherwise, then rm', async t => {
  const { env, calls, world } = await fakes(t, { terminals: {
    t9: { address: 't9', state: 'live', labels: { 'omo.dag': 'viewer', 'omo.dag.session': session } },
  } });
  const hc = createHc(env);
  assert.equal(await hc.launch({ parent: 't0', sessionId: session, cwd: '/tmp', argv }), 't1');
  assert.equal((await hc('get', 't1')).address, 't1');

  await hc('close', 't1');
  let log = await calls();
  const close = log.findIndex(call => call[0] === 'app' && call[2] === 'pane.close');
  assert.deepEqual(JSON.parse(log[close][3]), { pane: 'pt1' });
  assert.deepEqual(log.slice(close + 1).filter(call => call[0] === 'hc' && ['kill', 'rm'].includes(call[1])), [['hc', 'rm', '--json', 't1']]);

  await hc('close', 't9');
  log = await calls();
  const kill = log.findIndex(call => call[1] === 'kill');
  assert.deepEqual(log[kill], ['hc', 'kill', '--json', 't9']);
  assert.deepEqual(log[kill + 1], ['hc', 'rm', '--json', 't9']);
  assert.ok(!log.some(call => call[0] === 'app' && call[2] === 'pane.close' && call[3].includes('t9')));

  const { terminals } = await world();
  assert.equal(terminals.t1, undefined);
  assert.equal(terminals.t9, undefined);
});

test('unknown or finished terminals report pane_not_found', async t => {
  const { env } = await fakes(t, { terminals: { t5: { address: 't5', state: 'finished', labels: {} } } });
  const hc = createHc(env);
  await assert.rejects(hc('get', 't404'), /pane_not_found/);
  await assert.rejects(hc('close', 't404'), /pane_not_found/);
  await assert.rejects(hc('get', 't5'), /pane_not_found/);
  await assert.rejects(hc('close', 't5'), /pane_not_found/);
});
