import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { DagPane } from './src/controller.mjs';
import { createHc, createHerdr, hcSession, herdrSession } from './src/herdr.mjs';
import { resolveViewerNode } from './src/runtime.mjs';
import { tapStreams } from './src/stream-tap.mjs';
import { t, languageOf } from './src/i18n.mjs';

// One live controller per process: a reload or session replacement loads a new extension
// generation, which must retire the previous generation's controller and viewer.
const ACTIVE = Symbol.for('omo-herdr-dag.activeController');
const STALE = /^(This extension ctx is stale after session replacement or reload|stale extension generation after reload)/;
export const isStaleContextError = error => error instanceof Error && STALE.test(error.message);

export default function extension(pi) {
  const herdr = herdrSession();
  if (!herdr && !hcSession()) return;
  let installedLanguage = 'en';
  try { installedLanguage = JSON.parse(readFileSync(new URL('./locale.json', import.meta.url), 'utf8')).language; }
  catch (error) { if (error.code !== 'ENOENT') console.warn(`DAG pane: Cannot read locale configuration: ${error.message}`); }
  const language = languageOf(process.env.OMO_HERDR_DAG_LANG ?? installedLanguage);
  let controller;
  let unsubscribe;
  let streams;
  const viewer = join(dirname(fileURLToPath(import.meta.url)), 'src/viewer.mjs');
  const stateDir = process.env.OMO_HERDR_DAG_STATE_DIR ?? join(homedir(), '.omo', 'agent', 'herdr-dag');

  async function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
    streams?.stop();
    streams = undefined;
    const retiring = controller;
    controller = undefined;
    if (globalThis[ACTIVE] === stop) globalThis[ACTIVE] = undefined;
    await retiring?.stop();
  }
  // A ctx retired by session replacement or reload throws on use; that generation stops instead.
  const notifier = ctx => message => {
    try { ctx.ui.notify(message, 'warning'); }
    catch (error) { if (isStaleContextError(error)) void stop(); else throw error; }
  };

  pi.on('session_start', async (_event, ctx) => {
    await stop();
    // In-process child agents inherit the parent pane environment, but do not own its UI.
    if (/[/\\]senpi-task[/\\]children[/\\]/.test(ctx.sessionManager.getSessionFile?.() ?? '')) return;
    if (globalThis[ACTIVE] && globalThis[ACTIVE] !== stop) await globalThis[ACTIVE]().catch(() => {});
    controller = new DagPane({ sessionId: ctx.sessionManager.getSessionId(),
      parentPane: herdr ? process.env.HERDR_PANE_ID : process.env.HC_TERMINAL_ID,
      socket: herdr ? process.env.HERDR_SOCKET_PATH : process.env.HC_TERMINAL_SOCKET,
      stateDir, cwd: pi.cwd, node: () => resolveViewerNode({ language }), viewer, herdr: herdr ? createHerdr() : createHc(), language,
      taskStateDir: process.env.OMO_HERDR_DAG_TASK_STATE_DIR,
      notify: notifier(ctx) });
    globalThis[ACTIVE] = stop;
    const notify = notifier(ctx);
    const owner = controller;
    // In-process child sessions stream through the shared Senpi AgentSession class.
    streams = tapStreams(update => owner.receiveStream(update),
      { onUnsupported: () => notify(t(language, 'streamUnsupported')) });
    // Confirmed in senpi/dist/core/event-bus.js and extensions/loader.js:
    // pi.rpc.emit forwards {name, data} through this shared event channel.
    unsubscribe = pi.events.on('senpi:extension-rpc-event', event => {
      if (event?.name !== 'omo.dag.updated' && event?.name !== 'omo.task.updated') return;
      streams?.retry();
      // DagPane.enqueue reports rejected jobs; the event bus cannot await them.
      try { void (event.name === 'omo.dag.updated' ? controller?.receive(event.data) : controller?.receiveTasks(event.data))?.catch(() => {}); }
      catch (error) { notify(`DAG pane: ${error.message}`); }
    });
    await controller.start().catch(() => {}); // The queue reports startup errors to the UI.
  });
  pi.on('session_shutdown', stop);
  pi.registerCommand('dag-pane', {
    description: t(language, 'commandDescription'),
    handler: async (_args, ctx) => {
      if (!controller) return ctx.ui.notify(t(language, 'unavailable'), 'warning');
      await controller.open().catch(() => {});
    },
  });
}
