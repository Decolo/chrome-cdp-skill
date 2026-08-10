import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findReusableTab,
  resolveLastUsedProfile,
  chromeLaunchArgs,
  devToolsPortLive,
  findDevToolsActivePortFile,
  localStateUserEnabled,
  getPages,
} from '../skills/chrome-cdp/scripts/cdp.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-align-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// inspect-tab lifecycle (borrowed from browser-harness): the marker records
// that WE opened a chrome://inspect tab; the daemon closes it on the next
// successful connect. TTL prevents re-opening the tab on every command.
// ---------------------------------------------------------------------------

async function isolatedCdpModule(t) {
  const dir = tempDir(t);
  const oldXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
  t.after(() => {
    if (oldXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldXdg;
  });
  const mod = await import(`../skills/chrome-cdp/scripts/cdp.mjs?iso=${Date.now()}-${Math.random()}`);
  return { dir, mod };
}

test('inspectGuideDue respects TTL and skip env', async (t) => {
  const { dir, mod } = await isolatedCdpModule(t);
  const marker = `${dir}/cdp/inspect-opened`; // RUNTIME_DIR = XDG_RUNTIME_DIR/cdp
  assert.equal(mod.inspectGuideDue(), true, 'no marker -> due');

  writeFileSync(marker, String(Date.now()));
  assert.equal(mod.inspectGuideDue(), false, 'fresh marker -> not due (TTL)');

  const oldMtime = Date.now() - 180_000 - 1000; // INSPECT_REOPEN_TTL_MS
  const { utimesSync } = await import('node:fs');
  utimesSync(marker, new Date(oldMtime / 1000), new Date(oldMtime / 1000));
  assert.equal(mod.inspectGuideDue(), true, 'stale marker -> due');

  process.env.CDP_SKIP_INSPECT_HINT = '1';
  assert.equal(mod.inspectGuideDue(), false, 'skip env -> never due');
  delete process.env.CDP_SKIP_INSPECT_HINT;
});

test('closeInspectTabs closes only marker-owned inspect tabs and clears marker', async (t) => {
  const { dir, mod } = await isolatedCdpModule(t);
  const marker = `${dir}/cdp/inspect-opened`; // RUNTIME_DIR = XDG_RUNTIME_DIR/cdp
  const closed = [];
  const fakeCdp = {
    send: async (method, params) => {
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { targetId: 'INSP', type: 'page', url: 'chrome://inspect/#remote-debugging' },
            { targetId: 'REAL', type: 'page', url: 'https://x.com/home' },
            { targetId: 'NTAB', type: 'page', url: 'chrome://newtab/' },
            { targetId: 'WKR', type: 'worker', url: 'chrome://inspect/worker' },
          ],
        };
      }
      if (method === 'Target.closeTarget') closed.push(params.targetId);
    },
  };

  await mod.closeInspectTabs(fakeCdp); // no marker -> untouched
  assert.deepEqual(closed, [], 'no marker -> nothing closed');

  writeFileSync(marker, String(Date.now()));
  await mod.closeInspectTabs(fakeCdp);
  assert.deepEqual(closed, ['INSP'], 'only the page-type chrome://inspect tab closed');
  assert.equal(existsSync(marker), false, 'marker cleared after cleanup');
});

// ---------------------------------------------------------------------------
// getPages: default view hides chrome:// pages, but open must see them so a
// real chrome://newtab tab is reusable (regression: open never reused
// new-tab pages because the filtered enumeration hid them)
// ---------------------------------------------------------------------------

test('getPages filters chrome:// pages by default but includes them with includeInternal', async () => {
  const fakeCdp = {
    send: async () => ({
      targetInfos: [
        { targetId: 'A', type: 'page', url: 'https://x.com/home' },
        { targetId: 'B', type: 'page', url: 'chrome://newtab/' },
        { targetId: 'C', type: 'page', url: 'about:blank' },
        { targetId: 'D', type: 'other', url: 'https://example.com' },
      ],
    }),
  };
  const filtered = await getPages(fakeCdp);
  assert.deepEqual(filtered.map(p => p.targetId), ['A', 'C'], 'default: chrome:// pages hidden, non-page targets hidden');

  const full = await getPages(fakeCdp, { includeInternal: true });
  assert.deepEqual(full.map(p => p.targetId), ['A', 'B', 'C'], 'includeInternal: chrome://newtab visible for reuse');
});

// ---------------------------------------------------------------------------
// findReusableTab: blank tabs are reused, real tabs are never touched
// ---------------------------------------------------------------------------

test('findReusableTab reuses about:blank and new-tab pages', () => {
  const pages = [
    { targetId: 'A', url: 'https://x.com/home', title: 'X' },
    { targetId: 'B', url: 'about:blank', title: '' },
  ];
  assert.equal(findReusableTab(pages).targetId, 'B', 'about:blank is reusable');

  const newtab = [
    { targetId: 'A', url: 'chrome://newtab', title: 'New Tab' },
    { targetId: 'C', url: 'https://google.com', title: 'Google' },
  ];
  assert.equal(findReusableTab(newtab).targetId, 'A', 'chrome://newtab is reusable');

  const edge = [{ targetId: 'D', url: 'edge://newtab' }];
  assert.equal(findReusableTab(edge).targetId, 'D', 'edge://newtab is reusable');

  const blankHash = [{ targetId: 'E', url: 'about:blank#fragment' }];
  assert.equal(findReusableTab(blankHash).targetId, 'E', 'about:blank#* is reusable');
});

test('findReusableTab never touches real pages', () => {
  const pages = [
    { targetId: 'A', url: 'https://x.com/home' },
    { targetId: 'B', url: 'file:///tmp/a.html' },
    { targetId: 'C', url: 'chrome://settings' },
    { targetId: 'D', url: 'http://localhost:3000' },
  ];
  assert.equal(findReusableTab(pages), null, 'no blank tab among real pages');
  assert.equal(findReusableTab([]), null);
  assert.equal(findReusableTab(null), null);
  assert.equal(findReusableTab([{ targetId: 'X' }]), null, 'missing url is not reusable');
});

test('findReusableTab picks the first reusable tab in order', () => {
  const pages = [
    { targetId: 'Z', url: 'https://news.ycombinator.com' },
    { targetId: 'B', url: 'about:blank' },
    { targetId: 'N', url: 'chrome://newtab' },
  ];
  assert.equal(findReusableTab(pages).targetId, 'B', 'earliest reusable wins');
});

// ---------------------------------------------------------------------------
// resolveLastUsedProfile: parse Local State, skip profile picker on relaunch
// ---------------------------------------------------------------------------

test('resolveLastUsedProfile reads last_used from Local State', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'Profile 2'));
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2' } }));
  assert.equal(resolveLastUsedProfile(dir), 'Profile 2');
});

test('resolveLastUsedProfile falls back to null on missing/invalid Local State', (t) => {
  const dir = tempDir(t);
  assert.equal(resolveLastUsedProfile(dir), null, 'no Local State -> null');
  writeFileSync(join(dir, 'Local State'), 'not json {');
  assert.equal(resolveLastUsedProfile(dir), null, 'corrupt Local State -> null');
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { last_used: 'Ghost' } }));
  assert.equal(resolveLastUsedProfile(dir), null, 'last_used dir missing -> null');
  assert.equal(resolveLastUsedProfile(null), null);
});

// ---------------------------------------------------------------------------
// chromeLaunchArgs
// ---------------------------------------------------------------------------

test('chromeLaunchArgs enables debugging and honors CDP_USER_DATA_DIR', (t) => {
  const dir = tempDir(t);
  const prev = process.env.CDP_USER_DATA_DIR;
  process.env.CDP_USER_DATA_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CDP_USER_DATA_DIR;
    else process.env.CDP_USER_DATA_DIR = prev;
  });
  const args = chromeLaunchArgs();
  assert.ok(args.includes('--remote-debugging-port=0'), 'debugging on');
  assert.ok(args.includes(`--user-data-dir=${dir}`), 'user-data-dir override wins');
  assert.ok(!args.some(a => a.startsWith('--profile-directory')), 'no profile args with custom data dir');
});

// ---------------------------------------------------------------------------
// devToolsPortLive: a file with a dead port is NOT trusted
// ---------------------------------------------------------------------------

test('devToolsPortLive rejects dead ports and bad files', async (t) => {
  const dir = tempDir(t);
  const bad = join(dir, 'bad-port');
  writeFileSync(bad, 'not-a-port\n/path');
  assert.equal(await devToolsPortLive(bad), false, 'non-numeric port');
  const dead = join(dir, 'dead-port');
  // port 1 is virtually never listening
  writeFileSync(dead, '1\n/devtools/browser/abc');
  assert.equal(await devToolsPortLive(dead), false, 'no listener on port 1');
  assert.equal(await devToolsPortLive(null), false);
  assert.equal(await devToolsPortLive(join(dir, 'missing')), false);
});

// ---------------------------------------------------------------------------
// findDevToolsActivePortFile: CDP_PORT_FILE override
// ---------------------------------------------------------------------------

test('findDevToolsActivePortFile honors CDP_PORT_FILE', (t) => {
  const dir = tempDir(t);
  const f = join(dir, 'DevToolsActivePort');
  writeFileSync(f, '9222\n/devtools/browser/x');
  const prev = process.env.CDP_PORT_FILE;
  process.env.CDP_PORT_FILE = f;
  t.after(() => {
    if (prev === undefined) delete process.env.CDP_PORT_FILE;
    else process.env.CDP_PORT_FILE = prev;
  });
  assert.equal(findDevToolsActivePortFile(), f, 'override file wins');
  rmSync(f);
  const after = findDevToolsActivePortFile();
  assert.notEqual(after, f, 'deleted override falls through to real candidates');
  assert.ok(after === null || after.endsWith('DevToolsActivePort'));
});

// ---------------------------------------------------------------------------
// Local State switch detection (browser-harness alignment)
// ---------------------------------------------------------------------------

test('localStateUserEnabled reads devtools.remote_debugging.user-enabled', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }));
  assert.equal(localStateUserEnabled(dir), true);
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': false } } }));
  assert.equal(localStateUserEnabled(dir), false);
  writeFileSync(join(dir, 'Local State'), JSON.stringify({}));
  assert.equal(localStateUserEnabled(dir), null, 'absent -> null');
  assert.equal(localStateUserEnabled(join(dir, 'missing')), null);
});

test('chromeLaunchArgs: no debug flag on default profile (Chrome 136+ switch path)', (t) => {
  const prev = process.env.CDP_USER_DATA_DIR;
  delete process.env.CDP_USER_DATA_DIR;
  try {
    const args = chromeLaunchArgs();
    assert.ok(!args.some(a => a.includes('remote-debugging')), 'no --remote-debugging-port on default profile');
    assert.ok(!args.some(a => a.includes('user-data-dir')), 'no user-data-dir on default profile');
  } finally {
    if (prev !== undefined) process.env.CDP_USER_DATA_DIR = prev;
  }
});

test('chromeLaunchArgs: debug flag kept for custom user-data-dir', (t) => {
  const dir = tempDir(t);
  const prev = process.env.CDP_USER_DATA_DIR;
  process.env.CDP_USER_DATA_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CDP_USER_DATA_DIR;
    else process.env.CDP_USER_DATA_DIR = prev;
  });
  const args = chromeLaunchArgs();
  assert.ok(args.includes('--remote-debugging-port=0'), 'flag kept for custom data dir');
  assert.ok(args.includes(`--user-data-dir=${dir}`));
});
