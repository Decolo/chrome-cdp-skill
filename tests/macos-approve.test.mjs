import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAC_APPROVE_SCRIPT,
  classifyMacApprove,
  macApproveScript,
  runMacApproveScript,
  macApproveOnce,
} from '../skills/chrome-cdp/scripts/cdp.mjs';

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

test('MAC_APPROVE_SCRIPT: exact sheet name + Allow button press, no interpolation', () => {
  assert.match(MAC_APPROVE_SCRIPT, /"Allow remote debugging\?"/, 'exact English sheet name match');
  assert.match(MAC_APPROVE_SCRIPT, /"要允许远程调试吗？"/, 'exact Chinese sheet name match (localized Chrome)');
  assert.match(MAC_APPROVE_SCRIPT, /"AXButton"/, 'button role check');
  assert.match(MAC_APPROVE_SCRIPT, /"Allow"/, 'English button description');
  assert.match(MAC_APPROVE_SCRIPT, /"允许"/, 'Chinese button description');
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
  // Both passes (exact + lenient) must remain present.
  assert.ok(MAC_APPROVE_SCRIPT.includes('is "Allow remote debugging?"'));
  assert.ok(MAC_APPROVE_SCRIPT.includes('contains "remote debugging"'));
});
