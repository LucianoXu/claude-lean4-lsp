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
//
// Environment knobs:
//   LEAN4_LSP_LAKE / LEAN4_LSP_LEAN  absolute paths overriding binary lookup
//   LEAN4_LSP_MODE=lake|lean         force one server mode for all files
//   LEAN4_LSP_DEBUG=1                verbose routing log on stderr

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  findLakeRoot, resolveToolchain, LspFramer, frameMessage, uriToPath, pathToUri,
} from './lean-lsp-lib.mjs';

const DEBUG = !!process.env.LEAN4_LSP_DEBUG;
const log = (...a) => { if (DEBUG) process.stderr.write(`[lean4-lsp] ${a.join(' ')}\n`); };

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
  send(obj) { process.stdout.write(frameMessage({ jsonrpc: '2.0', ...obj })); },
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
const docRoots = new Map();    // document uri -> server key
const reqRoutes = new Map();   // client request id -> { server } | broadcast record
const srvReqMap = new Map();   // remapped id -> { server, origId } for server->client requests
let srvReqSeq = 1;

const BROADCAST_METHODS = new Set(['workspace/symbol']);

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
    key: spec.key, mode: spec.mode, cwd: spec.cwd,
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
    if (srv.state !== 'failed' && !shuttingDown) {
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
  // Forget the server and its documents so the next didOpen retries cleanly.
  servers.delete(srv.key);
  for (const [uri, key] of docRoots) if (key === srv.key) docRoots.delete(uri);
  try { srv.proc && srv.proc.kill(); } catch {}
}

function onServerMessage(srv, msg) {
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
        client.respond(msg.id, route.results);
        reqRoutes.delete(msg.id);
      }
    } else {
      client.send(msg);
      reqRoutes.delete(msg.id);
    }
    srv.inflight.delete(msg.id);
    return;
  }

  // Notification (diagnostics, progress, …): pass through.
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
    reqRoutes.set(msg.id, { srv });
    srv.inflight.add(msg.id);
  }
  if (srv.state === 'starting') srv.queue.push(msg);
  else writeTo(srv, msg);
}

function docUriOf(msg) {
  const p = msg.params;
  return p && p.textDocument && p.textDocument.uri;
}

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
        serverInfo: { name: 'lean4-lsp-proxy', version: '0.2.0' },
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
    reqRoutes.set(msg.id, { broadcast: true, pending: new Set(live.map((s) => s.key)), results: [] });
    for (const srv of live) {
      if (srv.state === 'starting') srv.queue.push(msg); else writeTo(srv, msg);
      srv.inflight.add(msg.id);
    }
    return;
  }

  // Per-document routing.
  const uri = docUriOf(msg);
  if (uri) {
    const filePath = uriToPath(uri);
    let srv;
    if (msg.method === 'textDocument/didOpen') {
      srv = ensureServer(filePath);
      docRoots.set(uri, srv.key);
    } else {
      const key = docRoots.get(uri);
      srv = key && servers.get(key);
      if (!srv) { srv = ensureServer(filePath); docRoots.set(uri, srv.key); }
    }
    if (msg.method === 'textDocument/didClose') docRoots.delete(uri);
    routeToServer(srv, msg);
    return;
  }

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
