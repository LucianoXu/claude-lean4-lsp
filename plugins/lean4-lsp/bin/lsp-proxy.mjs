#!/usr/bin/env node
// lean4-lsp launcher proxy.
//
// Claude Code starts LSP servers at the session root, but a Lean server must
// run from the Lake project root (where lakefile.toml and lean-toolchain
// live) or every import resolves against the wrong toolchain. This proxy sits
// between Claude Code and the real Lean server(s):
//
//   * answers `initialize` itself, so no server starts until a file is opened
//   * on each didOpen, walks up from the file to the nearest lakefile and
//     spawns `lake serve` there — or `lean --server` for standalone files
//   * routes per-document traffic to the right server, so one session can
//     work on several Lean projects at once
//   * finds lake/lean even when elan's bin dir is missing from PATH
//   * bounds what the Lean side holds (see "Memory" below)
//
// Memory. Every document open on a Lean server costs it a `lean --worker`
// process — about 2 GiB once Mathlib is imported — for as long as the
// document stays open. Claude Code opens a document on every Read or Edit
// of a .lean file and closes one only when more than 50 are open, so a long
// session with agents in several worktrees ends up holding dozens of
// workers. The proxy therefore keeps its own copy of every document the
// client has open and decides separately what the Lean side holds:
//   * at most LEAN4_LSP_MAX_OPEN documents are open on Lean servers; past
//     that the least recently used one is closed there
//   * a document untouched for LEAN4_LSP_DOC_IDLE_MS is closed there
//   * a server holding no documents for LEAN4_LSP_SERVER_IDLE_MS is stopped,
//     and one whose project directory was deleted is stopped at once
// A document closed this way is still open as far as the client knows: its
// next request or edit reopens it from the proxy's copy (and restarts its
// server if needed), at the cost of elaborating it again.
//
// Environment knobs:
//   LEAN4_LSP_LAKE / LEAN4_LSP_LEAN  absolute paths overriding binary lookup
//   LEAN4_LSP_MODE=lake|lean         force one server mode for all files
//   LEAN4_LSP_DEBUG=1                verbose routing log on stderr
//   LEAN4_LSP_MAX_OPEN               documents open on the Lean side (default 8, 0 = no cap)
//   LEAN4_LSP_DOC_IDLE_MS            close idle documents after (default 15 min, 0 = never)
//   LEAN4_LSP_SERVER_IDLE_MS         stop servers without documents after (default 10 min, 0 = never)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { appendFileSync as fsAppend, statSync } from 'node:fs';
import {
  findLakeRoot, resolveToolchain, LspFramer, frameMessage, uriToPath, pathToUri, isBuildNoise,
  applyContentChanges,
} from './lean-lsp-lib.mjs';

const DEBUG = !!process.env.LEAN4_LSP_DEBUG;
const LOG_FILE = process.env.LEAN4_LSP_LOG_FILE;
const log = (...a) => {
  const line = `[lean4-lsp] ${a.join(' ')}\n`;
  if (DEBUG) process.stderr.write(line);
  if (LOG_FILE) { try { fsAppend(LOG_FILE, `${new Date().toISOString()} ${line}`); } catch {} }
};
// Wire-level trace (only when LEAN4_LSP_LOG_FILE is set): every message that
// crosses the proxy, with direction, method/id and a result digest — enough
// to tell a client that never asked from a server that answered empty.
function traceMsg(dir, msg) {
  if (!LOG_FILE) return;
  let extra = '';
  if (msg.method === undefined && msg.result !== undefined) {
    const r = msg.result;
    extra = Array.isArray(r) ? ` results=${r.length}`
      + (r.length ? ` first=${JSON.stringify(r[0]).slice(0, 160)}` : '')
      : ` result=${JSON.stringify(r).slice(0, 160)}`;
  } else if (msg.error) {
    extra = ` error=${JSON.stringify(msg.error).slice(0, 160)}`;
  } else if (msg.params && msg.params.position) {
    extra = ` pos=${msg.params.position.line}:${msg.params.position.character}`
      + ` uri=${(msg.params.textDocument || {}).uri || ''}`;
  } else if (msg.params && msg.params.query !== undefined) {
    extra = ` query=${JSON.stringify(msg.params.query)}`;
  }
  log(`${dir} ${msg.method || 'response'}${msg.id !== undefined ? `#${msg.id}` : ''}${extra}`);
}

const toolchain = resolveToolchain(process.env);

// Capabilities advertised to the client before any real server exists. A
// superset of what Lean's server offers; operations a given server lacks
// simply return empty results from it.
const STATIC_CAPABILITIES = {
  textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
  completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
  hoverProvider: true,
  declarationProvider: true,
  definitionProvider: true,
  typeDefinitionProvider: true,
  referencesProvider: true,
  documentHighlightProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  foldingRangeProvider: true,
  callHierarchyProvider: true,
  semanticTokensProvider: {
    legend: { tokenTypes: ['keyword', 'variable', 'property', 'function'], tokenModifiers: [] },
    range: true, full: true,
  },
  codeActionProvider: true,
};

const client = {
  send(obj) {
    traceMsg('proxy→client', obj);
    process.stdout.write(frameMessage({ jsonrpc: '2.0', ...obj }));
  },
  respond(id, result) { this.send({ id, result }); },
  respondError(id, message, code = -32603) { this.send({ id, error: { code, message } }); },
  showMessage(message, type = 1) {
    this.send({ method: 'window/showMessage', params: { type, message } });
    this.send({ method: 'window/logMessage', params: { type, message } });
  },
};

let clientInitParams = null;   // saved from the client's initialize request
let shuttingDown = false;

const servers = new Map();     // key -> server record
// Every document the client has open, whether or not a Lean server holds it:
//   uri -> { uri, key, languageId, version, text, open, gone, lastUsed }
//   key   the server it routes to (null until it is next opened there)
//   open  a Lean server holds it right now, i.e. a worker process exists
//   gone  its server was stopped because the project directory vanished
const docs = new Map();
const reqRoutes = new Map();   // client request id -> { srv, msg, uri } | broadcast record
const srvReqMap = new Map();   // remapped id -> { server, origId } for server->client requests
let srvReqSeq = 1;

const BROADCAST_METHODS = new Set(['workspace/symbol']);

// The Lean watchdog loads its .ilean index asynchronously after startup
// (5–20 s for a Mathlib-sized workspace), and position requests can resolve
// empty while a file is still elaborating. During that warm-up window an
// empty result usually means "not ready yet", not "nothing there" — so
// retry a few times before letting an empty answer through.
const WARMUP_MS = parseInt(process.env.LEAN4_LSP_WARMUP_MS || '', 10) || 45000;
const RETRY_MS = parseInt(process.env.LEAN4_LSP_RETRY_MS || '', 10) || 2000;
const MAX_RETRIES = 3;
const RETRYABLE = new Set([
  'textDocument/definition', 'textDocument/declaration', 'textDocument/typeDefinition',
  'textDocument/references', 'textDocument/implementation', 'textDocument/documentSymbol',
  'workspace/symbol',
]);
const isEmptyResult = (msg) => !msg.error
  && (msg.result === null || (Array.isArray(msg.result) && msg.result.length === 0));

// Unlike the knobs above, 0 is meaningful here (no cap / never), so a plain
// `parseInt(...) || default` would not do.
function envInt(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
const MAX_OPEN = envInt('LEAN4_LSP_MAX_OPEN', 8);
const DOC_IDLE_MS = envInt('LEAN4_LSP_DOC_IDLE_MS', 15 * 60_000);
const SERVER_IDLE_MS = envInt('LEAN4_LSP_SERVER_IDLE_MS', 10 * 60_000);
const SWEEP_MS = envInt('LEAN4_LSP_SWEEP_MS', 30_000) || 30_000;
const STOP_GRACE_MS = 5000;

/** Identity of a directory, so one deleted and recreated at the same path
 *  (a worktree removed and added again) still counts as gone. */
function dirIdentity(dir) {
  try { const s = statSync(dir); return `${s.dev}:${s.ino}`; } catch { return null; }
}

function toolchainHint() {
  return 'lean4-lsp: no usable Lean toolchain found. Install elan '
    + '(https://lean-lang.org/lean4/doc/setup.html), or point LEAN4_LSP_LAKE / '
    + 'LEAN4_LSP_LEAN at the binaries. Searched PATH, $ELAN_HOME/bin and ~/.elan/bin.';
}

function serverKeyFor(filePath) {
  const forced = process.env.LEAN4_LSP_MODE;
  const lakeRoot = forced === 'lean' ? null : findLakeRoot(filePath);
  if (lakeRoot && (toolchain.lake || forced === 'lake')) {
    return { key: `lake:${lakeRoot}`, mode: 'lake', cwd: lakeRoot };
  }
  if (lakeRoot && !toolchain.lake) {
    // Lake project but no lake binary — degrade to lean --server from the
    // project root; imports of deps won't resolve, but plain files work.
    return { key: `lean:${lakeRoot}`, mode: 'lean', cwd: lakeRoot, degraded: true };
  }
  return { key: `lean:${path.dirname(filePath)}`, mode: 'lean', cwd: path.dirname(filePath) };
}

function ensureServer(filePath) {
  const spec = serverKeyFor(filePath);
  let srv = servers.get(spec.key);
  if (srv) return srv;

  const bin = spec.mode === 'lake' ? toolchain.lake : toolchain.lean;
  const args = spec.mode === 'lake' ? ['serve'] : ['--server'];

  srv = {
    key: spec.key, mode: spec.mode, cwd: spec.cwd, cwdId: dirIdentity(spec.cwd),
    spawnedAt: Date.now(), lastActive: Date.now(), stopping: false,
    state: 'starting', proc: null, queue: [], inflight: new Set(), warnedDead: false,
  };
  servers.set(spec.key, srv);

  if (!bin) {
    srv.state = 'failed';
    client.showMessage(toolchainHint());
    log(`no toolchain for ${spec.key}`);
    return srv;
  }
  if (spec.degraded) {
    client.showMessage(
      `lean4-lsp: found a Lake project at ${spec.cwd} but no 'lake' binary; `
      + 'falling back to lean --server — project imports will not resolve.', 2);
  }

  log(`spawning ${bin} ${args.join(' ')} in ${spec.cwd}`);
  let proc;
  try {
    proc = spawn(bin, args, { cwd: spec.cwd, env: toolchain.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    srv.state = 'failed';
    client.showMessage(`lean4-lsp: failed to start ${bin}: ${e.message}`);
    return srv;
  }
  srv.proc = proc;

  const framer = new LspFramer();
  framer.onMessage = (msg) => onServerMessage(srv, msg);
  proc.stdout.on('data', (c) => framer.push(c));
  proc.stderr.on('data', (c) => process.stderr.write(`[lean4-lsp ${path.basename(spec.cwd)}] ${c}`));
  proc.on('error', (e) => failServer(srv, `could not start ${bin}: ${e.message}`));
  proc.on('exit', (code, sig) => {
    // `lake serve` may hand its stdin to `lean --server`; close our end so
    // that process sees EOF instead of outliving lake.
    try { proc.stdin.destroy(); } catch {}
    if (srv.state !== 'failed' && !shuttingDown && !srv.stopping) {
      failServer(srv, `Lean server for ${spec.cwd} exited unexpectedly (${sig || `code ${code}`}).`);
    }
  });

  const initParams = {
    ...(clientInitParams || {}),
    processId: process.pid,
    rootUri: pathToUri(spec.cwd),
    rootPath: spec.cwd,
    workspaceFolders: [{ uri: pathToUri(spec.cwd), name: path.basename(spec.cwd) }],
    capabilities: (clientInitParams && clientInitParams.capabilities) || {},
  };
  srv.initId = `init:${spec.key}`;
  writeTo(srv, { jsonrpc: '2.0', id: srv.initId, method: 'initialize', params: initParams });
  return srv;
}

function writeTo(srv, obj) {
  if (srv.proc && srv.proc.stdin.writable) srv.proc.stdin.write(frameMessage(obj));
}

function failServer(srv, reason) {
  const wasFailed = srv.state === 'failed';
  srv.state = 'failed';
  if (!wasFailed && !srv.warnedDead) {
    srv.warnedDead = true;
    client.showMessage(`lean4-lsp: ${reason}`);
  }
  for (const item of srv.queue) {
    if (item.id !== undefined && item.method) client.respondError(item.id, `lean4-lsp: ${reason}`);
  }
  srv.queue = [];
  for (const id of srv.inflight) {
    client.respondError(id, `lean4-lsp: ${reason}`);
    reqRoutes.delete(id);
  }
  srv.inflight.clear();
  // Forget the server; its documents reopen (and so retry the server) on
  // their next use.
  servers.delete(srv.key);
  detachDocs(srv);
  try { srv.proc && srv.proc.kill(); } catch {}
}

/** Mark the documents a server held as no longer held anywhere. */
function detachDocs(srv) {
  for (const d of docs.values()) if (d.key === srv.key) { d.open = false; d.key = null; }
}

/**
 * Stop a server on purpose (idle, or its project directory is gone): no
 * user-facing warning, pending requests fail with the reason, and its
 * documents reopen elsewhere on next use. Shutdown is graceful — the Lean
 * server then stops its workers itself — with a kill as the fallback.
 */
function stopServer(srv, reason) {
  log(`stopping ${srv.key}: ${reason}`);
  srv.stopping = true;
  servers.delete(srv.key);
  for (const item of srv.queue) {
    if (item.id !== undefined && item.method) client.respondError(item.id, `lean4-lsp: Lean server stopped (${reason})`);
  }
  srv.queue = [];
  for (const id of srv.inflight) {
    client.respondError(id, `lean4-lsp: Lean server stopped (${reason})`);
    reqRoutes.delete(id);
  }
  srv.inflight.clear();
  detachDocs(srv);
  const proc = srv.proc;
  if (!proc || proc.exitCode !== null) return;
  if (srv.state === 'ready') {
    srv.onShutdownAck = () => {
      writeTo(srv, { jsonrpc: '2.0', method: 'exit' });
      try { proc.stdin.end(); } catch {}
    };
    writeTo(srv, { jsonrpc: '2.0', id: `shutdown:${srv.key}`, method: 'shutdown' });
  } else {
    try { proc.stdin.end(); } catch {}
  }
  setTimeout(() => { if (proc.exitCode === null) { try { proc.kill(); } catch {} } }, STOP_GRACE_MS).unref();
}

function onServerMessage(srv, msg) {
  traceMsg(`server(${path.basename(srv.cwd)})→proxy`, msg);
  // A server being stopped has nothing left to say to the client.
  if (srv.stopping) {
    if (typeof msg.id === 'string' && msg.id.startsWith('shutdown:') && srv.onShutdownAck) {
      srv.onShutdownAck(); srv.onShutdownAck = null;
    }
    return;
  }
  // Response to our synthetic initialize: finish the handshake, flush queue.
  if (msg.id === srv.initId && !msg.method) {
    if (msg.error) {
      failServer(srv, `initialize failed: ${msg.error.message}`);
      return;
    }
    srv.state = 'ready';
    writeTo(srv, { jsonrpc: '2.0', method: 'initialized', params: {} });
    log(`${srv.key} ready (${(msg.result && msg.result.serverInfo && msg.result.serverInfo.name) || 'server'})`);
    for (const item of srv.queue) writeTo(srv, item);
    srv.queue = [];
    return;
  }

  // Server-initiated request: remap its id so two servers cannot collide.
  if (msg.id !== undefined && msg.method) {
    const outId = 1_000_000_000 + srvReqSeq++;
    srvReqMap.set(outId, { srv, origId: msg.id });
    client.send({ ...msg, id: outId });
    return;
  }

  // Acknowledgement of our own shutdown request to this server.
  if (typeof msg.id === 'string' && msg.id.startsWith('shutdown:')) {
    if (srv.onShutdownAck) { srv.onShutdownAck(); srv.onShutdownAck = null; }
    return;
  }

  // Response to a client request.
  if (msg.id !== undefined) {
    const route = reqRoutes.get(msg.id);
    if (route && route.broadcast) {
      route.pending.delete(srv.key);
      if (!msg.error && Array.isArray(msg.result)) route.results.push(...msg.result);
      if (route.pending.size === 0) {
        const targets = route.targets && route.targets.filter((s) => s.state === 'ready');
        if (route.results.length === 0 && targets && targets.length
            && (route.retries || 0) < MAX_RETRIES
            && targets.some((s) => Date.now() - s.spawnedAt < WARMUP_MS)) {
          route.retries = (route.retries || 0) + 1;
          route.pending = new Set(targets.map((s) => s.key));
          setTimeout(() => { for (const s of targets) writeTo(s, route.msg); }, RETRY_MS);
          return;
        }
        client.respond(msg.id, route.results);
        reqRoutes.delete(msg.id);
      }
    } else if (route && RETRYABLE.has(route.msg && route.msg.method) && isEmptyResult(msg)
        && srv.state === 'ready' && Date.now() - srv.spawnedAt < WARMUP_MS
        && (route.retries || 0) < MAX_RETRIES) {
      route.retries = (route.retries || 0) + 1;
      log(`retry ${route.retries}/${MAX_RETRIES} for ${route.msg.method}#${msg.id} (warm-up empty)`);
      setTimeout(() => writeTo(srv, route.msg), RETRY_MS);
      return;
    } else {
      client.send(msg);
      reqRoutes.delete(msg.id);
    }
    srv.inflight.delete(msg.id);
    return;
  }

  // Notification (diagnostics, progress, …): pass through. Build-progress
  // lines that `lake setup-file` surfaces as info diagnostics (`✔ [12/40]
  // Built Foo`) are dropped: a Mathlib-sized import closure produces dozens
  // per open, and the client relays every one of them into the conversation.
  // Diagnostics for a document the proxy closed on this server are stale
  // (or the empty set a server may publish on close): the client still has
  // the document open and must not read them as "no errors".
  if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
    const d = docs.get(msg.params.uri);
    if (d && (!d.open || d.key !== srv.key)) return;
  }
  if (msg.method === 'textDocument/publishDiagnostics' && msg.params
      && Array.isArray(msg.params.diagnostics) && !process.env.LEAN4_LSP_KEEP_BUILD_INFO) {
    const kept = msg.params.diagnostics.filter((d) => !isBuildNoise(d));
    if (kept.length !== msg.params.diagnostics.length) {
      client.send({ ...msg, params: { ...msg.params, diagnostics: kept } });
      return;
    }
  }
  client.send(msg);
}

function routeToServer(srv, msg) {
  if (srv.state === 'failed') {
    if (msg.id !== undefined) {
      client.respondError(msg.id, 'lean4-lsp: no Lean server available for this file. ' + toolchainHint());
    }
    return;
  }
  if (msg.id !== undefined) {
    reqRoutes.set(msg.id, { srv, msg, uri: docUriOf(msg) });
    srv.inflight.add(msg.id);
  }
  srv.lastActive = Date.now();
  if (srv.state === 'starting') srv.queue.push(msg);
  else writeTo(srv, msg);
}

function docUriOf(msg) {
  const p = msg.params;
  return p && p.textDocument && p.textDocument.uri;
}

// ------------------------------------------------- what the Lean side holds

/** Open `doc` on its server (spawning one if needed) from the proxy's copy. */
function openOnServer(doc) {
  const srv = ensureServer(uriToPath(doc.uri));
  doc.key = srv.key;
  if (srv.state === 'failed') return srv;
  routeToServer(srv, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
    textDocument: { uri: doc.uri, languageId: doc.languageId || 'lean', version: doc.version, text: doc.text },
  } });
  doc.open = true;
  return srv;
}

/** Close `doc` on its server only; the client keeps it open. */
function closeOnServer(doc, reason) {
  const srv = doc.key && servers.get(doc.key);
  doc.open = false;
  if (!srv || srv.state === 'failed') return;
  log(`closing ${doc.uri} on ${srv.key}: ${reason}`);
  routeToServer(srv, { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: doc.uri } } });
}

/** A document with a request still in flight is never closed under it. */
function isBusy(doc) {
  for (const r of reqRoutes.values()) if (r.uri === doc.uri) return true;
  return false;
}

/** Close least recently used documents until at most MAX_OPEN are open. */
function enforceCap(keep) {
  if (!MAX_OPEN) return;
  const open = [...docs.values()].filter((d) => d.open);
  let excess = open.length - MAX_OPEN;
  if (excess <= 0) return;
  open.sort((a, b) => a.lastUsed - b.lastUsed);
  for (const d of open) {
    if (excess <= 0) break;
    if (d === keep || isBusy(d)) continue;
    closeOnServer(d, `more than ${MAX_OPEN} documents open`);
    excess--;
  }
}

/** The live server holding `doc`, reopening it there first if needed. */
function serverFor(doc) {
  const srv = doc.open && doc.key && servers.get(doc.key);
  if (srv) return srv;
  const opened = openOnServer(doc);
  enforceCap(doc);
  return opened;
}

function onDocumentMessage(uri, msg) {
  const filePath = uriToPath(uri);
  const method = msg.method;
  let doc = docs.get(uri);
  if (doc) doc.lastUsed = Date.now();

  if (doc && doc.gone) {
    if (method === 'textDocument/didClose') { docs.delete(uri); return; }
    if (method === 'textDocument/didOpen' || (filePath && dirIdentity(path.dirname(filePath)))) {
      doc.gone = false; // the directory is back (or the client opened it afresh)
    } else {
      if (msg.id !== undefined) {
        client.respondError(msg.id, `lean4-lsp: ${filePath} is gone — its project directory was deleted.`);
      }
      return;
    }
  }

  switch (method) {
    case 'textDocument/didOpen': {
      const td = msg.params.textDocument;
      if (doc && doc.open && servers.get(doc.key)) {
        // Already held: a second didOpen would be rejected, so pass the new
        // contents on as a full-text change.
        Object.assign(doc, { version: td.version, text: td.text });
        routeToServer(servers.get(doc.key), { jsonrpc: '2.0', method: 'textDocument/didChange', params: {
          textDocument: { uri, version: td.version }, contentChanges: [{ text: td.text }],
        } });
        return;
      }
      doc = { uri, key: null, languageId: td.languageId, version: td.version, text: td.text,
        open: false, gone: false, lastUsed: Date.now() };
      docs.set(uri, doc);
      serverFor(doc);
      return;
    }
    case 'textDocument/didChange': {
      if (!doc) break; // never opened through us: forward as is
      doc.text = applyContentChanges(doc.text, msg.params.contentChanges);
      if (msg.params.textDocument && msg.params.textDocument.version != null) {
        doc.version = msg.params.textDocument.version;
      }
      const srv = doc.open && doc.key && servers.get(doc.key);
      if (srv) routeToServer(srv, msg);
      else serverFor(doc); // reopening sends the new text
      return;
    }
    case 'textDocument/didSave': {
      if (!doc) break;
      const srv = doc.open && doc.key && servers.get(doc.key);
      if (srv) routeToServer(srv, msg); // a copy the server does not hold has nothing to save
      return;
    }
    case 'textDocument/didClose': {
      if (!doc) return; // nothing of ours to close
      docs.delete(uri);
      const srv = doc.open && doc.key && servers.get(doc.key);
      if (srv) routeToServer(srv, msg);
      return;
    }
    default:
      if (doc) { routeToServer(serverFor(doc), msg); return; }
  }
  // A document the client never opened (or a change to one): route by path.
  routeToServer(ensureServer(filePath), msg);
}

/** Periodic housekeeping: idle documents, idle servers, vanished projects. */
function sweep() {
  const now = Date.now();
  for (const srv of [...servers.values()]) {
    if (srv.state === 'failed' || !srv.cwdId || dirIdentity(srv.cwd) === srv.cwdId) continue;
    // Its documents are gone with it; requests on them fail fast instead of
    // walking up from a missing path to whatever Lake project encloses it.
    const held = [...docs.values()].filter((d) => d.key === srv.key);
    stopServer(srv, `its project directory ${srv.cwd} no longer exists`);
    for (const d of held) d.gone = true;
  }
  if (DOC_IDLE_MS) {
    for (const d of docs.values()) {
      if (d.open && now - d.lastUsed > DOC_IDLE_MS && !isBusy(d)) {
        closeOnServer(d, `idle for ${Math.round((now - d.lastUsed) / 1000)} s`);
      }
    }
  }
  enforceCap(null); // documents that were busy when the cap was last hit
  if (SERVER_IDLE_MS) {
    for (const srv of [...servers.values()]) {
      if (srv.state !== 'ready' || srv.inflight.size || srv.queue.length) continue;
      if ([...docs.values()].some((d) => d.open && d.key === srv.key)) continue;
      if (now - srv.lastActive > SERVER_IDLE_MS) stopServer(srv, 'no open documents');
    }
  }
}
setInterval(sweep, SWEEP_MS).unref();

function onClientMessage(msg) {
  // Response from client to a server-initiated request.
  if (msg.id !== undefined && !msg.method && srvReqMap.has(msg.id)) {
    const { srv, origId } = srvReqMap.get(msg.id);
    srvReqMap.delete(msg.id);
    if (srv.state !== 'failed') writeTo(srv, { ...msg, id: origId });
    return;
  }

  switch (msg.method) {
    case 'initialize':
      clientInitParams = msg.params || {};
      client.send({ id: msg.id, result: {
        capabilities: STATIC_CAPABILITIES,
        serverInfo: { name: 'lean4-lsp-proxy', version: '0.5.0' },
      } });
      return;
    case 'initialized':
      return; // we send initialized to each real server ourselves
    case 'shutdown': {
      shuttingDown = true;
      const live = [...servers.values()].filter((s) => s.state === 'ready');
      if (live.length === 0) { client.respond(msg.id, null); return; }
      let remaining = live.length;
      let answered = false;
      const done = () => {
        if (!answered && --remaining <= 0) { answered = true; client.respond(msg.id, null); }
      };
      setTimeout(() => { if (!answered) { answered = true; client.respond(msg.id, null); } }, 3000).unref();
      for (const srv of live) {
        srv.onShutdownAck = done;
        writeTo(srv, { jsonrpc: '2.0', id: `shutdown:${srv.key}`, method: 'shutdown' });
      }
      return;
    }
    case 'exit':
      for (const srv of servers.values()) {
        writeTo(srv, { jsonrpc: '2.0', method: 'exit' });
        setTimeout(() => { try { srv.proc && srv.proc.kill(); } catch {} }, 500).unref();
      }
      setTimeout(() => process.exit(0), 600).unref();
      return;
    case '$/cancelRequest': {
      const route = reqRoutes.get(msg.params && msg.params.id);
      if (route && route.srv) writeTo(route.srv, msg);
      return;
    }
  }

  // Broadcast requests that meaningfully span projects.
  if (BROADCAST_METHODS.has(msg.method) && msg.id !== undefined) {
    const live = [...servers.values()].filter((s) => s.state === 'ready' || s.state === 'starting');
    if (live.length === 0) { client.respond(msg.id, []); return; }
    reqRoutes.set(msg.id, { broadcast: true, pending: new Set(live.map((s) => s.key)), results: [], msg, targets: live });
    for (const srv of live) {
      if (srv.state === 'starting') srv.queue.push(msg); else writeTo(srv, msg);
      srv.inflight.add(msg.id);
    }
    return;
  }

  // Per-document routing.
  const uri = docUriOf(msg);
  if (uri) { onDocumentMessage(uri, msg); return; }

  // Anything else: notifications go to every live server (e.g.
  // workspace/didChangeConfiguration); requests go to the first one.
  const live = [...servers.values()].filter((s) => s.state !== 'failed');
  if (msg.id === undefined) {
    for (const srv of live) {
      if (srv.state === 'starting') srv.queue.push(msg); else writeTo(srv, msg);
    }
    return;
  }
  if (live.length) { routeToServer(live[0], msg); return; }
  client.respondError(msg.id, 'lean4-lsp: no Lean server is running yet — open a .lean file first.');
}

const stdinFramer = new LspFramer();
stdinFramer.onMessage = (m) => {
  traceMsg('client→proxy', m);
  try { onClientMessage(m); } catch (e) {
    process.stderr.write(`[lean4-lsp] internal error: ${e.stack || e}\n`);
    if (m && m.id !== undefined && m.method) client.respondError(m.id, `lean4-lsp internal error: ${e.message}`);
  }
};
process.stdin.on('data', (c) => stdinFramer.push(c));
process.stdin.on('end', () => {
  for (const srv of servers.values()) { try { srv.proc && srv.proc.kill(); } catch {} }
  process.exit(0);
});
