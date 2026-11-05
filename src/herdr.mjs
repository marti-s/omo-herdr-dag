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

const hcName = title => `omo-dag-${title.replace(/^DAG · /, '').toLowerCase().replace(/[^a-z0-9_-]/g, '')}`.slice(0, 32);

// Answers the pane commands DagPane uses (list, get, close) and adds launch,
// which starts the viewer as its own terminal in the session's space and tab.
export function createHc(env = process.env) {
  const hc = async (command, ...args) => {
    const bin = resolveHcBin(env);
    if (!bin) throw new Error('herdr-core is not available in this session');
    let stdout;
    try { ({ stdout } = await execute(bin, [command, '--json', ...args], { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })); }
    catch (error) { stdout = error.stdout?.trim() ? error.stdout : error.stderr; if (!stdout?.trim().startsWith('{')) throw error; }
    const reply = stdout.trim() ? JSON.parse(stdout) : {};
    if (reply.error) throw new Error(reply.error.kind === 'not_found' ? `pane_not_found: ${reply.error.message}` : reply.error.message);
    return reply;
  };
  return Object.assign(async (command, ...args) => {
    if (command === 'list') {
      const { terminals = [] } = await hc('ls');
      return { panes: terminals.map(terminal => ({ pane_id: terminal.address, tab_id: terminal.where,
        label: terminal.name?.startsWith('omo-dag-') ? `DAG · ${terminal.name.slice(8)}` : terminal.name })) };
    }
    if (command === 'get') {
      const terminal = await hc('get', args[0]);
      if (terminal.state !== 'live') throw new Error(`pane_not_found: ${args[0]} is ${terminal.state}`);
      return terminal;
    }
    if (command === 'close') {
      await hc('kill', args[0]);
      return {};
    }
    throw new Error(`herdr-core: unsupported pane command ${command}`);
  }, {
    async launch({ parent, title, cwd, argv }) {
      const { labels = {} } = await hc('get', parent);
      const placement = Object.entries(labels).filter(([key]) => key === 'where' || key === 'herdr.space')
        .flatMap(([key, value]) => ['--label', `${key}=${value}`]);
      const reply = await hc('run', '--bg', '--name', hcName(title), '--no-parent', '--outlive-parent', '--rm',
        '--cwd', cwd, ...placement, '--', ...argv);
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
