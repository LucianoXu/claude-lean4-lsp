#!/usr/bin/env node
// lean-goal — interactive proof-state queries for Lean 4, from the shell.
//
// Claude Code's generic LSP tool covers hover/definitions/symbols, but not the
// three things that actually drive interactive theorem proving: Lean's custom
// $/lean/plainGoal request, elaborating a *candidate* edit without committing
// it, and searching the imported environment. This CLI fills those gaps:
//
//   lean-goal goal <file>:<line>[:<col>]   tactic goals (and expected type)
//   lean-goal sorries <file>               every `sorry` with its open goal
//   lean-goal check <file>...              diagnostics after elaboration
//   lean-goal try <file>:<line> '<tac>'    elaborate a candidate tactic in
//                                          place of a `sorry` — in memory only
//   lean-goal hint <file>:<line> [tac...]  run exact?/simp?/rw? at a `sorry`
//   lean-goal search <file> <prefix>       find names in the imported env
//   lean-goal cmd <file> '<command>'       run #check/#print/example in
//                                          the file's import context
//   lean-goal build [file|dir]             lake build the enclosing project
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
  findLakeRoot, resolveToolchain, LspFramer, frameMessage, pathToUri, moduleNameFor,
  scanSorries, spliceSorry, truncate, rankNames, condenseSignature,
} from './lean-lsp-lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const IDLE_MS = parseInt(process.env.LEAN4_LSP_IDLE_MS || '', 10) || 30 * 60 * 1000;
const QUERY_TIMEOUT_MS = parseInt(process.env.LEAN4_LSP_TIMEOUT_MS || '', 10) || 300000;
const SILENCE_MS = parseInt(process.env.LEAN4_LSP_SILENCE_MS || '', 10) || 5000;
const MAX_MSG = parseInt(process.env.LEAN4_LSP_MAX_MSG || '', 10) || 4000;
const MAX_COMPLETIONS = parseInt(process.env.LEAN4_LSP_MAX_COMPLETIONS || '', 10) || 40;
const MAX_HINT_LINES = parseInt(process.env.LEAN4_LSP_MAX_HINT_LINES || '', 10) || 24;

// Daemons idle for 30 minutes, so one routinely outlives an upgrade and would
// keep answering with the previous version's code — silently defeating the
// update. Rather than rely on remembering to bump a constant, identify the
// build by this script's own size and mtime: every request carries the
// client's id, and a daemon whose id differs is replaced. Editing the file is
// therefore enough to invalidate a running daemon.
const BUILD_ID = (() => {
  try {
    const s = fs.statSync(SELF);
    return `${s.size}-${Math.floor(s.mtimeMs)}`;
  } catch { return 'unknown'; }
})();

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
    this.diags = new Map();            // uri -> diagnostic[]
    this.progress = new Map();         // uri -> 'processing' | 'done'
    this.sawAnyProgress = false;       // has this server ever reported progress?
    this.sawDiags = new Set();         // uris the server has published for
    this.settled = new Set();          // uris fully elaborated at current version
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
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          completion: { completionItem: { snippetSupport: false } },
          publishDiagnostics: { versionSupport: true },
        },
      },
      clientInfo: { name: 'lean-goal', version: '0.3.0' },
    }).then(() => this.notify('initialized', {}));
  }

  /**
   * Ignore an event that describes a document version we have already
   * superseded. Without this, a didChange racing the server's in-flight
   * publish for the previous version can hand back diagnostics for text that
   * no longer exists — which shows up as "clean ✓" on a file that does not
   * compile, the one failure mode that must never happen.
   */
  isStale(uri, version) {
    if (version === undefined || version === null) return false;
    const doc = this.docs.get(uri);
    return !!doc && version < doc.version;
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
      const { uri, version, diagnostics } = msg.params;
      if (!this.isStale(uri, version)) {
        this.diags.set(uri, diagnostics);
        this.sawDiags.add(uri);
      }
      this.notifyProgressWaiters();
    } else if (msg.method === '$/lean/fileProgress') {
      const uri = msg.params.textDocument.uri;
      this.sawAnyProgress = true;
      if (!this.isStale(uri, msg.params.textDocument.version)) {
        this.progress.set(uri, msg.params.processing.length === 0 ? 'done' : 'processing');
      }
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

  /** Push `text` as the current content of `file`, opening it if needed. */
  setText(file, text) {
    const uri = pathToUri(file);
    const doc = this.docs.get(uri);
    if (!doc) {
      this.docs.set(uri, { version: 1, text });
      this.progress.set(uri, 'processing');
      this.settled.delete(uri);
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'lean', version: 1, text },
      });
    } else if (doc.text !== text) {
      doc.version++;
      doc.text = text;
      this.progress.set(uri, 'processing');
      this.settled.delete(uri);
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  /** Open the file (or resync it if the on-disk content changed). */
  syncFile(file) {
    return this.setText(file, fs.readFileSync(file, 'utf8'));
  }

  /** Resolve once elaboration of `uri` finishes (fileProgress drained). */
  waitElaborated(uri, timeoutMs) {
    if (this.settled.has(uri)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let lastEvent = Date.now();
      let finished = false;
      const finish = (err) => {
        if (finished) return true;
        finished = true;
        clearInterval(poll);
        if (err) reject(err);
        // Diagnostics for the final command can trail fileProgress slightly;
        // give them a moment to land before reading them.
        else setTimeout(() => { this.settled.add(uri); resolve(); }, 300);
        return true;
      };
      const check = () => {
        lastEvent = Date.now();
        if (this.dead) return finish(new Error(this.dead));
        if (this.progress.get(uri) === 'done') return finish();
        return false;
      };
      const poll = setInterval(() => {
        if (this.dead) return finish(new Error(this.dead));
        if (this.progress.get(uri) === 'done') return finish();
        // Fallback for servers that never emit $/lean/fileProgress at all.
        // Two guards, both load-bearing:
        //   - the *session* has never seen a progress event, so we are not
        //     misreading a quiet gap during one slow declaration as the end;
        //   - this document has published diagnostics at least once, so we are
        //     not misreading a cold server that has yet to say anything as a
        //     clean file. That second case reported an empty diagnostic set on
        //     the first query against a fresh server.
        if (!this.sawAnyProgress && this.sawDiags.has(uri)
          && Date.now() - lastEvent > SILENCE_MS) return finish();
        if (Date.now() - started > timeoutMs) {
          return finish(new Error(`timed out after ${timeoutMs}ms waiting for elaboration of ${uri}`
            + ' (raise LEAN4_LSP_TIMEOUT_MS for very slow files)'));
        }
        return false;
      }, 100);
      if (!check()) this.progressWaiters.push(check);
    });
  }

  async diagnosticsFor(file, timeoutMs) {
    const uri = this.syncFile(file);
    await this.waitElaborated(uri, timeoutMs);
    return this.diags.get(uri) || [];
  }

  /**
   * Elaborate `text` as the content of `file`, hand the result to `fn`, then
   * restore the on-disk content. The file on disk is never touched, so a
   * candidate tactic that turns out to be wrong leaves no trace to clean up.
   */
  async withText(file, text, timeoutMs, fn) {
    const original = fs.readFileSync(file, 'utf8');
    const uri = this.setText(file, text);
    try {
      await this.waitElaborated(uri, timeoutMs);
      return await fn(uri, this.diags.get(uri) || []);
    } finally {
      this.setText(file, original);
      // Let the restore elaborate in the background; the next query waits on it.
    }
  }

  async plainGoal(file, line, col, timeoutMs) {
    const uri = this.syncFile(file);
    await this.waitElaborated(uri, timeoutMs);
    return this.goalAt(uri, line, col);
  }

  async goalAt(uri, line, col) {
    const position = { line: line - 1, character: col - 1 };
    const textDocument = { uri };
    const [goal, termGoal] = await Promise.all([
      this.request('$/lean/plainGoal', { textDocument, position }).catch(() => null),
      this.request('$/lean/plainTermGoal', { textDocument, position }).catch(() => null),
    ]);
    return { goal, termGoal };
  }

  shutdown() {
    try { this.notify('exit'); } catch {}
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 300);
  }
}

// ---------------------------------------------------------------------------
// Daemon mode: __daemon <mode> <root> <socketPath>

/** Key a diagnostic by content, not position: a multi-line splice shifts every
 *  line below it, so positions cannot identify "the same" pre-existing item. */
const diagKey = (d) => `${d.severity} ${d.message}`;

// Lean quotes this warning differently across versions — `sorry` on 4.33,
// 'sorry' on 4.27. Both the "did this candidate actually prove anything"
// check and the build gate hang off matching it, and a miss reads as
// success, so accept either form rather than pinning one toolchain.
const SORRY_WARN = /declaration uses ['`‘"]?sorry/;

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

  // Requests are serialized: a speculative edit swaps the document out and
  // back, so overlapping requests would read each other's scratch state.
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  const server = net.createServer((conn) => {
    touch();
    let buf = '';
    conn.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req;
      try { req = JSON.parse(line); } catch { conn.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n'); return; }
      dlog(`request: ${line.slice(0, 500)}`);
      serialize(async () => {
        try {
          const resp = await handle(req);
          conn.end(JSON.stringify(resp) + '\n');
          if (req.cmd === 'stop') cleanup(0);
        } catch (e) {
          conn.end(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n');
          if (session.dead) cleanup(1);
        }
      });
    });
    conn.on('error', () => {});
  });

  const handle = async (req) => {
    const timeoutMs = req.timeoutMs || QUERY_TIMEOUT_MS;
    if (req.cmd === 'ping') return { ok: true, build: BUILD_ID, mode, root, pid: process.pid, dead: session.dead };
    if (req.cmd === 'stop') return { ok: true };
    if (req.build !== BUILD_ID) {
      return { ok: false, error: `build mismatch (daemon ${BUILD_ID}, client ${req.build})` };
    }
    await session.ready;

    switch (req.cmd) {
      case 'goal': {
        const r = await session.plainGoal(req.file, req.line, req.col, timeoutMs);
        return { ok: true, ...r };
      }

      case 'check': {
        const diagnostics = await session.diagnosticsFor(req.file, timeoutMs);
        return { ok: true, diagnostics };
      }

      case 'sorries': {
        const uri = session.syncFile(req.file);
        await session.waitElaborated(uri, timeoutMs);
        const results = [];
        for (const s of scanSorries(fs.readFileSync(req.file, 'utf8'))) {
          const { goal } = await session.goalAt(uri, s.line, s.col);
          results.push({ ...s, goal });
        }
        return {
          ok: true,
          sorries: results,
          baselineErrors: (session.diags.get(uri) || []).filter((d) => d.severity === 1),
        };
      }

      case 'try': {
        const original = fs.readFileSync(req.file, 'utf8');
        const spliced = spliceSorry(original, req.line, req.col, req.tactic);
        if (spliced === null) {
          return {
            ok: false,
            error: `no \`sorry\` at ${req.file}:${req.line}:${req.col} — \`try\` replaces a `
              + 'sorry with the candidate tactic, so put one there first '
              + '(`lean-goal sorries <file>` lists them).',
          };
        }
        const before = await session.diagnosticsFor(req.file, timeoutMs);
        const baseline = new Map();
        for (const d of before) baseline.set(diagKey(d), (baseline.get(diagKey(d)) || 0) + 1);
        return session.withText(req.file, spliced, timeoutMs, (_uri, after) => {
          // Match against the baseline as a multiset. Every `sorry` in a file
          // produces a byte-identical "declaration uses sorry" warning, so set
          // membership cannot tell "this one is gone" from "all still here".
          const remaining = new Map(baseline);
          const introduced = [];
          for (const d of after) {
            const k = diagKey(d);
            const n = remaining.get(k) || 0;
            if (n > 0) remaining.set(k, n - 1); else introduced.push(d);
          }
          const sorryWarns = (ds) => ds.filter((d) => SORRY_WARN.test(d.message)).length;
          return {
            ok: true,
            introduced: introduced.sort((a, b) => (a.severity || 9) - (b.severity || 9)),
            preexisting: after.length - introduced.length,
            sorriesBefore: sorryWarns(before),
            sorriesAfter: sorryWarns(after),
            baselineErrors: before.filter((d) => d.severity === 1),
          };
        });
      }

      case 'hint': {
        const original = fs.readFileSync(req.file, 'utf8');
        const baselineErrors = (await session.diagnosticsFor(req.file, timeoutMs))
          .filter((d) => d.severity === 1);
        const out = [];
        for (const tac of req.tactics) {
          const spliced = spliceSorry(original, req.line, req.col, tac);
          if (spliced === null) {
            return { ok: false, error: `no \`sorry\` at ${req.file}:${req.line}:${req.col}` };
          }
          const r = await session.withText(req.file, spliced, timeoutMs, (_uri, diags) => diags);
          out.push({ tactic: tac, diagnostics: r });
        }
        return { ok: true, hints: out, baselineErrors };
      }

      case 'cmd': {
        const original = fs.readFileSync(req.file, 'utf8');
        const base = original.endsWith('\n') ? original : original + '\n';
        const firstAppendedLine = base.split('\n').length; // 1-based line of the blank separator
        const text = `${base}\n${req.command}\n`;
        return session.withText(req.file, text, timeoutMs, (_uri, diags) => ({
          ok: true,
          diagnostics: diags.filter((d) => d.range.start.line + 1 > firstAppendedLine),
          other: diags.filter((d) => d.range.start.line + 1 <= firstAppendedLine)
            .filter((d) => d.severity === 1).length,
        }));
      }

      case 'search': {
        const original = fs.readFileSync(req.file, 'utf8');
        const base = original.endsWith('\n') ? original : original + '\n';
        const probe = `#check ${req.prefix}`;
        const text = `${base}\n${probe}\n`;
        const lineIdx = base.split('\n').length; // 0-based line of `probe`
        return session.withText(req.file, text, timeoutMs, async (uri) => {
          const res = await session.request('textDocument/completion', {
            textDocument: { uri },
            position: { line: lineIdx, character: probe.length },
          }).catch((e) => ({ error: String(e.message || e) }));
          const items = (res && (res.items || (Array.isArray(res) ? res : []))) || [];
          const byLabel = new Map(items.map((i) => [i.label, i]));
          const { ranked, dropped } = rankNames([...byLabel.keys()], req.prefix);
          const top = ranked.slice(0, req.limit);
          // Lean sends completion items without types; `completionItem/resolve`
          // fills in the signature. Only the shortlist is resolved — one
          // round-trip each, and nobody reads past the first screen anyway.
          const detail = new Map();
          for (const label of top) {
            const r = await session.request('completionItem/resolve', byLabel.get(label)).catch(() => null);
            if (r && r.detail) detail.set(label, r.detail);
          }
          return {
            ok: true,
            total: ranked.length,
            dropped,
            items: top.map((label) => ({ label, detail: detail.get(label) })),
          };
        });
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
const isDown = (e) => ['ENOENT', 'ECONNREFUSED'].includes(e.code);

async function spawnDaemon(spec, sockPath, req) {
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
    catch (e) { if (!isDown(e)) throw e; }
  }
  const log = sockPath.replace(/\.sock$/, '.log');
  throw new Error(`daemon did not come up; check ${fs.existsSync(log) ? log : 'toolchain installation'}`);
}

async function queryDaemon(spec, rawReq) {
  const req = { build: BUILD_ID, ...rawReq };
  const sockPath = socketPathFor(spec);
  let resp = null;
  try {
    resp = await connectOnce(sockPath, req, QUERY_TIMEOUT_MS);
  } catch (e) {
    if (!isDown(e)) throw e;
  }
  if (resp && resp.ok === false && /^(unknown command|build mismatch)/.test(resp.error || '')) {
    // A daemon left over from an older install. Replace it rather than serving
    // the previous version's behaviour under the new version's name.
    process.stderr.write('lean-goal: restarting an outdated background server…\n');
    try { await connectOnce(sockPath, { cmd: 'stop' }, 5000); } catch {}
    await sleep(600);
    resp = null;
  }
  return resp || spawnDaemon(spec, sockPath, req);
}

function parseLocation(arg, { requireSorry = false } = {}) {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(arg);
  if (!m) fail(`expected <file>:<line>[:<col>], got: ${arg}`);
  const file = path.resolve(m[1]);
  if (!fs.existsSync(file)) fail(`no such file: ${file}`);
  const line = parseInt(m[2], 10);
  const text = fs.readFileSync(file, 'utf8');
  let col = m[3] ? parseInt(m[3], 10) : null;
  if (col === null) {
    const onLine = scanSorries(text).filter((s) => s.line === line);
    if (onLine.length) col = onLine[0].col;
    else if (requireSorry) {
      fail(`no \`sorry\` on line ${line} of ${file}. Run \`lean-goal sorries ${path.relative(process.cwd(), file)}\``
        + ' to see where the open goals are.');
    } else {
      const lineText = text.split('\n')[line - 1] || '';
      col = Math.max(1, lineText.trimEnd().length + 1);
    }
  }
  return { file, line, col };
}

const SEV = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

function fmtDiag(file, d, { prefix = '  ' } = {}) {
  const s = d.range.start, e = d.range.end;
  const sev = SEV[d.severity] || 'info';
  return `${prefix}${sev} ${file}:${s.line + 1}:${s.character + 1}-${e.line + 1}:${e.character + 1}: `
    + truncate(d.message, MAX_MSG);
}

function renderGoal(goal) {
  if (!goal) return null;
  if (goal.rendered) return goal.rendered.replace(/```(lean)?\n?/g, '').trimEnd();
  if (Array.isArray(goal.goals)) {
    return goal.goals.length ? goal.goals.join('\n\n') : 'no goals — this branch of the proof is complete ✓';
  }
  return null;
}

/**
 * Pull the payloads out of exact?/apply?/simp? "Try this" info messages.
 * `apply?` tags each candidate `[apply] ` and annotates it with the subgoals
 * it would leave behind — keep the annotations, drop the widget tag.
 */
function trySuggestions(diags) {
  return diags
    .filter((d) => /Try this/i.test(d.message))
    .flatMap((d) => d.message.split('\n'))
    .map((l) => l.replace(/^\s*Try this:\s*/i, '').replace(/^\s*\[[a-z]+\]\s*/i, '').trimEnd())
    .filter((l) => l.trim() && !/^Try this/i.test(l.trim()));
}

const FOOTER = '\n(lean-goal reflects the live server state; run `lake build` for final verification)';

/**
 * Errors that were already in the file poison every speculative result: a
 * statement that does not elaborate gives its own hypotheses the type `sorry`,
 * so a candidate tactic fails for reasons that have nothing to do with the
 * candidate. Say so up front instead of letting the reader debug the tactic.
 */
function warnBaselineErrors(file, errors) {
  if (!errors || !errors.length) return;
  console.log(`⚠ ${errors.length} error(s) were already present before this candidate.`);
  console.log('  Fix these first — until they are gone, the goal below may not mean what it says:');
  for (const d of errors) console.log(fmtDiag(file, d, { prefix: '    ' }));
  console.log('');
}

// ---------------------------------------------------------------------------

const USAGE = `lean-goal — Lean 4 proof state, candidate tactics, and environment search

inspect:
  lean-goal goal <file>:<line>[:<col>]     tactic goals at a position
  lean-goal sorries <file>                 the goal at every sorry
  lean-goal check <file>...                elaborate and report diagnostics

experiment (in memory — the file on disk is never modified):
  lean-goal try <file>:<line>[:<col>] '<tactic>'
                                           elaborate a candidate tactic in
                                           place of that sorry
  lean-goal hint <file>:<line>[:<col>] [tactic...]
                                           run exact? / simp? / rw? there and
                                           show what the library offers

explore:
  lean-goal search <file> <prefix>         names in the file's imported env
  lean-goal cmd <file> '<command>'         run #check / #print / example in
                                           the file's import context

verify / manage:
  lean-goal build [file|dir]               lake build that module; a \`sorry\`
                                           fails the gate (--allow-sorry opts out)
  lean-goal status                         list running daemons
  lean-goal stop                           stop them and free their memory

Positions are 1-based. Without <col>, the position is the first \`sorry\` on
the line (for goal, the end of the line if there is none).`;

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
      console.log(`${file}: ${resp.sorries.length} sorr${resp.sorries.length === 1 ? 'y' : 'ies'}\n`);
      warnBaselineErrors(file, resp.baselineErrors);
      for (const s of resp.sorries) {
        console.log(`\n${file}:${s.line}:${s.col}`);
        console.log(renderGoal(s.goal) || '(no goal information)');
      }
      return;
    }

    case 'check': {
      if (!rest.length) fail('usage: lean-goal check <file>...');
      let totalErrors = 0;
      for (const arg of rest) {
        const file = path.resolve(arg);
        if (!fs.existsSync(file)) fail(`no such file: ${file}`);
        const spec = serverSpecFor(file);
        const resp = await queryDaemon(spec, { cmd: 'check', file });
        if (!resp.ok) fail(resp.error);
        const diags = resp.diagnostics;
        const errors = diags.filter((d) => d.severity === 1);
        totalErrors += errors.length;
        console.log(`${file}: ${errors.length} error(s), ${diags.filter((d) => d.severity === 2).length} warning(s)`);
        for (const d of diags) console.log(fmtDiag(file, d));
        if (!diags.length) console.log('  clean ✓');
      }
      console.log(FOOTER);
      process.exit(totalErrors ? 1 : 0);
      return;
    }

    case 'try': {
      if (!rest[0] || rest[1] === undefined) {
        fail("usage: lean-goal try <file>:<line>[:<col>] '<tactic>'");
      }
      const { file, line, col } = parseLocation(rest[0], { requireSorry: true });
      const tactic = rest.slice(1).join(' ');
      const spec = serverSpecFor(file);
      const resp = await queryDaemon(spec, { cmd: 'try', file, line, col, tactic });
      if (!resp.ok) fail(resp.error);
      const errors = resp.introduced.filter((d) => d.severity === 1);
      const stillSorry = resp.sorriesAfter >= resp.sorriesBefore;
      console.log(`${file}:${line}:${col}  sorry ⟶  ${tactic.split('\n').join(' ⏎ ')}\n`);
      warnBaselineErrors(file, resp.baselineErrors);
      if (errors.length) {
        console.log(`\n✗ ${errors.length} new error(s):`);
      } else if (stillSorry) {
        console.log('\n⚠ no new errors, but the goal is still discharged by a `sorry`'
          + ' — this candidate does not prove anything.');
      } else {
        console.log('\n✓ elaborates with no new errors — this tactic closes the goal.');
        console.log('  The file on disk is unchanged; apply the edit to keep it.');
      }
      for (const d of resp.introduced) console.log(fmtDiag(file, d));
      if (resp.preexisting) {
        console.log(`\n(${resp.preexisting} pre-existing diagnostic(s) elsewhere in the file, unchanged)`);
      }
      process.exit(errors.length || stillSorry ? 1 : 0);
      return;
    }

    case 'hint': {
      if (!rest[0]) fail('usage: lean-goal hint <file>:<line>[:<col>] [tactic...]');
      const { file, line, col } = parseLocation(rest[0], { requireSorry: true });
      // `exact?` closes goals outright; `simp?` reports the simp set that
      // worked; `rw?` lists applicable rewrites *with the goal each leaves* —
      // the three that most often yield a next step. `apply?` is available by
      // name but is verbose and rarely decisive, so it is not a default.
      const tactics = rest.slice(1).length ? rest.slice(1) : ['exact?', 'simp?', 'rw?'];
      const spec = serverSpecFor(file);
      console.error(`lean-goal: running ${tactics.join(', ')} — library search can take a minute…`);
      const resp = await queryDaemon(spec, { cmd: 'hint', file, line, col, tactics });
      if (!resp.ok) fail(resp.error);
      console.log(`${file}:${line}:${col}\n`);
      warnBaselineErrors(file, resp.baselineErrors);
      let any = false;
      for (const h of resp.hints) {
        const suggestions = trySuggestions(h.diagnostics);
        console.log(`\n── ${h.tactic} ──`);
        if (suggestions.length) {
          any = true;
          for (const s of suggestions.slice(0, MAX_HINT_LINES)) console.log(`  ${s}`);
          if (suggestions.length > MAX_HINT_LINES) {
            console.log(`  … ${suggestions.length - MAX_HINT_LINES} more (raise LEAN4_LSP_MAX_HINT_LINES)`);
          }
        } else {
          const errs = h.diagnostics.filter((d) => d.severity === 1);
          console.log(errs.length ? `  ${truncate(errs[0].message, 600)}` : '  (no suggestion)');
        }
      }
      if (any) {
        console.log('\nVerify a suggestion before keeping it:  lean-goal try '
          + `${path.relative(process.cwd(), file)}:${line} '<suggestion>'`);
      }
      return;
    }

    case 'search': {
      if (!rest[0] || !rest[1]) fail('usage: lean-goal search <file> <prefix>');
      const file = path.resolve(rest[0]);
      if (!fs.existsSync(file)) fail(`no such file: ${file}`);
      const spec = serverSpecFor(file);
      const resp = await queryDaemon(spec, { cmd: 'search', file, prefix: rest[1], limit: MAX_COMPLETIONS });
      if (!resp.ok) fail(resp.error);
      if (!resp.items.length) {
        console.log(`no names matching "${rest[1]}" in the environment imported by ${file}`);
        console.log('Tip: search by a distinctive fragment of the name; try a namespace prefix'
          + ' (e.g. Matrix.trace) or fewer characters.');
        return;
      }
      console.log(`${resp.total} name(s) matching "${rest[1]}"`
        + `${resp.total > resp.items.length ? `, showing ${resp.items.length}` : ''}:`);
      for (const i of resp.items) {
        console.log(`  ${i.label}${i.detail ? ` : ${truncate(condenseSignature(i.detail), 200)}` : ''}`);
      }
      if (resp.dropped) console.log(`\n(${resp.dropped} loose subsequence match(es) hidden)`);
      console.log('Full signature:  lean-goal cmd <file> \'#check @<name>\'');
      return;
    }

    case 'cmd': {
      if (!rest[0] || rest[1] === undefined) fail("usage: lean-goal cmd <file> '<lean command>'");
      const file = path.resolve(rest[0]);
      if (!fs.existsSync(file)) fail(`no such file: ${file}`);
      const command = rest.slice(1).join(' ');
      const spec = serverSpecFor(file);
      const resp = await queryDaemon(spec, { cmd: 'cmd', file, command });
      if (!resp.ok) fail(resp.error);
      console.log(`${command}   (elaborated at the end of ${path.basename(file)})`);
      if (!resp.diagnostics.length) console.log('  (no output)');
      for (const d of resp.diagnostics) {
        console.log(`  ${SEV[d.severity] || 'info'}: ${truncate(d.message, MAX_MSG)}`);
      }
      if (resp.other) {
        console.log(`\n(note: ${resp.other} pre-existing error(s) in the file itself — `
          + 'the command still ran, but the environment may be incomplete)');
      }
      process.exit(resp.diagnostics.some((d) => d.severity === 1) ? 1 : 0);
      return;
    }

    case 'build': {
      const target = path.resolve(rest[0] || '.');
      const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
      const root = findLakeRoot(isDir ? path.join(target, '_.lean') : target);
      if (!root) fail(`no Lake project above ${target} — nothing to build`);
      const tc = resolveToolchain(process.env);
      if (!tc.lake) fail('no `lake` found. Install elan or set LEAN4_LSP_LAKE.');
      // A file argument builds *that module*. Falling through to the package's
      // default target would happily report success for a file it never
      // compiled — scratch modules outside the root import are the common case.
      const mod = isDir ? null : moduleNameFor(root, target);
      const passthrough = rest.slice(1).filter((a) => a !== '--allow-sorry');
      const allowSorry = rest.includes('--allow-sorry');
      const args = ['build', ...(mod ? [mod] : []), ...passthrough];
      console.log(`lake ${args.join(' ')}   (in ${root})`);
      const child = spawn(tc.lake, args, {
        cwd: root, env: tc.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      const code = await new Promise((r) => child.on('exit', r));
      const lines = out.split('\n');
      const interesting = lines.filter((l) => /error|warning|✖|⚠|sorry/i.test(l));
      for (const l of (interesting.length ? interesting : lines.slice(-3))) {
        if (l.trim()) console.log(`  ${truncate(l, MAX_MSG)}`);
      }
      // `lake build` exits 0 on a file full of `sorry`. For a proof that is
      // the one result that must not read as success, so sorries fail the gate
      // unless the caller explicitly asks to tolerate them.
      const sorries = lines.filter((l) => SORRY_WARN.test(l)).length;
      if (code !== 0) console.log(`\n✗ build failed (exit ${code})`);
      else if (sorries && !allowSorry) {
        console.log(`\n✗ compiles, but ${sorries} declaration(s) still use \`sorry\` —`
          + ' the proof is incomplete. Pass --allow-sorry to accept work in progress.');
      } else if (sorries) console.log(`\n✓ build succeeded (${sorries} sorry warning(s) allowed)`);
      else console.log('\n✓ build succeeded — no errors, no sorries');
      process.exit(code === 0 && (!sorries || allowSorry) ? 0 : 1);
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
          const stale = r.build !== BUILD_ID ? ' [outdated — will restart on next query]' : '';
          console.log(`${r.mode} ${r.root} (pid ${r.pid})${r.dead ? ' [server dead]' : ''}${stale}`);
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
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => fail(String(e.message || e)));
