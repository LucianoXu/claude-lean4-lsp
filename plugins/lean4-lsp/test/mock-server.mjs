#!/usr/bin/env node
// Mock Lean LSP server used by the proxy tests. Records how it was launched
// (tag, argv, cwd) into $MOCK_OUT, then speaks just enough LSP: it answers
// initialize/shutdown, publishes one diagnostic per didOpen, and answers
// textDocument/documentSymbol with a symbol that names this server's cwd.
// Like Lean, it refuses requests on documents it does not hold open, and
// publishes an empty diagnostic set when one is closed. With $MOCK_EVENTS set
// it logs every open/change/close and its own exit there, one JSON per line.

import fs from 'node:fs';
import { LspFramer, frameMessage } from '../bin/lean-lsp-lib.mjs';

const tag = process.argv[2] || 'unknown';
// Simulates the Lean server's cold-start window: the first N answerable
// requests return empty results, as the real watchdog does while its
// .ilean index is still loading.
let emptyFirst = parseInt(process.env.MOCK_EMPTY_FIRST || '0', 10);
if (process.env.MOCK_OUT) {
  fs.appendFileSync(process.env.MOCK_OUT,
    JSON.stringify({ tag, argv: process.argv.slice(3), cwd: process.cwd() }) + '\n');
}

const event = (e) => {
  if (process.env.MOCK_EVENTS) {
    fs.appendFileSync(process.env.MOCK_EVENTS, JSON.stringify({ tag, cwd: process.cwd(), pid: process.pid, ...e }) + '\n');
  }
};
const open = new Map(); // uri -> text
let exiting = false;
const exit = (how) => { if (!exiting) { exiting = true; event({ event: 'exit', how }); } process.exit(0); };

const send = (obj) => process.stdout.write(frameMessage(obj));
const framer = new LspFramer();
framer.onMessage = (msg) => {
  const uri = msg.params && msg.params.textDocument && msg.params.textDocument.uri;
  if (msg.id !== undefined && msg.method && msg.method.startsWith('textDocument/') && !open.has(uri)) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: `mock-${tag}: ${uri} is not open` } });
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const ch = msg.params.contentChanges;
    open.set(uri, ch[ch.length - 1].text);
    event({ event: 'change', uri, version: msg.params.textDocument.version, text: open.get(uri) });
  } else if (msg.method === 'textDocument/didClose') {
    open.delete(uri);
    event({ event: 'close', uri });
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      capabilities: { textDocumentSync: 1, documentSymbolProvider: true },
      serverInfo: { name: `mock-${tag}` },
      rootUri: msg.params.rootUri,
    } });
  } else if (msg.method === 'textDocument/didOpen') {
    open.set(uri, msg.params.textDocument.text);
    event({ event: 'open', uri, version: msg.params.textDocument.version, text: msg.params.textDocument.text });
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: msg.params.textDocument.uri,
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 3, message: `mock-${tag} opened from ${process.cwd()}` },
        // What `lake setup-file` echoes into the diagnostics of a real server.
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          severity: 3, message: '✔ [3/4] Built Dep.D (12ms)' },
      ],
    } });
  } else if (msg.method === 'textDocument/documentSymbol') {
    if (emptyFirst > 0) { emptyFirst--; send({ jsonrpc: '2.0', id: msg.id, result: [] }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: [
      { name: `sym@${process.cwd()}`, kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ] });
  } else if (msg.method === 'workspace/symbol') {
    send({ jsonrpc: '2.0', id: msg.id, result: [
      { name: `ws@${process.cwd()}`, kind: 12,
        location: { uri: 'file:///x', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
    ] });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    exit('exit');
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
};
process.stdin.on('data', (c) => framer.push(c));
process.stdin.on('end', () => exit('eof'));
process.on('SIGTERM', () => exit('SIGTERM'));
