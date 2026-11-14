import { once } from 'node:events';
import { watch as watchDirectory } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { readJson, writeJson } from './storage.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultTimers = { setTimeout, clearTimeout };
const identities = ['stateFile', 'sessionId', 'paneId', 'token'];

function identity(value) {
  if (!value || identities.some(key => typeof value[key] !== 'string' || !value[key]) || !UUID.test(value.token)) {
    throw new TypeError('Viewer health requires stateFile, sessionId, paneId and a UUID launch token');
  }
  return { stateFile: resolve(value.stateFile), sessionId: value.sessionId, paneId: value.paneId, token: value.token };
}

function matches(receipt, expected) {
  return receipt?.version === 1 && identities.every(key => receipt[key] === expected[key]);
}

export const viewerHealthFile = stateFile => `${resolve(stateFile)}.viewer.json`;
export function viewerIntentFile(expected) {
  const owner = identity(expected);
  return `${owner.stateFile}.viewer-${owner.token}.json`;
}

async function optionalReceipt(file, read = readJson) {
  try { return await read(file); }
  catch (error) {
    // An invalid receipt cannot prove ownership; filesystem permission errors still surface.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Start the viewer's identity endpoint before publishing its atomic startup receipt.
 * Lifecycle writes use a token-specific intent file, never the shared receipt: an
 * old viewer closing concurrently with a replacement cannot overwrite its identity.
 * PID is diagnostic only. The caller must supply the controller's fresh launch token.
 */
export async function startViewerHealth(expected, {
  pid = process.pid, read = readJson, write = writeJson, serverFactory = createServer,
} = {}) {
  const owner = identity(expected);
  const receiptFile = viewerHealthFile(owner.stateFile);
  const intentFile = viewerIntentFile(owner);
  const sockets = new Set();
  let receipt, stopped = false, closePromise, lifecycle = Promise.resolve();
  const server = serverFactory(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.end(JSON.stringify(receipt));
  });
  const stopServer = async () => {
    if (stopped) return;
    stopped = true;
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    });
  };
  try {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    receipt = { version: 1, ...owner, pid, port: server.address().port, status: 'running' };
    await write(receiptFile, receipt);
  } catch (error) {
    await stopServer().catch(cleanupError => { error.cause ??= cleanupError; });
    throw error;
  }

  const enqueue = action => {
    const result = lifecycle.then(action);
    lifecycle = result.catch(() => {});
    return result;
  };
  const mark = async status => {
    // This check avoids unnecessary old-generation files. Even if replacement
    // races it, the write is confined to this token and cannot touch the new receipt.
    if (!matches(await optionalReceipt(receiptFile, read), owner)) return false;
    const next = { ...receipt, status };
    await write(intentFile, next);
    receipt = next;
    return true;
  };
  return {
    markClosing() {
      if (closePromise) return Promise.resolve(false);
      return enqueue(async () => {
        if (stopped) return false;
        return receipt.status === 'closing' || await mark('closing');
      });
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = enqueue(async () => {
        try {
          // Generic shutdown never invents a manual close. A killed hc terminal
          // may leave only 'closing'; that still records the explicit user intent.
          if (receipt.status === 'closing') await mark('closed');
        } finally { await stopServer(); }
      });
      return closePromise;
    },
  };
}

function probeEndpoint(receipt, expected, { timeoutMs, connect, timers, signal }) {
  return new Promise((resolveProbe, reject) => {
    let socket, timer, received = '', settled = false;
    const finish = (status, reason, error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      socket?.destroy();
      if (error) reject(error);
      else resolveProbe({ status, receipt, ...(reason ? { reason } : {}) });
    };
    const aborted = () => finish('unhealthy', 'aborted');
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
    try { socket = connect({ host: '127.0.0.1', port: receipt.port }); }
    catch (error) { finish('unhealthy', 'endpoint-error', error); return; }
    timer = timers.setTimeout(() => finish('unhealthy', 'endpoint-timeout'), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      received += chunk;
      if (received.length > 16384) finish('unhealthy', 'oversized-response');
    });
    socket.once('end', () => {
      let answer;
      try { answer = JSON.parse(received); }
      catch { finish('unhealthy', 'invalid-response'); return; }
      if (!matches(answer, expected) || answer.port !== receipt.port || answer.pid !== receipt.pid ||
          !['running', 'closing', 'closed'].includes(answer.status)) {
        finish('unhealthy', 'endpoint-mismatch');
      } else finish(answer.status);
    });
    socket.once('error', error => {
      if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error.code)) {
        finish('unhealthy', 'endpoint-unreachable');
      } else finish('unhealthy', 'endpoint-error', error);
    });
    socket.once('close', () => {
      if (!settled) finish('unhealthy', 'endpoint-closed');
    });
  });
}

/** A matched explicit closing/closed intent survives endpoint death; ordinary readiness does not. */
export async function probeViewerHealth(expected, {
  timeoutMs = 300, read = readJson, connect = createConnection, timers = defaultTimers, signal,
} = {}) {
  const owner = identity(expected);
  const receipt = await optionalReceipt(viewerHealthFile(owner.stateFile), read);
  if (!receipt) return { status: 'unhealthy', reason: 'missing-receipt' };
  if (!matches(receipt, owner)) return { status: 'unhealthy', reason: 'identity-mismatch' };
  const intent = await optionalReceipt(viewerIntentFile(owner), read);
  if (matches(intent, owner) && ['closing', 'closed'].includes(intent.status)) return { status: intent.status, receipt: intent };
  if (!Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535 ||
      !Number.isInteger(receipt.pid) || receipt.pid <= 0) {
    return { status: 'unhealthy', receipt, reason: 'invalid-endpoint' };
  }
  return probeEndpoint(receipt, owner, { timeoutMs, connect, timers, signal });
}

/** Watch first, then probe; bounded fallback probes also cover lost events or an unavailable watcher. */
export function waitForViewerHealth(expected, {
  timeoutMs = 10000, probeTimeoutMs = 300, probeIntervalMs = 250, probe = probeViewerHealth,
  watch = watchDirectory, timers = defaultTimers, signal,
} = {}) {
  const owner = identity(expected);
  if (!Number.isFinite(probeIntervalMs) || probeIntervalMs <= 0) throw new TypeError('Viewer startup probe interval must be positive');
  const names = new Set([basename(viewerHealthFile(owner.stateFile)), basename(viewerIntentFile(owner))]);
  return new Promise((resolveWait, reject) => {
    let watcher, timeout, fallback, settled = false, checking = false, again = false;
    const abortProbe = new AbortController();
    const closeWatcher = () => {
      const previous = watcher;
      watcher = undefined;
      previous?.close();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      timers.clearTimeout(fallback);
      closeWatcher();
      signal?.removeEventListener('abort', abort);
      abortProbe.abort();
      if (error) reject(error); else resolveWait(result);
    };
    const abort = () => finish(Object.assign(new Error('Viewer startup was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    const check = async () => {
      if (settled) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        const result = await probe(owner, { timeoutMs: probeTimeoutMs, timers, signal: abortProbe.signal });
        if (result.status === 'running') finish(null, result);
        else if (['closing', 'closed'].includes(result.status)) {
          finish(Object.assign(new Error('Viewer was intentionally closed during startup'), { code: 'VIEWER_CLOSED_DURING_STARTUP' }));
        }
      } catch (error) { finish(error); }
      finally {
        checking = false;
        if (again && !settled) { again = false; void check(); }
      }
    };
    const scheduleFallback = () => {
      if (settled) return;
      fallback = timers.setTimeout(() => {
        fallback = undefined;
        void check();
        scheduleFallback();
      }, probeIntervalMs);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const current = watch(dirname(owner.stateFile), (_event, name) => {
        if (!name || names.has(String(name))) void check();
      });
      watcher = current;
      current.on('error', () => {
        if (watcher !== current) return;
        closeWatcher();
        void check();
      });
      current.on('close', () => { if (watcher === current) watcher = undefined; });
    } catch {
      // fs.watch may be unavailable even though receipts and the endpoint remain readable.
      closeWatcher();
    }
    timeout = timers.setTimeout(() => finish(Object.assign(
      new Error(`Viewer did not confirm startup within ${timeoutMs} ms`), { code: 'VIEWER_START_TIMEOUT' })), timeoutMs);
    scheduleFallback();
    void check();
  });
}
