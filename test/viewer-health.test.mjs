import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJson, writeJson } from '../src/storage.mjs';
import {
  probeViewerHealth, startViewerHealth, viewerHealthFile, viewerIntentFile, waitForViewerHealth,
} from '../src/viewer-health.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'viewer-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { stateFile: join(directory, 'state.json'), sessionId: 'test-session', paneId: 't-viewer', token: randomUUID() };
}

function manualTimers() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(ms) {
      const entry = [...pending].find(([, value]) => value.ms === ms);
      assert.ok(entry, `No pending ${ms} ms timer`);
      pending.delete(entry[0]); entry[1].fn();
    },
  };
}

test('live viewer receipt binds the endpoint to its launch, session, pane and state file', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  const health = await startViewerHealth(owner);
  t.after(() => health.close());
  assert.equal((await probeViewerHealth(owner)).status, 'running');
  for (const change of [{ token: randomUUID() }, { sessionId: 'other-session' }, { paneId: 'agent-terminal' }]) {
    assert.equal((await probeViewerHealth({ ...owner, ...change })).status, 'unhealthy');
  }
  const other = { ...owner, stateFile: join(join(owner.stateFile, '..'), 'other.json') };
  await writeJson(viewerHealthFile(other.stateFile), await readJson(viewerHealthFile(owner.stateFile)));
  assert.equal((await probeViewerHealth(other)).status, 'unhealthy');
});

test('generic shutdown leaves no manual intent and a living PID does not rescue its dead endpoint', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  const health = await startViewerHealth(owner);
  await health.close();
  assert.equal(await readJson(viewerIntentFile(owner)), null);
  assert.equal((await readJson(viewerHealthFile(owner.stateFile))).pid, process.pid);
  assert.equal((await probeViewerHealth(owner)).status, 'unhealthy');
});

test('manual close persists intent while the viewer endpoint stays available through pane closure', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  const health = await startViewerHealth(owner);
  t.after(() => health.close());
  assert.equal(await health.markClosing(), true);
  assert.equal((await probeViewerHealth(owner)).status, 'closing');
  // Bypass the marker to prove the actual endpoint remains alive during backend closure.
  const readWithoutIntent = path => path === viewerIntentFile(owner) ? null : readJson(path);
  assert.equal((await probeViewerHealth(owner, { read: readWithoutIntent })).status, 'closing');
  await health.close();
  assert.equal((await probeViewerHealth(owner)).status, 'closed');
  assert.equal((await probeViewerHealth(owner, { read: readWithoutIntent })).status, 'unhealthy');
  assert.equal((await readJson(viewerHealthFile(owner.stateFile))).status, 'running');
});

test('an old generation closing across replacement never overwrites the new startup receipt', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  const seen = Promise.withResolvers(), release = Promise.withResolvers();
  let intercept = false;
  const old = await startViewerHealth(owner, { read: async path => {
    const value = await readJson(path);
    if (intercept && path === viewerHealthFile(owner.stateFile)) {
      intercept = false; seen.resolve(); await release.promise;
    }
    return value;
  } });
  t.after(() => old.close());
  intercept = true;
  const marking = old.markClosing();
  await seen.promise;
  const replacement = { ...owner, token: randomUUID() };
  const fresh = await startViewerHealth(replacement);
  t.after(() => fresh.close());
  release.resolve();
  await marking;
  await old.close();
  assert.equal((await readJson(viewerHealthFile(owner.stateFile))).token, replacement.token);
  assert.equal((await probeViewerHealth(replacement)).status, 'running');
  assert.equal((await probeViewerHealth(owner)).status, 'unhealthy');
});

test('wrong endpoint identity and a silent reused port cannot prove a viewer is healthy', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  const sockets = new Set();
  let answer;
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    if (answer) socket.end(JSON.stringify(answer));
  });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const receipt = { version: 1, ...owner, port: server.address().port, pid: process.pid, status: 'running' };
  await writeJson(viewerHealthFile(owner.stateFile), receipt);
  answer = { ...receipt, token: randomUUID() };
  assert.equal((await probeViewerHealth(owner)).reason, 'endpoint-mismatch');
  answer = null;
  const timers = manualTimers(), accepted = once(server, 'connection');
  const probing = probeViewerHealth(owner, { timeoutMs: 300, timers });
  await accepted;
  timers.fire(300);
  assert.equal((await probing).reason, 'endpoint-timeout');
  assert.equal(timers.pending.size, 0);
});

test('startup receipt failures and close-marker failures always release the endpoint', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  let failedReceipt;
  await assert.rejects(startViewerHealth(owner, { write: async (_path, value) => {
    failedReceipt = value; throw new Error('Cannot publish receipt');
  } }), /Cannot publish receipt/);
  await writeJson(viewerHealthFile(owner.stateFile), failedReceipt);
  assert.equal((await probeViewerHealth(owner)).status, 'unhealthy');

  const fresh = { ...owner, token: randomUUID() };
  const health = await startViewerHealth(fresh, { write: async (path, value) => {
    if (value.status === 'closed') throw new Error('Cannot finish close marker');
    await writeJson(path, value);
  } });
  await health.markClosing();
  await assert.rejects(health.close(), /Cannot finish close marker/);
  assert.equal((await probeViewerHealth(fresh, {
    read: path => path === viewerIntentFile(fresh) ? null : readJson(path),
  })).status, 'unhealthy');
});

test('startup wait observes a receipt published after watcher registration and one already present', { timeout: 5000 }, async t => {
  const owner = await fixture(t);
  const waiting = waitForViewerHealth(owner);
  const health = await startViewerHealth(owner);
  t.after(() => health.close());
  assert.equal((await waiting).status, 'running');
  assert.equal((await waitForViewerHealth(owner)).status, 'running');
});

test('startup timeout closes its watcher, clears its timer, and aborts an outstanding probe', async t => {
  const owner = await fixture(t);
  const timers = manualTimers(), pending = Promise.withResolvers();
  const watcher = new EventEmitter(); let closes = 0, signal;
  watcher.close = () => { closes++; };
  const waiting = waitForViewerHealth(owner, { timers, timeoutMs: 10000,
    watch: () => watcher,
    probe: (_owner, options) => { signal = options.signal; return pending.promise; },
  });
  const rejected = assert.rejects(waiting, { code: 'VIEWER_START_TIMEOUT' });
  timers.fire(10000);
  await rejected;
  assert.equal(closes, 1);
  assert.equal(timers.pending.size, 0);
  assert.equal(signal.aborted, true);
  pending.resolve({ status: 'running' });
  await pending.promise;
  assert.equal(closes, 1);
});

test('startup fallback discovers readiness without a file event and coalesces outstanding probes', async t => {
  const owner = await fixture(t);
  const timers = manualTimers(), watcher = new EventEmitter(), probes = [];
  let closes = 0; watcher.close = () => { closes++; };
  const waiting = waitForViewerHealth(owner, { timers, watch: () => watcher,
    probe: () => { const result = Promise.withResolvers(); probes.push(result); return result.promise; },
  });
  assert.equal(probes.length, 1);
  // No watcher callback fires. Even multiple fallback ticks cannot overlap probes.
  for (let tick = 0; tick < 3; tick++) timers.fire(250);
  assert.equal(probes.length, 1);
  probes[0].resolve({ status: 'unhealthy' });
  await probes[0].promise;
  assert.equal(probes.length, 2, 'pending fallback work runs once after the first probe settles');
  probes[1].resolve({ status: 'running' });
  assert.equal((await waiting).status, 'running');
  assert.equal(closes, 1);
  assert.equal(timers.pending.size, 0);
});

test('startup fallback survives watcher registration failure and a watcher error', async t => {
  const owner = await fixture(t);
  for (const cause of ['registration', 'error']) {
    const timers = manualTimers(), watcher = new EventEmitter();
    let closes = 0, ready = false;
    watcher.close = () => { closes++; };
    const waiting = waitForViewerHealth(owner, { timers,
      watch: () => { if (cause === 'registration') throw new Error('Watch unavailable'); return watcher; },
      probe: async () => ({ status: ready ? 'running' : 'unhealthy' }),
    });
    await Promise.resolve();
    if (cause === 'error') watcher.emit('error', new Error('Watch lost'));
    await Promise.resolve();
    ready = true;
    timers.fire(250);
    assert.equal((await waiting).status, 'running');
    assert.equal(closes, cause === 'error' ? 1 : 0);
    assert.equal(timers.pending.size, 0);
  }
});

test('failed startup watcher still respects the deadline and cleans its fallback', async t => {
  const owner = await fixture(t);
  const timers = manualTimers(), watcher = new EventEmitter();
  let closes = 0; watcher.close = () => { closes++; };
  const waiting = waitForViewerHealth(owner, { timers, watch: () => watcher,
    probe: async () => ({ status: 'unhealthy' }),
  });
  const rejected = assert.rejects(waiting, { code: 'VIEWER_START_TIMEOUT' });
  watcher.emit('error', new Error('Watch lost'));
  timers.fire(10000);
  await rejected;
  assert.equal(closes, 1);
  assert.equal(timers.pending.size, 0);
});

test('startup cancellation clears the watcher and fallback with no readiness confirmation', async t => {
  const owner = await fixture(t);
  for (const watchFails of [false, true]) {
    const timers = manualTimers(), watcher = new EventEmitter(), controller = new AbortController();
    let closes = 0; watcher.close = () => { closes++; };
    const waiting = waitForViewerHealth(owner, { timers, watch: () => watcher,
      signal: controller.signal, probe: async () => ({ status: 'unhealthy' }),
    });
    const rejected = assert.rejects(waiting, { code: 'ABORT_ERR' });
    if (watchFails) watcher.emit('error', new Error('Watch lost'));
    controller.abort();
    await rejected;
    assert.equal(closes, 1);
    assert.equal(timers.pending.size, 0);
  }
});
