#!/usr/bin/env node
// audit.mjs — analyze the cdp audit log (~/.cdp/audit.jsonl by default).
//
// Usage:
//   node scripts/audit.mjs                 # summary: per-command stats
//   node scripts/audit.mjs --since 24h     # only the last 24 hours
//   node scripts/audit.mjs --session s1    # only session "s1"
//   node scripts/audit.mjs --errors        # the failing commands (with error msgs)
//   node scripts/audit.mjs --raw           # raw JSON lines (for piping)
//   CDP_AUDIT_FILE=/path node scripts/audit.mjs   # alternate log file
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

const file = process.env.CDP_AUDIT_FILE || resolve(homedir(), '.cdp', 'audit.jsonl');
let st;
try { st = statSync(file); } catch { console.error(`no audit log at ${file}`); process.exit(1); }

const sinceArg = (process.argv.find(a => a.startsWith('--since=')) || '').split('=')[1];
const sessionArg = (process.argv.find(a => a.startsWith('--session=')) || '').split('=')[1];
const errorsOnly = process.argv.includes('--errors');
const raw = process.argv.includes('--raw');

let since = 0;
if (sinceArg) {
  const n = Number(sinceArg.replace(/[a-z]/gi, ''));
  const unit = sinceArg.replace(/[0-9]/g, '');
  const mult = unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : unit === 'm' ? 60e3 : 86400e3;
  since = Date.now() - n * mult;
}

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

if (since) rows = rows.filter(r => new Date(r.ts).getTime() >= since);
if (sessionArg) rows = rows.filter(r => r.session === sessionArg);

if (raw) { for (const r of rows) console.log(JSON.stringify(r)); process.exit(0); }

if (errorsOnly) {
  const bad = rows.filter(r => !r.ok);
  console.log(`failing commands: ${bad.length}/${rows.length}\n`);
  for (const r of bad) {
    console.log(`${r.ts}  ${r.cmd}${r.target ? ' @' + r.target.slice(0, 8) : ''}  [${r.session}]  ${r.error}`);
  }
  process.exit(0);
}

const byCmd = new Map();
for (const r of rows) {
  const e = byCmd.get(r.cmd) || { n: 0, fail: 0, ms: 0 };
  e.n++; if (!r.ok) e.fail++; e.ms += r.ms;
  byCmd.set(r.cmd, e);
}

const total = rows.length;
const ok = rows.filter(r => r.ok).length;
const avgMs = total ? (rows.reduce((s, r) => s + r.ms, 0) / total).toFixed(1) : '0';
const maxMs = total ? Math.max(...rows.map(r => r.ms)) : 0;
console.log(`audit: ${file}`);
console.log(`range: ${rows.length ? rows[0].ts : '-'} .. ${rows.length ? rows[rows.length - 1].ts : '-'}`);
console.log(`commands: ${total}   ok: ${ok} (${(100 * ok / (total || 1)).toFixed(1)}%)   avg ${avgMs}ms   max ${maxMs}ms\n`);
console.log('per-command:');
console.log('  cmd                  n    fail%    avgMs');
for (const [cmd, e] of [...byCmd.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${cmd.padEnd(20)} ${String(e.n).padStart(4)}  ${String((100 * e.fail / e.n).toFixed(1)).padStart(5)}%  ${String((e.ms / e.n).toFixed(0)).padStart(6)}`);
}
const sessions = new Set(rows.map(r => r.session));
console.log(`\nsessions: ${[...sessions].join(', ')}`);
