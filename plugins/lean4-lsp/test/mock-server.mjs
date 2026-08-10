#!/usr/bin/env node
// Mock Lean LSP server used by the proxy tests. Records how it was launched
// (tag, argv, cwd) into $MOCK_OUT, then speaks just enough LSP: it answers
// initialize/shutdown, publishes one diagnostic per didOpen, and answers
// textDocument/documentSymbol with a symbol that names this server's cwd.

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

const send = (obj) => process.stdout.write(frameMessage(obj));
const framer = new LspFramer();
framer.onMessage = (msg) => {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      capabilities: { textDocumentSync: 1, documentSymbolProvider: true },
      serverInfo: { name: `mock-${tag}` },
      rootUri: msg.params.rootUri,
    } });
  } else if (msg.method === 'textDocument/didOpen') {
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: msg.params.textDocument.uri,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 3, message: `mock-${tag} opened from ${process.cwd()}` }],
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
    process.exit(0);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
};
process.stdin.on('data', (c) => framer.push(c));
process.stdin.on('end', () => process.exit(0));
