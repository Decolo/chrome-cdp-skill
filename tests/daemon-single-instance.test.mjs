import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireDaemonPidLock,
  releaseDaemonPidLock,
  isProcessAlive,
  socketStillMine,
  tryAcquireSpawnLock,
  releaseSpawnLock,
  readDaemonPidFile,
} from '../skills/chrome-cdp/scripts/cdp.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Exclusive daemon pid lock
// ---------------------------------------------------------------------------

test('acquireDaemonPidLock is exclusive: a second daemon is rejected', (t) => {
  const dir = tempDir(t);
  const pidFile = join(dir, 'daemon.pid');

  const first = acquireDaemonPidLock(pidFile);
  assert.deepEqual(first, { ok: true });
  assert.equal(readDaemonPidFile(pidFile), process.pid);

  const second = acquireDaemonPidLock(pidFile);
  assert.equal(second.ok, false, 'second daemon must be rejected');
  assert.equal(second.existingPid, process.pid, 'rejection reports the holder pid');
});

test('releaseDaemonPidLock frees the lock for the next daemon', (t) => {
  const dir = tempDir(t);
  const pidFile = join(dir, 'daemon.pid');

  assert.equal(acquireDaemonPidLock(pidFile).ok, true);
  releaseDaemonPidLock(pidFile);
  assert.equal(readDaemonPidFile(pidFile), null, 'pid file removed');
  assert.equal(acquireDaemonPidLock(pidFile).ok, true, 'lock can be re-acquired');
});

test('acquireDaemonPidLock reports a stale pid file instead of hanging', (t) => {
  const dir = tempDir(t);
  const pidFile = join(dir, 'daemon.pid');
  writeFileSync(pidFile, '99999999'); // pid that does not exist

  const result = acquireDaemonPidLock(pidFile);
  assert.equal(result.ok, false);
  assert.equal(result.existingPid, 99999999);
});

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

test('isProcessAlive distinguishes live and dead pids', () => {
  assert.equal(isProcessAlive(process.pid), true, 'own pid is alive');
  assert.equal(isProcessAlive(99999999), false, 'nonexistent pid is dead');
  assert.equal(isProcessAlive(0), false, 'pid 0 is rejected');
  assert.equal(isProcessAlive(NaN), false);
  assert.equal(isProcessAlive(-1), false);
});

// ---------------------------------------------------------------------------
// Socket inode ownership (orphan daemon self-check)
// ---------------------------------------------------------------------------

test('socketStillMine is true while the file is untouched and false after replacement', (t) => {
  const dir = tempDir(t);
  const socketPath = join(dir, 'x.sock');
  writeFileSync(socketPath, '');
  const ino = statSync(socketPath).ino;

  assert.equal(socketStillMine(socketPath, ino), true);

  // Replace the file (new daemon unlinked and re-created it): different inode.
  rmSync(socketPath);
  writeFileSync(socketPath, '');
  assert.equal(socketStillMine(socketPath, statSync(socketPath).ino), true, 'new inode is mine');
  assert.equal(socketStillMine(socketPath, ino), false, 'old inode no longer matches');

  // Deleted file: not mine.
  rmSync(socketPath);
  assert.equal(socketStillMine(socketPath, ino), false);
});

test('socketStillMine with no recorded inode is permissive', () => {
  assert.equal(socketStillMine('/nonexistent', null), true);
});

// ---------------------------------------------------------------------------
// Spawn lock (atomic mkdir: exactly one CLI spawns)
// ---------------------------------------------------------------------------

test('tryAcquireSpawnLock is exclusive and releaseSpawnLock frees it', (t) => {
  const dir = tempDir(t);
  const lockDir = join(dir, 'spawn.lock');

  assert.equal(tryAcquireSpawnLock(lockDir), true, 'first CLI wins');
  assert.equal(tryAcquireSpawnLock(lockDir), false, 'second CLI waits instead of spawning');
  assert.equal(statSync(dir + '/spawn.lock').isDirectory(), true);

  releaseSpawnLock(lockDir);
  assert.equal(tryAcquireSpawnLock(lockDir), true, 'lock can be re-acquired after release');
});
