import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAC_APPROVE_SCRIPT,
  MAC_APPROVE_TERMINAL,
  classifyMacApprove,
  macApproveScript,
  runMacApproveScript,
  macApproveOnce,
  macApproveWhile,
} from '../skills/chrome-cdp/scripts/cdp.mjs';

const SRC = readFileSync(new URL('../skills/chrome-cdp/scripts/cdp.mjs', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// macOS auto-approve of Chrome's "Allow remote debugging?" sheet
// (browser-harness mac-approve alignment). The AppleScript itself is live-
// verified on a Mac; these tests pin the classifier, the script content, and
// the process-name parameterization so regressions fail fast.
// ---------------------------------------------------------------------------

test('classifyMacApprove: daemon already connected -> ready', () => {
  const r = classifyMacApprove({ socketUp: true, toggleEnabled: false, exitCode: 1 });
  assert.equal(r.status, 'ready', 'socket up means nothing to click');
});

test('classifyMacApprove: non-macOS -> unsupported', () => {
  const r = classifyMacApprove({ platform: 'win32', toggleEnabled: true });
  assert.equal(r.status, 'unsupported');
});

test('classifyMacApprove: switch off -> setup-required', () => {
  const r = classifyMacApprove({ platform: 'darwin', toggleEnabled: false });
  assert.equal(r.status, 'setup-required');
  assert.match(r.detail, /chrome:\/\/inspect/);
  const none = classifyMacApprove({ platform: 'darwin', toggleEnabled: null });
  assert.equal(none.status, 'setup-required', 'unknown switch state also guides');
});

test('classifyMacApprove: not authorized / assistive -> accessibility-required', () => {
  const denied = classifyMacApprove({
    platform: 'darwin', toggleEnabled: true, exitCode: 1,
    stderr: 'osascript is not allowed assistive access. (-25211)',
  });
  assert.equal(denied.status, 'accessibility-required');
  assert.match(denied.detail, /Accessibility/);

  const timedOut = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, timedOut: true });
  assert.equal(timedOut.status, 'accessibility-required', 'hang = pending TCC prompt');
});

test('classifyMacApprove: osascript crash -> error', () => {
  const r = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 1, stderr: 'execution error: boom' });
  assert.equal(r.status, 'error');
  assert.match(r.detail, /boom/);
  const noDetail = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 3 });
  assert.equal(noDetail.status, 'error');
  assert.match(noDetail.detail, /exited 3/);
});

test('classifyMacApprove: script outcomes -> ready / not-found / error', () => {
  assert.equal(classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 0, stdout: 'ready' }).status, 'ready');
  assert.equal(classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 0, stdout: 'not-found' }).status, 'not-found');
  const empty = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 0, stdout: '' });
  assert.equal(empty.status, 'error', 'unexpected output is an error, not silent');
  const weird = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 0, stdout: 'maybe' });
  assert.equal(weird.status, 'error');
});

test('classifyMacApprove: sheet open but unmatched -> no-match, not a silent not-found', () => {
  // "no sheet yet" (retry) and "sheet present but nothing matched" (Chrome
  // changed the dialog) are different failures. Reporting both as not-found is
  // what let the 151+ AXHeading move go unnoticed for several occurrences.
  const one = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 0, stdout: 'no-match:1' });
  assert.equal(one.status, 'no-match');
  assert.match(one.detail, /1 sheet\(s\) open/);
  assert.match(one.detail, /isApprovalPrompt/, 'tells the reader which matcher to update');

  const two = classifyMacApprove({ platform: 'darwin', toggleEnabled: true, exitCode: 0, stdout: 'no-match:2' });
  assert.equal(two.status, 'no-match');
  assert.match(two.detail, /2 sheet\(s\) open/, 'reports how many sheets were seen');
});

test('MAC_APPROVE_SCRIPT: subtree match + Allow button press, no interpolation', () => {
  // Chrome 151+ (verified 153.0.8010.50) renders the dialog itself: the AXSheet
  // has name = missing value and the title sits on a nested AXHeading, ~5 levels
  // down. Matching the sheet's own name therefore never fires — the script must
  // walk the sub-tree and match on content. Both wordings stay covered: the
  // `contains` form also matches the old exact names, so older Chrome (title on
  // the sheet itself) keeps working.
  assert.match(MAC_APPROVE_SCRIPT, /on isApprovalPrompt/, 'matches by walking the sub-tree, not by the sheet name');
  assert.match(MAC_APPROVE_SCRIPT, /repeat with c in UI elements of node/, 'recurses into children (Chrome 151+ nests the title)');
  assert.match(MAC_APPROVE_SCRIPT, /if depth > 10 then return false/, 'recursion is depth-bounded');
  assert.match(MAC_APPROVE_SCRIPT, /"AXButton"/, 'button role check');
  assert.match(MAC_APPROVE_SCRIPT, /"Allow"/, 'English button description');
  assert.match(MAC_APPROVE_SCRIPT, /"允许"/, 'Chinese button description');
  // Button match must stay EXACT. The same sheet also offers 「取消」 and
  // 「在"设置"中关闭」 — the latter DISABLES remote debugging, so a loose
  // substring match on the label would click exactly the wrong button.
  assert.match(MAC_APPROVE_SCRIPT, /is "允许"/, 'button label matched by exact equality');
  assert.ok(!MAC_APPROVE_SCRIPT.includes('contains "允许"'), 'button label must never be a substring match');
  assert.match(MAC_APPROVE_SCRIPT, /AXPress/, 'presses the button');
  assert.match(MAC_APPROVE_SCRIPT, /clickAllow/, 'recursive UI-tree walk');
  assert.match(MAC_APPROVE_SCRIPT, /contains "remote debugging"/, 'lenient pass for Chrome 151+ wording');
  assert.match(MAC_APPROVE_SCRIPT, /contains "远程调试"/, 'lenient pass for Chinese wording');
  assert.match(MAC_APPROVE_SCRIPT, /__CDP_CHROME_PROCESS__/, 'process name is parameterized');
  assert.ok(!MAC_APPROVE_SCRIPT.includes('${'), 'no stray template interpolation');
});

test('macApproveScript: process name from CDP_CHROME_APP, escaped, default Google Chrome', (t) => {
  const prev = process.env.CDP_CHROME_APP;
  t.after(() => {
    if (prev === undefined) delete process.env.CDP_CHROME_APP;
    else process.env.CDP_CHROME_APP = prev;
  });
  delete process.env.CDP_CHROME_APP;
  assert.match(macApproveScript(), /set targetProcess to "Google Chrome"/);

  process.env.CDP_CHROME_APP = 'Brave';
  assert.match(macApproveScript(), /set targetProcess to "Brave Browser"/, 'Brave.app -> Brave Browser process name');

  process.env.CDP_CHROME_APP = '/Applications/Brave Browser.app';
  assert.match(macApproveScript(), /set targetProcess to "Brave Browser"/, 'path + .app stripped');

  process.env.CDP_CHROME_APP = 'Edge';
  assert.match(macApproveScript(), /set targetProcess to "Microsoft Edge"/, 'Edge.app -> Microsoft Edge process name');

  process.env.CDP_CHROME_APP = 'Chromium';
  assert.match(macApproveScript(), /set targetProcess to "Chromium"/);
});

test('runMacApproveScript: returns a bounded result shape, never throws', () => {
  const r = runMacApproveScript();
  assert.ok(typeof r.exitCode === 'number' || r.exitCode === null, `exitCode number|null, got ${r.exitCode}`);
  assert.equal(typeof r.timedOut, 'boolean');
  assert.equal(typeof r.stdout, 'string');
  assert.equal(typeof r.stderr, 'string');
});

test('macApproveOnce: socket already up -> ready without running osascript', async (t) => {
  const r = macApproveOnce({ socketUp: true });
  assert.equal(r.status, 'ready');
});

test('script clicks EVERY stacked sheet (no early exit)', () => {
  // Regression for the double-popup bug: rapid daemon restarts stack two
  // "Allow remote debugging?" sheets; the script must iterate every window
  // and every sheet, not stop at the first match.
  assert.ok(!MAC_APPROVE_SCRIPT.includes('exit repeat'),
    'script must not exit at the first matched sheet');
  assert.ok(MAC_APPROVE_SCRIPT.includes('repeat with s in sheets of w'),
    'script must iterate all sheets');
  assert.ok(MAC_APPROVE_SCRIPT.includes('clickedCount'),
    'script must count clicks so a single pass can clear stacked sheets');
  // Both wordings must remain covered. They now ride on the sub-tree match
  // (isApprovalPrompt) instead of the two sheet-name passes, but dropping
  // either language would silently break localized Chrome.
  assert.ok(MAC_APPROVE_SCRIPT.includes('contains "remote debugging"'), 'English wording covered');
  assert.ok(MAC_APPROVE_SCRIPT.includes('contains "远程调试"'), 'Chinese wording covered');
});

// ---------------------------------------------------------------------------
// The daemon must approve the sheet itself.
//
// The sheet is MODAL: while it is up, ALL of Chrome is blocked. It is drawn
// per NEW WebSocket connection, so a dropped connection makes the daemon
// redraw it on every backoff retry. The CLI only approves while one of its own
// commands is in flight, and the user is not watching a browser they did not
// touch — so a daemon that merely retried left a frozen Chrome behind each
// time. That is the reported freeze.
// ---------------------------------------------------------------------------

test('MAC_APPROVE_TERMINAL: only statuses where another poll cannot help', () => {
  for (const s of ['ready', 'unsupported', 'setup-required', 'accessibility-required']) {
    assert.ok(MAC_APPROVE_TERMINAL.has(s), `${s} is terminal`);
  }
  for (const s of ['not-found', 'no-match', 'error']) {
    assert.ok(!MAC_APPROVE_TERMINAL.has(s), `${s} keeps polling — the sheet may still draw`);
  }
});

test('macApproveWhile: isDone short-circuits before any osascript runs', async () => {
  assert.equal(await macApproveWhile(() => true), null,
    'returns null without polling once the thing we waited for has settled');
});

test('daemon connectOnce approves the sheet (modal would otherwise freeze Chrome)', () => {
  const start = SRC.indexOf('async function connectOnce()');
  assert.ok(start > -1, 'connectOnce exists');
  const body = SRC.slice(start, SRC.indexOf('\n  }\n', start));
  assert.match(body, /macApproveWhile\(\(\) => usable, 'daemon'\)/,
    'the daemon approves while its connect attempt is in flight');
  assert.match(body, /usable = true/,
    'and stops approving once the connection is usable');
  assert.match(body, /macApproveWhile[\s\S]*\.catch\(/,
    'the floating loop cannot take the daemon down as an unhandled rejection');
});

test('CLI and daemon share one approve loop', () => {
  // Two copies of this loop is how the daemon half went missing in the first
  // place: the CLI polled for a sheet the daemon had drawn and nobody clicked.
  const cli = SRC.slice(SRC.indexOf('async function sendCommandWithMacApprove'));
  assert.match(cli, /await macApproveWhile\(\(\) => settled\)/, 'CLI uses the shared loop');
  assert.ok(!SRC.includes('macDone'),
    'the dead macDone flag stays gone — it was never read, so the loop never stopped');
});
