import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod;

test('load cdp module', async () => {
  mod = await import(`../skills/chrome-cdp/scripts/cdp.mjs?iso=${Date.now()}-${Math.random()}`);
});

// ---------------------------------------------------------------------------
// self-improving knowledge: pure helpers
// ---------------------------------------------------------------------------

test('siteFromUrl normalizes hosts to site keys', () => {
  const { siteFromUrl } = mod;
  assert.equal(siteFromUrl('https://github.com/foo/bar'), 'github');
  assert.equal(siteFromUrl('https://www.youtube.com/watch?v=x'), 'youtube');
  assert.equal(siteFromUrl('https://mail.google.com/'), 'mail');
  assert.equal(siteFromUrl('http://gmail.com'), 'gmail');
  assert.equal(siteFromUrl('not a url'), null);
});

test('knowledgeFiles: private layer first, repo layer fallback', async (t) => {
  const priv = mkdtempSync(join(tmpdir(), 'cdp-know-priv-'));
  const repo = mkdtempSync(join(tmpdir(), 'cdp-know-repo-'));
  t.after(() => { rmSync(priv, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  mkdirSync(join(priv, 'github')); mkdirSync(join(repo, 'github'));
  writeFileSync(join(priv, 'github', 'a.md'), 'a');
  writeFileSync(join(repo, 'github', 'a.md'), 'a');
  writeFileSync(join(repo, 'github', 'b.md'), 'b');

  process.env.CDP_KNOWLEDGE_DIR = priv;
  process.env.CDP_REPO_KNOWLEDGE_DIR = repo;
  t.after(() => { delete process.env.CDP_KNOWLEDGE_DIR; delete process.env.CDP_REPO_KNOWLEDGE_DIR; });

  const m = await import(`../skills/chrome-cdp/scripts/cdp.mjs?iso2=${Date.now()}-${Math.random()}`);
  const files = m.knowledgeFiles('github');
  assert.deepEqual(files.map(f => [f.dir, f.file]), [['private', 'a.md'], ['repo', 'a.md'], ['repo', 'b.md']]);
  assert.deepEqual(m.knowledgeSites(), ['github']);
});

test('reviewFailures filters failed commands of one session', () => {
  const { reviewFailures } = mod;
  const entries = [
    { ts: '2026-08-24T01:00:00Z', cmd: 'nav', session: 's1', ok: true },
    { ts: '2026-08-24T01:00:01Z', cmd: 'click', session: 's1', ok: false, error: 'no such selector' },
    { ts: '2026-08-24T01:00:02Z', cmd: 'eval', session: 's2', ok: false, error: 'syntax' },
  ];
  assert.deepEqual(reviewFailures(entries, 's1'), [
    { ts: '2026-08-24T01:00:01Z', cmd: 'click', error: 'no such selector' },
  ]);
  assert.deepEqual(reviewFailures(entries, 's2').map(f => f.cmd), ['eval']);
  assert.deepEqual(reviewFailures(entries, 's3'), []);
});

test('reportStats aggregates per-host nav/knowledge stats', () => {
  const { reportStats } = mod;
  const entries = [
    { cmd: 'nav', host: 'github', ok: true },
    { cmd: 'nav', host: 'github', ok: false },
    { cmd: 'knowledge', host: 'github' },
    { cmd: 'nav', host: 'gmail', ok: true },
    { cmd: 'eval', host: '' },
    { cmd: 'eval' },
  ];
  const s = reportStats(entries);
  assert.deepEqual(s.github, { nav: 2, navFail: 1, knowledgeReads: 1 });
  assert.deepEqual(s.gmail, { nav: 1, navFail: 0, knowledgeReads: 0 });
  assert.equal(Object.keys(s).length, 2);
});
