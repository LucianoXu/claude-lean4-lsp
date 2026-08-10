#!/usr/bin/env node
// Live smoke test against a real Lean project, exercising the proxy the same
// way Claude Code does — including starting from a cwd far above the project.
//
//   node test/e2e-real.mjs <path/to/File.lean> [cwd]
//
// Verifies: initialize handshake, root detection, real diagnostics (no
// "unknown module prefix"), documentSymbol, and hover.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LspTestClient } from './helpers.mjs';
import { pathToUri } from '../bin/lean-lsp-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.argv[2] || '');
if (!file || !fs.existsSync(file)) {
  console.error('usage: node test/e2e-real.mjs <path/to/File.lean> [cwd]');
  process.exit(2);
}
const cwd = path.resolve(process.argv[3] || path.parse(file).root);
const PROXY = path.join(__dirname, '..', 'bin', 'lsp-proxy.mjs');

const c = new LspTestClient(process.execPath, [PROXY], {
  cwd, env: { ...process.env, LEAN4_LSP_DEBUG: '1' },
});
const uri = pathToUri(file);
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

try {
  const init = await c.request('initialize', { processId: null, rootUri: pathToUri(cwd), capabilities: {} }, 10000);
  step(`initialize ok (server: ${init.result.serverInfo.name})`);
  c.notify('initialized', {});
  c.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'lean', version: 1, text: fs.readFileSync(file, 'utf8') },
  });
  step('didOpen sent, waiting for diagnostics from the real server…');

  const diag = await c.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri, 180000, 'diagnostics');
  const msgs = diag.params.diagnostics.map((d) => d.message);
  step(`diagnostics received: ${msgs.length} item(s)`);
  for (const m of msgs.slice(0, 5)) console.log(`    - ${m.split('\n')[0]}`);
  if (msgs.some((m) => /unknown module prefix|object file .* does not exist/.test(m))) {
    console.error('FAIL: import resolution errors — root detection is broken');
    process.exit(1);
  }

  const syms = await c.request('textDocument/documentSymbol', { textDocument: { uri } }, 180000);
  const names = (syms.result || []).map((s) => s.name);
  step(`documentSymbol: ${names.length} symbols (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`);
  if (!names.length) { console.error('FAIL: no symbols'); process.exit(1); }

  const flat = (syms.result || []).flatMap(function walk(s) { return [s, ...(s.children || []).flatMap(walk)]; });
  const target = flat.find((s) => s.selectionRange);
  const pos = target.selectionRange.start;
  const hover = await c.request('textDocument/hover', { textDocument: { uri }, position: pos }, 60000);
  const hoverText = hover.result && hover.result.contents
    && (hover.result.contents.value || JSON.stringify(hover.result.contents));
  step(`hover on '${target.name}': ${hoverText ? hoverText.split('\n').slice(0, 3).join(' | ').slice(0, 120) : '(empty)'}`);

  console.log('\nPASS: proxy serves this project correctly from an unrelated cwd');
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  c.kill();
}
