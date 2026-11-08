#!/usr/bin/env node
// Test suite for the lean4-lsp plugin. No external dependencies.
// Usage: node test/run-tests.mjs [--e2e]   (--e2e adds live lean server tests)

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------- lib tests

const {
  findLakeRoot, resolveToolchain, LspFramer, frameMessage,
  scanSorries, spliceSorry, rankNames, condenseSignature, moduleNameFor, truncate,
  projectImports, importClosureStamp, spliceLine, stripTrace, isBuildNoise, applyContentChanges,
} = await import('../bin/lean-lsp-lib.mjs');

test('findLakeRoot: file inside a Lake project resolves to project root', () => {
  const file = path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean');
  assert.equal(findLakeRoot(file), path.join(FIXTURES, 'lakeproj'));
});

test('findLakeRoot: file directly next to lakefile resolves to that dir', () => {
  const file = path.join(FIXTURES, 'lakeproj/A.lean'); // need not exist on disk
  assert.equal(findLakeRoot(file), path.join(FIXTURES, 'lakeproj'));
});

test('findLakeRoot: standalone file yields null', () => {
  const file = path.join(FIXTURES, 'standalone/B.lean');
  assert.equal(findLakeRoot(file), null);
});

test('findLakeRoot: dependency file under .lake/packages resolves to outer project', () => {
  const file = path.join(FIXTURES, 'lakeproj/.lake/packages/dep/Dep/D.lean');
  assert.equal(findLakeRoot(file), path.join(FIXTURES, 'lakeproj'));
});

test('resolveToolchain: finds lake in an elan bin dir when PATH lacks it', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-test-'));
  const elanBin = path.join(fakeHome, '.elan', 'bin');
  fs.mkdirSync(elanBin, { recursive: true });
  fs.writeFileSync(path.join(elanBin, 'lake'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(elanBin, 'lean'), '#!/bin/sh\n', { mode: 0o755 });
  const tc = resolveToolchain({ HOME: fakeHome, PATH: '/usr/bin:/bin' });
  assert.equal(tc.lake, path.join(elanBin, 'lake'));
  assert.equal(tc.lean, path.join(elanBin, 'lean'));
  assert.ok(tc.env.PATH.startsWith(elanBin + path.delimiter));
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('resolveToolchain: PATH-provided binaries win when present', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-test-'));
  const pathBin = path.join(fakeHome, 'pathbin');
  fs.mkdirSync(pathBin, { recursive: true });
  fs.writeFileSync(path.join(pathBin, 'lake'), '#!/bin/sh\n', { mode: 0o755 });
  const tc = resolveToolchain({ HOME: fakeHome, PATH: pathBin });
  assert.equal(tc.lake, path.join(pathBin, 'lake'));
  assert.equal(tc.lean, null); // no lean anywhere
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('resolveToolchain: explicit env override beats everything', () => {
  const tc = resolveToolchain({ HOME: '/nonexistent', PATH: '/usr/bin', LEAN4_LSP_LAKE: '/opt/custom/lake' });
  assert.equal(tc.lake, '/opt/custom/lake');
});

test('LspFramer: parses a single framed message', () => {
  const framer = new LspFramer();
  const got = [];
  framer.onMessage = (m) => got.push(m);
  framer.push(frameMessage({ jsonrpc: '2.0', id: 1, method: 'x' }));
  assert.deepEqual(got, [{ jsonrpc: '2.0', id: 1, method: 'x' }]);
});

test('LspFramer: handles messages split across chunks and back-to-back', () => {
  const framer = new LspFramer();
  const got = [];
  framer.onMessage = (m) => got.push(m);
  const a = frameMessage({ id: 1 });
  const b = frameMessage({ id: 2, params: { text: '∀ α, α → α' } }); // multibyte content
  const joined = Buffer.concat([a, b]);
  framer.push(joined.subarray(0, 10));
  framer.push(joined.subarray(10, a.length + 5));
  framer.push(joined.subarray(a.length + 5));
  assert.deepEqual(got.map((m) => m.id), [1, 2]);
  assert.equal(got[1].params.text, '∀ α, α → α');
});

// ------------------------------------------------- source scanning / splicing

const SORRY_SRC = [
  '-- sorry in a line comment',
  '/- block sorry',
  '   /- nested sorry -/ still inside sorry -/',
  'def s := "a sorry string"',
  'theorem t : True := by sorry',
  '  sorry',
  'def sorryish := 1',
  '#check sorryAx',
].join('\n');

test('scanSorries: finds real sorries only', () => {
  assert.deepEqual(scanSorries(SORRY_SRC), [{ line: 5, col: 24 }, { line: 6, col: 3 }]);
});

test('scanSorries: skips comments, nested blocks, strings and lookalike identifiers', () => {
  // Every skipped case above would be a false positive for /\bsorry\b/.
  assert.equal(scanSorries('-- sorry').length, 0);
  assert.equal(scanSorries('/- a /- b sorry -/ c -/').length, 0);
  assert.equal(scanSorries('"sorry"').length, 0);
  assert.equal(scanSorries('sorryAx sorry_foo mysorry').length, 0);
  // A backslash-escaped quote does not end the string literal…
  assert.equal(scanSorries(String.raw`"a\" sorry"`).length, 0);
  // …but once the literal really closes, the next token counts again.
  assert.equal(scanSorries(String.raw`"a\"" sorry`).length, 1);
});

test('spliceSorry: indents continuation lines to the sorry column', () => {
  const out = spliceSorry('example : True := by\n  sorry\n', 2, 3, 'constructor\ndone');
  assert.equal(out, 'example : True := by\n  constructor\n  done\n');
});

test('spliceSorry: refuses a position that is not a sorry', () => {
  assert.equal(spliceSorry('example : True := by\n  sorry\n', 1, 1, 'x'), null);
  assert.equal(spliceSorry('example : True := by\n  sorry\n', 9, 1, 'x'), null);
});

test('spliceLine: replaces the tactic on a line, keeping its indentation', () => {
  const r = spliceLine('example : True := by\n  exact 5\n', 2, 'trivial');
  assert.deepEqual(r, { text: 'example : True := by\n  trivial\n', replaced: 'exact 5', col: 3 });
  const multi = spliceLine('by\n    foo\n', 2, 'constructor\nrfl');
  assert.equal(multi.text, 'by\n    constructor\n    rfl\n');
});

test('spliceLine: refuses blank and out-of-range lines', () => {
  assert.equal(spliceLine('a\n\nb\n', 2, 'x'), null);
  assert.equal(spliceLine('a\n', 5, 'x'), null);
});

test('stripTrace: drops the LEAN_PATH trace lines, keeps the message', () => {
  const msg = 'setup-file failed:\ntrace: .> LEAN_PATH=/a:/b lean X.lean\nerror: X.lean:3:1: boom';
  assert.equal(stripTrace(msg), 'setup-file failed:\nerror: X.lean:3:1: boom');
});

test('isBuildNoise: build-progress infos only', () => {
  const at = (severity, message) => ({ severity, message, range: {} });
  assert.ok(isBuildNoise(at(3, '✔ [12/40] Built Foo.Bar (1.2s)')));
  assert.ok(isBuildNoise(at(3, 'ℹ [1/2] Built Foo')));
  assert.ok(!isBuildNoise(at(1, '✖ [2/2] Building Foo')), 'an error stays');
  assert.ok(!isBuildNoise(at(3, "'foo' depends on axioms: [propext]")), 'a real info stays');
});

test('projectImports / importClosureStamp: follow project-local imports transitively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-imports-'));
  fs.mkdirSync(path.join(root, 'P'));
  fs.writeFileSync(path.join(root, 'P', 'A.lean'), 'def a := 1\n');
  fs.writeFileSync(path.join(root, 'P', 'B.lean'), 'import P.A\nimport Mathlib.Data.Nat.Basic\ndef b := a\n');
  fs.writeFileSync(path.join(root, 'P', 'C.lean'), 'import P.B\n');
  assert.deepEqual(projectImports(root, path.join(root, 'P', 'C.lean')), [path.join(root, 'P', 'B.lean')]);
  assert.deepEqual(projectImports(root, path.join(root, 'P', 'B.lean')), [path.join(root, 'P', 'A.lean')],
    'dependency modules are not on disk under the root, so they are ignored');
  const s1 = importClosureStamp(root, path.join(root, 'P', 'C.lean'));
  assert.ok(s1.startsWith('2:'), `closure has two files: ${s1}`);
  // Touch the transitive import into the future: the stamp must move.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'P', 'A.lean'), later, later);
  const s2 = importClosureStamp(root, path.join(root, 'P', 'C.lean'));
  assert.notEqual(s1, s2);
  // Editing the file itself does not count: it is the header's imports that matter.
  fs.writeFileSync(path.join(root, 'P', 'C.lean'), 'import P.B\n-- edited\n');
  assert.equal(importClosureStamp(root, path.join(root, 'P', 'C.lean')), s2);
  // The stamp is stable across repeated calls: an earlier version consumed
  // the cached import list while walking it, and every second query saw an
  // empty closure (`0:0`), so files were reopened once and never again.
  assert.equal(importClosureStamp(root, path.join(root, 'P', 'C.lean')), s2);
  assert.equal(importClosureStamp(root, path.join(root, 'P', 'B.lean')),
    importClosureStamp(root, path.join(root, 'P', 'B.lean')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('rankNames: literal matches beat subsequence noise', () => {
  const labels = [
    'CategoryTheory.opShiftFunctorEquivalence_unitIso_hom_naturality', // subsequence only
    'Matrix.trace_smul',
    'LinearMap.trace_smulRight',
  ];
  const { ranked, dropped } = rankNames(labels, 'trace_smul');
  assert.deepEqual(ranked, ['Matrix.trace_smul', 'LinearMap.trace_smulRight']);
  assert.equal(dropped, 1);
});

test('rankNames: keeps subsequence matches when nothing better exists', () => {
  const { ranked, dropped } = rankNames(['Foo.bar_baz'], 'zzz');
  assert.deepEqual(ranked, ['Foo.bar_baz']);
  assert.equal(dropped, 0);
});

test('condenseSignature: drops instance binders, keeps the statement', () => {
  const sig = '∀ {n : Type u} [inst : Fintype n] [inst_1 : AddCommMonoid R] [DistribSMul α R]'
    + ' (r : α) (A : Matrix n n R), (r • A).trace = r • A.trace';
  assert.equal(condenseSignature(sig),
    '∀ {n : Type u} (r : α) (A : Matrix n n R), (r • A).trace = r • A.trace');
});

test('condenseSignature: a stripped binder takes its arrow with it', () => {
  // Otherwise the signature renders as a row of bare arrows: "→ → → Matrix n n R → Prop".
  assert.equal(condenseSignature('{n : Type u} → [inst : Fintype n] → [CommRing R] → Matrix n n R → Prop'),
    '{n : Type u} → Matrix n n R → Prop');
  assert.equal(condenseSignature('[inst : Fintype n] → Matrix n n R → Prop'), 'Matrix n n R → Prop');
});

test('condenseSignature: leaves list literals alone', () => {
  assert.equal(condenseSignature('(l : List Nat) , l = [a, b]'), '(l : List Nat) , l = [a, b]');
});

test('truncate: marks how much was dropped', () => {
  assert.equal(truncate('abcdefghij', 4), 'abcd … [+6 chars]');
  assert.equal(truncate('abc', 10), 'abc');
});

test('moduleNameFor: derives the Lake target from a source path', () => {
  assert.equal(moduleNameFor('/p', '/p/Foo/Bar.lean'), 'Foo.Bar');
  assert.equal(moduleNameFor('/p', '/p/Foo.lean'), 'Foo');
});

test('moduleNameFor: refuses paths no target of this package covers', () => {
  assert.equal(moduleNameFor('/p', '/other/Foo.lean'), null);
  assert.equal(moduleNameFor('/p', '/p/.lake/packages/dep/D.lean'), null);
  assert.equal(moduleNameFor('/p', '/p/Foo/Bar.txt'), null);
});

// ---------------------------------------------------------------- proxy tests

import { LspTestClient, sleep } from './helpers.mjs';
import { pathToUri } from '../bin/lean-lsp-lib.mjs';

const PROXY = path.join(__dirname, '..', 'bin', 'lsp-proxy.mjs');
const MOCK = path.join(__dirname, 'mock');

function mockClient(extraEnv = {}) {
  const mockOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-mock-')), 'launches.jsonl');
  const client = new LspTestClient(process.execPath, [PROXY], {
    cwd: FIXTURES, // simulates a session rooted ABOVE the Lake projects
    env: {
      ...process.env,
      MOCK_OUT: mockOut,
      LEAN4_LSP_LAKE: path.join(MOCK, 'mock-lake'),
      LEAN4_LSP_LEAN: path.join(MOCK, 'mock-lean'),
      ...extraEnv,
    },
  });
  client.mockOut = mockOut;
  return client;
}

function launches(client) {
  try {
    return fs.readFileSync(client.mockOut, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

const openParams = (file) => ({
  textDocument: { uri: pathToUri(file), languageId: 'lean', version: 1, text: fs.readFileSync(file, 'utf8') },
});

test('proxy: answers initialize immediately, before any server is spawned', async () => {
  const c = mockClient();
  try {
    const resp = await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    assert.ok(resp.result.capabilities.hoverProvider, 'advertises hover');
    assert.ok(resp.result.capabilities.documentSymbolProvider, 'advertises documentSymbol');
    assert.equal(launches(c).length, 0, 'no server spawned yet');
  } finally { c.kill(); }
});

test('proxy: didOpen in a Lake project spawns lake serve at the project root', async () => {
  const c = mockClient();
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    const file = path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean');
    c.notify('textDocument/didOpen', openParams(file));
    const resp = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(file) } }, 5000);
    assert.equal(resp.result[0].name, `sym@${path.join(FIXTURES, 'lakeproj')}`, 'served from project root');
    const l = launches(c);
    assert.equal(l.length, 1);
    assert.equal(l[0].tag, 'lake');
    assert.deepEqual(l[0].argv, ['serve']);
    assert.equal(l[0].cwd, path.join(FIXTURES, 'lakeproj'));
  } finally { c.kill(); }
});

test('proxy: standalone file gets lean --server rooted at its directory', async () => {
  const c = mockClient();
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    const file = path.join(FIXTURES, 'standalone/B.lean');
    c.notify('textDocument/didOpen', openParams(file));
    const resp = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(file) } }, 5000);
    assert.equal(resp.result[0].name, `sym@${path.join(FIXTURES, 'standalone')}`);
    const l = launches(c);
    assert.equal(l[0].tag, 'lean');
    assert.deepEqual(l[0].argv, ['--server']);
  } finally { c.kill(); }
});

test('proxy: routes documents from two projects to two servers', async () => {
  const c = mockClient();
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    const lakeFile = path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean');
    const soloFile = path.join(FIXTURES, 'standalone/B.lean');
    c.notify('textDocument/didOpen', openParams(lakeFile));
    c.notify('textDocument/didOpen', openParams(soloFile));
    const r1 = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(lakeFile) } }, 5000);
    const r2 = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(soloFile) } }, 5000);
    assert.equal(r1.result[0].name, `sym@${path.join(FIXTURES, 'lakeproj')}`);
    assert.equal(r2.result[0].name, `sym@${path.join(FIXTURES, 'standalone')}`);
    assert.equal(launches(c).length, 2, 'exactly two servers');
    // diagnostics from both servers reach the client
    const d1 = await c.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === pathToUri(lakeFile), 5000, 'lake diagnostics');
    await c.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === pathToUri(soloFile), 5000, 'standalone diagnostics');
    // …minus the build-progress lines, which describe the build and not the file
    assert.deepEqual(d1.params.diagnostics.map((d) => d.message.slice(0, 4)), ['mock']);
  } finally { c.kill(); }
});

test('proxy: workspace/symbol broadcasts and merges results', async () => {
  const c = mockClient();
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    c.notify('textDocument/didOpen', openParams(path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean')));
    c.notify('textDocument/didOpen', openParams(path.join(FIXTURES, 'standalone/B.lean')));
    // make sure both servers are up before broadcasting
    await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean')) } }, 5000);
    await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(path.join(FIXTURES, 'standalone/B.lean')) } }, 5000);
    const resp = await c.request('workspace/symbol', { query: 'ws' }, 5000);
    const names = resp.result.map((s) => s.name).sort();
    assert.deepEqual(names, [`ws@${path.join(FIXTURES, 'lakeproj')}`, `ws@${path.join(FIXTURES, 'standalone')}`]);
  } finally { c.kill(); }
});

test('proxy: retries empty results while the server is warming up', async () => {
  const c = mockClient({ MOCK_EMPTY_FIRST: '2', LEAN4_LSP_RETRY_MS: '200' });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    const file = path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean');
    c.notify('textDocument/didOpen', openParams(file));
    const resp = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(file) } }, 10000);
    assert.equal(resp.result[0].name, `sym@${path.join(FIXTURES, 'lakeproj')}`,
      'real result delivered after the cold-start empties');
  } finally { c.kill(); }
});

test('proxy: genuinely empty results still arrive after bounded retries', async () => {
  const c = mockClient({ MOCK_EMPTY_FIRST: '99', LEAN4_LSP_RETRY_MS: '200' });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    const file = path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean');
    c.notify('textDocument/didOpen', openParams(file));
    const resp = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(file) } }, 10000);
    assert.deepEqual(resp.result, [], 'empty passes through once retries are exhausted');
  } finally { c.kill(); }
});

test('proxy: missing toolchain produces a clear showMessage, not a hang', async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-nohome-'));
  const c = new LspTestClient(process.execPath, [PROXY], {
    cwd: FIXTURES,
    env: { PATH: '/usr/bin:/bin', HOME: emptyHome },
  });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    const file = path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean');
    c.notify('textDocument/didOpen', openParams(file));
    const note = await c.waitFor((m) => m.method === 'window/showMessage', 5000, 'showMessage');
    assert.match(note.params.message, /elan|lean-lang\.org/i, 'mentions how to install the toolchain');
    const resp = await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(file) } }, 5000);
    assert.ok(resp.error, 'requests fail fast with an error instead of hanging');
    fs.rmSync(emptyHome, { recursive: true, force: true });
  } finally { c.kill(); }
});

test('proxy: clean shutdown/exit terminates proxy and servers', async () => {
  const c = mockClient();
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    c.notify('textDocument/didOpen', openParams(path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean')));
    await c.request('textDocument/documentSymbol', { textDocument: { uri: pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/A.lean')) } }, 5000);
    const resp = await c.request('shutdown', null, 5000);
    assert.equal(resp.result, null);
    c.notify('exit');
    const code = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
    assert.equal(code, 0, 'proxy exited cleanly');
  } finally { c.kill(); }
});

// What the Lean side holds. Each open document is a worker process (~2 GiB
// with Mathlib); Claude Code closes documents only past 50, so the proxy
// bounds it. The mock logs open/change/close/exit to $MOCK_EVENTS.

function eventClient(extraEnv = {}) {
  const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-events-')), 'events.jsonl');
  const c = mockClient({ MOCK_EVENTS: eventsFile, ...extraEnv });
  c.events = () => {
    try { return fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch { return []; }
  };
  c.waitEvent = async (pred, ms = 5000, what = 'event') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = c.events().find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`timeout waiting for ${what}; events: ${JSON.stringify(c.events())}\nstderr:\n${c.stderr}`);
  };
  return c;
}

const synthDoc = (rel, text, version = 1) => ({
  textDocument: { uri: pathToUri(path.join(FIXTURES, rel)), languageId: 'lean', version, text },
});
const symbols = (c, rel) => c.request('textDocument/documentSymbol',
  { textDocument: { uri: pathToUri(path.join(FIXTURES, rel)) } }, 5000);
const unexpectedExit = (c) => c.messages.some((m) => m.method === 'window/showMessage'
  && /exited unexpectedly/.test(m.params.message));

test('applyContentChanges: full replacement and ranged splices (UTF-16 positions)', () => {
  assert.equal(applyContentChanges('abc', [{ text: 'xyz' }]), 'xyz');
  const t = 'line one\nline two\nline three';
  assert.equal(applyContentChanges(t, [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 8 } }, text: '2' }]),
    'line one\nline 2\nline three');
  assert.equal(applyContentChanges(t, [{ range: { start: { line: 0, character: 4 }, end: { line: 2, character: 4 } }, text: '' }]),
    'line three');
  // α is one UTF-16 unit, 𝔽 is two
  assert.equal(applyContentChanges('α𝔽x', [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, text: 'y' }]), 'α𝔽y');
  // several changes apply in order, each against the previous result
  assert.equal(applyContentChanges('ab', [
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, text: '\nc' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, text: 'C' },
  ]), 'ab\nC');
});

test('proxy: holds at most LEAN4_LSP_MAX_OPEN documents on the Lean side, reopening on demand', async () => {
  const c = eventClient({ LEAN4_LSP_MAX_OPEN: '2' });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    for (const n of [1, 2, 3]) {
      c.notify('textDocument/didOpen', synthDoc(`lakeproj/Lakeproj/X${n}.lean`, `x${n}`));
      await symbols(c, `lakeproj/Lakeproj/X${n}.lean`);
      await sleep(20);
    }
    const x1 = pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/X1.lean'));
    const x2 = pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/X2.lean'));
    const x3 = pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/X3.lean'));
    await c.waitEvent((e) => e.event === 'close' && e.uri === x1, 5000, 'X1 closed as least recently used');
    assert.ok(!c.events().some((e) => e.event === 'close' && e.uri !== x1), 'only X1 closed');
    // The client still has X1 open: a request on it reopens it transparently.
    const r = await symbols(c, 'lakeproj/Lakeproj/X1.lean');
    assert.ok(!r.error, `request on an evicted document answered: ${JSON.stringify(r.error)}`);
    assert.equal(c.events().filter((e) => e.event === 'open' && e.uri === x1).length, 2, 'X1 reopened');
    await c.waitEvent((e) => e.event === 'close' && e.uri === x2, 5000, 'X2 now the one closed');
    await sleep(20);
    // An edit to an evicted document reopens it with the edited text.
    c.notify('textDocument/didChange', { textDocument: { uri: x2, version: 7 }, contentChanges: [{ text: 'x2 edited' }] });
    const reopened = await c.waitEvent((e) => e.event === 'open' && e.uri === x2 && e.text === 'x2 edited', 5000, 'X2 reopened with its new text');
    assert.equal(reopened.version, 7);
    await c.waitEvent((e) => e.event === 'close' && e.uri === x3, 5000, 'X3 closed in turn');
    // An edit to a held document is forwarded as an edit, not a reopen.
    c.notify('textDocument/didChange', { textDocument: { uri: x2, version: 8 }, contentChanges: [{ text: 'x2 again' }] });
    await c.waitEvent((e) => e.event === 'change' && e.uri === x2 && e.text === 'x2 again', 5000, 'change forwarded');
    assert.equal(launches(c).length, 1, 'one server throughout');
    // The empty diagnostics a server publishes on close never reach the client.
    await sleep(100);
    assert.ok(!c.messages.some((m) => m.method === 'textDocument/publishDiagnostics' && m.params.diagnostics.length === 0),
      'no stale "no errors" for documents the client still has open');
  } finally { c.kill(); }
});

test('proxy: a client didClose of an evicted document is not forwarded', async () => {
  const c = eventClient({ LEAN4_LSP_MAX_OPEN: '1' });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    c.notify('textDocument/didOpen', synthDoc('lakeproj/Lakeproj/X1.lean', 'x1'));
    await symbols(c, 'lakeproj/Lakeproj/X1.lean');
    await sleep(20);
    c.notify('textDocument/didOpen', synthDoc('lakeproj/Lakeproj/X2.lean', 'x2'));
    await symbols(c, 'lakeproj/Lakeproj/X2.lean');
    const x1 = pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/X1.lean'));
    await c.waitEvent((e) => e.event === 'close' && e.uri === x1);
    c.notify('textDocument/didClose', { textDocument: { uri: x1 } });
    await symbols(c, 'lakeproj/Lakeproj/X2.lean'); // a round trip after the didClose
    assert.equal(c.events().filter((e) => e.event === 'close' && e.uri === x1).length, 1, 'closed once, by the proxy');
  } finally { c.kill(); }
});

test('proxy: closes idle documents, stops the idle server, restarts both on next use', async () => {
  const c = eventClient({ LEAN4_LSP_DOC_IDLE_MS: '300', LEAN4_LSP_SERVER_IDLE_MS: '300', LEAN4_LSP_SWEEP_MS: '100' });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    c.notify('textDocument/didOpen', synthDoc('lakeproj/Lakeproj/X1.lean', 'x1'));
    await symbols(c, 'lakeproj/Lakeproj/X1.lean');
    const x1 = pathToUri(path.join(FIXTURES, 'lakeproj/Lakeproj/X1.lean'));
    await c.waitEvent((e) => e.event === 'close' && e.uri === x1, 5000, 'idle document closed');
    const ex = await c.waitEvent((e) => e.event === 'exit', 5000, 'idle server stopped');
    assert.equal(ex.how, 'exit', 'stopped by LSP shutdown/exit, not killed');
    assert.ok(!unexpectedExit(c), 'a deliberate stop is not reported as a crash');
    const r = await symbols(c, 'lakeproj/Lakeproj/X1.lean');
    assert.ok(!r.error, `answered after restart: ${JSON.stringify(r.error)}`);
    assert.equal(launches(c).length, 2, 'server restarted on demand');
    assert.equal(c.events().filter((e) => e.event === 'open' && e.uri === x1 && e.text === 'x1').length, 2);
  } finally { c.kill(); }
});

test('proxy: stops the server of a deleted project directory, and fails fast on its files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-lsp-worktree-'));
  fs.writeFileSync(path.join(root, 'lakefile.toml'), 'name = "wt"\n');
  fs.mkdirSync(path.join(root, 'Wt'));
  const file = path.join(root, 'Wt', 'F.lean');
  const uri = pathToUri(file);
  const c = eventClient({ LEAN4_LSP_SWEEP_MS: '100' });
  try {
    await c.request('initialize', { processId: null, rootUri: pathToUri(FIXTURES), capabilities: {} }, 5000);
    c.notify('initialized', {});
    c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'lean', version: 1, text: 'f' } });
    await c.request('textDocument/documentSymbol', { textDocument: { uri } }, 5000);
    fs.rmSync(root, { recursive: true, force: true });
    const ex = await c.waitEvent((e) => e.event === 'exit', 5000, 'server of the deleted directory stopped');
    assert.equal(ex.cwd, root);
    assert.ok(!unexpectedExit(c), 'not reported as a crash');
    const r = await c.request('textDocument/documentSymbol', { textDocument: { uri } }, 5000);
    assert.match(r.error && r.error.message, /deleted/, 'request on a vanished file fails with the reason');
    assert.equal(launches(c).length, 1, 'no server spawned for the vanished path');
  } finally { c.kill(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ lean-goal tests
// These run against a real `lean --server` and are skipped when no Lean
// toolchain is installed.

import { execFileSync, spawnSync } from 'node:child_process';

const LEAN_GOAL = path.join(__dirname, '..', 'bin', 'lean-goal.mjs');
const haveLean = !!resolveToolchain(process.env).lean;
const GOAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-goal-test-'));
const goalEnv = { ...process.env, LEAN4_LSP_GOAL_DIR: GOAL_DIR };

function leanGoal(args, opts = {}) {
  return spawnSync(process.execPath, [LEAN_GOAL, ...args], {
    env: goalEnv, encoding: 'utf8', timeout: 90000, ...opts,
  });
}

function leanTest(name, fn) {
  test(name, haveLean ? fn : () => { console.log('        (skipped: no lean toolchain)'); });
}

const C_LEAN = path.join(FIXTURES, 'standalone/C.lean');
const BAD_LEAN = path.join(FIXTURES, 'standalone/bad.lean');
const sorryCol = fs.readFileSync(C_LEAN, 'utf8').indexOf('sorry') + 1;

leanTest('lean-goal goal: reports the proof goal at a sorry', () => {
  const r = leanGoal(['goal', `${C_LEAN}:1:${sorryCol}`]);
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /⊢ 1 \+ 1 = 2/);
});

leanTest('lean-goal goal: line without column defaults to the sorry position', () => {
  const r = leanGoal(['goal', `${C_LEAN}:1`]);
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /⊢ 1 \+ 1 = 2/);
});

leanTest('lean-goal check: clean-but-sorried file reports the sorry warning, exit 0', () => {
  const r = leanGoal(['check', C_LEAN]);
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /sorry/);
});

leanTest('lean-goal check: file with a type error exits 1 and shows the error', () => {
  const r = leanGoal(['check', BAD_LEAN]);
  assert.equal(r.status, 1, `exit 1, stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /error/i);
});

leanTest('lean-goal sorries: lists each sorry with its goal', () => {
  const r = leanGoal(['sorries', C_LEAN]);
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /⊢ 1 \+ 1 = 2/);
  assert.match(r.stdout, /:1:/); // includes the location
});

leanTest('lean-goal: daemon persists between calls and stops on request', () => {
  leanGoal(['goal', `${C_LEAN}:1:${sorryCol}`]);
  const socks = fs.readdirSync(GOAL_DIR).filter((f) => f.endsWith('.sock'));
  assert.ok(socks.length >= 1, 'daemon socket exists after a query');
  const r = leanGoal(['stop']);
  assert.equal(r.status, 0, `stop works, stderr: ${r.stderr}`);
  const after = fs.readdirSync(GOAL_DIR).filter((f) => f.endsWith('.sock'));
  assert.equal(after.length, 0, 'sockets removed after stop');
});

leanTest('lean-goal try: a working tactic reports success and leaves the file untouched', () => {
  const before = fs.readFileSync(C_LEAN, 'utf8');
  const r = leanGoal(['try', `${C_LEAN}:1`, 'rfl']);
  assert.equal(r.status, 0, `exit 0, stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /✓/);
  assert.equal(fs.readFileSync(C_LEAN, 'utf8'), before, 'candidate must not be written to disk');
});

leanTest('lean-goal try: a failing tactic exits 1 and shows the error it would cause', () => {
  const r = leanGoal(['try', `${C_LEAN}:1`, 'exact 5']);
  assert.equal(r.status, 1, `exit 1, stdout: ${r.stdout}`);
  assert.match(r.stdout, /error/i);
});

leanTest('lean-goal try: a candidate that is itself a sorry does not count as proved', () => {
  const r = leanGoal(['try', `${C_LEAN}:1`, 'sorry']);
  assert.equal(r.status, 1, `exit 1, stdout: ${r.stdout}`);
  assert.match(r.stdout, /still discharged by a `sorry`/);
});

leanTest('lean-goal try: on a line without a sorry it replaces the tactic there', () => {
  // bad.lean: `example : 1 = 2 := rfl` — the whole line is the failing candidate.
  const before = fs.readFileSync(BAD_LEAN, 'utf8');
  const r = leanGoal(['try', `${BAD_LEAN}:1`, 'example : 2 = 2 := rfl']);
  assert.equal(r.status, 0, `exit 0, stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /example : 1 = 2 := rfl ⟶/);
  assert.match(r.stdout, /resolves 1 error/);
  assert.equal(fs.readFileSync(BAD_LEAN, 'utf8'), before, 'file untouched without --apply');
  const bad = leanGoal(['try', `${BAD_LEAN}:1`, 'example : 1 = 2 := by decide']);
  assert.equal(bad.status, 1, `a wrong replacement still fails: ${bad.stdout}`);
});

leanTest('lean-goal try --apply: writes a working candidate to disk', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-goal-apply-')), 'Apply.lean');
  fs.writeFileSync(f, 'example : 1 + 1 = 2 := by\n  sorry\n');
  const r = leanGoal(['try', '--apply', `${f}:2`, 'rfl']);
  assert.equal(r.status, 0, `exit 0, stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.equal(fs.readFileSync(f, 'utf8'), 'example : 1 + 1 = 2 := by\n  rfl\n');
});

leanTest('lean-goal check --errors-only --compact: one line per error, nothing else', () => {
  const r = leanGoal(['check', '--errors-only', '--compact', BAD_LEAN]);
  assert.equal(r.status, 1);
  const lines = r.stdout.split('\n').filter((l) => /^\s+error /.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\s+error .*bad\.lean:1:\d+: /);
  assert.ok(!/warning /.test(r.stdout));
});

const haveLake = !!resolveToolchain(process.env).lake;
const toolchainFile = (() => {
  // A pinned toolchain keeps the test off elan's network path; use one that
  // is already installed, if any.
  try {
    const dir = path.join(process.env.ELAN_HOME || path.join(os.homedir(), '.elan'), 'toolchains');
    const names = fs.readdirSync(dir).filter((n) => /^leanprover--lean4---v/.test(n)).sort();
    return names.length ? names[names.length - 1].replace('leanprover--lean4---', 'leanprover/lean4:') : null;
  } catch { return null; }
})();

test('lean-goal check: an edit to an imported module is seen by the importer', haveLake && toolchainFile ? () => {
  // The failure this guards: the daemon keeps the importer open, the server
  // re-reads its imports only on open, and a constant defined and built ten
  // seconds ago is reported as unknown for the rest of the session.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-goal-reload-'));
  fs.writeFileSync(path.join(root, 'lakefile.toml'), 'name = "reloadtest"\n[[lean_lib]]\nname = "R"\n');
  fs.writeFileSync(path.join(root, 'lean-toolchain'), `${toolchainFile}\n`);
  fs.mkdirSync(path.join(root, 'R'));
  fs.writeFileSync(path.join(root, 'R', 'A.lean'), 'def a : Nat := 1\n');
  const importer = path.join(root, 'R', 'B.lean');
  fs.writeFileSync(importer, 'import R.A\n#check b\n');
  const r1 = leanGoal(['check', importer], { timeout: 180000 });
  assert.match(r1.stdout, /nknown identifier .b./, `first check sees no b: ${r1.stdout} ${r1.stderr}`);
  // Define `b` in the import. The daemon still holds B.lean open.
  fs.writeFileSync(path.join(root, 'R', 'A.lean'), 'def a : Nat := 1\ndef b : Nat := 2\n');
  const r2 = leanGoal(['check', importer], { timeout: 180000 });
  assert.equal(r2.status, 0, `second check must see b: ${r2.stdout} ${r2.stderr}`);
  assert.match(r2.stdout, /reloaded them before answering/);
  assert.ok(!/nknown identifier/.test(r2.stdout));
  leanGoal(['stop']);
  fs.rmSync(root, { recursive: true, force: true });
} : () => { console.log('        (skipped: no lake toolchain)'); });

leanTest('lean-goal cmd: runs a command in the file\'s import context', () => {
  const r = leanGoal(['cmd', C_LEAN, '#check Nat.succ']);
  assert.equal(r.status, 0, `exit 0, stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /Nat\.succ/);
});

leanTest('lean-goal cmd: a failing command exits 1', () => {
  const r = leanGoal(['cmd', C_LEAN, '#check no_such_name_at_all']);
  assert.equal(r.status, 1, `exit 1, stdout: ${r.stdout}`);
});

leanTest('lean-goal search: finds environment names and shows signatures', () => {
  const r = leanGoal(['search', C_LEAN, 'Nat.succ_le']);
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /Nat\.succ_le/);
});

leanTest('lean-goal sorries: a broken statement is flagged before its goals', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-goal-broken-')), 'Broken.lean');
  // The statement does not elaborate, so the goal below it is meaningless.
  // (An unbound name would be auto-bound as an implicit and elaborate fine —
  // this needs a genuine type error.)
  fs.writeFileSync(f, 'example : (1 : Nat) + True := by sorry\n');
  const r = leanGoal(['sorries', f]);
  assert.match(r.stdout, /error\(s\) were already present/);
});

// ------------------------------------------------------------- runner

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(String(e && e.stack || e).replace(/^/gm, '        '));
  }
}
console.log(failed ? `\n${failed}/${tests.length} tests FAILED` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
