// Minimal LSP test client: spawns a server process (the proxy under test, or
// a real lean server) and provides request/notify/wait primitives.

import { spawn } from 'node:child_process';
import { LspFramer, frameMessage } from '../bin/lean-lsp-lib.mjs';

export class LspTestClient {
  constructor(command, args, opts = {}) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    this.messages = [];
    this.waiters = [];
    this.nextId = 1;
    this.stderr = '';
    this.proc.stderr.on('data', (c) => { this.stderr += c; });
    const framer = new LspFramer();
    framer.onMessage = (m) => {
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) { w.resolve(m); return false; }
        return true;
      });
    };
    this.proc.stdout.on('data', (c) => framer.push(c));
    this.exited = new Promise((res) => this.proc.on('exit', (code) => res(code)));
  }

  send(obj) { this.proc.stdin.write(frameMessage({ jsonrpc: '2.0', ...obj })); }

  notify(method, params) { this.send({ method, params }); }

  async request(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    this.send({ id, method, params });
    return this.waitFor((m) => m.id === id && !m.method, timeoutMs, `response to ${method} (id ${id})`);
  }

  waitFor(pred, timeoutMs = 10000, what = 'message') {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}\nstderr:\n${this.stderr}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  kill() { try { this.proc.kill('SIGKILL'); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
