import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CDP, resolveSession, sendCommand } from '../skills/chrome-cdp/scripts/cdp.mjs';

// ---------------------------------------------------------------------------
// CDP.send: the 15s timeout timer must be cleared once the command settles,
// so long-running daemons do not accumulate zombie timers.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  constructor(url) { this.url = url; this.sent = []; }
  _open() { this.onopen?.(); }
  _message(data) { this.onmessage?.({ data }); }
  _close() { this.onclose?.(); }
  send(data) { this.sent.push(data); }
  close() { this._close(); }
}

function installTimerSpies(t) {
  const timers = [];
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
    else origClearTimeout(handle);
  };
  t.after(() => {
    global.setTimeout = origSetTimeout;
    global.clearTimeout = origClearTimeout;
  });
  return timers;
}

test('CDP.send clears its timeout timer when the response arrives', async (t) => {
  const timers = installTimerSpies(t);
  const originalWebSocket = global.WebSocket;
  const fake = new FakeWebSocket('ws://fake');
  global.WebSocket = class { constructor(url) { return fake; } };
  t.after(() => { global.WebSocket = originalWebSocket; });

  const cdp = new CDP();
  const connecting = cdp.connect('ws://fake');
  fake._open();
  await connecting;
  timers.length = 0; // connect's own timeout timer was already cleared

  // Respond immediately on send.
  const origSend = fake.send.bind(fake);
  fake.send = (data) => {
    const msg = JSON.parse(data);
    origSend(data);
    fake._message(JSON.stringify({ id: msg.id, result: { ok: true } }));
  };

  const result = await cdp.send('Test.method', { a: 1 }, 'session-1');
  assert.deepEqual(result, { ok: true });
  assert.equal(timers.length, 1, 'exactly one timeout timer was created');
  assert.equal(timers[0].cleared, true, 'the timer must be cleared after the response');
});

test('CDP.send rejects on timeout and leaves no pending state behind', async (t) => {
  const timers = installTimerSpies(t);
  const originalWebSocket = global.WebSocket;
  const fake = new FakeWebSocket('ws://fake');
  global.WebSocket = class { constructor(url) { return fake; } };
  t.after(() => { global.WebSocket = originalWebSocket; });

  const cdp = new CDP();
  const connecting = cdp.connect('ws://fake');
  fake._open();
  await connecting;
  timers.length = 0; // connect's own timeout timer was already cleared

  const p = cdp.send('Test.hang'); // no response ever arrives
  assert.equal(timers.length, 1);
  timers[0].fn(); // fire the timeout manually instead of waiting 15s
  await assert.rejects(p, /Timeout: Test\.hang/);
  assert.equal(timers[0].cleared, false, 'fired timer needs no clear');

  // A subsequent command still works (pending state was cleaned up).
  fake.send = (data) => {
    const msg = JSON.parse(data);
    fake._message(JSON.stringify({ id: msg.id, result: { ok: true } }));
  };
  const result = await cdp.send('Test.again');
  assert.deepEqual(result, { ok: true });
});

// ---------------------------------------------------------------------------
// resolveSession: unknown target ids must fail fast (no 500ms attach wait),
// known-but-not-attached ids still wait for the async attach events.
// ---------------------------------------------------------------------------

function makeSessions(entries = []) {
  const sessions = new Map();
  for (const [tid, sid] of entries) sessions.set(tid, sid);
  return sessions;
}

test('resolveSession reuses an existing session immediately', async () => {
  const sessions = makeSessions([['T1', 's1']]);
  const res = await resolveSession({
    sessions,
    isKnownTarget: async () => { throw new Error('must not be called on reuse'); },
    attach: async () => { throw new Error('must not attach on reuse'); },
    targetId: 'T1',
  });
  assert.deepEqual(res, { sessionId: 's1', attachMs: 0, attachMode: 'reuse' });
});

test('resolveSession fails fast for unknown target ids without waiting', async () => {
  const sleeps = [];
  const sessions = makeSessions();
  await assert.rejects(
    resolveSession({
      sessions,
      isKnownTarget: async () => false,
      attach: async () => { throw new Error('must not attach for unknown id'); },
      targetId: 'GHOST',
      waitTries: 3,
      waitDelayMs: 10,
      sleepFn: async () => { sleeps.push(Date.now()); },
    }),
    /No target with given id found/,
  );
  assert.equal(sleeps.length, 0, 'no sleep should happen when the id is unknown');
  assert.ok(!sessions.has('GHOST'));
});

test('resolveSession waits briefly for a known id then returns the attached session', async () => {
  const sessions = makeSessions();
  let attachHappened = false;
  const res = await resolveSession({
    sessions,
    isKnownTarget: async () => true,
    attach: async (tid) => { attachHappened = true; return `sess-${tid}`; },
    targetId: 'T2',
    waitTries: 2,
    waitDelayMs: 1,
    sleepFn: async () => { sessions.set('T2', 'attached-by-event'); },
  });
  assert.equal(res.attachMode, 'wait');
  assert.equal(res.sessionId, 'attached-by-event');
  assert.equal(attachHappened, false, 'attach fallback not needed when events settle');
});

test('resolveSession falls back to attachToTarget when the attach event never arrives', async () => {
  const sessions = makeSessions();
  const res = await resolveSession({
    sessions,
    isKnownTarget: async () => true,
    attach: async (tid) => { sessions.set(tid, 'fallback-session'); return 'fallback-session'; },
    targetId: 'T3',
    waitTries: 2,
    waitDelayMs: 1,
    sleepFn: async () => {},
  });
  assert.equal(res.attachMode, 'attach');
  assert.equal(res.sessionId, 'fallback-session');
  assert.equal(sessions.get('T3'), 'fallback-session');
});

// ---------------------------------------------------------------------------
// sendCommand: one socket connection can carry multiple request/response
// round trips (resolve_target + command), responses are matched by id even
// when they arrive out of order, and close-after semantics are per request.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = []; this.ended = false; }
  write(data) { this.written.push(data.toString().trim()); }
  end() { this.ended = true; this.emit('close'); }
}

test('sendCommand multiplexes requests on one connection and closes after the last one', async () => {
  const conn = new FakeSocket();
  const resolveReq = sendCommand(conn, { cmd: 'resolve_target', args: ['ABC'] }, { close: false });
  const evalReq = sendCommand(conn, { cmd: 'eval', targetId: 'FULLID', args: ['1+1'] });

  // Daemon answers concurrently → out-of-order responses.
  conn.emit('data', JSON.stringify({ id: 2, ok: true, result: '2' }) + '\n');
  conn.emit('data', JSON.stringify({ id: 1, ok: true, result: '{"targetId":"FULLID"}' }) + '\n');

  const evalResp = await evalReq;
  const resolveResp = await resolveReq;
  assert.equal(evalResp.result, '2');
  assert.equal(JSON.parse(resolveResp.result).targetId, 'FULLID');

  assert.equal(conn.written.length, 2, 'two requests went out on the same connection');
  assert.equal(JSON.parse(conn.written[0]).id, 1);
  assert.equal(JSON.parse(conn.written[0]).cmd, 'resolve_target');
  assert.equal(JSON.parse(conn.written[1]).id, 2);
  assert.equal(JSON.parse(conn.written[1]).cmd, 'eval');
  assert.equal(conn.ended, true, 'connection closes after the close-after request');
});

test('sendCommand does not close the connection for close:false requests', async () => {
  const conn = new FakeSocket();
  const p = sendCommand(conn, { cmd: 'resolve_target', args: ['X'] }, { close: false });
  conn.emit('data', JSON.stringify({ id: 1, ok: true, result: '{}' }) + '\n');
  await p;
  assert.equal(conn.ended, false, 'close:false keeps the connection open for the next request');
});

test('sendCommand rejects pending requests when the connection dies', async () => {
  const conn = new FakeSocket();
  const p = sendCommand(conn, { cmd: 'eval', targetId: 'T', args: ['1'] });
  conn.emit('close');
  await assert.rejects(p, /Connection closed before response/);
});

test('sendCommand propagates daemon-side errors', async () => {
  const conn = new FakeSocket();
  const p = sendCommand(conn, { cmd: 'eval', targetId: 'T', args: ['1'] });
  conn.emit('data', JSON.stringify({ id: 1, ok: false, error: 'boom' }) + '\n');
  await assert.rejects(p, /boom/);
});
