#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Single browser daemon: all page commands go through one daemon that holds
// a single CDP WebSocket connection to Chrome. Chrome's "Allow debugging"
// modal fires once per daemon (= once per Chrome session). Daemon lives
// until Chrome disconnects or "cdp stop" is called.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync, writeSync, closeSync, statSync, rmdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { spawn, spawnSync, execFileSync } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const DAEMON_CONNECT_RETRIES = 70;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const COMMAND_HISTORY_LIMIT = 50;
const HTML_OUTPUT_LIMIT = 20000;
const NET_ENTRY_LIMIT = 40;
const METADATA_CACHE_TTL_MS = 1500;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
// Single browser-level daemon socket (one per Chrome session)
const BROWSER_SOCK = IS_WINDOWS
  ? `\\\\.\\pipe\\cdp-browser`
  : resolve(RUNTIME_DIR, 'cdp-browser.sock');
const DAEMON_PID_FILE = resolve(RUNTIME_DIR, 'cdp-browser.pid');
const SPAWN_LOCK_DIR = resolve(RUNTIME_DIR, 'cdp-spawn.lock');
const SOCKET_SELF_CHECK_MS = 5000;
const CHROME_LAUNCH_WAIT_MS = 15000;
const LOG_FILE = resolve(RUNTIME_DIR, 'cdp.log');

// Append-only log for the CLI and the daemon (both write to the same file,
// tagged with the process role). Useful when a command silently fails or the
// daemon dies: everything leading up to it is on disk.
function log(role, ...parts) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${role} ${parts.join(' ')}\n`);
  } catch {}
}

function devToolsPortCandidates() {
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
  const flatpakBrowsers = [
    ['org.chromium.Chromium', 'chromium'],
    ['com.google.Chrome', 'google-chrome'],
    ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
    ['com.microsoft.Edge', 'microsoft-edge'],
    ['com.vivaldi.Vivaldi', 'vivaldi'],
  ];
  return [
    process.env.CDP_PORT_FILE,
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    ...flatpakBrowsers.flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
    // Windows: %LOCALAPPDATA%/<name>/User Data/DevToolsActivePort
    ...(IS_WINDOWS ? ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft/Edge'].flatMap(b => {
      const base = process.env.LOCALAPPDATA || resolve(home, 'AppData/Local');
      return [
        resolve(base, b, 'User Data/DevToolsActivePort'),
        resolve(base, b, 'User Data/Default/DevToolsActivePort'),
      ];
    }) : []),
  ].filter(Boolean);
}

function findDevToolsActivePortFile() {
  return devToolsPortCandidates().find(p => existsSync(p)) || null;
}

// True when the file exists AND something is actually listening on its port
// (a stale DevToolsActivePort from a dead Chrome must not be trusted).
async function devToolsPortLive(filePath) {
  if (!filePath) return false;
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    const port = Number.parseInt(lines[0], 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
    return await new Promise((resolvePort) => {
      const s = net.connect(port, process.env.CDP_HOST || '127.0.0.1');
      s.setTimeout(300, () => { s.destroy(); resolvePort(false); });
      s.on('connect', () => { s.destroy(); resolvePort(true); });
      s.on('error', () => resolvePort(false));
    });
  } catch { return false; }
}

async function waitForDevToolsActivePort(timeoutMs = CHROME_LAUNCH_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = findDevToolsActivePortFile();
    if (f && await devToolsPortLive(f)) return f;
    await sleep(250);
  }
  return null;
}

// Cross-platform check for a RUNNING MAIN browser process (exact process-name
// match, not substring: Chrome's helper processes are named "Google Chrome
// Helper" and must NOT count as "the browser is running", or the auto-launch
// path would never trigger right after Chrome quits).
function isBrowserProcessRunning() {
  const targets = IS_WINDOWS
    ? ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe']
    : ['Google Chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave', 'brave-browser', 'microsoft-edge', 'vivaldi'];
  for (const t of targets) {
    try {
      const out = IS_WINDOWS
        ? execFileSync('tasklist', ['/FI', `IMAGENAME eq ${t}`], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        : execFileSync('pgrep', ['-x', t], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      if (out.trim()) return true;
    } catch {}
  }
  return false;
}

// Last-used profile from Chrome's Local State, so a relaunch skips the profile
// picker and lands in the user's normal session (browser-harness trick).
function resolveLastUsedProfile(baseDir) {
  if (!baseDir) return null;
  try {
    const state = JSON.parse(readFileSync(resolve(baseDir, 'Local State'), 'utf8'));
    const last = (state.profile || {}).last_used || 'Default';
    if (typeof last === 'string' && existsSync(resolve(baseDir, last))) return last;
  } catch {}
  return null;
}

function defaultProfileBase() {
  const home = homedir();
  if (IS_WINDOWS) return resolve(process.env.LOCALAPPDATA || resolve(home, 'AppData/Local'), 'Google/Chrome/User Data');
  if (process.platform === 'darwin') return resolve(home, 'Library/Application Support/Google/Chrome');
  return resolve(home, '.config/google-chrome');
}

// Launch args for Chrome. Chrome 136+ IGNORES --remote-debugging-port on the
// default profile (security change); the only reliable path there is Chrome's
// own "Allow remote debugging" switch, remembered in Local State
// (devtools.remote_debugging.user-enabled) and honored on every start — so we
// pass NO debug flag on the default profile (browser-harness does the same).
// The flag still works with a custom --user-data-dir (Chrome for Testing,
// isolated instances), so it is kept for that case.
function chromeLaunchArgs() {
  const dataDir = (process.env.CDP_USER_DATA_DIR || '').trim();
  const args = [];
  if (dataDir) {
    args.push('--remote-debugging-port=0', `--user-data-dir=${dataDir}`);
  } else {
    const last = resolveLastUsedProfile(defaultProfileBase());
    if (last) args.push(`--profile-directory=${last}`);
  }
  return args;
}

// chrome://inspect's "Allow remote debugging" switch, as recorded by Chrome in
// Local State (devtools.remote_debugging.user-enabled). True -> Chrome will
// open its DevTools port automatically on the next start.
function localStateUserEnabled(baseDir = defaultProfileBase()) {
  if (!baseDir) return null;
  try {
    const state = JSON.parse(readFileSync(resolve(baseDir, 'Local State'), 'utf8'));
    const enabled = (state.devtools || {}).remote_debugging?.['user-enabled'];
    return enabled === true ? true : enabled === false ? false : null;
  } catch { return null; }
}

// Launch the user's Chrome with remote debugging on. Returns true when the
// launch command was dispatched (not when Chrome is actually ready).
function launchChrome() {
  for (const key of ['CDP_CHROME_PATH', 'CHROME_PATH']) {
    const raw = (process.env[key] || '').trim();
    if (raw) {
      const bin = resolve(raw);
      if (existsSync(bin)) {
        try {
          spawn(bin, chromeLaunchArgs(), { detached: true, stdio: 'ignore' }).unref();
          log('cli', 'launchChrome: env-path', bin, chromeLaunchArgs().join(' '));
          return true;
        } catch { continue; }
      }
    }
  }
  if (IS_WINDOWS) {
    try {
      spawn('cmd', ['/c', 'start', '', 'chrome', ...chromeLaunchArgs()], { detached: true, stdio: 'ignore' }).unref();
      log('cli', 'launchChrome: windows start', chromeLaunchArgs().join(' '));
      return true;
    } catch { return false; }
  }
  if (process.platform === 'darwin') {
    const app = process.env.CDP_CHROME_APP || 'Google Chrome';
    try {
      const r = spawnSync('open', ['-a', app, '--args', ...chromeLaunchArgs()], { timeout: 10000, stdio: 'ignore' });
      log('cli', 'launchChrome: open -a', app, chromeLaunchArgs().join(' '), 'status=', r.status);
      return r.status === 0;
    } catch { return false; }
  }
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge', 'vivaldi']) {
    try {
      const w = spawnSync('which', [cmd], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (w.status === 0) {
        const bin = w.stdout.toString().trim().split('\n')[0];
        if (bin) { spawn(bin, chromeLaunchArgs(), { detached: true, stdio: 'ignore' }).unref(); return true; }
      }
    } catch {}
  }
  return false;
}

// macOS fallback: open a URL in Chrome via AppleScript when CDP is not
// available (Chrome running without remote debugging). Launches Chrome first
// if it is not running, so "open a tab" works without any debugging setup.
function openUrlViaAppleScript(url) {
  try {
    const safe = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Google Chrome"\n  open location "${safe}"\n  activate\nend tell`;
    const r = spawnSync('osascript', ['-e', script], { timeout: 8000, stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; }
}

// Open the remote-debugging permission page in the user's browser.
function openInspectGuide() {
  if (process.env.CDP_SKIP_INSPECT_HINT) return;
  try {
    const url = 'chrome://inspect/#remote-debugging';
    if (process.platform === 'darwin') spawnSync('open', ['-a', process.env.CDP_CHROME_APP || 'Google Chrome', url], { timeout: 5000, stdio: 'ignore' });
    else if (!IS_WINDOWS) spawnSync('xdg-open', [url], { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

const INSPECT_GUIDE_MSG =
  '\n⚠ Chrome is running without remote debugging.\n' +
  '  To enable it: open chrome://inspect/#remote-debugging in Chrome, tick\n' +
  '  "Allow remote debugging", then restart Chrome and rerun this command.\n' +
  '  (The switch is remembered; afterwards cdp works with full CDP.)\n\n';

// Make sure a debugging-enabled Chrome is reachable before the daemon spawns.
// Note: Chrome 136+ refuses --remote-debugging-port on the default profile,
// so the only reliable path is the chrome://inspect "Allow remote debugging"
// switch (one-time, remembered by Chrome). We therefore:
//   1. accept a live DevToolsActivePort if present        -> ok
//   2. otherwise launch Chrome (or just guide if running)
//      with a short window for the launch args to work (Chrome for Testing,
//      older Chromium, --user-data-dir setups still honor them)
//   3. if no port after ~8s, open chrome://inspect and wait up to 60s for
//      the user to tick the switch and let Chrome restart
async function ensureChromeAvailable() {
  const f = findDevToolsActivePortFile();
  const portLive = f && await devToolsPortLive(f);
  log('cli', 'ensureChromeAvailable: portFile=', f, 'portLive=', portLive);
  if (portLive) return true;

  const browserRunning = isBrowserProcessRunning();
  log('cli', 'ensureChromeAvailable: browserRunning=', browserRunning);

  if (browserRunning) {
    // Chrome is up but not debugging: guide immediately and return — the
    // command should never hang waiting for a human.
    openInspectGuide();
    process.stderr.write(INSPECT_GUIDE_MSG);
    return false;
  }

  // Chrome not running: launch it and wait for the DevTools port to appear.
  // With the "Allow remote debugging" switch on (Local State), a plain launch
  // opens the port automatically; without the switch, Chrome 136+ will never
  // open one, so after the cold-start window we guide the user instead.
  const launched = launchChrome();
  log('cli', 'ensureChromeAvailable: launchChrome=', launched);
  if (!launched) {
    openInspectGuide();
    process.stderr.write(INSPECT_GUIDE_MSG);
    return false;
  }
  const ready = !!(await waitForDevToolsActivePort(CHROME_LAUNCH_WAIT_MS));
  log('cli', 'ensureChromeAvailable: launch-wait result=', ready,
      'userEnabled=', localStateUserEnabled());
  if (!ready) {
    openInspectGuide();
    process.stderr.write(INSPECT_GUIDE_MSG);
  }
  return ready;
}

// Reusable blank tab for `open`: about:blank / new-tab pages only; real pages
// (user's tabs) are never touched.
function findReusableTab(pages) {
  if (!Array.isArray(pages)) return null;
  const u = (p) => (p && typeof p.url === 'string' ? p.url : '');
  return pages.find(p =>
    u(p) === 'about:blank' || u(p).startsWith('about:blank#') ||
    u(p).startsWith('chrome://newtab') || u(p).startsWith('edge://newtab') ||
    u(p).startsWith('about:newtab'),
  ) || null;
}

function getWsUrl() {
  const portFile = findDevToolsActivePortFile();
  if (!portFile) throw new Error('No DevToolsActivePort found. Enable remote debugging at chrome://inspect/#remote-debugging');
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  const host = process.env.CDP_HOST || '127.0.0.1';
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parseNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

function parseShotArgs(args) {
  const options = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--selector') {
      const selector = args[++i];
      if (!selector) throw new Error('shot --selector requires a CSS selector');
      options.selector = selector;
      continue;
    }
    if (arg === '--clip') {
      const x = parseNumber(args[++i], 'clip x');
      const y = parseNumber(args[++i], 'clip y');
      const width = parsePositiveNumber(args[++i], 'clip width');
      const height = parsePositiveNumber(args[++i], 'clip height');
      options.clip = { x, y, width, height };
      continue;
    }
    positional.push(arg);
  }

  if (options.selector && options.clip) {
    throw new Error('shot accepts either --selector or --clip, not both');
  }
  if (positional.length > 1) {
    throw new Error('shot accepts at most one output file path');
  }

  return {
    filePath: positional[0] || '',
    options,
  };
}

function parseInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function parsePositiveInteger(value, label) {
  const parsed = parseInteger(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10}KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

function parseInspectArgs(args) {
  const options = { limit: 20, textMax: 700 };
  const positional = [];
  const validSections = new Set(['headings', 'buttons', 'links', 'inputs', 'forms', 'text']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit') {
      options.limit = parsePositiveInteger(args[++i], 'inspect limit');
      continue;
    }
    if (arg === '--text-max') {
      options.textMax = parsePositiveInteger(args[++i], 'inspect text max');
      continue;
    }
    if (arg === '--sections') {
      const sections = splitCsv(args[++i]);
      if (sections.length === 0) throw new Error('inspect --sections requires a comma-separated list');
      for (const section of sections) {
        if (!validSections.has(section)) {
          throw new Error(`Unsupported inspect section: ${section}`);
        }
      }
      options.sections = sections;
      continue;
    }
    if (arg === '--no-text') {
      options.noText = true;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error('inspect accepts at most one selector');
  }
  if (options.noText) {
    options.sections = (options.sections || ['headings', 'buttons', 'links', 'inputs', 'forms'])
      .filter(section => section !== 'text');
  }
  return {
    selector: positional[0] || '',
    options,
  };
}

function parseHtmlArgs(args) {
  const options = { maxChars: HTML_OUTPUT_LIMIT };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--text') {
      options.textOnly = true;
      continue;
    }
    if (arg === '--max-chars') {
      options.maxChars = parsePositiveInteger(args[++i], 'html max chars');
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error('html accepts at most one selector');
  }
  return {
    selector: positional[0] || '',
    options,
  };
}

function parseNetArgs(args) {
  const options = { limit: NET_ENTRY_LIMIT };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit') {
      options.limit = parsePositiveInteger(args[++i], 'net limit');
      continue;
    }
    if (arg === '--type') {
      const type = args[++i];
      if (!type) throw new Error('net --type requires a resource type');
      options.type = type;
      continue;
    }
    if (arg === '--same-origin') {
      options.sameOrigin = true;
      continue;
    }
    throw new Error(`Unknown net option: ${arg}`);
  }

  return options;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl, timeoutMs = 8000) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { this.#ws.close(); } catch {}
        rej(new Error('CDP connect timeout'));
      }, timeoutMs);
      this.#ws.onopen = () => { clearTimeout(timer); res(); };
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject, timer } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
      this.#pending.set(id, { resolve, reject, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function truncateText(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n\n... [truncated ${text.length - maxLen} chars]`;
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function getShotPlan(cdp, sid, options) {
  if (options?.clip) {
    return {
      clip: {
        x: options.clip.x,
        y: options.clip.y,
        width: options.clip.width,
        height: options.clip.height,
        scale: 1,
      },
      scopeDescription: `clipped viewport region at CSS px x=${options.clip.x}, y=${options.clip.y}, width=${options.clip.width}, height=${options.clip.height}`,
      note: 'Clip coordinates use CSS pixels in the current viewport, matching clickxy inputs.',
    };
  }

  if (options?.selector) {
    const expr = `
      (function() {
        const selector = ${JSON.stringify(options.selector)};
        const el = document.querySelector(selector);
        if (!el) return { ok: false, error: 'Element not found: ' + selector };
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return { ok: false, error: 'Element has zero size: ' + selector };
        }
        const x = Math.max(0, rect.left);
        const y = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        const width = right - x;
        const height = bottom - y;
        if (width <= 0 || height <= 0) {
          return {
            ok: false,
            error: 'Element is outside the current viewport: ' + selector + '. Scroll it into view first.'
          };
        }
        return {
          ok: true,
          selector,
          clip: { x, y, width, height, scale: 1 },
          clippedByViewport: width !== rect.width || height !== rect.height,
        };
      })()
    `;
    const raw = await evalStr(cdp, sid, expr);
    const data = JSON.parse(raw);
    if (!data.ok) throw new Error(data.error);
    return {
      clip: data.clip,
      scopeDescription: `element-scoped region for selector ${JSON.stringify(data.selector)}`,
      note: data.clippedByViewport
        ? 'The selected element extended beyond the current viewport, so the screenshot was clipped to the visible portion. Scroll first if you need the whole element.'
        : 'Selector coordinates use CSS pixels from the current viewport, matching clickxy inputs.',
    };
  }

  return {
    clip: null,
    scopeDescription: 'full viewport',
    note: null,
  };
}

async function shotStr(cdp, sid, filePath, targetId, options = {}) {
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const shotPlan = await getShotPlan(cdp, sid, options);
  const captureParams = { format: 'png' };
  if (shotPlan.clip) captureParams.clip = shotPlan.clip;

  const { data } = await cdp.send('Page.captureScreenshot', captureParams, sid);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Capture scope: ${shotPlan.scopeDescription}`);
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  if (shotPlan.note) lines.push(shotPlan.note);
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector, options = {}) {
  const expr = `
    (function() {
      const selector = ${JSON.stringify(selector || '')};
      const root = selector ? document.querySelector(selector) : document.documentElement;
      if (!root) return { ok: false, error: 'Element not found: ' + selector };
      const text = (root.innerText || root.textContent || '').replace(/\\s+/g, ' ').trim();
      const html = root.outerHTML || '';
      return {
        ok: true,
        selector: selector || 'document.documentElement',
        html,
        text,
        truncated: html.length > ${Math.max(1, options.maxChars || HTML_OUTPUT_LIMIT)},
        totalLength: html.length,
      };
    })()
  `;
  const raw = await evalStr(cdp, sid, expr);
  const data = JSON.parse(raw);
  if (!data.ok) throw new Error(data.error);
  if (options.textOnly) {
    const text = truncateText(data.text || '', options.maxChars || HTML_OUTPUT_LIMIT);
    return [
      `HTML scope: ${data.selector}`,
      'Output mode: text',
      text,
    ].join('\n');
  }
  const html = truncateText(data.html, options.maxChars || HTML_OUTPUT_LIMIT);
  if (!data.truncated) return html;
  return [
    `HTML scope: ${data.selector}`,
    `HTML length: ${data.totalLength} chars`,
    html,
  ].join('\n');
}

function formatElementSummary(item) {
  const parts = [`<${item.tag.toLowerCase()}>`];
  if (item.label) parts.push(JSON.stringify(item.label));
  if (item.type) parts.push(`type=${item.type}`);
  if (item.name) parts.push(`name=${item.name}`);
  if (item.placeholder) parts.push(`placeholder=${JSON.stringify(item.placeholder)}`);
  if (item.href) parts.push(`href=${item.href}`);
  return parts.join(' ');
}

async function inspectStr(cdp, sid, selector, options = {}) {
  const expr = `
    (function() {
      const selector = ${JSON.stringify(selector || '')};
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) return { ok: false, error: 'Element not found: ' + selector };

      const MAX_TEXT = ${Math.max(1, options.textMax || 700)};
      const MAX_ITEMS = ${Math.max(1, options.limit || 20)};
      const sections = new Set(${JSON.stringify(options.sections || ['headings', 'buttons', 'links', 'inputs', 'forms', 'text'])});
      const textOf = (el, max = 90) => (el.innerText || el.textContent || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, max);
      const attr = (el, name) => el.getAttribute(name) || '';
      const labelFor = (el) => {
        const aria = attr(el, 'aria-label');
        if (aria) return aria.trim();
        const labelledBy = attr(el, 'aria-labelledby');
        if (labelledBy) {
          const text = labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
          if (text) return text.slice(0, 90);
        }
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label) return textOf(label);
        }
        return textOf(el);
      };
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || '1') > 0;
      };
      const summarize = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          label: labelFor(el),
          type: attr(el, 'type'),
          name: attr(el, 'name'),
          placeholder: attr(el, 'placeholder'),
          href: attr(el, 'href'),
          id: attr(el, 'id'),
          classes: attr(el, 'class').split(/\\s+/).filter(Boolean).slice(0, 4).join('.'),
          disabled: !!el.disabled || attr(el, 'aria-disabled') === 'true',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
        };
      };
      const takeVisible = (query) => [
          ...(root.matches?.(query) ? [root] : []),
          ...Array.from(root.querySelectorAll(query)),
        ]
        .filter((el, idx, list) => list.indexOf(el) === idx)
        .filter(isVisible)
        .slice(0, MAX_ITEMS)
        .map(summarize);
      const active = document.activeElement && document.activeElement !== document.body
        ? summarize(document.activeElement)
        : null;

      return {
        ok: true,
        scopedTo: selector || 'document.body',
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        sections: Array.from(sections),
        active,
        headings: sections.has('headings') ? takeVisible('h1,h2,h3') : [],
        buttons: sections.has('buttons') ? takeVisible('button,[role="button"],input[type="button"],input[type="submit"]') : [],
        links: sections.has('links') ? takeVisible('a[href]') : [],
        inputs: sections.has('inputs') ? takeVisible('input:not([type="button"]):not([type="submit"]),textarea,select') : [],
        forms: sections.has('forms') ? takeVisible('form') : [],
        text: sections.has('text') ? textOf(root, MAX_TEXT) : '',
        counts: {
          buttons: root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]').length,
          links: root.querySelectorAll('a[href]').length,
          inputs: root.querySelectorAll('input:not([type="button"]):not([type="submit"]),textarea,select').length,
          forms: root.querySelectorAll('form').length,
        },
      };
    })()
  `;
  const raw = await evalStr(cdp, sid, expr);
  const data = JSON.parse(raw);
  if (!data.ok) throw new Error(data.error);

  const lines = [
    `Title: ${data.title || '(untitled)'}`,
    `URL: ${data.url}`,
    `Ready state: ${data.readyState}`,
    `Scope: ${data.scopedTo}`,
    `Sections: ${data.sections.join(', ')}`,
  ];
  if (data.active) lines.push(`Focused: ${formatElementSummary(data.active)}`);

  const addSection = (label, items, total) => {
    lines.push('');
    lines.push(`${label} (${items.length}${total > items.length ? ` of ${total}` : ''})`);
    if (items.length === 0) {
      lines.push('  (none visible)');
      return;
    }
    for (const item of items) lines.push(`  - ${formatElementSummary(item)}`);
  };

  if (data.sections.includes('headings')) addSection('Headings', data.headings, data.headings.length);
  if (data.sections.includes('buttons')) addSection('Buttons', data.buttons, data.counts.buttons);
  if (data.sections.includes('links')) addSection('Links', data.links, data.counts.links);
  if (data.sections.includes('inputs')) addSection('Inputs', data.inputs, data.counts.inputs);
  if (data.sections.includes('forms')) addSection('Forms', data.forms, data.counts.forms);
  if (data.text) {
    lines.push('');
    lines.push('Text sample');
    lines.push(data.text);
  }
  return lines.join('\n');
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid, options = {}) {
  const raw = await evalStr(cdp, sid, `JSON.stringify((() => {
    const wantedType = ${JSON.stringify(options.type || '')};
    const sameOriginOnly = ${options.sameOrigin ? 'true' : 'false'};
    const entries = performance.getEntriesByType('resource')
      .map(e => ({
        name: e.name.substring(0, 120),
        type: e.initiatorType || 'other',
        duration: Math.round(e.duration),
        size: e.transferSize || 0,
        sameOrigin: (() => {
          try { return new URL(e.name, location.href).origin === location.origin; } catch { return false; }
        })()
      }))
      .filter(e => !wantedType || e.type === wantedType)
      .filter(e => !sameOriginOnly || e.sameOrigin)
      .sort((a, b) => b.duration - a.duration);
    return {
      total: entries.length,
      entries: entries.slice(0, ${Math.max(1, options.limit || NET_ENTRY_LIMIT)})
    };
  })())`);
  const data = JSON.parse(raw);
  const lines = [];
  if (options.type || options.sameOrigin) {
    const scope = [
      options.type ? `type=${options.type}` : '',
      options.sameOrigin ? 'same-origin only' : '',
    ].filter(Boolean).join(', ');
    lines.push(`Network scope: ${scope}`);
  }
  lines.push(...data.entries.map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ));
  if (data.total > data.entries.length) {
    lines.unshift(`Showing slowest ${data.entries.length} of ${data.total} resource entries`);
    lines.unshift('');
  }
  return lines.join('\n').trim();
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// Resolve a CDP session for a targetId, reusing the two-level attach sessions
// map populated by Target.attachedToTarget events.
//
// - sessions has the id → reuse immediately (common case, ~0ms).
// - id unknown to the page list → fast-fail instead of waiting 500ms for an
//   attach event that will never come (stale/closed target ids).
// - id known but not attached yet → wait briefly for the async two-level
//   attach events to settle (freshly opened tabs), then fall back to a direct
//   Target.attachToTarget for Chrome versions without 'tab' target support.
async function resolveSession({ sessions, isKnownTarget, attach, targetId, waitTries = 10, waitDelayMs = 50, sleepFn = sleep }) {
  if (sessions.has(targetId)) {
    return { sessionId: sessions.get(targetId), attachMs: 0, attachMode: 'reuse' };
  }
  const known = await isKnownTarget(targetId);
  if (!known) {
    throw new Error('No target with given id found — run "cdp list"');
  }
  const started = Date.now();
  for (let i = 0; i < waitTries; i++) {
    await sleepFn(waitDelayMs);
    if (sessions.has(targetId)) {
      return { sessionId: sessions.get(targetId), attachMs: Date.now() - started, attachMode: 'wait' };
    }
  }
  const sessionId = await attach(targetId);
  return { sessionId, attachMs: Date.now() - started, attachMode: 'attach' };
}

// ---------------------------------------------------------------------------
// Browser-level daemon (single WebSocket connection, manages all tab sessions)
// ---------------------------------------------------------------------------

async function runBrowserDaemon() {
  const sp = BROWSER_SOCK;

  // Single-instance guarantee: if another daemon already holds the pid file,
  // exit immediately instead of becoming a second, socket-clobbering daemon.
  const pidLock = acquireDaemonPidLock();
  if (!pidLock.ok) {
    process.stderr.write(
      pidLock.existingPid
        ? `Browser daemon already running (pid ${pidLock.existingPid}); exiting.\n`
        : `Browser daemon already running; exiting.\n`,
    );
    process.exit(0);
  }

  const cdp = new CDP();
  log('daemon', 'starting, pid=', process.pid, 'socket=', sp);
  // Patient connection: Chrome may still be warming up (fresh launch, remote
  // debugging switch just enabled, per-attach permission flow). Retry a few
  // times with a per-attempt timeout before giving up — mirrors browser-harness
  // _PatientCDPClient.
  let connected = false;
  for (let attempt = 1; attempt <= 3 && !connected; attempt++) {
    try {
      await cdp.connect(getWsUrl());
      connected = true;
      log('daemon', `connected to Chrome (attempt ${attempt})`);
    } catch (e) {
      log('daemon', `connect attempt ${attempt} FAILED:`, e.message);
      if (attempt < 3) await sleep(2000);
    }
  }
  if (!connected) {
    releaseDaemonPidLock();
    process.stderr.write('Browser daemon: cannot connect to Chrome\n');
    process.exit(1);
  }

  // sessions: targetId → sessionId
  // Populated via Target.attachedToTarget events (from setAutoAttach) + fallback attachToTarget
  const sessions = new Map();
  const startedAt = Date.now();
  const commandHistory = [];
  const metadataCache = {
    pages: { value: null, cachedAt: 0, hits: 0, misses: 0, refreshes: 0 },
    targetIds: new Map(),
  };

  function clearTargetResolutionCache() {
    metadataCache.targetIds.clear();
  }

  function cachePages(pages, reason = 'refresh') {
    metadataCache.pages.value = pages;
    metadataCache.pages.cachedAt = Date.now();
    metadataCache.pages.refreshes++;
    if (reason !== 'reuse') clearTargetResolutionCache();
    return pages;
  }

  function getCachedPages() {
    const ageMs = Date.now() - metadataCache.pages.cachedAt;
    if (metadataCache.pages.value && ageMs <= METADATA_CACHE_TTL_MS) {
      metadataCache.pages.hits++;
      return metadataCache.pages.value;
    }
    metadataCache.pages.misses++;
    return null;
  }

  async function getPagesCached(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = getCachedPages();
      if (cached) return { pages: cached, cacheStatus: 'hit', cacheAgeMs: Date.now() - metadataCache.pages.cachedAt };
    }
    const pages = await getPages(cdp);
    cachePages(pages);
    return { pages, cacheStatus: forceRefresh ? 'forced-refresh' : 'refresh', cacheAgeMs: 0 };
  }

  function rememberResolvedTarget(prefix, targetId) {
    metadataCache.targetIds.set(prefix.toUpperCase(), { targetId, cachedAt: Date.now() });
  }

  function getResolvedTarget(prefix) {
    const entry = metadataCache.targetIds.get(prefix.toUpperCase());
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > METADATA_CACHE_TTL_MS) {
      metadataCache.targetIds.delete(prefix.toUpperCase());
      return null;
    }
    return entry.targetId;
  }

  async function resolveTargetPrefix(prefix) {
    const started = Date.now();
    const cachedTargetId = getResolvedTarget(prefix);
    if (cachedTargetId) {
      return {
        targetId: cachedTargetId,
        pages: metadataCache.pages.value || [],
        trace: {
          resolveMs: Date.now() - started,
          pageListMs: 0,
          pageCacheStatus: 'target-hit',
        },
      };
    }

    const firstLookupStarted = Date.now();
    let pageSnapshot = await getPagesCached();
    let pages = pageSnapshot.pages;
    let targetId;
    try {
      targetId = resolvePrefix(prefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
    } catch (error) {
      const message = String(error?.message || '');
      if (!/No target matching prefix/.test(message)) throw error;
      pageSnapshot = await getPagesCached(true);
      pages = pageSnapshot.pages;
      targetId = resolvePrefix(prefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
    }
    rememberResolvedTarget(prefix, targetId);
    return {
      targetId,
      pages,
      trace: {
        resolveMs: Date.now() - started,
        pageListMs: Date.now() - firstLookupStarted,
        pageCacheStatus: pageSnapshot.cacheStatus,
      },
    };
  }

  function recordCommand(entry) {
    commandHistory.push(entry);
    if (commandHistory.length > COMMAND_HISTORY_LIMIT) commandHistory.shift();
  }

  async function statsStr() {
    const pageSnapshot = await getPagesCached().catch(() => ({ pages: [], cacheStatus: 'error', cacheAgeMs: 0 }));
    const pages = pageSnapshot.pages;
    const slowest = [...commandHistory]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5);
    const recent = commandHistory.slice(-10);
    const lastError = [...commandHistory].reverse().find(entry => !entry.ok);
    const lines = [
      `Browser daemon PID: ${process.pid}`,
      `Uptime: ${formatUptime(Date.now() - startedAt)}`,
      `Runtime dir: ${RUNTIME_DIR}`,
      `Socket: ${BROWSER_SOCK}`,
      `Sessions: ${sessions.size}`,
      `Pages: ${pages.length}`,
      `Metadata cache TTL: ${METADATA_CACHE_TTL_MS}ms`,
      `Page cache: ${metadataCache.pages.value ? pageSnapshot.cacheStatus : 'empty'} (hits=${metadataCache.pages.hits}, misses=${metadataCache.pages.misses}, refreshes=${metadataCache.pages.refreshes})`,
      `Resolved target cache entries: ${metadataCache.targetIds.size}`,
      `Recent commands: ${commandHistory.length}/${COMMAND_HISTORY_LIMIT}`,
      `Last error: ${lastError ? `${lastError.cmd}${lastError.targetId ? ` target=${lastError.targetId.slice(0, 8)}` : ''}: ${lastError.error}` : '(none)'}`,
    ];

    const renderEntry = (entry) => {
      const target = entry.targetId ? ` target=${entry.targetId.slice(0, 8)}` : '';
      const status = entry.ok ? 'ok' : 'error';
      const error = entry.error ? ` (${entry.error})` : '';
      const size = entry.resultBytes != null ? ` ${formatBytes(entry.resultBytes)}` : '';
      const setup = entry.setupMs != null ? ` setup=${formatDuration(entry.setupMs)}` : '';
      const body = entry.commandMs != null ? ` body=${formatDuration(entry.commandMs)}` : '';
      const resolve = entry.resolveMs != null ? ` resolve=${formatDuration(entry.resolveMs)}` : '';
      const pageList = entry.pageListMs != null ? ` pages=${formatDuration(entry.pageListMs)}${entry.pageCacheStatus ? `(${entry.pageCacheStatus})` : ''}` : '';
      const attach = entry.attachMs != null ? ` attach=${formatDuration(entry.attachMs)}${entry.attachMode ? `(${entry.attachMode})` : ''}` : '';
      return `  - ${entry.cmd}${target}: ${formatDuration(entry.durationMs)}${size}${resolve}${pageList}${setup}${attach}${body} ${status}${error}`;
    };

    lines.push('');
    lines.push('Slowest recent commands');
    if (slowest.length === 0) lines.push('  (none yet)');
    else for (const entry of slowest) lines.push(renderEntry(entry));

    lines.push('');
    lines.push('Last commands');
    if (recent.length === 0) lines.push('  (none yet)');
    else for (const entry of recent) lines.push(renderEntry(entry));
    return lines.join('\n');
  }

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    log('daemon', 'shutdown');
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    releaseDaemonPidLock();
    cdp.close();
    process.exit(0);
  }

  // Exit if Chrome disconnects
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // sessions: targetId → sessionId, populated by the two-level setAutoAttach below
  // This mirrors exactly what Puppeteer does, which is why chrome-devtools-mcp
  // never triggers the "Allow debugging?" popup.

  // Level 2: when a page is attached from a tab session, store its sessionId
  cdp.onEvent('Target.attachedToTarget', async (params) => {
    const { sessionId, targetInfo } = params;
    if (!sessionId || !targetInfo?.targetId) return;

    if (targetInfo.type === 'tab') {
      // Level 1 fired: a tab target was attached at browser level.
      // Now set up page-level autoAttach on THIS tab's session (Level 2).
      // Pages attached this way don't trigger the Allow popup.
      try {
        await cdp.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{}],
        }, sessionId);
      } catch {}
    } else if (targetInfo.type === 'page') {
      // Level 2 fired: a page was attached from a tab session → store it
      sessions.set(targetInfo.targetId, sessionId);
    }
  });

  // Clean up sessions when targets go away
  cdp.onEvent('Target.targetDestroyed', (params) => {
    sessions.delete(params.targetId);
    clearTargetResolutionCache();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    for (const [tid, sid] of sessions) {
      if (sid === params.sessionId) { sessions.delete(tid); break; }
    }
  });

  // Level 1: browser-level setAutoAttach, excluding page targets.
  // Attach only to 'tab' targets (Chrome's tab wrapper) — same as Puppeteer.
  // Direct browser→page attachment is what triggers the popup; this avoids it.
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'page', exclude: true }, {}],
  });

  // Get or wait for a session for a given targetId.
  async function getSession(targetId) {
    return resolveSession({
      sessions,
      isKnownTarget: async (tid) => {
        const { pages } = await getPagesCached();
        return pages.some((p) => p.targetId === tid);
      },
      attach: async (tid) => {
        const res = await cdp.send('Target.attachToTarget', { targetId: tid, flatten: true });
        sessions.set(tid, res.sessionId);
        return res.sessionId;
      },
      targetId,
    });
  }

  // Handle a command; targetId is required for tab-specific commands
  async function runCommand({ cmd, targetId, args }) {
    const trace = {
      pageCacheStatus: '',
      pageListMs: 0,
      resolveMs: 0,
      setupMs: 0,
      attachMs: 0,
      attachMode: '',
      commandMs: 0,
    };
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pageListStarted = Date.now();
          const { pages, cacheStatus } = await getPagesCached();
          trace.pageListMs = Date.now() - pageListStarted;
          trace.pageCacheStatus = cacheStatus;
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pageListStarted = Date.now();
          const { pages, cacheStatus } = await getPagesCached();
          trace.pageListMs = Date.now() - pageListStarted;
          trace.pageCacheStatus = cacheStatus;
          result = JSON.stringify(pages);
          break;
        }
        case 'stats': {
          result = await statsStr();
          break;
        }
        case 'resolve_target': {
          const targetPrefix = args[0];
          if (!targetPrefix) return { ok: false, error: 'target prefix required', trace };
          const resolved = await resolveTargetPrefix(targetPrefix);
          trace.resolveMs = resolved.trace.resolveMs;
          trace.pageListMs = resolved.trace.pageListMs;
          trace.pageCacheStatus = resolved.trace.pageCacheStatus;
          result = JSON.stringify({ targetId: resolved.targetId, pages: resolved.pages });
          break;
        }
        case 'open': {
          const url = args[0] || 'about:blank';
          // Reuse a blank tab (about:blank / new-tab page) when one exists —
          // never touch the user's real tabs.
          const { pages: tabsBefore } = await getPagesCached(true);
          const reusable = findReusableTab(tabsBefore);
          let targetId;
          if (reusable) {
            targetId = reusable.targetId;
            await cdp.send('Target.activateTarget', { targetId });
            const { sessionId } = await getSession(targetId);
            await cdp.send('Page.enable', {}, sessionId);
            await cdp.send('Page.navigate', { url }, sessionId);
          } else {
            ({ targetId } = await cdp.send('Target.createTarget', { url }));
          }
          const pageListStarted = Date.now();
          const { pages } = await getPagesCached(true);
          trace.pageListMs = Date.now() - pageListStarted;
          trace.pageCacheStatus = 'forced-refresh';
          if (!pages.some(p => p.targetId === targetId)) {
            pages.push({ targetId, title: url, url });
            cachePages(pages, 'reuse');
          }
          trace.reusedTab = !!reusable;
          result = JSON.stringify({
            targetId,
            pages,
            reusedTab: !!reusable,
            text: reusable
              ? `Reused blank tab: ${targetId}  ${url}`
              : `Opened new tab: ${targetId}  ${url}`,
          });
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: {
          if (!targetId) return { ok: false, error: 'targetId required for this command' };
          let session;
          try {
            const setupStarted = Date.now();
            session = await getSession(targetId);
            trace.setupMs = Date.now() - setupStarted;
            trace.attachMs = session.attachMs;
            trace.attachMode = session.attachMode;
          } catch (e) {
            return { ok: false, error: `Failed to attach to tab: ${e.message}`, trace };
          }
          // Execute command; on session error, evict cache and retry once
          const run = async (sessionId) => {
            const commandStarted = Date.now();
            let commandResult;
            switch (cmd) {
              case 'snap': case 'snapshot':
                commandResult = await snapshotStr(cdp, sessionId, true);
                break;
              case 'inspect': {
                const { selector, options } = parseInspectArgs(args);
                commandResult = await inspectStr(cdp, sessionId, selector, options);
                break;
              }
              case 'eval':
                commandResult = await evalStr(cdp, sessionId, args[0]);
                break;
              case 'shot': case 'screenshot': {
                const { filePath, options } = parseShotArgs(args);
                commandResult = await shotStr(cdp, sessionId, filePath, targetId, options);
                break;
              }
              case 'html': {
                const { selector, options } = parseHtmlArgs(args);
                commandResult = await htmlStr(cdp, sessionId, selector, options);
                break;
              }
              case 'nav': case 'navigate':
                commandResult = await navStr(cdp, sessionId, args[0]);
                break;
              case 'net': case 'network':
                commandResult = await netStr(cdp, sessionId, parseNetArgs(args));
                break;
              case 'click':
                commandResult = await clickStr(cdp, sessionId, args[0]);
                break;
              case 'clickxy':
                commandResult = await clickXyStr(cdp, sessionId, args[0], args[1]);
                break;
              case 'type':
                commandResult = await typeStr(cdp, sessionId, args[0]);
                break;
              case 'loadall':
                commandResult = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500);
                break;
              case 'evalraw':
                commandResult = await evalRawStr(cdp, sessionId, args[0], args[1]);
                break;
              default: throw new Error(`Unknown command: ${cmd}`);
            }
            trace.commandMs = Date.now() - commandStarted;
            return commandResult;
          };
          try {
            result = await run(session.sessionId);
          } catch (e) {
            // If session is stale, re-attach once
            if (/session|Session|detach|Detach/.test(e.message)) {
              sessions.delete(targetId);
              clearTargetResolutionCache();
              session = await getSession(targetId);
              trace.attachMs += session.attachMs;
              trace.attachMode = trace.attachMode ? `${trace.attachMode}+reattach` : 'reattach';
              result = await run(session.sessionId);
            } else {
              throw e;
            }
          }
          break;
        }
      }
      return { ok: true, result: result ?? '', trace };
    } catch (e) {
      return { ok: false, error: e.message, trace };
    }
  }

  async function handleCommand(req) {
    const started = Date.now();
    const res = await runCommand(req);
    if (req.cmd !== 'list_raw') {
      recordCommand({
        cmd: req.cmd,
        targetId: req.targetId,
        durationMs: Date.now() - started,
        resultBytes: Buffer.byteLength(String(res.result || ''), 'utf8'),
        resolveMs: res.trace?.resolveMs ?? 0,
        pageListMs: res.trace?.pageListMs ?? 0,
        pageCacheStatus: res.trace?.pageCacheStatus || '',
        setupMs: res.trace?.setupMs ?? 0,
        attachMs: res.trace?.attachMs ?? 0,
        attachMode: res.trace?.attachMode || '',
        commandMs: res.trace?.commandMs ?? 0,
        ok: !!res.ok,
        error: res.ok ? '' : String(res.error || '').slice(0, 120),
      });
    }
    return res;
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "targetId": "<id>", "args": ["arg1", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        // Ownership check: if this daemon's socket file was unlinked or
        // replaced, it is an orphan — shut down instead of serving commands.
        if (!alive) return;
        if (!socketStillMine(sp, mySocketIno)) { shutdown(); return; }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Browser daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);

  // Orphan self-check: remember the inode of the socket file we created. If
  // the file is ever unlinked or replaced (e.g. a stale daemon outliving its
  // socket, or `cdp stop` racing a reconnect), this daemon is no longer the
  // single server and must exit. Checked per command and on an idle timer so
  // even a quiet orphan does not linger.
  let mySocketIno = null;
  try { mySocketIno = statSync(sp).ino; } catch {}
  const ensureSocketIsMine = () => {
    if (!alive) return;
    if (!socketStillMine(sp, mySocketIno)) shutdown();
  };
  setInterval(ensureSocketIsMine, SOCKET_SELF_CHECK_MS);

}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Single-daemon guarantees: all cdp commands share ONE daemon process.
//   - daemon side: exclusive pid file (second daemon exits immediately),
//     socket-inode self-check (an orphaned daemon whose socket file was
//     unlinked/replaced shuts itself down)
//   - CLI side: atomic mkdir spawn lock (only one CLI spawns; others wait),
//     stale pid/socket cleanup before spawning
// ---------------------------------------------------------------------------

function acquireDaemonPidLock(pidFile = DAEMON_PID_FILE) {
  try {
    const fd = openSync(pidFile, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return { ok: true };
  } catch (error) {
    if (error.code === 'EEXIST') {
      let existingPid = null;
      try { existingPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) || null; } catch {}
      return { ok: false, existingPid };
    }
    return { ok: false, error: error.message };
  }
}

function releaseDaemonPidLock(pidFile = DAEMON_PID_FILE) {
  try { unlinkSync(pidFile); } catch {}
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// True while socketPath still refers to the inode this daemon created.
function socketStillMine(socketPath, expectedIno) {
  if (expectedIno == null) return true;
  try { return statSync(socketPath).ino === expectedIno; } catch { return false; }
}

// mkdir is atomic: exactly one CLI wins the spawner role.
function tryAcquireSpawnLock(lockDir = SPAWN_LOCK_DIR) {
  try { mkdirSync(lockDir, { mode: 0o700 }); return true; } catch { return false; }
}

function releaseSpawnLock(lockDir = SPAWN_LOCK_DIR) {
  try { rmdirSync(lockDir); } catch {}
}

function readDaemonPidFile(pidFile = DAEMON_PID_FILE) {
  try { return Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) || null; } catch { return null; }
}

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartBrowserDaemon() {
  // 1) Fast path: the single daemon's socket is already there.
  try {
    const conn = await connectToSocket(BROWSER_SOCK);
    log('cli', 'daemon: socket fast-path hit');
    return conn;
  } catch {}

  // 2) A daemon process may be alive but its socket file missing (e.g. it was
  //    unlinked while the daemon still runs). Wait briefly for it to recover
  //    before considering spawning a replacement.
  const existingPid = readDaemonPidFile();
  if (existingPid != null && isProcessAlive(existingPid)) {
    for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
      await sleep(DAEMON_CONNECT_DELAY);
      try { return await connectToSocket(BROWSER_SOCK); } catch {}
    }
    throw new Error(
      `Browser daemon (pid ${existingPid}) is running but its socket is unavailable. ` +
      'Run "cdp stop" and retry.',
    );
  }

  // 3) No live daemon: clear stale pid/socket files, then race to spawn with
  //    an atomic mkdir lock so exactly ONE CLI process spawns the daemon and
  //    the others wait for its socket.
  if (existingPid != null) releaseDaemonPidLock();
  if (!IS_WINDOWS) try { unlinkSync(BROWSER_SOCK); } catch {}
  log('cli', 'daemon: stale pid/socket cleared, racing for spawn lock');

  if (!tryAcquireSpawnLock()) {
    // Another CLI is already spawning: wait for its daemon's socket.
    for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
      await sleep(DAEMON_CONNECT_DELAY);
      try { return await connectToSocket(BROWSER_SOCK); } catch {}
    }
    throw new Error('Browser daemon failed to start (another CLI is spawning it, socket never appeared).');
  }
  try {
    // Double-check after winning the lock (the winner may have been this fast
    // path earlier, or another CLI just released it).
    try { return await connectToSocket(BROWSER_SOCK); } catch {}

    // Make sure a debugging-enabled Chrome is reachable before spawning the
    // daemon: auto-launch Chrome if it is not running, or guide the user to
    // tick remote debugging if it is running without it.
    log('cli', 'daemon: won spawn lock, ensuring Chrome availability');
    if (!(await ensureChromeAvailable())) {
      throw new Error(
        'Browser daemon failed to start — no debugging-enabled Chrome is available. ' +
        'See chrome://inspect/#remote-debugging or run "cdp --doctor".',
      );
    }

    // Spawn daemon
    const child = spawn(process.execPath, [process.argv[1], '_browser_daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log('cli', 'daemon: spawned pid=', child.pid);

    // Wait for socket (includes time for user to click Allow)
    for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
      await sleep(DAEMON_CONNECT_DELAY);
      try { return await connectToSocket(BROWSER_SOCK); } catch {}
    }
    throw new Error('Browser daemon failed to start — did you click Allow in Chrome?');
  } finally {
    releaseSpawnLock();
  }
}

// Per-connection state so one socket can carry multiple request/response
// round trips (daemon responses are matched by id, arrival order is not
// guaranteed because the daemon handles requests concurrently).
const connStates = new WeakMap();
function connState(conn) {
  let st = connStates.get(conn);
  if (!st) {
    st = { nextId: 1, pending: new Map(), buf: '', wired: false, closeRequested: false };
    connStates.set(conn, st);
  }
  return st;
}

function wireConn(conn, st) {
  if (st.wired) return;
  st.wired = true;
  const failAll = (message) => {
    for (const [, pending] of st.pending) {
      st.pending.delete(pending.id);
      pending.reject(new Error(message));
    }
  };
  conn.on('data', (chunk) => {
    st.buf += chunk.toString();
    const lines = st.buf.split('\n');
    st.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const pending = st.pending.get(msg.id);
      if (!pending) continue;
      st.pending.delete(msg.id);
      if (pending.closeAfter) st.closeRequested = true;
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg);
    }
    // Close only when every in-flight request has settled AND someone asked
    // for the connection to close — otherwise a close:true response arriving
    // before a close:false one would kill the still-pending request.
    if (st.pending.size === 0 && st.closeRequested) conn.end();
  });
  conn.on('error', (error) => failAll(error.message));
  conn.on('end', () => failAll('Connection closed before response'));
  conn.on('close', () => failAll('Connection closed before response'));
}

function sendCommand(conn, req, { close = true } = {}) {
  const st = connState(conn);
  wireConn(conn, st);
  const id = st.nextId++;
  return new Promise((resolve, reject) => {
    st.pending.set(id, { id, resolve, reject, closeAfter: close });
    conn.write(JSON.stringify({ ...req, id }) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemon
// ---------------------------------------------------------------------------

async function stopDaemon() {
  try {
    const conn = await connectToSocket(BROWSER_SOCK);
    await sendCommand(conn, { cmd: 'stop' });
  } catch {
    if (!IS_WINDOWS) try { unlinkSync(BROWSER_SOCK); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  stats                             Show browser daemon health and recent command timings
  inspect <target> [selector] [--limit <n>] [--sections a,b,c] [--text-max <n>] [--no-text]
                                    Lightweight page summary with optional section/output scoping
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file] [--selector <css> | --clip <x> <y> <w> <h>]
                                    Screenshot (default: full viewport) with optional cheaper scoped capture
  html  <target> [selector] [--text] [--max-chars <n>]
                                    Get scoped HTML or text-only output with bounded size
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target> [--limit <n>] [--type <initiator>] [--same-origin]
                                    Slowest network entries with optional narrower scope
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  open  [url]                       Open a new tab (default: about:blank)
  stop                              Stop the browser daemon

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution by default.
  Use --selector for an element-scoped screenshot or --clip for a CSS-pixel region.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  A single browser daemon runs at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "targetId":"<id>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: stats, inspect, snap, eval, shot, html, nav, net,
  click, clickxy, type, loadall, evalraw, stop. Use evalraw to send arbitrary CDP methods.
  The socket disappears when Chrome disconnects or after "cdp stop".
`;

const NEEDS_TARGET = new Set([
  'inspect','snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  log('cli', 'command:', cmd, args.slice(0, 2).map(a => (a || '').length > 80 ? a.slice(0, 80) + '…' : a).join(' '));

  // Daemon mode (internal)
  if (cmd === '_browser_daemon') { await runBrowserDaemon(); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const conn = await getOrStartBrowserDaemon();
    const response = await sendCommand(conn, { cmd: 'list', args: [] });
    if (!response.ok) { console.error('Error:', response.error); process.exit(1); }
    console.log(response.result);
    return;
  }

  if (cmd === 'stats') {
    const conn = await getOrStartBrowserDaemon();
    const response = await sendCommand(conn, { cmd: 'stats', args: [] });
    if (!response.ok) { console.error('Error:', response.error); process.exit(1); }
    console.log(response.result);
    return;
  }

  // Open new tab — routed through daemon to reuse existing Chrome connection
  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    let conn;
    try {
      conn = await getOrStartBrowserDaemon();
    } catch (e) {
      // CDP unavailable (Chrome running without remote debugging): fall back
      // to the system-level open so "open a tab" always works on macOS.
      if (process.platform === 'darwin' && openUrlViaAppleScript(url)) {
        console.log(`Opened ${url} via system (Chrome remote debugging off; daemon unavailable)`);
        return;
      }
      console.error('Error:', e.message);
      process.exit(1);
    }
    const response = await sendCommand(conn, { cmd: 'open', args: [url] });
    if (!response.ok) { console.error('Error:', response.error); process.exit(1); }
    const { targetId, reusedTab } = JSON.parse(response.result);
    console.log(
      reusedTab
        ? `Reused blank tab: ${targetId.slice(0, 8)}  ${url}`
        : `Opened new tab: ${targetId.slice(0, 8)}  ${url}`,
    );
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemon();
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  const conn = await getOrStartBrowserDaemon();
  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  // One connection, two round trips: resolve the target prefix, then run the
  // command. The daemon's response for resolve_target carries the full id.
  const resolved = await sendCommand(conn, { cmd: 'resolve_target', args: [targetPrefix] }, { close: false });
  if (!resolved.ok) {
    console.error('Error:', resolved.error);
    process.exit(1);
  }
  const targetId = JSON.parse(resolved.result).targetId;

  const response = await sendCommand(conn, { cmd, targetId, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

export {
  CDP,
  resolveSession,
  sendCommand,
  connState,
  acquireDaemonPidLock,
  releaseDaemonPidLock,
  isProcessAlive,
  socketStillMine,
  tryAcquireSpawnLock,
  releaseSpawnLock,
  readDaemonPidFile,
  findDevToolsActivePortFile,
  devToolsPortLive,
  waitForDevToolsActivePort,
  isBrowserProcessRunning,
  resolveLastUsedProfile,
  chromeLaunchArgs,
  launchChrome,
  ensureChromeAvailable,
  findReusableTab,
  localStateUserEnabled,
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
