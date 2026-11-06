import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileStaleState } from '../src/reconcile.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

const now = Date.parse('2026-11-06T12:00:00Z');
const hoursAgo = hours => new Date(now - hours * 3600e3).toISOString();
const runs = () => [{ id: 'run', status: 'running', nodes: [{ id: 'a', state: 'completed' }, { id: 'b', state: 'running' }] },
  { id: 'done', status: 'completed', nodes: [{ id: 'c', state: 'completed' }] }];

test('reconcile interrupts dead-owner and old ownerless snapshots and leaves live ones', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omo-dag-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    dead: { connected: true, owner: { pid: 2222 }, updatedAt: hoursAgo(0), runs: runs() },
    old: { connected: true, updatedAt: hoursAgo(7), runs: runs() },
    fresh: { connected: true, updatedAt: hoursAgo(1), runs: runs() },
    live: { connected: true, owner: { pid: 1111 }, updatedAt: hoursAgo(48), runs: runs() },
    disconnected: { connected: false, owner: { pid: 2222 }, updatedAt: hoursAgo(48), runs: runs() },
    'key.pane': { connected: true, updatedAt: hoursAgo(48), runs: runs() },
    'key.json.view': { connected: true, updatedAt: hoursAgo(48), runs: runs() },
  };
  for (const [name, state] of Object.entries(files)) await writeJson(join(dir, `${name}.json`), state);
  const result = await reconcileStaleState(dir, { alive: pid => pid === 1111, now });
  assert.deepEqual(result.reconciled.sort(), ['dead.json', 'old.json']);
  assert.deepEqual(result.errors, []);
  for (const name of ['dead', 'old']) {
    const state = await readJson(join(dir, `${name}.json`));
    assert.equal(state.connected, false);
    assert.deepEqual(state.runs.map(run => run.status), ['cancelled', 'completed']);
    assert.deepEqual(state.runs[0].nodes.map(node => node.state), ['completed', 'cancelled']);
    assert.equal(state.updatedAt, files[name].updatedAt);
  }
  for (const name of ['fresh', 'live', 'disconnected', 'key.pane', 'key.json.view'])
    assert.deepEqual(await readJson(join(dir, `${name}.json`)), files[name]);
});

test('reconcile tolerates a missing state directory', async () => {
  assert.deepEqual(await reconcileStaleState(join(tmpdir(), 'omo-dag-missing-dir-xyz')), { reconciled: [], errors: [] });
});

test('reconcile keeps a snapshot whose owner is alive but not ours to signal (EPERM)', { skip: process.getuid?.() === 0 && 'root may signal pid 1' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omo-dag-reconcile-eperm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // pid 1 always exists and belongs to root, so signalling it from a normal user fails with EPERM.
  const state = { connected: true, owner: { pid: 1 }, updatedAt: hoursAgo(48), runs: runs() };
  await writeJson(join(dir, 'root-owned.json'), state);
  assert.deepEqual((await reconcileStaleState(dir)).reconciled, []);
  assert.deepEqual(await readJson(join(dir, 'root-owned.json')), state);
});
