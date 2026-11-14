import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';

const STALE_MS = 6 * 60 * 60 * 1000;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  // EPERM: alive, but owned by another user.
  catch (error) { return error.code !== 'ESRCH'; }
}

// Owner loss is evidence that this display is disconnected, not that OmO
// cancelled the underlying work. Retain the last reported workflow/task states.
export async function reconcileStaleState(stateDir, { alive = processAlive, now = Date.now() } = {}) {
  let files;
  try { files = await readdir(stateDir); }
  catch (error) { if (error.code === 'ENOENT') return { reconciled: [], errors: [] }; throw error; }
  const reconciled = [], errors = [];
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.pane.json') || file.endsWith('.view.json')) continue;
    try {
      const state = await readJson(join(stateDir, file));
      if (!state || state.connected !== true) continue;
      const pid = state.owner?.pid;
      const stale = Number.isInteger(pid) ? !alive(pid)
        : !state.owner && !(now - Date.parse(state.updatedAt) < STALE_MS);
      if (!stale) continue;
      const tasks = state.tasks?.map(({ activity: _activity, ...task }) => task);
      await writeJson(join(stateDir, file), { ...state, connected: false, ...(tasks ? { tasks } : {}) });
      reconciled.push(file);
    } catch (error) { errors.push({ file, error }); }
  }
  return { reconciled, errors };
}
