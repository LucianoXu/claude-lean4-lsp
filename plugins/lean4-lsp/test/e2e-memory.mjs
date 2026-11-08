#!/usr/bin/env node
// Live check of the proxy's memory bounds against a real Lean toolchain,
// counting the Lean processes under the proxy rather than trusting the
// protocol:
//
//   node test/e2e-memory.mjs              throwaway Lake project, full check
//   node test/e2e-memory.mjs A.lean B.lean C.lean
//                                         eviction only, on real files of one
//                                         project (e.g. Mathlib importers, to
//                                         see the RSS that comes back)
//
// Verifies: one worker per document the Lean side holds; past
// LEAN4_LSP_MAX_OPEN the least recently used document's worker exits; a
// request on it reopens it; idle documents close and an idle server stops
// with its `lean --server` and workers; a deleted project directory stops
// its server at once.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LspTestClient, sleep } from './helpers.mjs';
import { pathToUri } from '../bin/lean-lsp-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, '..', 'bin', 'lsp-proxy.mjs');
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

/** Lean processes descending from `root`: { workers, servers, lake, rssMiB }. */
function leanTree(root) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] };
    }).filter(Boolean);
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const out = { workers: 0, servers: 0, lake: 0, rssMiB: 0 };
  const stack = [...(kids.get(root) || [])];
  while (stack.length) {
    const r = stack.pop();
    stack.push(...(kids.get(r.pid) || []));
    if (/\blean\b.*--worker/.test(r.args)) out.workers++;
    else if (/\blean\b.*--server/.test(r.args)) out.servers++;
    else if (/\blake\b.*\bserve\b/.test(r.args)) out.lake++;
    else continue;
    out.rssMiB += Math.round(r.rss / 1024);
  }
  return out;
}

async function until(what, pred, ms) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = leanTree(c.proc.pid);
    if (pred(last)) { step(`${what}: ${JSON.stringify(last)}`); return last; }
    await sleep(250);
  }
  fail(`${what} — still ${JSON.stringify(last)} after ${ms / 1000} s`);
}

const realFiles = process.argv.slice(2).map((f) => path.resolve(f));
let root = null;
let files = realFiles;
if (!files.length) {
  const tc = fs.readdirSync(path.join(process.env.ELAN_HOME || path.join(os.homedir(), '.elan'), 'toolchains'))
    .filter((n) => /^leanprover--lean4---v/.test(n)).sort().pop();
  if (!tc) fail('no installed Lean toolchain');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-mem-'));
  fs.writeFileSync(path.join(root, 'lakefile.toml'), 'name = "mem"\n[[lean_lib]]\nname = "Mem"\n');
  fs.writeFileSync(path.join(root, 'lean-toolchain'), tc.replace('leanprover--lean4---', 'leanprover/lean4:') + '\n');
  fs.mkdirSync(path.join(root, 'Mem'));
  files = ['A', 'B', 'C'].map((n) => {
    const f = path.join(root, 'Mem', `${n}.lean`);
    fs.writeFileSync(f, `def ${n.toLowerCase()} : Nat := 1\ntheorem ${n.toLowerCase()}_eq : ${n.toLowerCase()} = 1 := rfl\n`);
    return f;
  });
}
if (files.length < 3) fail('need three files');
const idleMs = realFiles.length ? 0 : 4000;

const c = new LspTestClient(process.execPath, [PROXY], {
  cwd: os.tmpdir(),
  env: {
    ...process.env, LEAN4_LSP_MAX_OPEN: '2', LEAN4_LSP_SWEEP_MS: '500',
    LEAN4_LSP_DOC_IDLE_MS: String(idleMs), LEAN4_LSP_SERVER_IDLE_MS: String(idleMs ? 2000 : 0),
  },
});
const uri = (f) => pathToUri(f);
const open = (f) => c.notify('textDocument/didOpen', {
  textDocument: { uri: uri(f), languageId: 'lean', version: 1, text: fs.readFileSync(f, 'utf8') },
});
// documentSymbol waits for the file to be elaborated far enough to answer.
const touch = (f) => c.request('textDocument/documentSymbol', { textDocument: { uri: uri(f) } }, 600000);
const slow = realFiles.length ? 600000 : 60000;

try {
  await c.request('initialize', { processId: null, rootUri: pathToUri(os.tmpdir()), capabilities: {} }, 10000);
  c.notify('initialized', {});

  open(files[0]); await touch(files[0]);
  await until('A open', (t) => t.workers === 1, slow);
  open(files[1]); await touch(files[1]);
  const two = await until('A, B open', (t) => t.workers === 2, slow);
  open(files[2]); await touch(files[2]);
  const capped = await until('C opened, A evicted (cap 2)', (t) => t.workers === 2 && t.servers === 1, slow);
  if (realFiles.length) step(`RSS with 2 documents held: ${two.rssMiB} MiB → ${capped.rssMiB} MiB after a third was opened`);

  const r = await touch(files[0]);
  if (r.error) fail(`request on evicted A: ${JSON.stringify(r.error)}`);
  await until('A reopened by a request, B evicted', (t) => t.workers === 2, slow);

  if (realFiles.length) { console.log('\nPASS: eviction bounds the workers on real files'); process.exit(0); }

  await until('idle: documents closed, server stopped with its lean --server', (t) => t.workers + t.servers + t.lake === 0, 30000);
  if (c.messages.some((m) => m.method === 'window/showMessage')) fail('a deliberate stop surfaced a message');

  const back = await touch(files[1]);
  if (back.error) fail(`request after the idle stop: ${JSON.stringify(back.error)}`);
  await until('next use restarted the server and reopened B', (t) => t.workers === 1 && t.servers === 1, 60000);

  fs.rmSync(root, { recursive: true, force: true });
  await until('project directory deleted: server gone', (t) => t.workers + t.servers + t.lake === 0, 15000);
  const gone = await touch(files[1]);
  if (!gone.error) fail('request on a file of the deleted project should fail');
  step(`request on the deleted file: ${gone.error.message}`);

  console.log('\nPASS: the Lean side stays bounded and is released');
  process.exit(0);
} catch (e) {
  fail(e.message);
} finally {
  c.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
}
