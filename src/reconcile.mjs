import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';

const STALE_MS = 6 * 60 * 60 * 1000;
// The renderer has no 'interrupted' style; 'cancelled' is the closest status it already draws.
const INTERRUPTED = 'cancelled';

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// A state file whose owning session died still says connected/running; mark it
// disconnected and interrupt its running work so viewers stop showing it live.
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
      const runs = (state.runs ?? []).map(run => ({ ...run,
        ...(run.status === 'running' ? { status: INTERRUPTED } : {}),
        nodes: (run.nodes ?? []).map(node => node.state === 'running' ? { ...node, state: INTERRUPTED } : node) }));
      await writeJson(join(stateDir, file), { ...state, connected: false, runs });
      reconciled.push(file);
    } catch (error) { errors.push({ file, error }); }
  }
  return { reconciled, errors };
}
