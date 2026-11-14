import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';
import { pruneExpiredSnapshots, retentionDaysFromEnv } from './retention.mjs';
import { reconcileStaleState } from './reconcile.mjs';
import { shellCommand } from './herdr.mjs';
import { normalizeRun, sessionRuns, terminal } from './model.mjs';
import { t, languageOf } from './i18n.mjs';
import { TaskData } from './task-data.mjs';
import { probeViewerHealth, waitForViewerHealth } from './viewer-health.mjs';

export function viewKey(socket, pane, session) {
  return createHash('sha256').update(JSON.stringify([socket, pane, session])).digest('hex').slice(0, 24);
}

export function dagTitle(sessionId) {
  return `DAG · ${sessionId.slice(0, 8)}`;
}

export function isDagViewerPane(pane) {
  return [pane?.label, pane?.terminal_title, pane?.terminal_title_stripped]
    .some(name => typeof name === 'string' && (name.startsWith('DAG · ') || name === 'OmO DAG'));
}

function missingPane(error) {
  return /pane_not_found|unknown pane|pane .*not found/i.test(`${error.message} ${error.stderr ?? ''}`);
}

const nodeTerminal = new Set([...terminal, 'skipped']);

// A delayed RPC or checkpoint must not roll back newer state. Timestamps may
// tie: preserve terminal outcomes unless a newer attempt explicitly resumes,
// and allow durable terminal progress even when the producer omitted its time.
function replaceRun(previous, next, preferNext = false, bootstrap = false) {
  if (!previous) return true;
  const before = Date.parse(previous.updatedAt), after = Date.parse(next.updatedAt);
  if (Number.isFinite(before) && Number.isFinite(after) && before !== after) return after > before;
  if (Number.isFinite(before) && !Number.isFinite(after)) return false;
  if (!Number.isFinite(before) && Number.isFinite(after)) return true;
  const nodes = new Map(previous.nodes.map(node => [node.id, node]));
  const newAttempt = next.nodes.some(node => nodes.has(node.id) && node.attempt > nodes.get(node.id).attempt);
  if (!bootstrap) {
    if (next.nodes.some(node => nodes.has(node.id) && node.attempt < nodes.get(node.id).attempt)) return false;
    if (terminal.has(previous.status) && !terminal.has(next.status) && !newAttempt) return false;
    if (next.nodes.some(node => nodeTerminal.has(nodes.get(node.id)?.state) && !nodeTerminal.has(node.state) &&
        !(node.attempt > nodes.get(node.id).attempt))) return false;
  }
  return preferNext || newAttempt || terminal.has(next.status) && !terminal.has(previous.status) ||
    next.nodes.some(node => nodeTerminal.has(node.state) && !nodeTerminal.has(nodes.get(node.id)?.state));
}

export class DagPane {
  constructor({ sessionId, parentPane, socket, stateDir, cwd, node, viewer, herdr, notify = () => {}, language = 'en', taskStateDir, retentionDays, streamDelay = 250, now = Date.now,
    refreshInterval = 2000, healthInterval = 5000, startupTimeout = 10000,
    health = { probe: probeViewerHealth, wait: waitForViewerHealth } }) {
    Object.assign(this, { sessionId, parentPane, stateDir, cwd, node, viewer, herdr, notify });
    this.language = languageOf(language);
    this.key = viewKey(socket, parentPane, sessionId);
    this.stateFile = join(stateDir, `${this.key}.json`);
    this.recordFile = join(stateDir, `${this.key}.pane.json`);
    this.checkpointDir = join(taskStateDir ?? join(cwd, '.omo', 'senpi-task'), 'dag', 'runs');
    // Explicit option wins so tests need not mutate the shared process environment.
    this.retentionDays = retentionDays ?? retentionDaysFromEnv();
    this.streamDelay = streamDelay;
    this.now = now;
    Object.assign(this, { refreshInterval, healthInterval, startupTimeout, health });
    this.notShownUntil = 0;
    this.queue = Promise.resolve();
    this.runs = [];
    this.stopped = false;
    this.tasks = [];
    this.streams = new Map();
    this.checkpointErrors = new Map();
    this.taskData = new TaskData({ cwd, sessionId, stateDir: taskStateDir, notify,
      onChange: () => { void this.refresh().catch(() => {}); } });
  }

  enqueue(job) {
    const result = this.queue.then(job);
    this.queue = result.catch(error => this.notify(`DAG pane: ${error.message}`));
    return result;
  }

  receive(payload) {
    const runs = sessionRuns(payload, this.sessionId, this.language);
    if (runs === null || this.stopped) return Promise.resolve();
    return this.enqueue(async () => {
      // RPC replaces transient runs; durable runs omitted by a snapshot remain recoverable.
      await this.restoreRuns(runs, true);
      await this.save(true);
    });
  }

  start() {
    return this.enqueue(async () => {
      const record = await readJson(this.recordFile);
      // Housekeeping precedes restore so a fresh pane never lists pruned snapshots.
      await pruneExpiredSnapshots(this.stateDir, {
        keepFiles: [basename(this.stateFile), basename(this.recordFile), `${basename(this.stateFile)}.view.json`,
          `${basename(this.stateFile)}.viewer.json`, `${basename(this.stateFile)}.viewer-${record?.token}.json`],
        days: this.retentionDays, notify: message => this.notify(t(this.language, 'pruneFailed', { error: message })) });
      // Snapshots left connected by a dead session must not look live to their viewers.
      try {
        const { errors } = await reconcileStaleState(this.stateDir);
        for (const { file, error } of errors) this.notify(`DAG pane: Cannot reconcile ${file}: ${error.message}`);
      } catch (error) { this.notify(`DAG pane: Cannot reconcile stale state: ${error.message}`); }
      // Viewers of an older install carry no omo.dag labels; replace the ones showing this session.
      if (this.herdr.legacy) {
        try { for (const id of await this.herdr.legacy(this.stateFile)) await this.closePane(id); }
        catch (error) { this.notify(`DAG pane: ${error.message}`); }
      }
      const state = await readJson(this.stateFile);
      if (state?.sessionId === this.sessionId) {
        this.runs = state.runs ?? [];
        this.taskData.restore(state.tasks);
      }
      this.taskData.start();
      await this.restoreRuns(this.runs, false, true);
      if (!this.stopped && this.refreshInterval > 0) {
        clearInterval(this.refreshTimer);
        // Filesystem notifications are the fast path. Reconcile periodically as
        // well so a missed task/DAG event does not freeze the projected graph.
        this.refreshTimer = setInterval(() => { void this.refresh().catch(() => {}); }, this.refreshInterval);
        this.refreshTimer.unref?.();
      }
      await this.save(true);
    });
  }

  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.refreshQueued) { this.refreshAgain = true; return this.refreshQueued; }
    const queued = this.enqueue(async () => {
      do {
        this.refreshAgain = false;
        if (this.stopped) return;
        const before = JSON.stringify([this.runs, this.tasks]);
        await this.restoreRuns();
        this.tasks = await this.taskData.refresh(this.runs);
        if (JSON.stringify([this.runs, this.tasks]) !== before) await this.save(true, false);
        else if (this.runs.length || this.tasks.length) await this.ensure(false);
      } while (this.refreshAgain && !this.stopped);
    });
    this.refreshQueued = queued.finally(() => { this.refreshQueued = undefined; });
    return this.refreshQueued;
  }

  receiveTasks(payload) {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(async () => {
      await this.restoreRuns();
      await this.taskData.refresh(this.runs);
      if (this.taskData.receive(payload)) await this.save(true);
    });
  }

  // Streamed tokens arrive far more often than task records change; coalesce
  // them and rewrite the snapshot without rescanning the task store. The
  // returned promise settles after the coalesced save, so tests need no sleeps.
  // `since` marks when the current phase began and `lastAt` the latest event,
  // so the viewer clock can show elapsed waits and gaps between tokens.
  receiveStream(update) {
    if (this.stopped) return Promise.resolve();
    if (update.active) {
      const previous = this.streams.get(update.taskId);
      const samePhase = previous?.phase === update.phase && previous.tool === update.tool;
      this.streams.set(update.taskId, { phase: update.phase,
        ...(update.tool ? { tool: update.tool } : {}), ...(update.text ? { text: update.text } : {}),
        ...(update.attempt ? { attempt: update.attempt } : {}), ...(update.maxAttempts ? { maxAttempts: update.maxAttempts } : {}),
        since: samePhase ? previous.since : update.now, lastAt: update.now });
    } else if (!this.streams.delete(update.taskId)) return Promise.resolve();
    if (this.streamTimer) return this.streamFlush;
    this.streamFlush = new Promise(resolve => {
      this.streamTimer = setTimeout(() => {
        this.streamTimer = undefined;
        this.enqueue(() => this.save(true, false)).then(resolve, resolve);
      }, this.streamDelay);
      this.streamTimer.unref?.();
    });
    return this.streamFlush;
  }

  withStreams(tasks, connected) {
    if (!connected || !this.streams.size) return tasks;
    return tasks.map(task => {
      // A finished task never regains a stale activity from a late event.
      if (task.status !== 'running') { this.streams.delete(task.id); return task; }
      const activity = this.streams.get(task.id);
      return activity ? { ...task, activity } : task;
    });
  }

  async restoreRuns(runs = this.runs, preferLive = false, bootstrap = false) {
    let files;
    try { files = await readdir(this.checkpointDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    const current = new Map(this.runs.map(run => [run.id, run]));
    const restored = new Map(runs.map(run => [run.id,
      preferLive && !replaceRun(current.get(run.id), run, true) ? current.get(run.id) : run]));
    for (const file of files.filter(file => file.endsWith('.json'))) {
      try {
        const raw = await readJson(join(this.checkpointDir, file));
        if (raw === null) continue; // A checkpoint may disappear after readdir.
        if (typeof raw.parentSessionId !== 'string' || raw.schemaVersion !== 1) throw new Error('Invalid checkpoint header');
        if (raw.parentSessionId !== this.sessionId) continue;
        const run = normalizeRun(raw);
        if (!run) throw new Error('Invalid checkpoint run');
        // A durable update can arrive without a corresponding RPC. Conversely,
        // the event bus can be ahead of disk: never replace it with an old write.
        if (replaceRun(restored.get(run.id), run, bootstrap && !preferLive, bootstrap && !preferLive)) restored.set(run.id, run);
        this.checkpointErrors.delete(file);
      } catch (error) {
        if (this.checkpointErrors.get(file) !== error.message) this.notify(`DAG pane: Cannot read checkpoint ${file}: ${error.message}`);
        this.checkpointErrors.set(file, error.message);
      }
    }
    this.runs = [...restored.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async save(connected, refresh = true) {
    if (refresh) this.tasks = await this.taskData.refresh(this.runs);
    await writeJson(this.stateFile, { version: 1, sessionId: this.sessionId, connected, owner: { pid: process.pid }, language: this.language,
      updatedAt: new Date().toISOString(), runs: this.runs, tasks: this.withStreams(this.tasks, connected) });
    // All callers serialize saves through the queue, including task-only disk changes.
    if (connected && !this.stopped && (this.runs.length || this.tasks.length)) await this.ensure(false);
  }

  open() {
    return this.enqueue(async () => {
      const bootstrap = !this.runs.length;
      if (!this.runs.length) {
        const state = await readJson(this.stateFile);
        if (state?.sessionId === this.sessionId) {
          this.runs = state.runs ?? [];
          this.taskData.restore(state.tasks);
        }
      }
      await this.restoreRuns(this.runs, false, bootstrap);
      await this.save(true);
      return this.ensure(true);
    });
  }

  async listDagPanes(strict = false) {
    try {
      const panes = (await this.herdr('list'))?.panes ?? [];
      const tab = panes.find(pane => pane.pane_id === this.parentPane)?.tab_id;
      return panes.filter(isDagViewerPane)
        .filter(pane => pane.pane_id && pane.pane_id !== this.parentPane && (!tab || pane.tab_id === tab))
        .map(pane => pane.pane_id);
    } catch (error) {
      if (strict) throw error;
      if (error instanceof Error) return [];
      throw error;
    }
  }

  async closePane(paneId, strict = false) {
    if (paneId === this.parentPane) throw new Error('Refusing to close the parent terminal as a DAG viewer');
    try { await this.herdr('close', paneId); }
    catch (error) {
      if (!missingPane(error)) {
        if (strict) throw error;
        this.notify(t(this.language, 'closeFailed', { error: error.message }));
      }
    }
  }

  async closeDagPanes(keep) {
    for (const paneId of await this.listDagPanes(true)) {
      if (paneId !== keep) await this.closePane(paneId, true);
    }
  }

  // herdr-core viewers are identified by their omo.dag.session label, never by title.
  async sessionViewers(strict = false) {
    try {
      return ((await this.herdr('list'))?.panes ?? [])
        .filter(pane => pane.session === this.sessionId && pane.pane_id && pane.pane_id !== this.parentPane).map(pane => pane.pane_id);
    } catch (error) {
      if (strict) throw error;
      this.notify(`DAG pane: ${error.message}`);
      return [];
    }
  }

  async isLive(paneId) {
    if (paneId === this.parentPane) throw new Error('Refusing to reuse the parent terminal as a DAG viewer');
    try {
      const pane = await this.herdr('get', paneId);
      if (this.herdr.launch && (pane.labels?.['omo.dag'] !== 'viewer' || pane.labels?.['omo.dag.session'] !== this.sessionId)) {
        throw new Error('Recorded DAG terminal does not belong to this session');
      }
      return true;
    }
    catch (error) { if (missingPane(error)) return false; throw error; }
  }

  viewerIdentity(record) {
    return { stateFile: this.stateFile, sessionId: this.sessionId, paneId: record.paneId, token: record.token };
  }

  async viewerStatus(record, force = false) {
    if (!record?.ready || !record.token) return 'unhealthy';
    const cache = this.viewerHealth;
    if (!force && cache?.paneId === record.paneId && cache.token === record.token && this.now() - cache.checkedAt < this.healthInterval) return cache.status;
    const { status } = await this.health.probe(this.viewerIdentity(record), { timeoutMs: 300 });
    this.viewerHealth = { paneId: record.paneId, token: record.token, status, checkedAt: this.now() };
    return status;
  }

  async confirmViewer(record) {
    await this.health.wait(this.viewerIdentity(record), { timeoutMs: this.startupTimeout, probeTimeoutMs: 300 });
    const ready = { ...record, ready: true };
    await writeJson(this.recordFile, ready);
    this.viewerHealth = { paneId: ready.paneId, token: ready.token, status: 'running', checkedAt: this.now() };
  }

  async ensureViewer(force) {
    const record = await readJson(this.recordFile);
    const runId = this.runs[0]?.id ?? null;
    const sameRun = record?.runId === runId;
    if (!force && record && sameRun && (record.closed || record.attempted && !record.ready)) return record.paneId;
    const status = await this.viewerStatus(record, force || !sameRun);
    // Direct loopback probes are cached briefly; streamed updates still do not
    // spawn hc subprocesses. A live terminal alone is not a live viewer.
    if (!force && sameRun && this.settledRun === runId && status === 'running') return record.paneId;
    if (!force && sameRun && (status === 'closing' || status === 'closed')) {
      await writeJson(this.recordFile, { ...record, closed: true });
      return record.paneId;
    }
    const live = record?.paneId ? await this.isLive(record.paneId) : false;
    if (live && status === 'running') {
      for (const id of await this.sessionViewers(true)) if (id !== record.paneId) await this.closePane(id, true);
      if (record.runId !== runId) await writeJson(this.recordFile, { ...record, runId });
      this.settledRun = runId;
      return record.paneId;
    }
    // A viewer closed (or a launch failed) during this run stays closed until a new run or /dag-pane.
    if (record && !live && !force && sameRun) { this.settledRun = runId; return record.paneId; }
    // A window that does not show this session is retried with back-off, not on every save.
    if (!force && this.notShownUntil > this.now()) return null;
    if (typeof this.node === 'function') this.node = await this.node();
    // Record an attempt before mutation: a timeout must not create repeated orphan viewers.
    const token = randomUUID();
    await writeJson(this.recordFile, { attempted: true, runId, ...(record?.paneId ? { paneId: record.paneId } : {}) });
    if (live) await this.closePane(record.paneId, true);
    for (const id of await this.sessionViewers(true)) await this.closePane(id, true);
    let paneId;
    try {
      paneId = await this.herdr.launch({ parent: this.parentPane, sessionId: this.sessionId, cwd: this.cwd,
        argv: [this.node, this.viewer, '--state', this.stateFile, '--owner-pid', String(process.pid),
          '--viewer-session', this.sessionId, '--viewer-token', token] });
    } catch (error) {
      // The window does not show this session yet: retry on the next save instead of guessing a tab.
      if (/parent_not_shown/.test(error.message)) {
        await rm(this.recordFile, { force: true });
        this.notShownDelay = Math.min((this.notShownDelay ?? 1000) * 2, 300000);
        this.notShownUntil = this.now() + this.notShownDelay;
        if (force) this.notify(t(this.language, 'notShown'));
        return null;
      }
      throw error;
    }
    this.notShownDelay = undefined; this.notShownUntil = 0;
    if (!paneId) throw new Error(t(this.language, 'missingPaneId'));
    const pending = { paneId, ready: false, attempted: true, runId, token };
    await writeJson(this.recordFile, pending);
    await this.confirmViewer(pending);
    this.settledRun = runId;
    return paneId;
  }

  async ensure(force) {
    if (this.herdr.launch) return this.ensureViewer(force);
    const record = await readJson(this.recordFile);
    // Failed launches and manual closure stay suppressed until /dag-pane.
    if (!force && record && (record.closed || record.attempted && !record.ready)) return record.paneId;
    const status = await this.viewerStatus(record, force);
    if (status === 'running') {
      if (!force) return record.paneId;
      if (await this.isLive(record.paneId)) {
        await this.closeDagPanes(record.paneId);
        return record.paneId;
      }
    }
    if (!force && (status === 'closing' || status === 'closed')) {
      await writeJson(this.recordFile, { ...record, closed: true });
      return record.paneId;
    }
    const live = record?.paneId ? await this.isLive(record.paneId) : false;
    if (record && !live && !force) return record.paneId;
    if (typeof this.node === 'function') this.node = await this.node();
    // Record an attempt before mutation: a timeout must not create repeated orphan panes.
    await writeJson(this.recordFile, { attempted: true, ...(record?.paneId ? { paneId: record.paneId } : {}) });
    if (live) await this.closePane(record.paneId, true);
    await this.closeDagPanes();
    const result = await this.herdr('split', '--pane', this.parentPane, '--direction', 'right',
      '--ratio', '0.65', '--cwd', this.cwd, '--no-focus');
    const paneId = result?.pane?.pane_id;
    if (!paneId) throw new Error(t(this.language, 'missingPaneId'));
    const token = randomUUID();
    const pending = { paneId, ready: false, attempted: true, token };
    await writeJson(this.recordFile, pending);
    await this.herdr('rename', paneId, dagTitle(this.sessionId));
    await this.herdr('run', paneId, shellCommand([this.node, this.viewer, '--state', this.stateFile, '--close-pane', paneId,
      '--viewer-session', this.sessionId, '--viewer-token', token]));
    await this.confirmViewer(pending);
    return paneId;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.streamTimer);
    clearInterval(this.refreshTimer);
    this.streams.clear();
    this.taskData.stop();
    return this.enqueue(async () => {
      await this.save(false);
      // A herdr-core viewer outlives its session's terminal; close it with the session.
      if (!this.herdr.launch) return;
      const record = await readJson(this.recordFile);
      const viewers = new Set(await this.sessionViewers());
      if (record?.paneId && !viewers.has(record.paneId)) {
        try { if (await this.isLive(record.paneId)) viewers.add(record.paneId); }
        catch (error) { this.notify(`DAG pane: ${error.message}`); }
      }
      for (const id of viewers) await this.closePane(id);
      await rm(this.recordFile, { force: true });
    });
  }
}
