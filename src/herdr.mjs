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
    if (reply.error) throw new Error(reply.error.kind === 'not_found' ? `pane_not_found: ${reply.error.message}` : reply.error.message);
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
  // The window pane showing a terminal, or null without herdr-app, a window, or a pane.
  const paneOf = async terminal => {
    if (!resolveHerdrAppBin(env)) return null;
    let window;
    try { window = await app('ls'); }
    catch { return null; }
    for (const space of window.spaces ?? []) {
      for (const tab of space.tabs ?? []) {
        const found = (tab.terminals ?? []).find(entry => entry.terminal === terminal);
        if (found?.pane) return found.pane;
      }
    }
    return null;
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
      // A --rm fallback viewer is already gone once killed.
      try { await hc('rm', address); }
      catch (error) { if (!/pane_not_found/.test(error.message)) throw error; }
      return {};
    }
    throw new Error(`herdr-core: unsupported pane command ${command}`);
  }, {
    async launch({ parent, sessionId, cwd, argv }) {
      const pane = await paneOf(parent);
      if (pane) {
        const { terminal } = await app('do', 'pane.split', JSON.stringify({ direction: 'right', pane, argv }));
        if (!terminal) throw new Error('herdr-app: pane.split returned no terminal');
        await hc('label', terminal, `${VIEWER}=viewer`, `${SESSION}=${sessionId}`);
        return terminal;
      }
      const { labels = {} } = await hc('get', parent);
      const placement = ['herdr.space', 'herdr.tab'].filter(key => labels[key] !== undefined)
        .flatMap(key => ['--label', `${key}=${labels[key]}`]);
      const reply = await hc('run', '--bg', '--no-parent', '--outlive-parent', '--rm', '--cwd', cwd, ...placement,
        '--label', `${VIEWER}=viewer`, '--label', `${SESSION}=${sessionId}`, '--', ...argv);
      return reply.address ?? reply.terminal?.address;
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
