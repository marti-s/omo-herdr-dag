import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';
import { pruneExpiredSnapshots, retentionDaysFromEnv } from './retention.mjs';
import { reconcileStaleState } from './reconcile.mjs';
import { shellCommand } from './herdr.mjs';
import { normalizeRun, sessionRuns } from './model.mjs';
import { t, languageOf } from './i18n.mjs';
import { TaskData } from './task-data.mjs';

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

export class DagPane {
  constructor({ sessionId, parentPane, socket, stateDir, cwd, node, viewer, herdr, notify = () => {}, language = 'en', taskStateDir, retentionDays, streamDelay = 250, now = Date.now }) {
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
    this.notShownUntil = 0;
    this.queue = Promise.resolve();
    this.runs = [];
    this.stopped = false;
    this.tasks = [];
    this.streams = new Map();
    this.taskData = new TaskData({ cwd, sessionId, stateDir: taskStateDir, notify,
      onChange: () => { if (!this.stopped) this.enqueue(() => this.save(true)); } });
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
      // Housekeeping precedes restore so a fresh pane never lists pruned snapshots.
      await pruneExpiredSnapshots(this.stateDir, {
        keepFiles: [basename(this.stateFile), basename(this.recordFile), `${basename(this.stateFile)}.view.json`],
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
      await this.restoreRuns();
      await this.save(true);
    });
  }

  receiveTasks(payload) {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(async () => {
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

  async restoreRuns(runs = this.runs, preferLive = false) {
    let files;
    try { files = await readdir(this.checkpointDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    const restored = new Map(runs.map(run => [run.id, run]));
    for (const file of files.filter(file => file.endsWith('.json'))) {
      try {
        const raw = await readJson(join(this.checkpointDir, file));
        if (raw === null) continue; // A checkpoint may disappear after readdir.
        if (typeof raw.parentSessionId !== 'string' || raw.schemaVersion !== 1) throw new Error('Invalid checkpoint header');
        if (raw.parentSessionId !== this.sessionId) continue;
        const run = normalizeRun(raw);
        if (!run) throw new Error('Invalid checkpoint run');
        // Startup/open distrust cached state; an incoming RPC may be ahead of disk.
        if (!preferLive || !restored.has(run.id)) restored.set(run.id, run);
      } catch (error) { this.notify(`DAG pane: Cannot read checkpoint ${file}: ${error.message}`); }
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
      if (!this.runs.length) {
        const state = await readJson(this.stateFile);
        if (state?.sessionId === this.sessionId) {
          this.runs = state.runs ?? [];
          this.taskData.restore(state.tasks);
        }
      }
      await this.restoreRuns();
      await this.save(true);
      return this.ensure(true);
    });
  }

  async listDagPanes() {
    try {
      const panes = (await this.herdr('list'))?.panes ?? [];
      const tab = panes.find(pane => pane.pane_id === this.parentPane)?.tab_id;
      return panes.filter(isDagViewerPane)
        .filter(pane => pane.pane_id && pane.pane_id !== this.parentPane && (!tab || pane.tab_id === tab))
        .map(pane => pane.pane_id);
    } catch (error) {
      if (error instanceof Error) return [];
      throw error;
    }
  }

  async closePane(paneId) {
    try { await this.herdr('close', paneId); }
    catch (error) {
      if (!missingPane(error)) this.notify(t(this.language, 'closeFailed', { error: error.message }));
    }
  }

  async closeDagPanes(keep) {
    for (const paneId of await this.listDagPanes()) {
      if (paneId !== keep) await this.closePane(paneId);
    }
  }

  // herdr-core viewers are identified by their omo.dag.session label, never by title.
  async sessionViewers() {
    try {
      return ((await this.herdr('list'))?.panes ?? [])
        .filter(pane => pane.session === this.sessionId && pane.pane_id).map(pane => pane.pane_id);
    } catch (error) {
      this.notify(`DAG pane: ${error.message}`);
      return [];
    }
  }

  async isLive(paneId) {
    try { await this.herdr('get', paneId); return true; }
    catch (error) { if (missingPane(error)) return false; throw error; }
  }

  async ensureViewer(force) {
    const record = await readJson(this.recordFile);
    const runId = this.runs[0]?.id ?? null;
    // Saves run on every stream flush: once this run's viewer is settled, they need no hc calls.
    if (!force && record && record.runId === runId && this.settledRun === runId) return record.paneId;
    if (record?.paneId && await this.isLive(record.paneId)) {
      for (const id of await this.sessionViewers()) if (id !== record.paneId) await this.closePane(id);
      if (record.runId !== runId) await writeJson(this.recordFile, { ...record, runId });
      this.settledRun = runId;
      return record.paneId;
    }
    // A viewer closed (or a launch failed) during this run stays closed until a new run or /dag-pane.
    if (record && !force && record.runId === runId) { this.settledRun = runId; return record.paneId; }
    // A window that does not show this session is retried with back-off, not on every save.
    if (!force && this.notShownUntil > this.now()) return null;
    if (typeof this.node === 'function') this.node = await this.node();
    // Record an attempt before mutation: a timeout must not create repeated orphan viewers.
    await writeJson(this.recordFile, { attempted: true, runId });
    for (const id of await this.sessionViewers()) await this.closePane(id);
    let paneId;
    try {
      paneId = await this.herdr.launch({ parent: this.parentPane, sessionId: this.sessionId, cwd: this.cwd,
        argv: [this.node, this.viewer, '--state', this.stateFile, '--owner-pid', String(process.pid)] });
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
    this.settledRun = runId;
    this.notShownDelay = undefined; this.notShownUntil = 0;
    if (!paneId) throw new Error(t(this.language, 'missingPaneId'));
    await writeJson(this.recordFile, { paneId, ready: true, runId });
    return paneId;
  }

  async ensure(force) {
    if (this.herdr.launch) return this.ensureViewer(force);
    const record = await readJson(this.recordFile);
    // Preserve a manually closed pane across events/reloads. /dag-pane explicitly reopens it.
    if (record && !force) return record.paneId;
    if (record?.paneId) {
      try {
        await this.herdr('get', record.paneId);
        if (record.ready) {
          await this.closeDagPanes(record.paneId);
          return record.paneId;
        }
        // Occupied leftover from a failed launch: close it, then replace.
        await this.closePane(record.paneId);
      } catch (error) {
        if (!missingPane(error)) throw error;
      }
    }
    if (typeof this.node === 'function') this.node = await this.node();
    // Record an attempt before mutation: a timeout must not create repeated orphan panes.
    await writeJson(this.recordFile, { attempted: true });
    await this.closeDagPanes();
    const result = await this.herdr('split', '--pane', this.parentPane, '--direction', 'right',
      '--ratio', '0.65', '--cwd', this.cwd, '--no-focus');
    const paneId = result?.pane?.pane_id;
    if (!paneId) throw new Error(t(this.language, 'missingPaneId'));
    await writeJson(this.recordFile, { paneId, ready: false });
    await this.herdr('rename', paneId, dagTitle(this.sessionId));
    await this.herdr('run', paneId, shellCommand([this.node, this.viewer, '--state', this.stateFile, '--close-pane', paneId]));
    await writeJson(this.recordFile, { paneId, ready: true });
    return paneId;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.streamTimer);
    this.streams.clear();
    this.taskData.stop();
    return this.enqueue(async () => {
      await this.save(false);
      // A herdr-core viewer outlives its session's terminal; close it with the session.
      if (!this.herdr.launch) return;
      const record = await readJson(this.recordFile);
      const viewers = new Set(await this.sessionViewers());
      if (record?.paneId) viewers.add(record.paneId);
      for (const id of viewers) await this.closePane(id);
      await rm(this.recordFile, { force: true });
    });
  }
}
