import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function shellCommand(args, platform = process.platform) {
  // Windows Herdr panes run PowerShell, where quoted executables need &.
  if (platform === 'win32') return `& ${args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ')}`;
  return args.map(quote).join(' ');
}

function executableFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

export function resolveHerdrBin(env = process.env, platform = process.platform) {
  const explicit = env.HERDR_BIN_PATH?.trim();
  if (explicit && executableFile(explicit)) return explicit;
  const name = platform === 'win32' ? 'herdr.exe' : 'herdr';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

export function herdrSession(env = process.env) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) return false;
  if (!existsSync(env.HERDR_SOCKET_PATH)) return false;
  const explicit = env.HERDR_BIN_PATH?.trim();
  // A leftover HERDR_BIN_PATH such as `/path/herdr (deleted)` is not a live pane.
  if (explicit && !executableFile(explicit)) return false;
  return Boolean(resolveHerdrBin(env));
}

// herdr-core (hc): terminals instead of panes. Used only when no old Herdr pane is present.
export function resolveHcBin(env = process.env) {
  const explicit = env.HC_BIN_PATH?.trim();
  if (explicit) return executableFile(explicit) ? explicit : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const name of ['herdr-core', 'hc']) {
      if (dir && executableFile(join(dir, name))) return join(dir, name);
    }
  }
  const fallback = join(env.HOME ?? homedir(), '.local', 'bin', 'herdr-core');
  return executableFile(fallback) ? fallback : null;
}

export function hcSession(env = process.env) {
  if (!env.HC_TERMINAL_ID || !env.HC_TERMINAL_SOCKET || !existsSync(env.HC_TERMINAL_SOCKET)) return false;
  return Boolean(resolveHcBin(env));
}

// herdr-app drives the visible window; it places the viewer beside its session's pane.
export function resolveHerdrAppBin(env = process.env) {
  const explicit = env.HC_APP_BIN_PATH?.trim();
  if (explicit) return executableFile(explicit) ? explicit : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && executableFile(join(dir, 'herdr-app'))) return join(dir, 'herdr-app');
  }
  const fallback = join(env.HOME ?? homedir(), '.local', 'bin', 'herdr-app');
  return executableFile(fallback) ? fallback : null;
}

const VIEWER = 'omo.dag';
const SESSION = 'omo.dag.session';

// The lane a viewer serves: its tab's name, unless that is only a number.
export function laneName(tabName, { env = process.env, cwd } = {}) {
  const name = String(tabName ?? '').trim();
  if (name && !/^\d+$/.test(name)) return name;
  return env.DORI_LANE?.trim() || (cwd ? cwd.split(/[/\\]/).filter(Boolean).pop() : '') || '';
}

// hc names are 1-32 of a-z 0-9 - _ and unique among live terminals.
export function viewerName(lane, sessionId, unique = false) {
  const slug = text => String(text).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const tail = slug(sessionId).replaceAll('-', '').slice(-6);
  const base = slug(lane) || tail;
  const name = unique && base !== tail ? `${base.slice(0, 32 - 8 - 7)}-${tail}` : base;
  return `omo-dag-${name}`.slice(0, 32).replace(/[-_]+$/, '');
}

// Where the window shows a terminal: { space, tab, tabName, pane }; null when the window
// does not show it (yet), undefined when there is no herdr-app or no window at all.
export function locateTerminal(window, terminal) {
  for (const space of window?.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      const found = (tab.terminals ?? []).find(entry => entry.terminal === terminal);
      if (found) return { space: space.id, tab: tab.id, tabName: tab.name, pane: found.pane ?? null };
    }
  }
  return null;
}

// Answers the pane commands DagPane uses (list, get, close) and adds launch.
// A viewer is identified only by its hc labels, never by its name.
export function createHc(env = process.env) {
  const options = { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 };
  const hc = async (command, ...args) => {
    const bin = resolveHcBin(env);
    if (!bin) throw new Error('herdr-core is not available in this session');
    let stdout;
    try { ({ stdout } = await execute(bin, [command, '--json', ...args], options)); }
    catch (error) { stdout = error.stdout?.trim() ? error.stdout : error.stderr; if (!stdout?.trim().startsWith('{')) throw error; }
    const reply = stdout.trim() ? JSON.parse(stdout) : {};
    if (reply.error) {
      throw Object.assign(new Error(reply.error.kind === 'not_found' ? `pane_not_found: ${reply.error.message}` : reply.error.message),
        { kind: reply.error.kind });
    }
    return reply;
  };
  const app = async (...args) => {
    const bin = resolveHerdrAppBin(env);
    if (!bin) throw new Error('herdr-app is not available');
    let stdout;
    try { ({ stdout } = await execute(bin, args, options)); }
    catch (error) { stdout = error.stdout; if (!stdout?.trim().startsWith('{')) throw error; }
    const reply = stdout.trim() ? JSON.parse(stdout) : {};
    if (reply.error) throw new Error(`herdr-app: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply;
  };
  const windowLs = async () => {
    if (!resolveHerdrAppBin(env)) return undefined;
    try { return await app('ls'); }
    catch { return undefined; }
  };
  // The window pane showing a terminal, or null without herdr-app, a window, or a pane.
  const paneOf = async terminal => locateTerminal(await windowLs(), terminal)?.pane ?? null;
  const runViewer = async (name, placement, { cwd, sessionId, argv }) => hc('run', '--bg', '--no-parent', '--outlive-parent', '--rm',
    '--cwd', cwd, '--name', name, ...placement, '--label', `${VIEWER}=viewer`, '--label', `${SESSION}=${sessionId}`, '--', ...argv);
  const runNamed = async (lane, placement, options) => {
    const name = viewerName(lane, options.sessionId), unique = viewerName(lane, options.sessionId, true);
    let reply;
    try { reply = await runViewer(name, placement, options); }
    // Another live terminal (another session of the same lane) holds the plain name. Any other
    // failure, a timeout included, may have started a viewer already and must not start a second.
    catch (error) {
      if (error.kind !== 'name_taken' || unique === name) throw error;
      reply = await runViewer(unique, placement, options);
    }
    return reply.address ?? reply.terminal?.address;
  };
  const live = async address => {
    const terminal = await hc('get', address);
    if (terminal.state !== 'live') throw new Error(`pane_not_found: ${address} is ${terminal.state}`);
    return terminal;
  };
  return Object.assign(async (command, ...args) => {
    if (command === 'list') {
      const { terminals = [] } = await hc('ls', '--label', `${VIEWER}=viewer`);
      const panes = [];
      for (const { address } of terminals) {
        // ls carries no labels; get supplies the session and skips ones that just ended.
        let terminal;
        try { terminal = await live(address); }
        catch (error) { if (/pane_not_found/.test(error.message)) continue; throw error; }
        if (terminal.labels?.[VIEWER] !== 'viewer') continue;
        const session = terminal.labels[SESSION] ?? '';
        panes.push({ pane_id: address, session, label: `DAG · ${session.slice(0, 8)}` });
      }
      return { panes };
    }
    if (command === 'get') return live(args[0]);
    if (command === 'close') {
      const [address] = args;
      await live(address);
      const pane = await paneOf(address);
      if (pane) await app('do', 'pane.close', JSON.stringify({ pane }));
      else await hc('kill', address);
      // A --rm viewer is already gone once killed; one the window just closed may still be ending.
      try { await hc('rm', address); }
      catch (error) {
        if (/pane_not_found/.test(error.message)) return {};
        await hc('kill', address).catch(() => {});
        try { await hc('rm', address); }
        catch (again) { if (!/pane_not_found/.test(again.message)) throw again; }
      }
      return {};
    }
    throw new Error(`herdr-core: unsupported pane command ${command}`);
  }, {
    // The viewer joins its session's own tab, right of the session's pane in the window layout,
    // named after the lane. A tab named only by a number is renamed to the lane first.
    async launch({ parent, sessionId, cwd, argv }) {
      const window = await windowLs();
      const where = locateTerminal(window, parent);
      // A window that does not show the session yet must not get a viewer in some other tab.
      if (window && !where) throw new Error(`parent_not_shown: the window does not show ${parent} yet`);
      if (where) {
        const lane = laneName(where.tabName, { env, cwd });
        // Cosmetic: a failed rename must not keep the viewer from starting.
        if (lane && lane !== where.tabName) await app('do', 'tab.rename', JSON.stringify({ id: where.tab, name: lane })).catch(() => {});
        return runNamed(lane, ['--label', `herdr.space=${where.space}`, '--label', `herdr.tab=${where.tab}`], { sessionId, cwd, argv });
      }
      const { labels = {} } = await hc('get', parent);
      const placement = ['herdr.space', 'herdr.tab'].filter(key => labels[key] !== undefined)
        .flatMap(key => ['--label', `${key}=${labels[key]}`]);
      return runNamed(laneName(labels.where?.split(' / ').pop(), { env, cwd }), placement, { sessionId, cwd, argv });
    },
    // Viewers from before the omo.dag labels: unlabelled omo-dag-* terminals showing this state file.
    async legacy(stateFile) {
      const { terminals = [] } = await hc('ls');
      const found = [];
      for (const { address } of terminals) {
        let terminal;
        try { terminal = await hc('get', address); }
        catch (error) { if (/pane_not_found/.test(error.message)) continue; throw error; }
        if (terminal.state !== 'live' || !terminal.name?.startsWith('omo-dag-') || terminal.labels?.[VIEWER]) continue;
        if ((terminal.argv ?? []).includes(stateFile)) found.push(address);
      }
      return found;
    },
  });
}

export function createHerdr(env = process.env) {
  return async (...args) => {
    const bin = resolveHerdrBin(env);
    if (!bin) throw new Error('Herdr is not available in this session');
    const { stdout } = await execute(bin, ['pane', ...args], { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    // pane run acknowledges success with an empty body in Herdr protocol 20.
    if (!stdout.trim()) return {};
    const reply = JSON.parse(stdout);
    if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
    return reply.result;
  };
}
