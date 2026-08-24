import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clickXyEvents,
  parseClickxyArgs,
  doctorItems,
} from '../skills/chrome-cdp/scripts/cdp.mjs';

// ---------------------------------------------------------------------------
// clickxy: --button left|right|middle, --clicks 1|2 (BH click_at_xy alignment)
// ---------------------------------------------------------------------------

test('clickXyEvents: single left click = move + press/release with clickCount 1', () => {
  const evts = clickXyEvents(100, 200, 'left', 1);
  assert.equal(evts.length, 3);
  assert.deepEqual(evts[0], { type: 'mouseMoved', x: 100, y: 200, button: 'left', clickCount: 0, modifiers: 0 });
  assert.deepEqual(evts[1], { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1, modifiers: 0 });
  assert.deepEqual(evts[2], { type: 'mouseReleased', x: 100, y: 200, button: 'left', clickCount: 1, modifiers: 0 });
});

test('clickXyEvents: double click = two full press/release cycles (1,1,2,2)', () => {
  const evts = clickXyEvents(10, 20, 'left', 2);
  assert.equal(evts.length, 5);
  assert.deepEqual(evts.map(e => e.type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(evts.slice(1).map(e => e.clickCount), [1, 1, 2, 2]);
});

test('clickXyEvents: button preserved for right/middle', () => {
  for (const b of ['right', 'middle']) {
    const evts = clickXyEvents(0, 0, b, 1);
    assert.ok(evts.every(e => e.button === b), `all events use ${b}`);
  }
});

test('parseClickxyArgs: defaults and options', () => {
  assert.deepEqual(parseClickxyArgs(['10', '20']), { x: 10, y: 20, button: 'left', clicks: 1 });
  assert.deepEqual(parseClickxyArgs(['10', '20', '--button', 'right']), { x: 10, y: 20, button: 'right', clicks: 1 });
  assert.deepEqual(parseClickxyArgs(['10', '20', '--clicks', '2']), { x: 10, y: 20, button: 'left', clicks: 2 });
  assert.deepEqual(parseClickxyArgs(['10', '20', '--button', 'middle', '--clicks', '2']), { x: 10, y: 20, button: 'middle', clicks: 2 });
  assert.deepEqual(parseClickxyArgs(['1.5', '2.5', '--clicks', '1']), { x: 1.5, y: 2.5, button: 'left', clicks: 1 });
});

test('parseClickxyArgs: rejects invalid input', () => {
  assert.throws(() => parseClickxyArgs([]), /x and y required/);
  assert.throws(() => parseClickxyArgs(['abc', '10']), /must be numbers/);
  assert.throws(() => parseClickxyArgs(['10', '20', '--button', 'sideways']), /left\|right\|middle/);
  assert.throws(() => parseClickxyArgs(['10', '20', '--clicks', '3']), /1 or 2/);
  assert.throws(() => parseClickxyArgs(['10', '20', '--nope']), /unknown clickxy option/);
});

// ---------------------------------------------------------------------------
// cdp doctor: doctorItems classification (BH --doctor alignment)
// ---------------------------------------------------------------------------

const baseFacts = {
  platform: 'darwin', nodeVersion: 'v22.0.0', runtimeDir: '/tmp/x',
  daemonConnected: false, daemonPidAlive: false, socketExists: false,
  chromeRunning: true, portFile: '/tmp/DevToolsActivePort', portLive: true,
  switchEnabled: true, port: '9222',
};

test('doctorItems: healthy machine -> no fails, remote debugging ok', () => {
  const { lines, failCount } = doctorItems({ ...baseFacts });
  assert.equal(failCount, 0);
  const joined = lines.join('\n');
  assert.match(joined, /\[ok\] remote debugging/);
  assert.doesNotMatch(joined, /\[FAIL\]/);
});

test('doctorItems: daemon not running is info, not a failure', () => {
  const { failCount, lines } = doctorItems({ ...baseFacts });
  assert.equal(failCount, 0);
  assert.ok(lines.some(l => l.includes('not running (starts automatically')));
});

test('doctorItems: connected daemon -> ok line', () => {
  const { lines } = doctorItems({ ...baseFacts, daemonConnected: true, daemonPidAlive: true, socketExists: true });
  assert.ok(lines.some(l => /\[ok\] daemon/.test(l)));
  assert.ok(lines.some(l => l.includes('connected to Chrome')));
});

test('doctorItems: stale socket -> warn with self-heal hint', () => {
  const { lines, failCount } = doctorItems({ ...baseFacts, socketExists: true });
  assert.equal(failCount, 0);
  assert.ok(lines.some(l => l.includes('stale socket')));
});

test('doctorItems: Chrome running but no port file -> fail + inspect hint', () => {
  const { lines, failCount } = doctorItems({ ...baseFacts, portFile: null, portLive: false, switchEnabled: false, port: null });
  assert.equal(failCount, 1);
  assert.ok(lines.some(l => l.includes('chrome://inspect')));
});

test('doctorItems: port file exists but dead -> fail + restart hint', () => {
  const { lines, failCount } = doctorItems({ ...baseFacts, portLive: false, switchEnabled: false });
  assert.equal(failCount, 1);
  assert.ok(lines.some(l => l.includes('not responding')));
});

test('doctorItems: live port but switch off -> fail + toggle hint', () => {
  const { lines, failCount } = doctorItems({ ...baseFacts, switchEnabled: false });
  assert.equal(failCount, 1);
  assert.ok(lines.some(l => l.includes('user-enabled')));
});

test('doctorItems: Chrome not running -> warn, not fail (cdp auto-launches)', () => {
  const { failCount, lines } = doctorItems({ ...baseFacts, chromeRunning: false });
  assert.equal(failCount, 0);
  assert.ok(lines.some(l => l.includes('Chrome is not running')));
});

test('doctorItems: darwin shows macOS auto-approve info; linux does not', () => {
  const d = doctorItems({ ...baseFacts }).lines.join('\n');
  assert.match(d, /macOS auto-approve/);
  const l = doctorItems({ ...baseFacts, platform: 'linux' }).lines.join('\n');
  assert.doesNotMatch(l, /macOS auto-approve/);
});

test('doctorItems: fail count aggregates', () => {
  // Chrome running, port file missing -> 1 fail (port checks short-circuit to
  // a warn when Chrome itself is not running — cdp can auto-launch it).
  const { failCount } = doctorItems({ ...baseFacts, portFile: null, portLive: false, switchEnabled: false });
  assert.equal(failCount, 1);
  const { failCount: zero } = doctorItems({ ...baseFacts, chromeRunning: false, portFile: null, portLive: false, switchEnabled: false });
  assert.equal(zero, 0);
});
