#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency (hand-rolled RFC 6455
// client so the Origin header is controllable — Chrome's "Allow debugging"
// prompt is sticky per origin; without an Origin it re-prompts on every
// connection).
//
// Single browser daemon: all page commands go through one daemon that holds
// a single CDP WebSocket connection to Chrome. Daemon lives until Chrome
// disconnects or "cdp stop" is called.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync, writeSync, closeSync, statSync, rmdirSync, appendFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { spawn, spawnSync, execFileSync } from 'child_process';
import net from 'net';
import { randomBytes, createHash } from 'crypto';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const DAEMON_CONNECT_RETRIES = 100;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const COMMAND_HISTORY_LIMIT = 50;
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const AUDIT_DIR = process.env.CDP_AUDIT_DIR || resolve(homedir(), '.cdp');
const AUDIT_FILE = process.env.CDP_AUDIT_FILE || resolve(AUDIT_DIR, 'audit.jsonl');
// Self-improving knowledge: private layer (~/.cdp/knowledge, auto-sedimented,
// never in git) + repo layer (.cdp-knowledge at repo root, shared seeds).
const KNOWLEDGE_DIR = process.env.CDP_KNOWLEDGE_DIR || resolve(AUDIT_DIR, 'knowledge');
const REPO_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_KNOWLEDGE_DIR = process.env.CDP_REPO_KNOWLEDGE_DIR || resolve(REPO_ROOT_DIR, '.cdp-knowledge');
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
// Marker recording that the harness opened a chrome://inspect tab (so the
// daemon can close it later — borrowed from browser-harness inspect_marker).
const INSPECT_MARKER = resolve(RUNTIME_DIR, 'inspect-opened');
const INSPECT_REOPEN_TTL_MS = 180_000;
// macOS auto-approve of Chrome's per-connection "Allow remote debugging?"
// sheet (browser-harness mac-approve alignment). See macApproveOnce below.
// Timing: Chrome draws the sheet ~0.3s after the connection lands, so the
// first probe fires at 0.4s and the click lands ~1.2-1.5s after daemon start
// (measured live). Six attempts at 300ms gaps cover slow draws/machines.
const MAC_APPROVE_TIMEOUT_MS = 5000;
const MAC_APPROVE_MAX_ATTEMPTS = 6;
const MAC_APPROVE_ATTEMPT_GAP_MS = 300;
const MAC_APPROVE_START_DELAY_MS = 400;

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
  // --remote-allow-origins=* disables Chrome 151's per-connection "Allow
  // debugging" prompt for every CDP client we spawn (the prompt is sticky per
  // connection without it; with it, connections are allowed outright).
  args.push('--remote-allow-origins=*');
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
          const args = chromeLaunchArgs();
          spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
          log('cli', 'launchChrome: env-path', bin, args.join(' '));
          return true;
        } catch { continue; }
      }
    }
  }
  if (IS_WINDOWS) {
    try {
      const wargs = chromeLaunchArgs();
      spawn('cmd', ['/c', 'start', '', 'chrome', ...wargs], { detached: true, stdio: 'ignore' }).unref();
      log('cli', 'launchChrome: windows start', wargs.join(' '));
      return true;
    } catch { return false; }
  }
  if (process.platform === 'darwin') {
    const app = process.env.CDP_CHROME_APP || 'Google Chrome';
    try {
      const margs = chromeLaunchArgs();
      const r = spawnSync('open', ['-a', app, '--args', ...margs], { timeout: 10000, stdio: 'ignore' });
      log('cli', 'launchChrome: open -a', app, margs.join(' '), 'status=', r.status);
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

// macOS: auto-approve Chrome's per-connection "Allow remote debugging?" sheet
// (browser-harness `mac-approve` alignment — src/browser_harness/macos.py).
// System Events walks Chrome's windows -> sheets and presses the Allow button
// WITHOUT activating Chrome. Requires Accessibility permission for the app
// that launched the terminal (iTerm, Terminal, ...) in System Settings >
// Privacy & Security > Accessibility — a one-time grant; after that the CLI
// approves the sheet automatically and the user never clicks Allow.
// Opt out with CDP_NO_MAC_APPROVE=1.
const MAC_APPROVE_SCRIPT = `using terms from application "System Events"
	on clickAllow(nodeRef)
		try
			if (role of nodeRef as text) is "AXButton" and ¬
				((description of nodeRef as text) is "Allow" or ¬
				 (description of nodeRef as text) is "允许") then
				perform action "AXPress" of nodeRef
				return true
			end if
		end try
		try
			repeat with childRef in UI elements of nodeRef
				if my clickAllow(childRef) then return true
			end repeat
		end try
		return false
	end clickAllow
end using terms from

set resultText to "not-found"
set targetProcess to "__CDP_CHROME_PROCESS__"
tell application "System Events"
	if exists process targetProcess then
		tell process targetProcess
			-- exact pass: English and Chinese sheet titles (Chrome is
			-- localized; browser-harness matches only the English title)
			repeat with w in windows
				try
					repeat with s in sheets of w
						if (name of s as text) is "Allow remote debugging?" or ¬
							(name of s as text) is "要允许远程调试吗？" then
							if my clickAllow(s) then
								set resultText to "ready"
								exit repeat
							end if
						end if
					end repeat
				end try
				if resultText is "ready" then exit repeat
			end repeat
			if resultText is "not-found" then
				-- lenient pass: Chrome may reword the sheet (151+)
				repeat with w in windows
					try
						repeat with s in sheets of w
							if (name of s as text) contains "remote debugging" or ¬
								(name of s as text) contains "远程调试" then
								if my clickAllow(s) then
									set resultText to "ready"
									exit repeat
								end if
							end if
						end repeat
					end try
					if resultText is "ready" then exit repeat
				end repeat
			end if
		end tell
	end if
end tell
return resultText`;

const MAC_APPROVE_ACCESSIBILITY_HINT =
  'grant Accessibility to the app running the terminal (iTerm, Terminal, ...) ' +
  'in System Settings > Privacy & Security > Accessibility, then rerun ' +
  '(or run `cdp mac-approve` to check)';

// System Events process names differ from `open -a` app names: Brave.app ->
// "Brave Browser", Edge.app -> "Microsoft Edge". CDP_CHROME_APP (also used by
// launchChrome / openInspectGuide) is mapped here too.
function macApproveScript(app = process.env.CDP_CHROME_APP) {
  const base = String(app || 'Google Chrome').split('/').pop().replace(/\.app$/, '');
  const name = { Brave: 'Brave Browser', Edge: 'Microsoft Edge' }[base] || base;
  const safe = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return MAC_APPROVE_SCRIPT.replace('__CDP_CHROME_PROCESS__', safe);
}

// Pure classifier (unit-tested). Statuses mirror browser-harness mac-approve:
// ready / setup-required / accessibility-required / not-found / error /
// unsupported.
function classifyMacApprove({ platform = process.platform, toggleEnabled, socketUp = false, exitCode = null, timedOut = false, stdout = '', stderr = '' } = {}) {
  if (socketUp) return { status: 'ready', detail: null };
  if (platform !== 'darwin') return { status: 'unsupported', detail: 'macOS only' };
  if (toggleEnabled !== true) {
    return {
      status: 'setup-required',
      detail: 'tick "Allow remote debugging" at chrome://inspect/#remote-debugging first',
    };
  }
  const out = String(stdout || '').trim();
  const err = String(stderr || '').trim();
  if (timedOut) return { status: 'accessibility-required', detail: MAC_APPROVE_ACCESSIBILITY_HINT };
  if (exitCode !== 0) {
    if (/not authorized|assistive/i.test(err)) {
      return { status: 'accessibility-required', detail: MAC_APPROVE_ACCESSIBILITY_HINT };
    }
    return { status: 'error', detail: err || `osascript exited ${exitCode}` };
  }
  if (out === 'ready') return { status: 'ready', detail: null };
  if (out === 'not-found') return { status: 'not-found', detail: 'no "Allow remote debugging?" sheet visible' };
  return { status: 'error', detail: `unexpected osascript output: ${out || '<empty>'}` };
}

// Run the AppleScript via stdin (like browser-harness). Never throws; returns
// { exitCode, timedOut, stdout, stderr }.
function runMacApproveScript() {
  try {
    const r = spawnSync('osascript', [], {
      input: macApproveScript(),
      timeout: MAC_APPROVE_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (r.error) {
      return {
        exitCode: null,
        timedOut: r.error.code === 'ETIMEDOUT',
        stdout: '',
        stderr: String(r.error.message || 'osascript failed'),
      };
    }
    return { exitCode: r.status, timedOut: false, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { exitCode: null, timedOut: false, stdout: '', stderr: String((e && e.message) || e) };
  }
}

// One approve attempt. socketUp short-circuits to ready (daemon already
// connected — nothing to click).
function macApproveOnce({ socketUp = false } = {}) {
  if (socketUp) return { status: 'ready', detail: null };
  const toggle = localStateUserEnabled();
  if (process.platform !== 'darwin' || toggle !== true) {
    return classifyMacApprove({ toggleEnabled: toggle, socketUp });
  }
  const r = runMacApproveScript();
  return classifyMacApprove({
    toggleEnabled: true,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

// Bounded daemon-socket liveness probe (standalone `cdp mac-approve` uses it;
// connectToSocket alone would hang forever when no daemon is running).
function socketUp(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const conn = net.connect(BROWSER_SOCK);
    const t = setTimeout(() => { try { conn.destroy(); } catch {} resolve(false); }, timeoutMs);
    conn.on('connect', () => { clearTimeout(t); try { conn.destroy(); } catch {} resolve(true); });
    conn.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

// Open the remote-debugging permission page in the user's browser, at most
// once per INSPECT_REOPEN_TTL_MS (borrowed from browser-harness
// _open_chrome_inspect_once). The marker also tells the daemon to close the
// tab it opened once the connection is up.
function inspectGuideDue() {
  if (process.env.CDP_SKIP_INSPECT_HINT) return false;
  try {
    if (Date.now() - statSync(INSPECT_MARKER).mtimeMs < INSPECT_REOPEN_TTL_MS) return false;
  } catch {}
  return true;
}

function markInspectOpened() {
  try { writeFileSync(INSPECT_MARKER, String(Date.now())); } catch {}
}

function openInspectGuide() {
  if (!inspectGuideDue()) return;
  try {
    const url = 'chrome://inspect/#remote-debugging';
    let ok = false;
    if (process.platform === 'darwin') {
      const app = process.env.CDP_CHROME_APP || 'Google Chrome';
      ok = spawnSync('open', ['-a', app, url], { timeout: 5000, stdio: 'ignore' }).status === 0;
    }
    else if (!IS_WINDOWS) {
      ok = spawnSync('xdg-open', [url], { timeout: 5000, stdio: 'ignore' }).status === 0;
    }
    if (ok) markInspectOpened();
  } catch {}
}

function inspectGuideMsg() {
  if (localStateUserEnabled() === true) {
    return (
      '\n⚠ Chrome debugging is on but the CDP connection was rejected.\n' +
      '  The "Allow remote debugging" switch is already ticked.\n' +
      '  If Chrome did not show an "Allow debugging" popup, untick and re-tick\n' +
      '  the switch, then restart Chrome and rerun this command.\n' +
      '  (Chrome shows ONE "Allow debugging" popup per connection — expect it\n' +
      '   on the next run; it is normal, not a re-ask.)\n\n'
    );
  }
  return (
    '\n⚠ Chrome is running without remote debugging.\n' +
    '  To enable it: open chrome://inspect/#remote-debugging in Chrome, tick\n' +
    '  "Allow remote debugging", then restart Chrome and rerun this command.\n' +
    '  (Chrome shows ONE "Allow debugging" popup when cdp connects — expected.)\n\n'
  );
}

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
    process.stderr.write(inspectGuideMsg());
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
    process.stderr.write(inspectGuideMsg());
    return false;
  }
  const ready = !!(await waitForDevToolsActivePort(CHROME_LAUNCH_WAIT_MS));
  log('cli', 'ensureChromeAvailable: launch-wait result=', ready,
      'userEnabled=', localStateUserEnabled());
  if (!ready) {
    openInspectGuide();
    process.stderr.write(inspectGuideMsg());
  }
  return ready;
}

// Close chrome://inspect tabs this tool opened (marked by INSPECT_MARKER) —
// borrowed from browser-harness _close_inspect_tabs. Tabs the user opened
// themselves are never touched (no marker -> no cleanup).
async function closeInspectTabs(cdp) {
  try {
    if (!existsSync(INSPECT_MARKER)) return;
    const { targetInfos } = await cdp.send('Target.getTargets');
    let closed = 0;
    for (const t of targetInfos) {
      if (t.type === 'page' && (t.url || '').startsWith('chrome://inspect')) {
        try { await cdp.send('Target.closeTarget', { targetId: t.targetId }); closed++; } catch {}
      }
    }
    unlinkSync(INSPECT_MARKER);
    if (closed) log('daemon', `closed ${closed} leftover chrome://inspect tab(s)`);
  } catch (e) {
    log('daemon', 'closeInspectTabs:', e.message);
  }
}

// Reusable blank tab for `open`: about:blank / new-tab pages only; real pages
// (user's tabs) are never touched.
function findReusableTab(pages) {
  if (!Array.isArray(pages)) return null;
  const u = (p) => (p && typeof p.url === 'string' ? p.url : '');
  return pages.find(p =>
    u(p) === 'about:blank' || u(p).startsWith('about:blank#') ||
    u(p).startsWith('chrome://newtab') || u(p).startsWith('edge://newtab')
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

// Minimal RFC 6455 WebSocket client (zero-dep). Node's built-in WebSocket
// cannot set request headers, and Chrome 151 shows the "Allow debugging"
// prompt for EVERY anonymous-origin connection. A fixed Origin header makes
// the Allow grant sticky per origin, so the prompt fires once per Chrome
// session instead of once per daemon restart.
// Protocol limits (fine for CDP): no fragmentation reassembly, binary frames
// ignored, no auto-ping. Close frames are echoed per 5.5.1.
// Chrome 403s any Origin header without --remote-allow-origins; anonymous
// connections get the Allow prompt instead. Keep Origin unset (per-connection
// prompt is governed by the daemon staying alive, not by the header).
// const WS_ORIGIN = 'http://localhost';

function wsConnect(wsUrl, { origin, timeoutMs = 10000 } = {}) {
  const u = new URL(wsUrl);
  const ws = { onopen: null, onerror: null, onclose: null, onmessage: null, readyState: 0 };
  const key = randomBytes(16).toString('base64');
  const req = [
    `GET ${(u.pathname || '/') + (u.search || '')} HTTP/1.1`,
    `Host: ${u.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(origin ? [`Origin: ${origin}`] : []),
    '', '',
  ].join('\r\n');
  const sock = net.createConnection({ host: u.hostname, port: Number(u.port) || 80 });
  let buf = Buffer.alloc(0);
  let handshaken = false;
  const timer = setTimeout(() => {
    try { sock.destroy(); } catch {}
    ws.onerror?.({ message: 'CDP connect timeout' });
  }, timeoutMs);
  const sendFrame = (opcode, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = randomBytes(4);
    const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
    let header;
    if (data.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    sock.write(Buffer.concat([header, mask, masked]));
  };
  ws.send = (data) => { if (ws.readyState === 1) sendFrame(0x1, String(data)); };
  ws.close = () => {
    if (ws.readyState === 1) {
      ws.readyState = 2;
      try { sendFrame(0x8, Buffer.alloc(0)); } catch {}
      setTimeout(() => { try { sock.destroy(); } catch {} }, 50);
    }
  };
  sock.on('connect', () => sock.write(req));
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshaken) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString('latin1');
      buf = buf.slice(idx + 4);
      const statusLine = head.split('\r\n')[0];
      const expect = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const accept = head.split('\r\n').find(l => l.toLowerCase().startsWith('sec-websocket-accept:'));
      if (!statusLine.includes(' 101 ') || !accept || accept.split(':')[1].trim() !== expect) {
        clearTimeout(timer);
        ws.onerror?.({ message: `handshake failed: ${statusLine}` });
        try { sock.destroy(); } catch {}
        return;
      }
      handshaken = true;
      clearTimeout(timer);
      ws.readyState = 1;
      ws.onopen?.();
    }
    while (handshaken && buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) break;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const m = buf.slice(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]));
      }
      buf = buf.slice(off + maskLen + len);
      if (opcode === 0x8) { // close: echo a close frame (RFC 6455 5.5.1), then end
        try { sendFrame(0x8, payload); } catch {}
        ws.readyState = 3;
        ws.onclose?.();
        try { sock.end(); } catch {}
        return;
      } else if (opcode === 0x9) { // ping -> pong
        sendFrame(0xA, payload);
      } else if (opcode === 0x1 || opcode === 0x0) { // text / continuation
        ws.onmessage?.({ data: payload.toString('utf8') });
      }
    }
  });
  sock.on('error', (e) => { if (!handshaken) { clearTimeout(timer); ws.onerror?.({ message: e.message }); } });
  sock.on('close', () => {
    if (ws.readyState !== 3) { ws.readyState = 3; ws.onclose?.(); }
  });
  return ws;
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
      this.#ws = wsConnect(wsUrl, { timeoutMs });
      const timer = setTimeout(() => {
        try { this.#ws.close(); } catch {}
        rej(new Error('CDP connect timeout'));
      }, timeoutMs);
      const done = () => clearTimeout(timer);
      this.#ws.onopen = () => { done(); res(); };
      this.#ws.onerror = (e) => { done(); rej(new Error('WebSocket error: ' + (e.message || e.type))); };
      this.#ws.onclose = () => { done(); this.#closeHandlers.forEach(h => h()); };
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

// One definition of "internal page" for getPages filtering and
// ensure-real-tab (they must agree on what is a real tab).
const INTERNAL_URL_PREFIXES = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];
const isInternalUrl = (u) => INTERNAL_URL_PREFIXES.some((pre) => u.startsWith(pre));

async function getPages(cdp, { includeInternal = false } = {}) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && (includeInternal || !isInternalUrl(t.url)));
}

// Cross-origin (OOPIF) iframes are independent CDP targets (type=iframe).
// Fresh enumeration every call — iframes appear/disappear dynamically and
// must never come from the TTL page cache.
async function getIframes(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos
    .filter(t => t.type === 'iframe')
    .map(t => ({ targetId: t.targetId, url: t.url || '', title: t.title || '' }));
}

function formatPageList(pages, currentTargetId) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    const mark = p.targetId === currentTargetId ? '  *' : '';
    return `${id}  ${title}  ${p.url}${mark}`;
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

function parseWaitArgs(args) {
  let selector = null;
  let timeout = 10000;
  let visible = false;
  let load = false;
  let networkIdle = false;
  let idleMs = 500;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--load') load = true;
    else if (a === '--network-idle') networkIdle = true;
    else if (a === '--visible') visible = true;
    else if (a === '--idle') idleMs = parsePositiveInteger(args[++i], 'idle');
    else if (a === '--timeout') timeout = parsePositiveInteger(args[++i], 'timeout');
    else if (!selector) selector = a; // first non-flag arg is the selector
    else throw new Error(`Unknown wait option: ${a}`);
  }
  const modes = [load, networkIdle].filter(Boolean).length;
  if (modes > 1) throw new Error('wait: --load and --network-idle are mutually exclusive');
  if (load || networkIdle) {
    if (selector) throw new Error(`wait: ${load ? '--load' : '--network-idle'} cannot be combined with a selector`);
    if (visible) throw new Error('wait: --visible is only for element waits');
  } else if (!selector) {
    throw new Error('wait: selector required (or use --load / --network-idle)');
  }
  return { selector, timeout, visible, load, networkIdle, idleMs };
}

// BH helpers.py press_key alignment: key → {vk, code, text}
// Modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift.
const PRESS_KEYS = {
  Enter: { vk: 13, code: 'Enter', text: '\r' },
  Tab: { vk: 9, code: 'Tab', text: '\t' },
  Backspace: { vk: 8, code: 'Backspace', text: '' },
  Escape: { vk: 27, code: 'Escape', text: '' },
  Delete: { vk: 46, code: 'Delete', text: '' },
  ' ': { vk: 32, code: 'Space', text: ' ' },
  ArrowLeft: { vk: 37, code: 'ArrowLeft', text: '' },
  ArrowUp: { vk: 38, code: 'ArrowUp', text: '' },
  ArrowRight: { vk: 39, code: 'ArrowRight', text: '' },
  ArrowDown: { vk: 40, code: 'ArrowDown', text: '' },
  Home: { vk: 36, code: 'Home', text: '' },
  End: { vk: 35, code: 'End', text: '' },
  PageUp: { vk: 33, code: 'PageUp', text: '' },
  PageDown: { vk: 34, code: 'PageDown', text: '' },
};

async function pressStr(cdp, sid, args) {
  const key = args[0];
  if (!key) throw new Error('press: key required (e.g. Enter, Tab, "a", " ")');
  const modFlags = { ctrl: 2, shift: 8, alt: 1, meta: 4 };
  let modifiers = 0;
  for (const [flag, bit] of Object.entries(modFlags)) {
    if (args.includes(`--${flag}`)) modifiers |= bit;
  }
  const spec = PRESS_KEYS[key] ?? (key.length === 1 ? { vk: key.charCodeAt(0), code: key, text: key } : null); // BH uses ord(key[0])
  if (!spec) throw new Error(`press: unsupported key "${key}" (single char or one of: ${Object.keys(PRESS_KEYS).join(', ')})`);

  const base = { key, code: spec.code, modifiers, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
  const shortcutMods = modifiers & (1 | 2 | 4); // Alt/Ctrl/Meta turn single keys into shortcuts
  const printable = key.length === 1 && !!spec.text && !shortcutMods;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(printable || !spec.text ? {} : { text: spec.text }) }, sid);
  if (printable) {
    // NB: text lives on spec, not base — destructuring it from base yields
    // undefined, and JSON.stringify drops undefined fields, so Chrome gets a
    // text-less char event (accepted, but inserts nothing).
    const { text, ...baseNoText } = { text: spec.text, ...base };
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text, ...baseNoText }, sid);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);
  return JSON.stringify({ key, modifiers });
}

async function jsEvalRaw(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  return result.result.value;
}

// BH helpers.py fill_input alignment: focus -> clear (select-all + Backspace) ->
// per-char real key events -> synthetic input+change so frameworks (React
// controlled, Vue v-model) see the update. Input.insertText (type) bypasses
// framework listeners; real key events plus the synthetic pair do not.
async function fillStr(cdp, sid, args) {
  const selector = args[0];
  if (!selector) throw new Error('fill: selector required (e.g. #email)');
  let clearFirst = true;
  let timeout = 0;
  const textTokens = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-clear') clearFirst = false;
    else if (a === '--timeout') timeout = parsePositiveInteger(args[++i], 'timeout');
    else textTokens.push(a);
  }
  const text = textTokens.join(' ');
  if (!text) throw new Error('fill: text required');
  if (timeout > 0) {
    await waitStr(cdp, sid, [selector, '--timeout', String(timeout)]);
  }
  const focused = await jsEvalRaw(cdp, sid, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return true})()`);
  if (!focused) throw new Error(`fill: element not found: ${selector}`);
  if (clearFirst) {
    // JS select() + Backspace. BH dispatches Cmd/Ctrl+A via rawKeyDown, but
    // CDP-synthesized shortcut keys never fire Chrome's select-all edit
    // command (measured: selection stays put even in a foreground tab, and
    // background tabs — our e2e default — never receive edit commands at all).
    // select() is deterministic in both; the Backspace below is still a real
    // key event, so key listeners still fire.
    await jsEvalRaw(cdp, sid, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.select();return true})()`);
    await pressStr(cdp, sid, ['Backspace']);
  }
  for (const ch of text) {
    await pressStr(cdp, sid, [ch]);
  }
  await jsEvalRaw(cdp, sid, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  return JSON.stringify({ chars: text.length, cleared: clearFirst });
}

// BH helpers.py scroll alignment: mouse wheel at viewport CSS-pixel coords.
async function scrollStr(cdp, sid, args) {
  const x = parseInteger(args[0], 'x');
  const y = parseInteger(args[1], 'y');
  let dy = -300;
  let dx = 0;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '--dy') dy = parseInteger(args[++i], 'dy');
    else if (a === '--dx') dx = parseInteger(args[++i], 'dx');
    else throw new Error(`Unknown scroll option: ${a}`);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy }, sid);
  return JSON.stringify({ x, y, deltaX: dx, deltaY: dy });
}

// BH helpers.py upload_file alignment: set files on a file input via CDP.
async function uploadStr(cdp, sid, args) {
  const selector = args[0];
  const path = args[1];
  if (!selector) throw new Error('upload: selector required (file input)');
  if (!path) throw new Error('upload: file path required');
  const doc = await cdp.send('DOM.getDocument', { depth: -1 }, sid);
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, sid);
  if (!q.nodeId) throw new Error(`upload: no element for selector ${selector}`);
  await cdp.send('DOM.setFileInputFiles', { files: [path], nodeId: q.nodeId }, sid);
  return JSON.stringify({ files: [path] });
}

async function waitStr(cdp, sid, args) {
  const { selector, timeout, visible, load, networkIdle, idleMs } = parseWaitArgs(args);
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  if (networkIdle) {
    // Idempotent enable: covers sessions attached before the tracker existed.
    await cdp.send('Network.enable', {}, sid).catch(() => {});
    // Never use a throwaway tracker: events update the map entry, so the
    // fallback MUST be stored or requests that start during the wait are
    // invisible (wait would report idle instantly / prematurely).
    let t = cdp.networkTrackers?.get(sid);
    if (!t) { t = { inflight: new Set(), lastActivity: Date.now() }; cdp.networkTrackers.set(sid, t); }
    let found = false;
    let inflightCount = t.inflight.size;
    while (Date.now() < deadline) {
      inflightCount = t.inflight.size;
      const quietMs = Date.now() - t.lastActivity;
      if (inflightCount === 0 && quietMs >= idleMs) { found = true; break; }
      await sleep(50);
    }
    const waitedMs = Date.now() - startedAt;
    return JSON.stringify({ found, waitedMs, inflight: inflightCount, idleMs });
  }

  const expression = load
    ? 'document.readyState'
    : visible
      ? `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;if(typeof e.checkVisibility==='function')return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'})()`
      : `(()=>!!document.querySelector(${JSON.stringify(selector)}))()`;
  const done = load ? (v) => v === 'complete' : (v) => v === true;
  let found = false;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description);
      lastState = r.result.value;
      lastError = undefined;  // a clean poll resets transient failures (SPA nav, busy main thread)
      if (done(lastState)) { found = true; break; }
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }
  const waitedMs = Date.now() - startedAt;
  const extra = load ? { readyState: String(lastState ?? '') } : {};
  if (found) return JSON.stringify({ found: true, waitedMs, ...extra });
  if (lastError) throw new Error(`wait: ${lastError.message}`);
  return JSON.stringify({ found: false, waitedMs, ...extra });
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
// Pure: build the Input.dispatchMouseEvent sequence for one clickxy call.
// A double click is two full press/release cycles (clickCount 1,1,2,2) so the
// page sees real mousedown/mouseup pairs plus dblclick — same as a human.
// (browser-harness sends a single press/release with clickCount=clicks; the
// real sequence is more faithful and still triggers dblclick.)
function clickXyEvents(x, y, button, clicks) {
  const evts = [{ type: 'mouseMoved', x, y, button, clickCount: 0, modifiers: 0 }];
  for (let i = 1; i <= clicks; i++) {
    evts.push({ type: 'mousePressed', x, y, button, clickCount: i, modifiers: 0 });
    evts.push({ type: 'mouseReleased', x, y, button, clickCount: i, modifiers: 0 });
  }
  return evts;
}

// Pure: parse `clickxy` command args (after target): x y [--button left|right|middle] [--clicks 1|2]
function parseClickxyArgs(args) {
  if (args.length < 2) throw new Error('x and y required (CSS pixels)');
  const x = parseFloat(args[0]);
  const y = parseFloat(args[1]);
  if (isNaN(x) || isNaN(y)) throw new Error('x and y must be numbers (CSS pixels)');
  let button = 'left';
  let clicks = 1;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '--button') {
      button = args[++i];
      if (!['left', 'right', 'middle'].includes(button)) throw new Error(`--button must be left|right|middle (got '${button}')`);
    } else if (a === '--clicks') {
      clicks = parseInt(args[++i], 10);
      if (![1, 2].includes(clicks)) throw new Error(`--clicks must be 1 or 2 (got '${clicks}')`);
    } else {
      throw new Error(`unknown clickxy option: '${a}'`);
    }
  }
  return { x, y, button, clicks };
}

async function clickXyStr(cdp, sid, x, y, button = 'left', clicks = 1) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  for (const evt of clickXyEvents(cx, cy, button, clicks)) {
    await cdp.send('Input.dispatchMouseEvent', evt, sid);
    if (evt.type === 'mousePressed') await sleep(50);
  }
  return `Clicked ${button}${clicks === 2 ? ' (double)' : ''} at CSS (${cx}, ${cy})`;
}

// ---- cdp doctor: environment diagnostics (browser-harness --doctor alignment) ----

function readLogTail(n = 8) {
  try {
    const data = readFileSync(LOG_FILE, 'utf8').trim();
    if (!data) return '(empty)';
    return data.split('\n').slice(-n).join('\n');
  } catch {
    return '(no log file yet)';
  }
}

// ---- self-improving knowledge: site notes (browser-harness domain-skills alignment) ----

// Normalize a URL to a site key: https://www.youtube.com/watch?v=x -> 'youtube'
function siteFromUrl(url) {
  try {
    const host = new URL(url).hostname || '';
    if (!host) return null;
    return host.replace(/^www\./, '').split('.')[0] || null;
  } catch { return null; }
}

// All knowledge files for a site: private layer first, repo layer as fallback.
function knowledgeFiles(site) {
  const out = [];
  for (const [dir, root] of [['private', KNOWLEDGE_DIR], ['repo', REPO_KNOWLEDGE_DIR]]) {
    const d = resolve(root, site);
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const f of names.filter(x => x.endsWith('.md')).sort()) {
      out.push({ dir, site, file: f, path: resolve(d, f) });
    }
  }
  return out;
}

// All sites that have any notes (either layer).
function knowledgeSites() {
  const sites = new Set();
  for (const root of [KNOWLEDGE_DIR, REPO_KNOWLEDGE_DIR]) {
    let names;
    try { names = readdirSync(root); } catch { continue; }
    for (const f of names) {
      try { if (statSync(resolve(root, f)).isDirectory()) sites.add(f); } catch {}
    }
  }
  return [...sites].sort();
}

// Tail of the audit log as parsed entries (malformed lines skipped).
function readAuditEntries(limit = 1000) {
  try {
    return readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Failed commands for one session (the sediment-review trigger).
function reviewFailures(entries, session) {
  return entries.filter(e => e && !e.ok && e.session === session)
    .map(e => ({ ts: e.ts, cmd: e.cmd, error: String(e.error || '').slice(0, 120) }));
}

// Per-host stats: nav counts/failures + knowledge reads (the evaluation report).
function reportStats(entries) {
  const byHost = {};
  for (const e of entries) {
    if (!e || !e.host) continue;
    byHost[e.host] ||= { nav: 0, navFail: 0, knowledgeReads: 0 };
    if (e.cmd === 'nav' || e.cmd === 'navigate') { byHost[e.host].nav += 1; if (!e.ok) byHost[e.host].navFail += 1; }
    if (e.cmd === 'knowledge') byHost[e.host].knowledgeReads += 1;
  }
  return byHost;
}

// Pure: turn collected environment facts into a doctor report (no I/O here).
// Returns { lines, failCount }.
function doctorItems(f) {
  const lines = [];
  let failCount = 0;
  const add = (status, name, detail, hint) => {
    const mark = status === 'ok' ? '[ok]' : status === 'warn' ? '[warn]' : status === 'fail' ? '[FAIL]' : '[info]';
    lines.push(`${mark} ${name}`);
    if (detail) lines.push(`      ${detail}`);
    if (hint) lines.push(`      -> ${hint}`);
    if (status === 'fail') failCount++;
  };

  add('info', `platform: ${f.platform} (node ${f.nodeVersion})`);
  add('info', `runtime dir: ${f.runtimeDir}`);

  // daemon
  if (f.daemonConnected) {
    add('ok', 'daemon', 'running and connected to Chrome');
  } else if (f.daemonPidAlive) {
    add('warn', 'daemon', 'process alive but not connected to Chrome',
      f.socketExists ? 'Chrome may be asking for permission — run `cdp mac-approve` or wait for the next command' : 'socket missing — run `cdp stop` then retry');
  } else if (f.socketExists) {
    add('warn', 'daemon', 'stale socket without a live process',
      'run `cdp stop` (or just run any command — it self-heals)');
  } else {
    add('info', 'daemon', 'not running (starts automatically on the next command)');
  }

  // Chrome / remote debugging
  if (!f.chromeRunning) {
    add('warn', 'chrome', 'Chrome is not running',
      '`cdp` can auto-launch it (CDP_CHROME_PATH / CHROME_PATH override)');
  } else if (!f.portFile) {
    add('fail', 'remote debugging', 'Chrome is running but no DevToolsActivePort file found',
      'enable "Allow remote debugging" at chrome://inspect/#remote-debugging, then restart Chrome');
  } else if (!f.portLive) {
    add('fail', 'remote debugging', `port file ${f.portFile} exists but the port is not responding`,
      'restart Chrome, or check for a conflicting process on that port');
  } else if (!f.switchEnabled) {
    add('fail', 'remote debugging', `port is live but Local State switch 'devtools.remote_debugging.user-enabled' is off`,
      'tick "Allow remote debugging" at chrome://inspect/#remote-debugging (keep it on), then restart Chrome');
  } else {
    add('ok', 'remote debugging', `enabled (port ${f.port}, Local State switch on)`);
  }

  if (f.platform === 'darwin') {
    add('info', 'macOS auto-approve', 'active — your terminal app needs Accessibility permission once (System Settings → Privacy & Security → Accessibility)');
  }

  return { lines, failCount };
}

async function doctorCmd() {
  const f = {};
  f.platform = process.platform;
  f.nodeVersion = process.version;
  f.runtimeDir = RUNTIME_DIR;

  // daemon facts (read-only; ping does not spawn anything)
  const pid = readDaemonPidFile();
  f.daemonPidAlive = pid != null && isProcessAlive(pid);
  f.socketExists = existsSync(BROWSER_SOCK);
  f.daemonConnected = false;
  if (f.socketExists) {
    try {
      const conn = await connectToSocket(BROWSER_SOCK);
      // Short probe: a hung daemon must not stall `doctor` for 60s.
      const r = await Promise.race([
        sendCommand(conn, { cmd: 'ping' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 2000)),
      ]);
      f.daemonConnected = JSON.parse(r.result).connected === true;
      conn.end();
    } catch {}
  }

  // chrome facts
  f.chromeRunning = isBrowserProcessRunning();
  f.portFile = findDevToolsActivePortFile() || null;
  f.portLive = f.portFile ? await devToolsPortLive(f.portFile) : false;
  f.port = null;
  f.switchEnabled = false;
  if (f.portFile) {
    try { f.port = readFileSync(f.portFile, 'utf8').trim().split('\n')[0]; } catch {}
  }
  try { f.switchEnabled = localStateUserEnabled(); } catch {}

  const { lines, failCount } = doctorItems(f);

  const out = ['cdp doctor', '='.repeat(60), ...lines, '='.repeat(60), `log tail (${LOG_FILE}):`, readLogTail()];
  return { text: out.join('\n'), failCount };
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
  // Chrome 151 shows an "Allow debugging" popup per NEW WebSocket connection.
  // The daemon keeps one connection for its whole life; on failure it stays up
  // and retries with exponential backoff (connectOnce below), so the modal is
  // present for the user to click at any time instead of racing a command.
  let chromeConnected = false;
  let connectRetryTimer = null;
  let connectInFlight = false;
  let connectFails = 0;
  async function connectOnce() {
    if (connectInFlight) return false; // serialise: connect+setAutoAttach can
    // outlast a retry interval; a second connect would orphan the first socket.
    connectInFlight = true;
    try {
      await cdp.connect(getWsUrl(), 8000);
      await closeInspectTabs(cdp);
      await cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'page', exclude: true }, {}],
      });
      // chromeConnected set only after the connection is fully usable —
      // otherwise a half-initialised connect leaves the daemon unable to
      // retry (the retry guard checks chromeConnected).
      chromeConnected = true;
      connectFails = 0;
      log('daemon', 'connected to Chrome');
      if (connectRetryTimer) { clearTimeout(connectRetryTimer); connectRetryTimer = null; }
      return true;
    } catch (e) {
      chromeConnected = false;
      connectFails += 1;
      log('daemon', 'connect attempt failed:', e.message);
      // Exponential backoff (10s → 30s → 60s) so a dead/never-approved
      // Chrome doesn't hammer new connections (each one is a new Allow prompt
      // candidate) — while keeping the prompt alive for the user to click.
      const delay = connectFails < 3 ? 10000 : connectFails < 6 ? 30000 : 60000;
      connectRetryTimer = setTimeout(() => { if (!chromeConnected) connectOnce(); }, delay);
      return false;
    } finally {
      connectInFlight = false;
    }
  }
  connectOnce();

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

  async function getPagesCached(forceRefresh = false, opts = {}) {
    if (!forceRefresh) {
      const cached = getCachedPages();
      if (cached) return { pages: cached, cacheStatus: 'hit', cacheAgeMs: Date.now() - metadataCache.pages.cachedAt };
    }
    const pages = await getPages(cdp, opts);
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
      try {
        targetId = resolvePrefix(prefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
      } catch (error2) {
        const message2 = String(error2?.message || '');
        if (!/No target matching prefix/.test(message2)) throw error2;
        // Fallback: cross-origin iframes are CDP targets too (BH
        // iframe_target). Resolve against a fresh iframe enumeration.
        const iframes = await getIframes(cdp);
        targetId = resolvePrefix(prefix, iframes.map(f => f.targetId), 'target', 'Run "cdp iframe".');
      }
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

  function auditEntryCount() {
    try {
      const st = statSync(AUDIT_FILE);
      if (!st || st.size === 0) return 0;
      return readFileSync(AUDIT_FILE).toString().split('\n').filter(Boolean).length;
    } catch { return 0; }
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
      `Audit log: ${AUDIT_FILE} (${auditEntryCount()} entries)`, 
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

  // Exit if Chrome disconnects (but not when a connect attempt merely failed —
  // e.g. the Allow prompt wasn't answered in time; the daemon stays up and
  // retries on the next command).
  cdp.onClose(() => { if (chromeConnected) shutdown(); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // sessions: targetId → sessionId, populated by the two-level setAutoAttach below
  // This mirrors exactly what Puppeteer does, which is why chrome-devtools-mcp
  // never triggers the "Allow debugging?" popup.

  // Network idle tracking (per session), mirroring browser-harness
  // wait_for_network_idle: track in-flight request ids per session so
  // `wait --network-idle` can observe quiet windows. Attach paths enable the
  // Network domain (see below) so events are complete from navigation start —
  // CDP does not replay events that fired before Network.enable.
  const networkTrackers = new Map(); // sessionId -> { inflight:Set, lastActivity:number }
  cdp.networkTrackers = networkTrackers; // exposed to waitStr (module-level fn)
  function ensureNetworkTracker(sessionId, now = Date.now()) {
    let t = networkTrackers.get(sessionId);
    if (!t) { t = { inflight: new Set(), lastActivity: now }; networkTrackers.set(sessionId, t); }
    return t;
  }
  cdp.onEvent('Network.requestWillBeSent', (params, msg) => {
    if (!msg.sessionId) return;
    const t = ensureNetworkTracker(msg.sessionId);
    t.inflight.add(params.requestId);
    t.lastActivity = Date.now();
  });
  cdp.onEvent('Network.loadingFinished', (params, msg) => {
    if (!msg.sessionId) return;
    const t = networkTrackers.get(msg.sessionId);
    if (t) { t.inflight.delete(params.requestId); t.lastActivity = Date.now(); }
  });
  cdp.onEvent('Network.loadingFailed', (params, msg) => {
    if (!msg.sessionId) return;
    const t = networkTrackers.get(msg.sessionId);
    if (t) { t.inflight.delete(params.requestId); t.lastActivity = Date.now(); }
  });

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
    } else if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
      // Level 2 fired: a page/iframe was attached from a tab session → store
      // it so getSession resolves instantly (no second attach, no 500ms wait).
      sessions.set(targetInfo.targetId, sessionId);
      // Enable Network so idle tracking sees events from the start of any
      // navigation that follows (CDP never replays pre-enable events).
      cdp.send('Network.enable', {}, sessionId).catch(() => {});
      // Page domain is required for Page.javascriptDialogOpening (dialog
      // detection/blocking). Missing it silently breaks `cdp dialog` on tabs
      // that were never `open`ed by us (user-opened tabs, window.open).
      cdp.send('Page.enable', {}, sessionId).catch(() => {});
    }
  });

  // Pending JS dialogs, keyed by targetId (a dialog freezes its page's JS
  // thread; Page.javascriptDialogOpening arrives on the page's session and
  // needs Page.enable at attach). Keyed so two tabs with dialogs don't
  // overwrite each other; only the tab that opened the dialog is blocked.
  const pendingDialogs = new Map(); // targetId -> dialog
  cdp.onEvent('Page.javascriptDialogOpening', (params, msg) => {
    let targetId = null;
    for (const [tid, sid] of sessions) {
      if (sid === msg.sessionId) { targetId = tid; break; }
    }
    pendingDialogs.set(targetId, {
      type: params.type,
      message: params.message,
      hasTouch: !!params.hasTouch,
      defaultPrompt: params.defaultPrompt,
      sessionId: msg.sessionId,
      targetId,
    });
  });
  cdp.onEvent('Page.javascriptDialogClosed', (params, msg) => {
    for (const [tid, d] of pendingDialogs) {
      if (d.sessionId === msg?.sessionId) { pendingDialogs.delete(tid); break; }
    }
  });

  // Clean up sessions when targets go away
  cdp.onEvent('Target.targetDestroyed', (params) => {
    sessions.delete(params.targetId);
    for (const [k, v] of agentSessions) if (v === params.targetId) agentSessions.delete(k);
    clearTargetResolutionCache();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    for (const [tid, sid] of sessions) {
      if (sid === params.sessionId) { sessions.delete(tid); break; }
    }
  });

  // (Level 1 setAutoAttach is issued inside connectOnce above.)

  // Get or wait for a session for a given targetId.
  async function getSession(targetId) {
    return resolveSession({
      sessions,
      isKnownTarget: async (tid) => {
        const { pages } = await getPagesCached();
        if (pages.some((p) => p.targetId === tid)) return true;
        const iframes = await getIframes(cdp);
        return iframes.some((f) => f.targetId === tid);
      },
      attach: async (tid) => {
        const res = await cdp.send('Target.attachToTarget', { targetId: tid, flatten: true });
        sessions.set(tid, res.sessionId);
        cdp.send('Network.enable', {}, res.sessionId).catch(() => {});
        cdp.send('Page.enable', {}, res.sessionId).catch(() => {});
        return res.sessionId;
      },
      targetId,
    });
  }

  // The daemon keeps trying to connect in the background (connectOnce +
  // interval above), so Chrome's Allow prompt stays up. A command just waits
  // for the connection to land — clicking Allow while any command is running
  // lets that same command complete.
  async function ensureChrome() {
    if (chromeConnected) return;
    log('daemon', 'waiting for Chrome connection (click "Allow debugging" in Chrome)');
    const deadline = Date.now() + 60000;
    while (!chromeConnected && Date.now() < deadline) await sleep(500);
    if (!chromeConnected) {
      const up = isBrowserProcessRunning();
      throw new Error(up
        ? 'Chrome connection pending — click "Allow debugging" in Chrome, then run this command again'
        : 'Chrome is not running — start Chrome with remote debugging (or run "cdp open" which launches it), then retry');
    }
    // NB: sessions/trackers are NOT cleared here — a connected-then-disconnected
    // daemon shuts down (cdp.onClose → shutdown), so there is no reconnect path
    // that would need a fresh map. Clearing here would only race the
    // setAutoAttach flood.
  }

  // Handle a command; targetId is required for tab-specific commands
  // Session-scoped current tab (F1-F5): each agent session (CDP_SESSION env or
// --session flag, 'default' when absent) remembers the tab it is working on.
// Set by `open`/`switch`; consumed when a command omits <target>; cleared on
// close/targetDestroyed/attach-failure so stale pointers never linger.
const agentSessions = new Map();

async function runCommand({ cmd, targetId, args, session }) {
    const sid = session || 'default';
    if (cmd !== 'stats' && cmd !== 'stop' && cmd !== 'ping') {  // keep in sync with handleCommand's audit/record skip
      try { await ensureChrome(); }
      catch (e) { return { ok: false, error: e.message }; }
    }
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
        case 'ping': {
          // Instant daemon liveness: Chrome connection state WITHOUT the
          // ensureChrome wait (used by `cdp mac-approve` to distinguish
          // "already connected" from "sheet pending").
          result = JSON.stringify({ connected: chromeConnected });
          break;
        }
        case 'list': {
          const pageListStarted = Date.now();
          const { pages, cacheStatus } = await getPagesCached();
          trace.pageListMs = Date.now() - pageListStarted;
          trace.pageCacheStatus = cacheStatus;
          result = formatPageList(pages, agentSessions.get(sid));
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
        case 'iframe': {
          // BH iframe_target: list all OOPIF iframes, or resolve the first
          // whose URL contains the given substring. The returned targetId
          // works with every page command (eval/click/inspect/...).
          const iframes = await getIframes(cdp);
          const sub = args[0];
          if (!sub) {
            result = JSON.stringify({
              list: iframes.map(f => `${f.targetId.slice(0, 8)}  ${(f.title || '').substring(0, 40)}  ${f.url}`),
            });
          } else {
            const m = iframes.find(f => f.url.includes(sub));
            if (!m) {
              return { ok: false, error: `no iframe matching "${sub}" (${iframes.length} iframe(s) found)`, trace };
            }
            result = JSON.stringify({ targetId: m.targetId, url: m.url, title: m.title });
          }
          break;
        }
        case 'dialog': {
          // L2 dialogs (BH interaction-skills/dialogs.md): query or handle the
          // pending JS dialog. Dialogs freeze the page; commands on that tab
          // are blocked with a hint while one is pending (see default case).
          const action = args[0];
          if (action && action !== 'accept' && action !== 'dismiss') {
            return { ok: false, error: `unknown dialog action: "${action}" (accept|dismiss)`, trace };
          }
          // Pick the dialog for this session's current tab first, else the
          // most recently opened one (multi-tab dialogs are still possible;
          // the picked tab is reported in the response).
          let dialogEntry = null;
          const cur = agentSessions.get(sid);
          if (cur && pendingDialogs.has(cur)) dialogEntry = pendingDialogs.get(cur);
          if (!dialogEntry) {
            for (const d of pendingDialogs.values()) { dialogEntry = d; break; }
          }
          if (!dialogEntry) {
            result = JSON.stringify({ dialog: null });
            break;
          }
          if (!action) {
            result = JSON.stringify({
              dialog: {
                type: dialogEntry.type,
                message: dialogEntry.message,
                hasTouch: dialogEntry.hasTouch,
                defaultPrompt: dialogEntry.defaultPrompt,
              },
              targetId: dialogEntry.targetId,
            });
            break;
          }
          const promptText = args.find((a, i) => i > 0 && args[i - 1] === '--prompt-text');
          const dialog = { type: dialogEntry.type, message: dialogEntry.message };
          await cdp.send('Page.handleJavaScriptDialog', {
            accept: action === 'accept',
            ...(action === 'accept' && promptText !== undefined ? { promptText } : {}),
          }, dialogEntry.sessionId);
          pendingDialogs.delete(dialogEntry.targetId);
          result = JSON.stringify({ handled: true, dialog, action, targetId: dialogEntry.targetId });
          break;
        }
        case 'cookies': case 'cookie': {
          // L2 cookies (BH interaction-skills/cookies.md): list/set/delete +
          // save/load a JSON snapshot (session restore across tasks).
          // Cookie APIs live on a page session (the browser endpoint does not
          // register the Network/Storage domains), so route through the
          // session's current tab, else the first attached page.
          let pageSession = null;
          const cur = agentSessions.get(sid);
          if (cur) pageSession = sessions.get(cur) || null;
          if (!pageSession) {
            const { pages } = await getPagesCached();
            for (const pg of pages) {
              pageSession = sessions.get(pg.targetId) || null;
              if (pageSession) break;
            }
          }
          if (!pageSession) {
            return { ok: false, error: 'no page available for cookie operations — open a tab first', trace };
          }
          const sub = cmd === 'cookie' ? args[0] : undefined;
          const rest = cmd === 'cookie' ? args.slice(1) : args;
          const flagVal = (name) => {
            const i = rest.indexOf(name);
            return i >= 0 ? rest[i + 1] : undefined;
          };
          const hasFlag = (name) => rest.includes(name);

          if (cmd === 'cookies') {
            if (hasFlag('--save')) {
              const file = flagVal('--save');
              if (!file) return { ok: false, error: '--save requires a file path', trace };
              const { cookies } = await cdp.send('Network.getAllCookies', {}, pageSession);
              writeFileSync(file, JSON.stringify({ cookies }, null, 2));
              result = JSON.stringify({ saved: file, count: cookies.length });
              break;
            }
            if (hasFlag('--load')) {
              const file = flagVal('--load');
              if (!file) return { ok: false, error: '--load requires a file path', trace };
              let data;
              try { data = JSON.parse(readFileSync(file, 'utf8')); }
              catch { return { ok: false, error: `cannot read cookie file: ${file}`, trace }; }
              if (!Array.isArray(data.cookies)) return { ok: false, error: `invalid cookie file: ${file} (expected {cookies:[...]})`, trace };
              for (const c of data.cookies) {
                await cdp.send('Network.setCookie', { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', ...(c.secure ? { secure: true } : {}), ...(c.httpOnly ? { httpOnly: true } : {}), ...(c.expires ? { expires: c.expires } : {}) }, pageSession).catch(() => {});
              }
              result = JSON.stringify({ loaded: file, count: data.cookies.length });
              break;
            }
            const { cookies } = await cdp.send('Network.getAllCookies', {}, pageSession);
            result = JSON.stringify(cookies);
            break;
          }

          // cmd === 'cookie': set <name> <value> | delete <name>
          const name = rest[0];
          if (sub !== 'set' && sub !== 'delete') {
            return { ok: false, error: 'usage: cookie set <name> <value> [--domain d] [--path p] [--secure] [--httpOnly] [--expires ts] | cookie delete <name> [--domain d]', trace };
          }
          if (!name) return { ok: false, error: `cookie ${sub} requires a name`, trace };
          if (sub === 'delete') {
            const r = await cdp.send('Network.deleteCookies', { name, ...(flagVal('--domain') ? { domain: flagVal('--domain') } : {}) }, pageSession);
            result = JSON.stringify({ deleted: name, success: !!r.success });
            break;
          }
          const value = rest[1];
          if (value === undefined) return { ok: false, error: 'cookie set requires a value', trace };
          const domain = flagVal('--domain');
          if (!domain) return { ok: false, error: 'cookie set requires --domain <host> (or use eval to set a cookie for the current page)', trace };
          const r = await cdp.send('Network.setCookie', {
            name, value,
            domain,
            path: flagVal('--path') || '/',
            ...(hasFlag('--secure') ? { secure: true } : {}),
            ...(hasFlag('--httpOnly') ? { httpOnly: true } : {}),
            ...(flagVal('--expires') ? { expires: Number(flagVal('--expires')) } : {}),
          }, pageSession);
          if (!r.success) return { ok: false, error: `cookie set failed (${r.errorMessage || 'unknown'})`, trace };
          result = JSON.stringify({ set: { name, domain, path: flagVal('--path') || '/' } });
          break;
        }
        case 'current': {
          // BH current_tab: the tab this session is working on.
          const cur = agentSessions.get(sid);
          if (!cur) {
            return { ok: false, error: `no current tab for session "${sid}" — run 'cdp switch <target> [--session <id>]' first`, trace };
          }
          const { pages } = await getPagesCached();
          const p = pages.find(x => x.targetId === cur);
          if (!p) {
            agentSessions.delete(sid);
            return { ok: false, error: `current tab for session "${sid}" is gone (closed or crashed) — run 'cdp switch <target> [--session <id>]' again`, trace };
          }
          result = JSON.stringify({ targetId: cur, url: p.url, title: p.title, session: sid });
          break;
        }
        case 'knowledge': {
          const arg = args[0] || '';
          if (arg === '--review') {
            const fails = reviewFailures(readAuditEntries(300), sid);
            result = fails.length
              ? `最近失败命令(会话 ${sid}):\n` +
                fails.map(f => `  ${f.ts.slice(11, 19)} ${f.cmd} — ${f.error}`).join('\n') +
                `\n→ 踩坑值得沉淀:cdp knowledge <site> 查看笔记,或直接写笔记文件`
              : `会话 ${sid} 最近无失败命令,无需沉淀`;
            break;
          }
          if (arg === '--report') {
            const byHost = reportStats(readAuditEntries(1000));
            const hosts = Object.keys(byHost).sort();
            result = hosts.length
              ? `按站点统计(audit 近 1000 条):\n` +
                hosts.map(h => {
                  const s = byHost[h];
                  const rate = s.nav ? `${(100 * s.navFail / s.nav).toFixed(0)}%` : '-';
                  return `  ${h}: nav ${s.nav} 次(失败 ${rate}),知识读取 ${s.knowledgeReads} 次`;
                }).join('\n') +
                `\n→ 对比:有笔记的站 vs 无笔记的站,失败率是否更低`
              : `暂无 host 统计(需要 nav 命令的日志)`;
            break;
          }
          const site = arg;
          if (!site) {
            const sites = knowledgeSites();
            result = sites.length
              ? `已有笔记的站点:\n` +
                sites.map(s => {
                  const fs = knowledgeFiles(s);
                  const mark = fs.some(f => f.dir === 'private') ? ' (含私人)' : '';
                  return `  ${s} — ${fs.length} 条${mark}`;
                }).join('\n')
              : `还没有任何站点笔记(私人 ${KNOWLEDGE_DIR}/ 与公共 ${REPO_KNOWLEDGE_DIR}/ 都是空的)`;
          } else {
            const files = knowledgeFiles(site);
            result = files.length
              ? files.map(f => `# [${f.dir}] ${f.file}\n${readFileSync(f.path, 'utf8').trim()}`).join('\n\n')
              : `暂无 ${site} 的笔记(私人 ${KNOWLEDGE_DIR}/${site}/ 与公共 ${REPO_KNOWLEDGE_DIR}/${site}/ 都没有)\n→ 首次成功完成任务后可在此沉淀第一条`;
          }
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
          // Full enumeration including chrome:// pages so a real new-tab page
          // (chrome://newtab) is reusable; bypasses the shared filter cache.
          const tabsBefore = await getPages(cdp, { includeInternal: true });
            const reusable = findReusableTab(tabsBefore);
          let targetId;
          if (reusable) {
            targetId = reusable.targetId;
            await cdp.send('Target.activateTarget', { targetId });
                const { sessionId } = await getSession(targetId);
                await cdp.send('Page.enable', {}, sessionId);
                // Page.navigate can take ~12s to respond on never-ending (streaming)
            // pages; the navigation itself is async, so don't block open on it.
            // open is fire-and-forget: success means the navigation was STARTED,
            // not loaded — use `cdp wait <t> --load` / `cdp nav` when needed.
            const navP = cdp.send('Page.navigate', { url }, sessionId);
            await Promise.race([navP, sleep(2000)]);
            navP.catch(() => {});
              } else {
            // BH new_tab pattern: create blank, attach a session, THEN navigate.
            // createTarget({url}) navigates asynchronously — the tab stays on
            // about:blank for a while and Network/Runtime events for the early
            // navigation are missed (CDP does not replay them). open is
            // fire-and-forget; use `cdp wait <t> --load` / `cdp nav` for loaded.
            ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
                // resolveSession's isKnownTarget check reads the TTL page cache —
            // a just-created target is not in it, so refresh before attaching
            // (otherwise it throws "No target with given id found").
            await getPagesCached(true);
                const { sessionId } = await getSession(targetId);
                await cdp.send('Page.enable', {}, sessionId);
                const navP = cdp.send('Page.navigate', { url }, sessionId);
            await Promise.race([navP, sleep(2000)]);
            navP.catch(() => {});
              }
          // The opened tab becomes this session's current tab (BH new_tab
          // attaches and makes the tab current).
          agentSessions.set(sid, targetId);
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
          if (cmd === 'switch' && !targetId) {
            return { ok: false, error: 'target required for switch — e.g. cdp switch <target> [--session <id>]', trace };
          }
          if (!targetId) {
            // Session current-tab resolution: commands may omit <target> and
            // act on the session's current tab. args[0] counts as an explicit
            // target only when it looks like one (hex prefix, not a flag);
            // otherwise it is a command argument (js/selector/url/...).
            const a0 = args[0];
            if (a0 && !a0.startsWith('-') && /^[0-9A-Fa-f]{6,}$/.test(a0)) {
              try {
                const resolved = await resolveTargetPrefix(a0);
                targetId = resolved.targetId;
                args.shift();
              } catch (e) {
                // Escape hatch: a pure-hex ARGUMENT (e.g. `cdp eval deadbeef`,
                // `cdp fill #x cafe01`) would otherwise be swallowed as a
                // target prefix and fail resolution. If this session has a
                // current tab, treat the hex token as a plain argument.
                const curTab = agentSessions.get(sid);
                if (curTab) targetId = curTab;
                else return { ok: false, error: e.message, trace };
              }
            } else {
              const cur = agentSessions.get(sid);
              if (!cur) {
                return { ok: false, error: `no current tab for session "${sid}" — run 'cdp switch <target> [--session <id>]' first`, trace };
              }
              targetId = cur;
            }
          }
          const pendingDlg = pendingDialogs.get(targetId);
          if (pendingDlg) {
            return {
              ok: false,
              error: `page has a pending dialog (${pendingDlg.type}${pendingDlg.message ? `: ${pendingDlg.message.slice(0, 80)}` : ''}) — handle it with 'cdp dialog accept|dismiss' first`,
              trace,
            };
          }
          let session;
          try {
            const setupStarted = Date.now();
            session = await getSession(targetId);
            trace.setupMs = Date.now() - setupStarted;
            trace.attachMs = session.attachMs;
            trace.attachMode = session.attachMode;
          } catch (e) {
            if (agentSessions.get(sid) === targetId) agentSessions.delete(sid);
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
              case 'nav': case 'navigate': {
                commandResult = await navStr(cdp, sessionId, args[0]);
                const site = siteFromUrl(args[0]);
                if (site) {
                  const files = knowledgeFiles(site);
                  commandResult += files.length
                    ? `\nknowledge: ${site} — ${files.length} 条 (cdp knowledge ${site} 查看)`
                    : `\nknowledge: ${site} — 尚无笔记(首次成功后可沉淀)`;
                }
                break;
              }

              case 'net': case 'network':
                commandResult = await netStr(cdp, sessionId, parseNetArgs(args));
                break;
              case 'click':
                commandResult = await clickStr(cdp, sessionId, args[0]);
                break;
              case 'clickxy': {
                const p = parseClickxyArgs(args);
                commandResult = await clickXyStr(cdp, sessionId, p.x, p.y, p.button, p.clicks);
                break;
              }
              case 'type':
                commandResult = await typeStr(cdp, sessionId, args[0]);
                break;
              case 'loadall': {
                let interval = 1500;
                if (args[1] !== undefined) {
                  interval = parseInt(args[1], 10);
                  if (!Number.isInteger(interval) || interval < 0) {
                    throw new Error(`invalid interval: "${args[1]}" (expected a non-negative integer ms)`);
                  }
                }
                commandResult = await loadAllStr(cdp, sessionId, args[0], interval);
                break;
              }
              case 'evalraw':
                commandResult = await evalRawStr(cdp, sessionId, args[0], args[1]);
                break;
              case 'wait':
                commandResult = await waitStr(cdp, sessionId, args);
                break;
              case 'press':
                commandResult = await pressStr(cdp, sessionId, args);
                break;
              case 'close':
                // Target.closeTarget is browser-level; the session is only
                // needed to confirm the target resolves (targetDestroyed
                // cleans the sessions map). Force-refresh the page cache so
                // the next list reflects the close immediately (TTL cache
                // would otherwise show the dead tab for ~1.5s).
                await cdp.send('Target.closeTarget', { targetId });
                for (const [k, v] of agentSessions) if (v === targetId) agentSessions.delete(k);
                await getPagesCached(true);
                return JSON.stringify({ targetId, closed: true });
              case 'switch':
                agentSessions.set(sid, targetId);
                await cdp.send('Target.activateTarget', { targetId });
                return JSON.stringify({ targetId, activated: true, session: sid });
              case 'fill':
                commandResult = await fillStr(cdp, sessionId, args);
                break;
              case 'scroll':
                commandResult = await scrollStr(cdp, sessionId, args);
                break;
              case 'upload':
                commandResult = await uploadStr(cdp, sessionId, args);
                break;
              case 'pdf': {
                // L2 print-as-pdf: Page.printToPDF -> base64 -> file.
                const file = args[0] || `${targetId.slice(0, 8)}.pdf`;
                const res = await cdp.send('Page.printToPDF', { printBackground: true }, sessionId);
                writeFileSync(file, Buffer.from(res.data, 'base64'));
                const size = statSync(file).size;
                commandResult = JSON.stringify({ file, size, targetId });
                break;
              }
              case 'ensure-real-tab': {
                // BH ensure_real_tab: if the tab is an internal page (chrome://,
                // about:, devtools://, chrome-extension://), switch to the first
                // real (non-internal) tab; otherwise leave it alone.
                const pages = await getPages(cdp, { includeInternal: true });
                const cur = pages.find((t) => t.targetId === targetId);
                if (!cur) throw new Error(`ensure-real-tab: unknown target ${targetId}`);
                if (!isInternalUrl(cur.url)) {
                  return JSON.stringify({ switched: false, targetId, url: cur.url, title: cur.title });
                }
                const real = pages.filter((t) => !isInternalUrl(t.url));
                if (!real.length) throw new Error('ensure-real-tab: no real (non-internal) tab open');
                await cdp.send('Target.activateTarget', { targetId: real[0].targetId });
                return JSON.stringify({ switched: true, targetId: real[0].targetId, url: real[0].url, title: real[0].title });
              }
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

  // Persistent audit log: one JSON line per command (privacy-scrubbed —
  // argument VALUES are never recorded, only count + total length). Never
  // throws: audit must not affect command execution.
  function appendAudit(entry) {
    try {
      mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
      let st = null;
      try { st = statSync(AUDIT_FILE); } catch {}
      if (st && st.size > AUDIT_MAX_BYTES) {
        const data = readFileSync(AUDIT_FILE);
        // Keep the tail, but start at a line boundary so the file never
        // begins with a half-written JSON entry.
        let start = data.length >> 1;
        const nl = data.indexOf(0x0a, start);
        if (nl >= 0) start = nl + 1;
        writeFileSync(AUDIT_FILE, data.slice(start));
      }
      appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    } catch {}
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
    if (req.cmd !== 'list_raw') {
      const args = Array.isArray(req.args) ? req.args : [];
      const entry = {
        ts: new Date().toISOString(),
        cmd: req.cmd,
        args: args.length,
        argChars: args.join(' ').length,
        target: String(req.targetId || ''),
        session: String(req.session || 'default'),
        host: '',
      };
      if ((req.cmd === 'nav' || req.cmd === 'navigate') && args[0]) entry.host = siteFromUrl(args[0]) || '';
      else if (req.cmd === 'knowledge' && args[0] && !args[0].startsWith('--')) entry.host = args[0];
      entry.ok = !!res.ok;
      entry.error = res.ok ? '' : String(res.error || '').slice(0, 200);
      entry.ms = Date.now() - started;
      appendAudit(entry);
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
        }).catch((e) => {
          conn.write(JSON.stringify({ ok: false, error: String(e?.message || e), id: req.id }) + '\n');
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
        'See chrome://inspect/#remote-debugging — tick "Allow remote debugging", restart Chrome, then rerun.',
      );
    }

    // Spawn daemon
    const child = spawn(process.execPath, [process.argv[1], '_browser_daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log('cli', 'daemon: spawned pid=', child.pid);

    // Wait for the daemon's socket. The daemon binds it immediately on
    // startup, so this loop only matters if the daemon dies mid-spawn; the
    // actual Chrome "Allow remote debugging?" approval happens while a
    // command waits for its response (see sendCommandWithMacApprove).
    for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
      await sleep(DAEMON_CONNECT_DELAY);
      try { return await connectToSocket(BROWSER_SOCK); } catch {}
    }
    throw new Error(
      'Chrome debugging is on but the browser rejected the CDP connection. ' +
      'Chrome 151 shows an "Allow debugging" prompt — click Allow in Chrome, ' +
      'then rerun this command (or run `cdp mac-approve` on macOS to click it ' +
      'for you). Until approved, connections fail.',
    );
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

const IPC_RESPONSE_TIMEOUT = 60000;
// Shared CLI→daemon dispatch: connect (starting the daemon if needed), send
// one command, print the result or exit(1) with the daemon's error message.
async function cliSend(req) {
  const conn = await getOrStartBrowserDaemon();
  const response = await sendCommandWithMacApprove(conn, req);
  if (!response.ok) { console.error('Error:', response.error); process.exit(1); }
  return response;
}

// macOS: while a command waits for the daemon's response (the daemon may be
// blocked on Chrome's per-connection "Allow remote debugging?" sheet — up to
// 60s), auto-approve the sheet so the user never clicks Allow (browser-harness
// mac-approve alignment). First probe at 0.4s (sheet draws in ~0.3s), then
// every 0.3s; terminal statuses stop the loop. Opt out with CDP_NO_MAC_APPROVE=1.
async function sendCommandWithMacApprove(conn, req) {
  // CDP_NO_MAC_APPROVE=1 opts out of the automatic click (the standalone
  // `cdp mac-approve` command is still available).
  if (process.env.CDP_NO_MAC_APPROVE) return sendCommand(conn, req);
  let macTries = 0;
  let macNextAt = Date.now() + MAC_APPROVE_START_DELAY_MS;
  let macDone = false;
  let settled = false;
  let outcome;
  sendCommand(conn, req).then(
    (v) => { settled = true; outcome = v; },
    (e) => { settled = true; outcome = e; },
  );
  while (!settled) {
    const wait = macNextAt - Date.now();
    if (wait > 0) await sleep(wait);
    if (settled) break;
    macTries += 1;
    macNextAt = Date.now() + MAC_APPROVE_ATTEMPT_GAP_MS;
    const res = macApproveOnce();
    if (res.status === 'ready') {
      macDone = true;
      log('cli', 'mac-approve: clicked Allow');
      process.stderr.write('cdp: macOS auto-approve clicked Chrome\'s "Allow remote debugging?" — connecting…\n');
    } else if (res.status === 'accessibility-required') {
      macDone = true;
      process.stderr.write(`cdp: cannot auto-approve — ${res.detail}\n`);
    } else if (res.status === 'setup-required' || res.status === 'unsupported') {
      macDone = true; // nothing to click; the daemon's error will guide
    } else if (macTries >= MAC_APPROVE_MAX_ATTEMPTS) {
      macDone = true; // not-found / error — the sheet never appeared
    }
  }
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

function sendCommand(conn, req, { close = true } = {}) {
  const st = connState(conn);
  wireConn(conn, st);
  const id = st.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.pending.delete(id);
      reject(new Error(
        `daemon did not respond within ${IPC_RESPONSE_TIMEOUT / 1000}s (cmd: ${req.cmd})` +
        (process.platform === 'darwin'
          ? ' — if Chrome is asking for permission, run `cdp mac-approve` and retry'
          : ''),
      ));
    }, IPC_RESPONSE_TIMEOUT);
    st.pending.set(id, {
      id, resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      closeAfter: close,
    });
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

  list [--session <id>]             List open pages; * marks this session's current tab
  current [--session <id>]          Show this session's current tab (BH current_tab)
  iframe [url-substr]               List cross-origin iframe targets, or resolve the first
                                    whose URL contains the substring; the id works with
                                    every page command (eval/click/inspect/...)
  dialog [accept|dismiss] [--prompt-text <t>]
                                    Query the pending JS dialog (alert/confirm/prompt/
                                    beforeunload), or handle it; page commands on the
                                    dialog's tab are blocked until handled
  cookies [--save <file> | --load <file>]
                                    List all cookies, or save/load a JSON snapshot
  cookie set <name> <value> --domain <host> [--path /] [--secure] [--httpOnly] [--expires ts]
  cookie delete <name> [--domain <host>]
  pdf     <target> [file]           Print the page to a PDF file (default: <prefix>.pdf)
  stats                             Show browser daemon health and recent command timings
  doctor                            Diagnose install/daemon/Chrome state and print
                                    fix hints; exits 1 if anything is broken
  knowledge [site|--review|--report]  Site notes for self-improving: list notes for a
                                    site (private + repo layers), list all sites,
                                    review recent session failures, or per-site stats
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
  clickxy <target> <x> <y> [--button left|right|middle] [--clicks 1|2]
                                    Click at CSS pixel coordinates; default left click,
                                    --clicks 2 = double click (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  wait  <target> <selector> [--timeout <ms>] [--visible]
                                    Wait for a CSS selector to appear (default 10s)
                                    --visible: also require non-hidden and in-layout
  wait  <target> --load [--timeout <ms>]
                                    Wait for document.readyState == 'complete' (SPA-safe page load)
  wait  <target> --network-idle [--timeout <ms>] [--idle <ms>]
                                    Wait until no in-flight requests and quiet for idle ms (default 500)
  press <target> <key> [--ctrl|--shift|--alt|--meta]
                                    Dispatch a key press (Enter/Tab/Arrows/char...)
                                    with optional modifier combo
  close <target>                    Close the tab
  switch <target>                   Activate the tab (bring to foreground)
  fill <target> <selector> <text...> [--no-clear] [--timeout <ms>]
                                    Fill a framework-managed input: focus, clear,
                                    type real key events, then fire input+change
                                    (works where insertText-based type does not)
  scroll <target> <x> <y> [--dy <px>] [--dx <px>]
                                    Wheel-scroll at viewport coords (default dy=-300)
  upload <target> <selector> <path>
                                    Set files on a file input (DOM.setFileInputFiles)
  ensure-real-tab <target>          If the tab is an internal page (chrome:// etc.),
                                    switch to the first real tab; else no-op
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  open  [url]                       Open url in a blank tab if one exists (reused), else a new tab (default: about:blank)
  stop                              Stop the browser daemon
  mac-approve                       macOS: auto-click Chrome's "Allow remote
                                    debugging?" sheet (once; requires
                                    Accessibility permission for your
                                    terminal app)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

SESSIONS (current tab)
  Each agent session remembers the tab it is working on. Session id comes from
  --session <id> (any position) or env CDP_SESSION; without either, "default".
  'open' and 'switch' set the session's current tab. Page commands may then
  OMIT <target> and act on that tab:  cdp eval "js"   cdp wait --load
  cdp wait "#x" --visible   cdp close   cdp ensure-real-tab
  An explicit hex prefix still wins; a <target>-less command with no current
  tab errors with a hint to run switch first. Multiple subagents can each
  operate on their own tab via different session ids.

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
    Request:  {"id":<number>, "cmd":"<command>", "targetId":"<id>", "args":["arg1","arg2",...], "session":"<id>"}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: stats, inspect, snap, eval, shot, html, nav, net,
  click, clickxy, type, loadall, wait, press, close, switch, fill, scroll,
  upload, ensure-real-tab, current, iframe, dialog, cookies, cookie, pdf, evalraw,
  stop. Use evalraw to send arbitrary CDP methods.
  The socket disappears when Chrome disconnects or after "cdp stop".
`;

const NEEDS_TARGET = new Set([
  'inspect','snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw','wait','press','close','switch',
  'fill','scroll','upload','ensure-real-tab','pdf',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  log(cmd === '_browser_daemon' ? 'daemon' : 'cli', 'command:', cmd, args.slice(0, 2).map(a => (a || '').length > 80 ? a.slice(0, 80) + '…' : a).join(' '));

  // Daemon mode (internal)
  if (cmd === '_browser_daemon') { await runBrowserDaemon(); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  // Session id: --session <id> / --session=<id> (any position) wins over env
  // CDP_SESSION; when neither is present the daemon uses "default". Sessions
  // isolate the "current tab" per agent (multiple subagents, different tabs).
  let session = process.env.CDP_SESSION || undefined;
  {
    const kept = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--session') {
        if (i + 1 >= args.length) { console.error('Error: --session requires a value'); process.exit(1); }
        session = args[++i];
      } else if (a.startsWith('--session=')) {
        session = a.slice('--session='.length);
      } else {
        kept.push(a);
      }
    }
    args.length = 0;
    args.push(...kept);
  }

  if (cmd === 'mac-approve') {
    // Standalone helper: ready when the daemon is already Chrome-connected
    // (nothing to click); otherwise click the pending sheet, if any. NOTE:
    // the daemon socket being up is NOT enough — it binds before Chrome
    // approves (hence the ping probe).
    let daemonConnected = false;
    try {
      const conn = await connectToSocket(BROWSER_SOCK);
      const r = await sendCommand(conn, { cmd: 'ping' });
      daemonConnected = JSON.parse(r.result).connected === true;
      conn.end();
    } catch {}
    if (daemonConnected) {
      console.log('ready');
      process.exit(0);
    }
    const res = macApproveOnce();
    if (res.detail) console.log(`${res.status}: ${res.detail}`);
    else console.log(res.status);
    process.exit(res.status === 'ready' ? 0 : 1);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const response = await cliSend({ cmd: 'list', args: [], session });
    console.log(response.result);
    return;
  }

  if (cmd === 'stats') {
    const response = await cliSend({ cmd: 'stats', args: [] });
    console.log(response.result);
    return;
  }

  if (cmd === 'knowledge') {
    const response = await cliSend({ cmd: 'knowledge', args, session });
    console.log(response.ok ? response.result : response.error);
    process.exit(response.ok ? 0 : 1);
  }

  if (cmd === 'doctor') {
    const r = await doctorCmd();
    console.log(r.text);
    process.exit(r.failCount > 0 ? 1 : 0);
  }

  // Cross-origin iframes (BH iframe_target): list all, or resolve the first
  // whose URL contains the substring; the id works with every page command.
  if (cmd === 'iframe') {
    const response = await cliSend({ cmd: 'iframe', args, session });
    const data = JSON.parse(response.result);
    if (data.list) {
      console.log(data.list.join('\n'));
    } else {
      console.log(`iframe: ${data.targetId.slice(0, 8)}  ${data.title}  ${data.url}`);
    }
    return;
  }

  // L2 dialogs/cookies: no target needed (dialog state and cookies are
  // browser-level).
  if (cmd === 'cookies') {
    // M1: resolve relative snapshot paths against the caller's cwd (the
    // daemon's cwd is wherever it was first spawned).
    for (let i = 0; i < args.length - 1; i++) {
      if ((args[i] === '--save' || args[i] === '--load') && args[i + 1]) args[i + 1] = resolve(args[i + 1]);
    }
  }
  if (cmd === 'dialog' || cmd === 'cookies' || cmd === 'cookie') {
    const response = await cliSend({ cmd, args, session });
    console.log(response.result);
    return;
  }

  // Current tab for this session (BH current_tab)
  if (cmd === 'current') {
    const response = await cliSend({ cmd: 'current', args: [], session });
    console.log(response.result); // JSON: {targetId, url, title, session}
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
        console.log(`Opened ${url} via system (CDP unavailable — see message above)`);
        return;
      }
      console.error('Error:', e.message);
      process.exit(1);
    }
    const response = await sendCommand(conn, { cmd: 'open', args: [url], session });
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

  // Target handling: an explicit target is a hex prefix (>= 6 chars, not a
  // flag). Anything else means the command acts on this session's current tab
  // (daemon-side resolution) — e.g. `cdp eval "js"`, `cdp wait --load`,
  // `cdp wait "#x" --visible`, `cdp close --session A`.
  const a0 = args[0];
  let explicitTarget = a0 && !a0.startsWith('-') && /^[0-9A-Fa-f]{6,}$/.test(a0);
  if (cmd === 'switch' && !explicitTarget) {
    console.error('Error: switch requires a target — e.g. "cdp switch <target> [--session <id>]"');
    process.exit(1);
  }

  // M1: resolve relative output paths on the CLI side. The daemon is a
  // long-lived process whose cwd is wherever it was FIRST spawned; writing
  // relative paths there would silently surprise later callers.
  if (cmd === 'pdf' || cmd === 'shot') {
    const fileIdx = explicitTarget ? 1 : 0;
    const file = args[fileIdx];
    if (file && !file.startsWith('-')) args[fileIdx] = resolve(file);
  }

  const conn = await getOrStartBrowserDaemon();
  let cmdArgs = explicitTarget ? args.slice(1) : args;

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

  let targetId = null;
  if (explicitTarget) {
    // One connection, two round trips: resolve the target prefix, then run the
    // command. The daemon's response for resolve_target carries the full id.
    const resolved = await sendCommand(conn, { cmd: 'resolve_target', args: [a0] }, { close: false });
    if (resolved.ok) {
      targetId = JSON.parse(resolved.result).targetId;
    } else {
      // M4 escape hatch: the hex token may be a plain ARGUMENT (e.g. `cdp
      // eval deadbeef`). Retry with the full args and no target; the daemon
      // falls back to this session's current tab and errors only if none.
      cmdArgs = args;
      explicitTarget = false;
    }
  }

  const response = await sendCommand(conn, { cmd, targetId, args: cmdArgs, session });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exit(1);
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
  getPages,
  inspectGuideDue,
  markInspectOpened,
  closeInspectTabs,
  clickXyEvents,
  parseClickxyArgs,
  doctorItems,
  siteFromUrl,
  knowledgeFiles,
  knowledgeSites,
  readAuditEntries,
  reviewFailures,
  reportStats,
  MAC_APPROVE_SCRIPT,
  macApproveScript,
  classifyMacApprove,
  runMacApproveScript,
  macApproveOnce,
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
