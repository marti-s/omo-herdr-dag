import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDagViewerPane } from '../src/controller.mjs';
import { createHc, createHerdr, hcSession, laneName, locateTerminal, resolveHcBin, resolveHerdrAppBin, viewerName } from '../src/herdr.mjs';

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
  const name = flags('--name')[0];
  if (name && Object.values(db.terminals).some(x => x.state === 'live' && x.name === name)) {
    process.stderr.write(JSON.stringify({ error: { kind: 'name_taken', message: 'name taken: ' + name } }) + '\\n'); process.exit(3);
  }
  if (db.failRun) { process.stderr.write(JSON.stringify({ error: { kind: db.failRun, message: 'run failed' } }) + '\\n'); process.exit(3); }
  const address = 't' + (db.next++);
  const labels = pairs(flags('--label'));
  db.terminals[address] = { address, name: name ?? address, state: 'live', where: 'w', labels, rm: rest.includes('--rm'), argv: rest.slice(rest.indexOf('--') + 1) };
  // Like Herdr: a herdr.tab label shows the terminal in that tab, beside the ones already there.
  const tab = db.window?.spaces.flatMap(space => space.tabs).find(tab => tab.id === labels['herdr.tab']);
  if (tab && !db.hideRun) tab.terminals.push({ terminal: address, pane: 'p' + address, name: name ?? address });
  save(); out({ address, state: 'live' });
} else fail('unknown command ' + command);
`;

const APP = `
const args = process.argv.slice(2);
log(['app', ...args]);
if (!db.window) { out({ error: { message: 'no window' } }); process.exit(1); }
const tabs = db.window.spaces.flatMap(space => space.tabs);
if (args[0] === 'ls') { const { status, ...window } = db.window; out(window); }
else if (args[0] === 'status') out(db.window.status ?? {});
else if (args[0] === 'do' && args[1] === 'pane.focus') out({ ok: true });
else if (args[0] === 'do' && args[1] === 'pane.split') {
  const { direction, pane, argv } = JSON.parse(args[2]);
  const tab = tabs.find(tab => tab.terminals.some(entry => entry.pane === pane));
  if (!tab || direction !== 'right') { out({ error: { message: 'bad split' } }); process.exit(1); }
  const address = 't' + (db.next++);
  db.terminals[address] = { address, name: address, state: 'live', where: 'w', labels: {}, argv };
  tab.terminals.push({ terminal: address, pane: 'p' + address });
  save(); out({ pane: 'p' + address, terminal: address });
} else if (args[0] === 'do' && args[1] === 'tab.rename') {
  if (db.renameFails) { out({ error: { message: 'unknown command tab.rename' } }); process.exit(1); }
  const { id, name } = JSON.parse(args[2]);
  const tab = tabs.find(tab => tab.id === id);
  if (!tab) { out({ error: { message: 'no tab' } }); process.exit(1); }
  tab.name = name; save(); out({ ok: true });
} else if (args[0] === 'do' && args[1] === 'pane.close') {
  const { pane } = JSON.parse(args[2]);
  const tab = tabs.find(tab => tab.terminals.some(entry => entry.pane === pane));
  if (!tab) { out({ error: { message: 'no pane' } }); process.exit(1); }
  const entry = tab.terminals.find(entry => entry.pane === pane);
  tab.terminals = tab.terminals.filter(other => other !== entry);
  if (!db.closeLeavesLive) db.terminals[entry.terminal].state = 'finished';
  save(); out({ ok: true });
} else { out({ error: { message: 'unknown' } }); process.exit(1); }
`;

async function fakes(t, { window = true, app = true, parentLabels = { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' }, terminals = {}, tabName = 'm3', env: extra = {}, closeLeavesLive = false, renameFails = false, failRun = null, status = null, hideRun = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hc-fake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const state = join(directory, 'state.json');
  const log = join(directory, 'calls.jsonl');
  await writeFile(state, JSON.stringify({ next: 1, closeLeavesLive, renameFails, failRun, hideRun,
    terminals: { t0: { address: 't0', name: 'session', state: 'live', where: 'w', labels: parentLabels }, ...terminals },
    window: window ? { status, spaces: [{ id: 'sp1', name: 'S', tabs: [{ id: 'tb1', name: tabName,
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
  const env = { PATH: bin, HC_TERMINAL_ID: 't0', HC_TERMINAL_SOCKET: socket, HOME: directory, ...extra };
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

test('the lane is the tab name unless it is only a number, then DORI_LANE, then the folder', () => {
  assert.equal(laneName('M3', { env: {} }), 'M3');
  assert.equal(laneName('2', { env: { DORI_LANE: 'policy' } }), 'policy');
  assert.equal(laneName('17', { env: {}, cwd: '/Users/me/dev/forma-rs-omo/m2a' }), 'm2a');
  assert.equal(laneName(undefined, { env: {} }), '');
});

test('viewer names follow the lane, fit hc names and differ by session only when made unique', () => {
  const a = '01a1aded-1111-7000-8000-00000000aaaa', b = '01a1aded-2222-7000-8000-00000000bbbb';
  assert.equal(viewerName('M3', a), 'omo-dag-m3');
  assert.equal(viewerName('goa config / x', a), 'omo-dag-goa-config-x');
  // Sessions sharing the first 8 id characters still get distinct unique names.
  assert.notEqual(viewerName('m3', a, true), viewerName('m3', b, true));
  assert.equal(viewerName('m3', a, true), 'omo-dag-m3-00aaaa');
  assert.equal(viewerName('', a), 'omo-dag-00aaaa');
  for (const name of [viewerName('a'.repeat(60), a), viewerName('a'.repeat(60), a, true)]) assert.match(name, /^[a-z0-9_-]{1,32}$/);
});

test('locateTerminal finds the space, tab and pane that show a terminal', () => {
  const window = { spaces: [{ id: 'sp1', tabs: [{ id: 'tb1', name: 'lead', terminals: [{ terminal: 't2g', pane: 'pa' }] },
    { id: 'tb2', name: 'm3', terminals: [{ terminal: 't3h', pane: 'pb' }, { terminal: 't3j', pane: 'pc' }] }] }] };
  assert.deepEqual(locateTerminal(window, 't3h'), { space: 'sp1', tab: 'tb2', tabName: 'm3', pane: 'pb' });
  assert.equal(locateTerminal(window, 't99'), null);
  assert.equal(locateTerminal(undefined, 't3h'), null);
});

test('launch runs a lane-named viewer in the session\'s own tab, after the session\'s pane', async t => {
  const { env, calls, world } = await fakes(t);
  assert.equal(await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv }), 't1');
  // --json goes before the program; everything after -- is the viewer's own argv.
  assert.deepEqual((await calls()).find(call => call[1] === 'run'), ['hc', 'run', '--json', '--bg', '--no-parent', '--outlive-parent', '--rm',
    '--cwd', '/tmp/project', '--name', 'omo-dag-m3', '--label', 'herdr.space=sp1', '--label', 'herdr.tab=tb1',
    '--label', 'omo.dag=viewer', '--label', `omo.dag.session=${session}`, '--', ...argv]);
  const { window, terminals } = await world();
  assert.deepEqual(window.spaces[0].tabs[0].terminals.map(entry => entry.terminal), ['t0', 't1']);
  assert.deepEqual(terminals.t1.labels, { 'herdr.space': 'sp1', 'herdr.tab': 'tb1', 'omo.dag': 'viewer', 'omo.dag.session': session });
});

test('launch renames a tab named only by a number to the lane', async t => {
  const { env, calls, world } = await fakes(t, { tabName: '2', env: { DORI_LANE: 'hostf' } });
  await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
  const log = await calls();
  assert.deepEqual(JSON.parse(log.find(call => call[2] === 'tab.rename')[3]), { id: 'tb1', name: 'hostf' });
  assert.ok(log.find(call => call[1] === 'run').includes('omo-dag-hostf'));
  assert.equal((await world()).window.spaces[0].tabs[0].name, 'hostf');
});

test('a second session of the same lane gets a session-unique viewer name', async t => {
  const { env, world } = await fakes(t, { terminals: {
    t7: { address: 't7', name: 'omo-dag-m3', state: 'live', labels: { 'omo.dag': 'viewer', 'omo.dag.session': 'other' } } } });
  const address = await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
  assert.equal((await world()).terminals[address].name, viewerName('m3', session, true));
});

test('a viewer joining the tab the person is typing in hands focus back to the agent', async t => {
  const { env, calls } = await fakes(t, { status: { tab: 'tb1', focused_pane: 'p0' } });
  await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
  const log = await calls();
  const run = log.findIndex(call => call[1] === 'run'), focus = log.findIndex(call => call[2] === 'pane.focus');
  assert.ok(focus > run);
  assert.deepEqual(JSON.parse(log[focus][3]), { pane: 'p0' });
});

test('focus is left alone when the person looks at another tab or another pane', async t => {
  for (const status of [{ tab: 'tb9', focused_pane: 'p9' }, { tab: 'tb1', focused_pane: 'p-other' }]) {
    const { env, calls } = await fakes(t, { status });
    await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
    assert.ok(!(await calls()).some(call => call[2] === 'pane.focus'), JSON.stringify(status));
  }
});

test('handing focus back gives up after a bounded wait when the window never shows the viewer', async t => {
  const { env, calls } = await fakes(t, { status: { tab: 'tb1', focused_pane: 'p0' }, hideRun: true });
  let pauses = 0;
  await createHc(env, { pause: async () => { pauses++; } }).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
  assert.equal(pauses, 20);
  assert.ok(!(await calls()).some(call => call[2] === 'pane.focus'));
});

test('a failed tab rename still starts the viewer under the lane name', async t => {
  const { env, world } = await fakes(t, { tabName: '2', env: { DORI_LANE: 'hostf' }, renameFails: true });
  const address = await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv });
  assert.equal((await world()).terminals[address].name, 'omo-dag-hostf');
});

test('a run failure other than a taken name is not retried with a second viewer', async t => {
  const { env, calls } = await fakes(t, { failRun: 'timeout' });
  await assert.rejects(createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv }), /run failed/);
  assert.equal((await calls()).filter(call => call[1] === 'run').length, 1);
});

test('launch refuses to guess a tab while the window does not show the session yet', async t => {
  const { env, calls } = await fakes(t, { window: 'no-parent' });
  await assert.rejects(createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv }), /parent_not_shown/);
  assert.ok(!(await calls()).some(call => call[1] === 'run'));
});

test('launch falls back to hc run with the parent labels when herdr-app is absent or has no window', async t => {
  for (const options of [{ app: false, parentLabels: { 'herdr.space': 'sp1' } }, { window: false, parentLabels: { 'herdr.space': 'sp1' } }]) {
    const { env, calls } = await fakes(t, options);
    assert.equal(await createHc(env).launch({ parent: 't0', sessionId: session, cwd: '/tmp/project', argv }), 't1');
    assert.deepEqual((await calls()).find(call => call[1] === 'run'), ['hc', 'run', '--json', '--bg', '--no-parent', '--outlive-parent', '--rm',
      '--cwd', '/tmp/project', '--name', 'omo-dag-project', '--label', 'herdr.space=sp1',
      '--label', 'omo.dag=viewer', '--label', `omo.dag.session=${session}`, '--', ...argv]);
  }
});

test('legacy finds only unlabelled live omo-dag-* viewers of the given state file', async t => {
  const { env } = await fakes(t, { terminals: {
    t1: { address: 't1', name: 'omo-dag-01a1aded', state: 'live', labels: {}, argv: ['node', 'viewer.mjs', '--state', '/s/a.json'] },
    t2: { address: 't2', name: 'omo-dag-01a1aded', state: 'live', labels: {}, argv: ['node', 'viewer.mjs', '--state', '/s/b.json'] },
    t3: { address: 't3', name: 'omo-dag-m3', state: 'live', labels: { 'omo.dag': 'viewer' }, argv: ['--state', '/s/a.json'] },
    t4: { address: 't4', name: 'zsh', state: 'live', labels: {}, argv: ['--state', '/s/a.json'] },
  } });
  assert.deepEqual(await createHc(env).legacy('/s/a.json'), ['t1']);
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

test('close kills and removes a viewer still ending after its pane closed', async t => {
  const { env, calls, world } = await fakes(t, { closeLeavesLive: true });
  const hc = createHc(env);
  const address = await hc.launch({ parent: 't0', sessionId: session, cwd: '/tmp', argv });
  await hc('close', address);
  const log = (await calls()).filter(call => call[0] === 'hc' && ['kill', 'rm'].includes(call[1])).map(call => call[1]);
  assert.deepEqual(log, ['rm', 'kill', 'rm']);
  assert.equal((await world()).terminals[address], undefined);
});

test('unknown or finished terminals report pane_not_found', async t => {
  const { env } = await fakes(t, { terminals: { t5: { address: 't5', state: 'finished', labels: {} } } });
  const hc = createHc(env);
  await assert.rejects(hc('get', 't404'), /pane_not_found/);
  await assert.rejects(hc('close', 't404'), /pane_not_found/);
  await assert.rejects(hc('get', 't5'), /pane_not_found/);
  await assert.rejects(hc('close', 't5'), /pane_not_found/);
});
