// Shared library for the lean4-lsp plugin: Lake project-root detection,
// elan toolchain resolution, and LSP stdio message framing.

import fs from 'node:fs';
import path from 'node:path';

const LAKEFILES = ['lakefile.toml', 'lakefile.lean'];

function hasLakefile(dir) {
  return LAKEFILES.some((f) => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });
}

/**
 * Walk up from a .lean file to the enclosing Lake project root.
 * Files under `<proj>/.lake/packages/...` (dependency sources) belong to the
 * outer project that owns the `.lake` directory, not to the dependency's own
 * lakefile — same resolution VS Code's Lean extension uses.
 * Returns an absolute directory path, or null for standalone files.
 */
export function findLakeRoot(filePath) {
  const abs = path.resolve(filePath);
  const lakeSeg = `${path.sep}.lake${path.sep}`;
  const lakeIdx = abs.indexOf(lakeSeg);
  if (lakeIdx !== -1) {
    const owner = abs.slice(0, lakeIdx);
    if (hasLakefile(owner)) return owner;
  }
  let dir = path.dirname(abs);
  while (true) {
    if (hasLakefile(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch { return false; }
}

function whichIn(pathVar, name) {
  for (const dir of (pathVar || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Locate lake/lean, tolerating environments where elan's bin dir was never
 * added to PATH. Search order per binary:
 *   1. LEAN4_LSP_LAKE / LEAN4_LSP_LEAN env override
 *   2. PATH
 *   3. $ELAN_HOME/bin, then ~/.elan/bin
 * Returns { lake, lean, env } — env is a copy of the input with the
 * discovered elan bin dir prepended to PATH so child processes (elan proxy
 * re-exec, lake spawning lean workers) resolve consistently.
 */
export function resolveToolchain(baseEnv = process.env) {
  const env = { ...baseEnv };
  const elanDirs = [];
  if (env.ELAN_HOME) elanDirs.push(path.join(env.ELAN_HOME, 'bin'));
  if (env.HOME) elanDirs.push(path.join(env.HOME, '.elan', 'bin'));

  const find = (name, override) => {
    if (override) return override;
    const onPath = whichIn(env.PATH, name);
    if (onPath) return onPath;
    for (const dir of elanDirs) {
      const p = path.join(dir, name);
      if (isExecutableFile(p)) return p;
    }
    return null;
  };

  const lake = find('lake', env.LEAN4_LSP_LAKE);
  const lean = find('lean', env.LEAN4_LSP_LEAN);

  const found = [lake, lean].filter(Boolean).map((p) => path.dirname(p));
  const prepend = [...new Set(found)].filter((d) => !(env.PATH || '').split(path.delimiter).includes(d));
  if (prepend.length) env.PATH = [...prepend, env.PATH || ''].join(path.delimiter);

  return { lake, lean, env };
}

/** Encode one LSP message with Content-Length framing. */
export function frameMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Incremental parser for LSP stdio framing. Feed chunks via push(); parsed
 *  messages are delivered to onMessage. Tolerates extra headers. */
export class LspFramer {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.onMessage = null;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { // malformed frame: drop the header and resync
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (this.onMessage) this.onMessage(msg);
    }
  }
}

/** file:// URI ↔ path helpers (Lean servers use standard file URIs). */
export function uriToPath(uri) {
  if (!uri || !uri.startsWith('file://')) return null;
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
export function pathToUri(p) {
  return 'file://' + path.resolve(p).split(path.sep).map(encodeURIComponent).join('/');
}
