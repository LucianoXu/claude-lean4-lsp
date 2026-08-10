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

const { findLakeRoot, resolveToolchain, LspFramer, frameMessage } =
  await import('../bin/lean-lsp-lib.mjs');

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

// ---------------------------------------------------------------- proxy tests

import { LspTestClient } from './helpers.mjs';
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
    // diagnostics from both servers reach the client untouched
    await c.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === pathToUri(lakeFile), 5000, 'lake diagnostics');
    await c.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === pathToUri(soloFile), 5000, 'standalone diagnostics');
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
