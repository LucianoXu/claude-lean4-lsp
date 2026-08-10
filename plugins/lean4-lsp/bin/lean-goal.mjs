#!/usr/bin/env node
// lean-goal — interactive proof-state queries for Lean 4, from the shell.
//
// Claude Code's generic LSP tool covers hover/definitions/symbols, but not
// Lean's custom $/lean/plainGoal request — the proof goal state that drives
// interactive theorem proving. This CLI fills that gap:
//
//   lean-goal goal <file>:<line>[:<col>]   tactic goals (and expected type)
//   lean-goal sorries <file>               every `sorry` with its open goal
//   lean-goal check <file>                 diagnostics after elaboration
//   lean-goal status                       running daemons
//   lean-goal stop                         stop all daemons
//
// The first query on a project starts a background daemon holding a Lean
// server for that project root; later queries reuse it, so they return in
// milliseconds instead of re-elaborating the file every time. Daemons exit
// after 30 minutes idle. `lake build` stays the final word on correctness —
// this tool is for the edit/inspect loop in between.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  findLakeRoot, resolveToolchain, LspFramer, frameMessage, pathToUri,
} from './lean-lsp-lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const IDLE_MS = parseInt(process.env.LEAN4_LSP_IDLE_MS || '', 10) || 30 * 60 * 1000;
const QUERY_TIMEOUT_MS = parseInt(process.env.LEAN4_LSP_TIMEOUT_MS || '', 10) || 300000;

function goalDir() {
  const dir = process.env.LEAN4_LSP_GOAL_DIR
    || path.join(os.tmpdir(), `lean4-lsp-goal-${os.userInfo().username}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function serverSpecFor(file) {
  const root = findLakeRoot(file);
  const tc = resolveToolchain(process.env);
  if (root && tc.lake) return { root, mode: 'lake', bin: tc.lake, args: ['serve'], tc };
  const cwd = root || path.dirname(path.resolve(file));
  if (!tc.lean) {
    fail('no usable Lean toolchain found. Install elan (https://lean-lang.org/lean4/doc/setup.html) '
      + 'or set LEAN4_LSP_LAKE / LEAN4_LSP_LEAN. Searched PATH, $ELAN_HOME/bin and ~/.elan/bin.');
  }
  return { root: cwd, mode: 'lean', bin: tc.lean, args: ['--server'], tc };
}

function socketPathFor(spec) {
  const hash = crypto.createHash('sha1').update(`${spec.mode}:${spec.root}`).digest('hex').slice(0, 16);
  return path.join(goalDir(), `${hash}.sock`);
}

function fail(msg) {
  process.stderr.write(`lean-goal: ${msg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Lean server session (daemon side)

class LeanSession {
  constructor(spec) {
    this.spec = spec;
    this.nextId = 1;
    this.pending = new Map();          // id -> {resolve, reject}
    this.docs = new Map();             // uri -> {version, text}
    this.diags = new Map();            // uri -> latest publishDiagnostics params
    this.progress = new Map();         // uri -> 'processing' | 'done'
    this.progressWaiters = [];
    this.dead = null;

    this.proc = spawn(spec.bin, spec.args, {
      cwd: spec.root, env: spec.tc.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderrTail = '';
    this.proc.stderr.on('data', (c) => { this.stderrTail = (this.stderrTail + c).slice(-4000); });
    this.proc.on('exit', (code, sig) => {
      this.dead = `Lean server exited (${sig || `code ${code}`}). stderr tail:\n${this.stderrTail}`;
      for (const { reject } of this.pending.values()) reject(new Error(this.dead));
      this.pending.clear();
      this.notifyProgressWaiters();
    });
    const framer = new LspFramer();
    framer.onMessage = (m) => this.onMessage(m);
    this.proc.stdout.on('data', (c) => framer.push(c));

    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToUri(spec.root),
      capabilities: {},
      clientInfo: { name: 'lean-goal', version: '0.2.0' },
    }).then(() => this.notify('initialized', {}));
  }

  onMessage(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      this.diags.set(msg.params.uri, msg.params);
      this.notifyProgressWaiters();
    } else if (msg.method === '$/lean/fileProgress') {
      const uri = msg.params.textDocument.uri;
      this.progress.set(uri, msg.params.processing.length === 0 ? 'done' : 'processing');
      this.notifyProgressWaiters();
    } else if (msg.id !== undefined && msg.method) {
      // Server-to-client request (e.g. registerCapability): acknowledge blindly.
      this.send({ id: msg.id, result: null });
    }
  }

  send(obj) { this.proc.stdin.write(frameMessage({ jsonrpc: '2.0', ...obj })); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notifyProgressWaiters() {
    this.progressWaiters = this.progressWaiters.filter((w) => !w());
  }

  /** Open the file (or resync it if the on-disk content changed). */
  syncFile(file) {
    const uri = pathToUri(file);
    const text = fs.readFileSync(file, 'utf8');
    const doc = this.docs.get(uri);
    if (!doc) {
      this.docs.set(uri, { version: 1, text });
      this.progress.set(uri, 'processing');
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'lean', version: 1, text },
      });
    } else if (doc.text !== text) {
      doc.version++;
      doc.text = text;
      this.progress.set(uri, 'processing');
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  /** Resolve once elaboration of `uri` finishes (fileProgress drained). */
  waitElaborated(uri, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let lastActivity = Date.now();
      const check = () => {
        if (this.dead) { reject(new Error(this.dead)); return true; }
        if (this.progress.get(uri) === 'done') { settle(); return true; }
        lastActivity = Date.now();
        return false;
      };
      // Fallback: servers that never emit fileProgress — treat 5s of silence
      // after the last diagnostics/progress event as completion.
      const poll = setInterval(() => {
        if (this.progress.get(uri) === 'done' || Date.now() - lastActivity > 5000) {
          cleanup(); settle();
        } else if (Date.now() - started > timeoutMs) {
          cleanup();
          reject(new Error(`timed out after ${timeoutMs}ms waiting for elaboration of ${uri}`));
        }
      }, 200);
      const settle = () => { cleanup(); setTimeout(resolve, 300); };
      const cleanup = () => { clearInterval(poll); };
      if (!check()) this.progressWaiters.push(check);
    });
  }

  async plainGoal(file, line, col, timeoutMs) {
    const uri = this.syncFile(file);
    await this.waitElaborated(uri, timeoutMs);
    const position = { line: line - 1, character: col - 1 };
    const textDocument = { uri };
    const [goal, termGoal] = await Promise.all([
      this.request('$/lean/plainGoal', { textDocument, position }).catch(() => null),
      this.request('$/lean/plainTermGoal', { textDocument, position }).catch(() => null),
    ]);
    return { goal, termGoal };
  }

  async diagnostics(file, timeoutMs) {
    const uri = this.syncFile(file);
    await this.waitElaborated(uri, timeoutMs);
    const d = this.diags.get(uri);
    return (d && d.diagnostics) || [];
  }

  shutdown() {
    try { this.notify('exit'); } catch {}
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 300);
  }
}

// ---------------------------------------------------------------------------
// Daemon mode: __daemon <mode> <root> <socketPath>

async function runDaemon(mode, root, sockPath) {
  const logPath = sockPath.replace(/\.sock$/, '.log');
  const logFd = fs.openSync(logPath, 'a');
  const dlog = (m) => fs.writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`);

  const spec = serverSpecFor(mode === 'lake' ? path.join(root, 'lakefile.toml') : path.join(root, '_.lean'));
  spec.root = root; spec.mode = mode;
  const session = new LeanSession(spec);
  dlog(`daemon starting: ${spec.bin} ${spec.args.join(' ')} in ${root}`);

  let idleTimer = null;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { dlog('idle timeout'); cleanup(0); }, IDLE_MS);
  };
  const cleanup = (code) => {
    try { fs.unlinkSync(sockPath); } catch {}
    session.shutdown();
    setTimeout(() => process.exit(code), 400);
  };
  process.on('SIGTERM', () => cleanup(0));
  process.on('SIGINT', () => cleanup(0));

  try { fs.unlinkSync(sockPath); } catch {}
  const server = net.createServer((conn) => {
    touch();
    let buf = '';
    conn.on('data', async (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req;
      try { req = JSON.parse(line); } catch { conn.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n'); return; }
      dlog(`request: ${line}`);
      try {
        const resp = await handle(req);
        conn.end(JSON.stringify(resp) + '\n');
        if (req.cmd === 'stop') cleanup(0);
      } catch (e) {
        conn.end(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n');
        if (session.dead) cleanup(1);
      }
    });
    conn.on('error', () => {});
  });

  const handle = async (req) => {
    const timeoutMs = req.timeoutMs || QUERY_TIMEOUT_MS;
    switch (req.cmd) {
      case 'ping':
        return { ok: true, mode, root, pid: process.pid, dead: session.dead };
      case 'stop':
        return { ok: true };
      case 'goal': {
        await session.ready;
        const r = await session.plainGoal(req.file, req.line, req.col, timeoutMs);
        return { ok: true, ...r };
      }
      case 'check': {
        await session.ready;
        const diagnostics = await session.diagnostics(req.file, timeoutMs);
        return { ok: true, diagnostics };
      }
      case 'sorries': {
        await session.ready;
        const text = fs.readFileSync(req.file, 'utf8');
        const found = [];
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const re = /\bsorry\b/g;
          let m;
          while ((m = re.exec(lines[i]))) found.push({ line: i + 1, col: m.index + 1 });
        }
        const results = [];
        for (const s of found) {
          const { goal } = await session.plainGoal(req.file, s.line, s.col, timeoutMs);
          results.push({ ...s, goal });
        }
        return { ok: true, sorries: results };
      }
      default:
        return { ok: false, error: `unknown command ${req.cmd}` };
    }
  };

  server.listen(sockPath, () => { dlog(`listening on ${sockPath}`); touch(); });
  server.on('error', (e) => { dlog(`socket error: ${e.message}`); process.exit(1); });
}

// ---------------------------------------------------------------------------
// Client side

function connectOnce(sockPath, req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('query timed out')); }, timeoutMs);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', (c) => { buf += c; });
    conn.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buf)); } catch { reject(new Error(`bad daemon reply: ${buf}`)); }
    });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queryDaemon(spec, req) {
  const sockPath = socketPathFor(spec);
  try {
    return await connectOnce(sockPath, req, QUERY_TIMEOUT_MS);
  } catch (e) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e;
  }
  try { fs.unlinkSync(sockPath); } catch {}
  process.stderr.write(`lean-goal: starting Lean server for ${spec.root} (${spec.mode} mode) — `
    + 'the first query on a project can take a while…\n');
  const child = spawn(process.execPath, [SELF, '__daemon', spec.mode, spec.root, sockPath], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(150);
    try { return await connectOnce(sockPath, req, QUERY_TIMEOUT_MS); }
    catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  }
  const log = sockPath.replace(/\.sock$/, '.log');
  throw new Error(`daemon did not come up; check ${fs.existsSync(log) ? log : 'toolchain installation'}`);
}

function parseLocation(arg) {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(arg);
  if (!m) fail(`expected <file>:<line>[:<col>], got: ${arg}`);
  const file = path.resolve(m[1]);
  if (!fs.existsSync(file)) fail(`no such file: ${file}`);
  const line = parseInt(m[2], 10);
  let col = m[3] ? parseInt(m[3], 10) : null;
  if (col === null) {
    const lineText = (fs.readFileSync(file, 'utf8').split('\n')[line - 1] || '');
    const sorryAt = lineText.search(/\bsorry\b/);
    col = sorryAt !== -1 ? sorryAt + 1 : Math.max(1, lineText.trimEnd().length + 1);
  }
  return { file, line, col };
}

const SEV = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

function fmtDiag(file, d) {
  const s = d.range.start, e = d.range.end;
  const sev = SEV[d.severity] || 'info';
  return `  ${sev} ${file}:${s.line + 1}:${s.character + 1}-${e.line + 1}:${e.character + 1}: ${d.message}`;
}

function renderGoal(goal) {
  if (!goal) return null;
  if (goal.rendered) return goal.rendered.replace(/```(lean)?\n?/g, '').trimEnd();
  if (Array.isArray(goal.goals)) {
    return goal.goals.length ? goal.goals.join('\n\n') : 'no goals — this branch of the proof is complete ✓';
  }
  return null;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'goal': {
      if (!rest[0]) fail('usage: lean-goal goal <file>:<line>[:<col>]');
      const { file, line, col } = parseLocation(rest[0]);
      const spec = serverSpecFor(file);
      const resp = await queryDaemon(spec, { cmd: 'goal', file, line, col });
      if (!resp.ok) fail(resp.error);
      console.log(`${file}:${line}:${col} (${spec.mode} mode, root ${spec.root})`);
      const g = renderGoal(resp.goal);
      if (g) {
        console.log('Tactic goals:');
        console.log(g);
      } else {
        console.log('No tactic goal at this position (not inside a tactic proof, or the position is off).');
        console.log('Tip: point at a tactic or a `sorry`; line:col are 1-based.');
      }
      if (resp.termGoal && resp.termGoal.goal) {
        console.log(`Expected type: ${resp.termGoal.goal}`);
      }
      return;
    }
    case 'sorries': {
      if (!rest[0]) fail('usage: lean-goal sorries <file>');
      const file = path.resolve(rest[0]);
      if (!fs.existsSync(file)) fail(`no such file: ${file}`);
      const spec = serverSpecFor(file);
      const resp = await queryDaemon(spec, { cmd: 'sorries', file });
      if (!resp.ok) fail(resp.error);
      if (!resp.sorries.length) { console.log(`${file}: no sorries ✓`); return; }
      console.log(`${file}: ${resp.sorries.length} sorr${resp.sorries.length === 1 ? 'y' : 'ies'}`);
      for (const s of resp.sorries) {
        console.log(`\n${file}:${s.line}:${s.col}`);
        console.log(renderGoal(s.goal) || '(no goal information)');
      }
      return;
    }
    case 'check': {
      if (!rest[0]) fail('usage: lean-goal check <file>');
      const file = path.resolve(rest[0]);
      if (!fs.existsSync(file)) fail(`no such file: ${file}`);
      const spec = serverSpecFor(file);
      const resp = await queryDaemon(spec, { cmd: 'check', file });
      if (!resp.ok) fail(resp.error);
      const diags = resp.diagnostics;
      const errors = diags.filter((d) => d.severity === 1);
      const warnings = diags.filter((d) => d.severity === 2);
      console.log(`${file}: ${errors.length} error(s), ${warnings.length} warning(s)`);
      for (const d of diags) console.log(fmtDiag(file, d));
      if (!diags.length) console.log('  clean ✓');
      console.log('\n(lean-goal reflects the live server state; run `lake build` for final verification)');
      process.exit(errors.length ? 1 : 0);
      return;
    }
    case 'status': {
      const dir = goalDir();
      const socks = fs.readdirSync(dir).filter((f) => f.endsWith('.sock'));
      if (!socks.length) { console.log('no lean-goal daemons running'); return; }
      for (const s of socks) {
        const p = path.join(dir, s);
        try {
          const r = await connectOnce(p, { cmd: 'ping' }, 3000);
          console.log(`${r.mode} ${r.root} (pid ${r.pid})${r.dead ? ' [server dead]' : ''}`);
        } catch {
          console.log(`stale socket removed: ${p}`);
          try { fs.unlinkSync(p); } catch {}
        }
      }
      return;
    }
    case 'stop': {
      const dir = goalDir();
      const socks = fs.readdirSync(dir).filter((f) => f.endsWith('.sock'));
      for (const s of socks) {
        const p = path.join(dir, s);
        try { await connectOnce(p, { cmd: 'stop' }, 5000); } catch {}
        try { fs.unlinkSync(p); } catch {}
      }
      console.log(`stopped ${socks.length} daemon(s)`);
      return;
    }
    case '__daemon':
      return runDaemon(rest[0], rest[1], rest[2]);
    default:
      console.log(`lean-goal — Lean 4 proof-state queries (goal / sorries / check / status / stop)

usage:
  lean-goal goal <file>:<line>[:<col>]   show tactic goals at a position
  lean-goal sorries <file>               show the goal at every sorry
  lean-goal check <file>                 elaborate and report diagnostics
  lean-goal status                       list running daemons
  lean-goal stop                         stop all daemons

Positions are 1-based (editor convention). Without <col>, the position
defaults to the first \`sorry\` on the line, or the end of the line.`);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => fail(String(e.message || e)));
