import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createHc, createHerdr } from './herdr.mjs';
import { t } from './i18n.mjs';
import { renderFrame, runningTarget, standaloneTasks } from './render.mjs';
import { readJson } from './storage.mjs';
import { startViewerHealth } from './viewer-health.mjs';
import { TASK_SCOPE, emptyViewState, isExpanded, loadViewState, saveViewState, setExpanded } from './view-state.mjs';

const file = process.argv[process.argv.indexOf('--state') + 1];
if (!process.argv.includes('--state') || !file) throw new Error('Usage: node viewer.mjs --state PATH');
let state = await readJson(file);
let selectedId = state?.runs?.[0]?.id;
let view = state?.runs?.length ? 'dag' : 'tasks', selectedTaskId;
let scroll = 0, error = '', watchError = '', timer, watcher, drawing = false, again = false;
let viewState = emptyViewState(state?.sessionId), viewError = '', saving = Promise.resolve(), closing = false;
const selectedNodes = new Map();
let revealSelection = false, verbose = false, detailSelection, completedExpanded = false;
let follow = true, target;
// Arrow keys arrive as CSI (ESC [ C) or, in application-cursor mode, SS3 (ESC O C); both parse to one name.
const ARROWS = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
async function restorePreferences() {
  try { viewState = await loadViewState(file, state?.sessionId); viewError = ''; }
  catch (cause) { viewState = emptyViewState(state?.sessionId); viewError = cause.message; }
}
await restorePreferences();
const ownerPid = process.argv.includes('--owner-pid') ? Number(process.argv[process.argv.indexOf('--owner-pid') + 1]) : undefined;
function ownerGone() {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  try { process.kill(ownerPid, 0); return false; }
  catch (cause) { return cause.code === 'ESRCH'; }
}
const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
function draw({ inspect = false } = {}) {
  if (closing) return;
  if (state?.connected) target = runningTarget(state, target);
  // Inspection gets its own frame without changing the person's Follow setting.
  // The next model/snapshot/clock update resumes following unless f turned it off.
  if (follow && !inspect) revealSelection = false;
  const running = follow && !inspect && state?.connected ? target : undefined;
  if (running) {
    if (view !== running.view || running.view === 'dag' && selectedId !== running.runId) scroll = 0;
    view = running.view;
    if (view === 'dag') selectedId = running.runId;
  }
  let runIndex = state?.runs?.findIndex(run => run.id === selectedId) ?? 0;
  if (runIndex < 0) { runIndex = 0; selectedId = state?.runs?.[0]?.id; }
  const run = state?.runs?.[runIndex];
  if (!state?.runs?.length) view = 'tasks';
  const roots = standaloneTasks(state);
  if (!roots.some(task => task.id === selectedTaskId)) selectedTaskId = roots[0]?.id;
  if (!run?.nodes.some(node => node.id === selectedNodes.get(selectedId))) selectedNodes.set(selectedId, run?.nodes[0]?.id);
  const selection = JSON.stringify([state?.sessionId, view, view === 'tasks' ? null : selectedId,
    view === 'tasks' ? selectedTaskId : selectedNodes.get(selectedId)]);
  if (selection !== detailSelection) { verbose = false; detailSelection = selection; }
  const result = renderFrame(state, { columns: process.stdout.columns ?? 54, rows: process.stdout.rows ?? 48, runIndex, scroll, color: interactive,
    error: error || watchError, notice: viewError ? t(state?.language, 'viewError', { error: viewError }) : '', completedExpanded,
    selectedNodeId: selectedNodes.get(selectedId), selectedTaskId, view, viewState, verbose, revealSelection, follow,
    runningNodeId: running?.nodeId, runningTaskId: running?.taskId });
  scroll = result.scroll;
  const frame = result.text;
  process.stdout.write(interactive ? `\x1b[H${frame.replaceAll('\n', '\x1b[K\r\n')}\x1b[K` : `${frame}\n`);
}
async function refresh() {
  if (closing) return;
  if (drawing) { again = true; return; }
  drawing = true;
  try {
    const next = await readJson(file);
    if (next) {
      if (viewerToken && next.sessionId !== viewerSession) throw new Error('Viewer snapshot does not match its session');
      const sessionChanged = next.sessionId !== state?.sessionId;
      // A newly started run takes over the view while following, even before its first node runs.
      const newRun = follow && next.runs?.[0]?.id && next.runs[0].id !== state?.runs?.[0]?.id;
      state = next; error = '';
      // The running target still decides the view; a new run only becomes the selected run.
      if (newRun && !sessionChanged) { selectedId = state.runs[0].id; if (view === 'dag') scroll = 0; }
      if (sessionChanged) {
        await saving; selectedNodes.clear(); selectedTaskId = undefined; scroll = 0;
        selectedId = state?.runs?.[0]?.id; completedExpanded = false;
        follow = true; target = undefined; revealSelection = false;
        view = state?.runs?.length ? 'dag' : 'tasks';
        await restorePreferences();
      }
    }
    else error = t(state?.language, 'stateMissing');
  } catch (cause) { error = cause.message; }
  draw(); drawing = false;
  if (again) { again = false; void refresh(); }
}
if (process.argv.includes('--once') || !interactive) { draw(); process.exit(0); }
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const viewerToken = argument('--viewer-token');
const viewerSession = argument('--viewer-session') ?? state?.sessionId;
if (viewerToken && state?.sessionId !== viewerSession) throw new Error('Viewer snapshot does not match its session');
// A token-bound receipt proves this process loaded the intended snapshot, not just
// that a shell command was accepted. Standalone and --once invocations need none.
const health = viewerToken ? await startViewerHealth({ stateFile: file, sessionId: viewerSession,
  paneId: argument('--close-pane') ?? process.env.HC_TERMINAL_ID, token: viewerToken }) : undefined;
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b]0;OmO DAG\x07');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
emitKeypressEvents(process.stdin);
function startWatcher() {
  if (closing || watcher) return;
  try {
    const next = watch(dirname(file), (_event, name) => {
      if (name && String(name) !== basename(file)) return;
      clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 40);
    });
    watcher = next;
    watchError = '';
    next.on('error', cause => {
      if (watcher !== next) return;
      watchError = cause.message; watcher = undefined; next.close(); draw();
    });
    next.on('close', () => { if (watcher === next) watcher = undefined; });
  } catch (cause) { watchError = cause.message; }
}
startWatcher();
const resize = () => draw();
process.stdout.on('resize', resize);
// fs.watch is the fast path, not the only path: dropped events and failed watches
// recover on a bounded interval. refresh() coalesces overlapping reads.
const recovery = setInterval(() => { startWatcher(); void refresh(); }, 2000);
recovery.unref();
// Elapsed time can advance between snapshots; recovery independently rereads data.
const clock = setInterval(() => {
  if (ownerGone()) return void close(true);
  if (state?.connected && (state.tasks?.some(task => task.status === 'running') ||
      state.runs?.some(run => run.nodes.some(node => node.state === 'running')))) draw();
}, 1000);
async function close(closePane = false, intentional = false) {
  if (closing) return;
  closing = true;
  clearTimeout(timer); clearInterval(clock); clearInterval(recovery); watcher?.close(); process.stdout.off('resize', resize);
  await saving;
  if (intentional) {
    try { await health?.markClosing(); }
    catch (cause) { process.stderr.write(`DAG pane: ${cause.message}\n`); }
  }
  process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  if (viewError) process.stderr.write(`${t(state?.language, 'viewError', { error: viewError })}\n`);
  if (closePane && process.argv.includes('--close-pane')) {
    const pane = process.argv[process.argv.indexOf('--close-pane') + 1];
    try { await createHerdr()('close', pane); }
    catch (error) { process.stderr.write(`${t(state?.language, 'closeFailed', { error: error.message })}\n`); }
  } else if (closePane && process.env.HC_TERMINAL_ID) {
    // Close only this session's own viewer terminal: a viewer started from an agent's shell
    // (or a test) inherits that agent's HC_TERMINAL_ID and must never close the agent.
    try {
      const hc = createHc();
      const own = await hc('get', process.env.HC_TERMINAL_ID);
      if (own.labels?.['omo.dag'] === 'viewer' && own.labels?.['omo.dag.session'] === state?.sessionId) await hc('close', process.env.HC_TERMINAL_ID);
    }
    catch (error) {
      if (!String(error.message).includes('pane_not_found')) process.stderr.write(`${t(state?.language, 'closeFailed', { error: error.message })}\n`);
    }
  }
  try { await health?.close(); }
  catch (cause) { process.stderr.write(`DAG pane: ${cause.message}\n`); }
  process.exit(0);
}
process.stdin.on('keypress', (text, pressed) => {
  if (closing) return;
  const key = !pressed.ctrl && !pressed.meta && !pressed.shift && ARROWS[pressed.name] || pressed.sequence || pressed.name || text;
  if (key === 'q' || key === '\x03' || key === '\x04') return void close(true, true);
  if (key === 'f') {
    follow = !follow; revealSelection = false;
    // Following again means the newest run, not the run that was followed before the person chose one.
    if (follow && state?.runs?.length) { target = undefined; selectedId = state.runs[0].id; view = 'dag'; scroll = 0; }
  }
  if (['\x1b[B', 'j', '\x1b[A', 'k', '\x1b[6~', '\x1b[5~'].includes(key)) {
    revealSelection = false;
  }
  if (key === '\x1b[B' || key === 'j') scroll++;
  if (key === '\x1b[A' || key === 'k') scroll = Math.max(0, scroll - 1);
  if (key === '\x1b[6~') scroll += Math.max(1, (process.stdout.rows ?? 48) - 8);
  if (key === '\x1b[5~') scroll = Math.max(0, scroll - Math.max(1, (process.stdout.rows ?? 48) - 8));
  if (key === 't' && state?.runs?.length) {
    view = view === 'dag' ? 'tasks' : 'dag';
    scroll = 0; revealSelection = true;
  }
  if ((key === 'c' || pressed.name === 'c') && (state?.runs?.length ?? 0) > 1) {
    completedExpanded = !completedExpanded;
    scroll = 0; revealSelection = true;
  }
  if (key === '\x1b[C' || key === '\x1b[D') {
    // Every run of the session, completed ones included; the header shows which one of how many.
    const runs = state?.runs ?? [];
    const current = Math.max(0, runs.findIndex(run => run.id === selectedId));
    selectedId = runs[(current + (key === '\x1b[C' ? 1 : -1) + runs.length) % runs.length]?.id;
    if (runs.length) view = 'dag';
    scroll = 0; revealSelection = false;
  }
  const run = state?.runs?.find(run => run.id === selectedId);
  const items = view === 'tasks' ? standaloneTasks(state) : run?.nodes ?? [];
  const scope = view === 'tasks' ? TASK_SCOPE : run?.id;
  const itemId = view === 'tasks' ? selectedTaskId : selectedNodes.get(selectedId);
  if (items.length && (pressed.name === 'tab' || key === 'n' || key === 'p')) {
    const current = Math.max(0, items.findIndex(item => item.id === itemId));
    const direction = pressed.shift || key === 'p' ? -1 : 1;
    const nextId = items[(current + direction + items.length) % items.length].id;
    if (view === 'tasks') selectedTaskId = nextId;
    else selectedNodes.set(selectedId, nextId);
    revealSelection = true;
  }
  if (items.length && key === 'd') {
    // A temporary detail peek never writes or replaces the saved fold state.
    verbose = !verbose;
    revealSelection = true;
  }
  if (items.length && (key === ' ' || key === '\r' || key === '\n')) {
    verbose = false;
    const item = items.find(item => item.id === itemId);
    const status = view === 'tasks' ? item.status : item.state;
    setExpanded(viewState, scope, itemId, !isExpanded(viewState, scope, itemId, status));
    const snapshot = structuredClone(viewState);
    saving = saving.then(() => saveViewState(file, snapshot)).then(() => {
      if (viewError) { viewError = ''; draw(); }
    }, cause => {
      viewError = cause.message; draw();
    });
    revealSelection = true;
  }
  draw({ inspect: key !== 'f' });
});
process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); }); process.on('SIGHUP', () => { void close(); });
draw();
// Recover a replacement that raced with watcher registration.
void refresh();
