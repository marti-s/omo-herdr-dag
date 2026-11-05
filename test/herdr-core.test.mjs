import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DagPane } from '../src/controller.mjs';
import { createHc, createHerdr, hcSession, resolveHcBin } from '../src/herdr.mjs';
import { payload, sessionId } from './fixtures.mjs';

// A fake herdr-core CLI: records argv, keeps terminals in a JSON file, and
// answers like `hc --json` (errors as {"error":{kind}} on stderr, exit 3).
async function fakeHc(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hc-fake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'herdr-core');
  const state = join(directory, 'state.json');
  const log = join(directory, 'calls.jsonl');
  await writeFile(state, JSON.stringify({ next: 1, terminals: {
    t0: { address: 't0', name: 'session', state: 'live', where: 'space / tab', labels: { where: 'space / tab', 'herdr.space': 'sp1', other: 'x' } },
  } }));
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const [command, json, ...rest] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, json, ...rest]) + '\\n');
const db = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const fail = message => { process.stderr.write(JSON.stringify({ error: { kind: 'not_found', message } }) + '\\n'); process.exit(3); };
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(db));
if (command === 'ls') console.log(JSON.stringify({ terminals: Object.values(db.terminals).filter(x => x.state === 'live') }));
else if (command === 'get') { const x = db.terminals[rest[0]]; if (!x) fail('no terminal'); console.log(JSON.stringify(x)); }
else if (command === 'kill') { const x = db.terminals[rest[0]]; if (!x) fail('no terminal'); delete db.terminals[rest[0]]; save(); console.log('{}'); }
else if (command === 'run') {
  const address = 't' + (db.next++);
  const name = rest[rest.indexOf('--name') + 1];
  db.terminals[address] = { address, name, state: 'live', where: 'space / tab' };
  save(); console.log(JSON.stringify({ address, name, state: 'live' }));
} else fail('unknown command ' + command);
`);
  chmodSync(bin, 0o755);
  const socket = join(directory, 'hc.sock');
  await writeFile(socket, '');
  const env = { PATH: directory, HC_TERMINAL_ID: 't0', HC_TERMINAL_SOCKET: socket, HOME: directory };
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { bin, env, calls, directory };
}

test('hcSession requires a terminal id, a live socket and a herdr-core binary', async t => {
  const { bin, env } = await fakeHc(t);
  assert.equal(hcSession(env), true);
  assert.equal(resolveHcBin(env), bin);
  assert.equal(hcSession({ ...env, HC_TERMINAL_ID: '' }), false);
  assert.equal(hcSession({ ...env, HC_TERMINAL_SOCKET: join(env.HOME, 'missing.sock') }), false);
  assert.equal(hcSession({ ...env, PATH: '', HOME: join(env.HOME, 'nowhere') }), false);
  assert.equal(hcSession({ ...env, HC_BIN_PATH: join(env.HOME, 'missing') }), false);
});

test('createHerdr stays the Herdr pane adapter even inside a herdr-core terminal', async t => {
  const { env } = await fakeHc(t);
  assert.equal(createHerdr(env).launch, undefined);
  assert.equal(typeof createHc(env).launch, 'function');
});

test('herdr-core adapter launches the viewer beside its session and maps list, get and close', async t => {
  const { env, calls } = await fakeHc(t);
  const hc = createHc(env);
  const address = await hc.launch({ parent: 't0', title: 'DAG · Abc-1234', cwd: '/tmp/project', argv: ['/usr/bin/node', '/tmp/viewer.mjs', '--state', '/tmp/s.json'] });
  assert.equal(address, 't1');
  const run = (await calls()).find(call => call[0] === 'run');
  // --json goes before the program; everything after -- is the viewer's own argv.
  assert.deepEqual(run, ['run', '--json', '--bg', '--name', 'omo-dag-abc-1234', '--no-parent', '--outlive-parent', '--rm',
    '--cwd', '/tmp/project', '--label', 'where=space / tab', '--label', 'herdr.space=sp1',
    '--', '/usr/bin/node', '/tmp/viewer.mjs', '--state', '/tmp/s.json']);
  const { panes } = await hc('list');
  assert.deepEqual(panes.find(pane => pane.pane_id === 't1'), { pane_id: 't1', tab_id: 'space / tab', label: 'DAG · abc-1234' });
  assert.equal(panes.find(pane => pane.pane_id === 't0').label, 'session');
  assert.equal((await hc('get', 't1')).address, 't1');
  await hc('close', 't1');
  await assert.rejects(hc('get', 't1'), /pane_not_found/);
  await assert.rejects(hc('close', 't1'), /pane_not_found/);
});

test('DagPane opens one herdr-core viewer for a DAG and closes it with the session', async t => {
  const { env, calls, directory } = await fakeHc(t);
  const controller = new DagPane({ sessionId, parentPane: 't0', socket: env.HC_TERMINAL_SOCKET,
    stateDir: join(directory, 'state'), cwd: join(directory, 'project'), node: '/usr/bin/node',
    viewer: '/tmp/viewer.mjs', herdr: createHc(env) });
  await controller.start();
  await controller.receive(payload());
  await controller.receive(payload());
  const runs = (await calls()).filter(call => call[0] === 'run');
  assert.equal(runs.length, 1);
  assert.ok(runs[0].includes(controller.stateFile));
  assert.ok((await hc('list', env)).some(pane => pane.pane_id === 't1'));
  await controller.stop();
  assert.ok(!(await hc('list', env)).some(pane => pane.pane_id === 't1'));
});

async function hc(command, env) {
  return (await createHc(env)(command)).panes;
}
