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

/**
 * Lake target name for a source file inside `root` — `Foo/Bar.lean` under the
 * project root becomes `Foo.Bar`. Returns null when the file is outside the
 * root or is a dependency source, where no target of the current package
 * covers it.
 *
 * Without this, `lean-goal build path/to/File.lean` would build the package's
 * *default* target, which may not include that file at all — reporting success
 * for a file nothing compiled.
 */
export function moduleNameFor(root, file) {
  const rel = path.relative(root, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).includes('.lake')) return null;
  if (!rel.endsWith('.lean')) return null;
  const parts = rel.slice(0, -'.lean'.length).split(path.sep);
  if (parts.some((p) => !/^[A-Za-z_][A-Za-z0-9_']*$/.test(p))) return null;
  return parts.join('.');
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

// ---------------------------------------------------------------------------
// Source scanning and splicing (pure — unit-tested without a Lean server)

/** Lean identifier characters, for token-boundary checks around `sorry`. */
const IDENT_RE = /[\p{L}\p{N}_'!?ₙ-ₜ₀-₉]/u;

/**
 * Locate every `sorry` token in Lean source, skipping line comments (`--`),
 * nested block comments (`/- -/`, including doc comments), and string
 * literals. Returns 1-based `{line, col}` positions in source order.
 *
 * A plain regex over the raw text also matches the `sorry` in `-- sorry, TODO`
 * and in `"contains sorry"`, which makes `lean-goal sorries` report positions
 * with no goal attached; skipping them keeps the output actionable.
 */
export function scanSorries(text) {
  const found = [];
  let line = 1, col = 1, depth = 0, i = 0;
  let inLineComment = false, inString = false;
  const at = (s) => text.startsWith(s, i);
  const adv = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (text[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  while (i < text.length) {
    if (inLineComment) {
      if (text[i] === '\n') inLineComment = false;
      adv();
    } else if (depth > 0) {
      if (at('/-')) { depth++; adv(2); }
      else if (at('-/')) { depth--; adv(2); }
      else adv();
    } else if (inString) {
      if (text[i] === '\\') adv(2);
      else { if (text[i] === '"') inString = false; adv(); }
    } else if (at('--')) { inLineComment = true; adv(2); }
    else if (at('/-')) { depth = 1; adv(2); }
    else if (text[i] === '"') { inString = true; adv(); }
    else if (at('sorry')
      && !IDENT_RE.test(text[i - 1] || ' ')
      && !IDENT_RE.test(text[i + 5] || ' ')) {
      found.push({ line, col });
      adv(5);
    } else adv();
  }
  return found;
}

/** 1-based (line, col) → absolute offset in `text`; null when out of range. */
export function offsetOf(text, line, col) {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return null;
  if (col < 1 || col > lines[line - 1].length + 1) return null;
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  return off + col - 1;
}

/**
 * Replace the `sorry` token at 1-based (line, col) with `replacement`.
 *
 * Lean's tactic blocks are whitespace-sensitive, so a multi-line replacement
 * has its continuation lines indented to the column the `sorry` started at —
 * `try` with a two-tactic block then means what it looks like it means.
 * Returns null if there is no `sorry` at that position.
 */
export function spliceSorry(text, line, col, replacement) {
  const off = offsetOf(text, line, col);
  if (off === null || !text.startsWith('sorry', off)) return null;
  const pad = ' '.repeat(col - 1);
  const body = replacement.split('\n').map((l, k) => (k === 0 ? l : pad + l)).join('\n');
  return text.slice(0, off) + body + text.slice(off + 'sorry'.length);
}

const lastSegment = (n) => n.slice(n.lastIndexOf('.') + 1);

/**
 * Rank Lean completion labels against a search fragment.
 *
 * Lean's completion matcher accepts any *subsequence*, so a query like
 * `trace_smul` comes back with `opShiftFunctorEquivalence_unitIso_hom_naturality`
 * — technically a match, useless as an answer. Everything above tier 2 here is
 * a name a person would accept, so results with a literal match are kept and
 * the subsequence-only remainder is dropped whenever anything better exists.
 *
 * Tiers: 0 = the bare name starts with the query, 1 = the bare name contains
 * it, 2 = the qualified name contains it, 3 = subsequence only. Within a tier,
 * shorter names first (they are the general lemma; longer ones are variants).
 */
export function rankNames(labels, query) {
  const q = query.toLowerCase();
  const qLast = lastSegment(q);
  const tierOf = (label) => {
    const full = label.toLowerCase();
    const bare = lastSegment(full);
    if (bare.startsWith(qLast)) return 0;
    if (bare.includes(qLast)) return 1;
    if (full.includes(q) || full.includes(qLast)) return 2;
    return 3;
  };
  const scored = labels.map((label) => ({ label, tier: tierOf(label) }));
  const best = Math.min(...scored.map((s) => s.tier));
  const kept = best < 3 ? scored.filter((s) => s.tier < 3) : scored;
  kept.sort((a, b) => a.tier - b.tier
    || a.label.length - b.label.length
    || a.label.localeCompare(b.label));
  return { ranked: kept.map((s) => s.label), dropped: scored.length - kept.length };
}

/**
 * Squeeze a Lean signature down to what a reader is actually scanning for.
 *
 * Mathlib signatures open with a wall of instance binders — `Matrix.trace_smul`
 * spends 60 of its 120 characters on `[inst : Fintype n] [inst_1 : ...]` before
 * reaching the equation. Truncating such a line to fit a terminal keeps the
 * binders and cuts the statement, exactly backwards. Instance-implicit binders
 * carry no information for choosing between candidate lemmas, so drop them.
 *
 * A group is treated as an instance binder only when it opens with `inst…` or
 * a capitalised class name, which leaves list literals like `[a, b]` alone.
 */
export function condenseSignature(sig) {
  const flat = sig.replace(/\s+/g, ' ').trim();
  let out = '', i = 0;
  while (i < flat.length) {
    if (flat[i] === '[' && /^\[(inst\w*\b|[A-Z][\w.']*\b)/.test(flat.slice(i))) {
      let depth = 0, j = i;
      for (; j < flat.length; j++) {
        if (flat[j] === '[') depth++;
        else if (flat[j] === ']' && --depth === 0) break;
      }
      if (j < flat.length) {
        i = j + 1;
        while (flat[i] === ' ') i++;
        // In arrow form (`[Fintype n] → [StarRing R] → Matrix n n R`) the
        // binder owns the arrow that follows it; leaving it behind renders as
        // a row of bare `→ → →`.
        if (flat[i] === '→') { i++; while (flat[i] === ' ') i++; }
        continue;
      }
    }
    out += flat[i++];
  }
  return out.replace(/∀\s*,/, '').replace(/^(?:→\s*)+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Clamp a Lean diagnostic to `max` characters. Elaboration errors routinely
 * run to thousands of lines (whole unfolded terms); pasted verbatim they
 * crowd out everything else in an agent's context, so keep the head — where
 * Lean states what went wrong — and say what was dropped.
 */
export function truncate(msg, max) {
  if (!max || msg.length <= max) return msg;
  return `${msg.slice(0, max)} … [+${msg.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// Import tracking

// Parsed import lists, keyed by path and mtime, so that walking a closure of a
// few hundred modules on every query costs stats rather than reads.
const importCache = new Map();

/**
 * Project-local modules a file imports, as source paths: `import A.B.C` is
 * `<root>/A/B/C.lean` when that file exists. Dependency modules (Mathlib and
 * the like, under `.lake/packages`) are not returned — their sources do not
 * change under an editing session.
 */
export function projectImports(root, file) {
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const key = `${file}`;
  const hit = importCache.get(key);
  if (hit && hit.mtime === mtime) return hit.imports;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const re = /^import\s+([\w.']+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const p = path.join(root, ...m[1].split('.')) + '.lean';
    if (p !== path.resolve(file) && fs.existsSync(p)) out.push(p);
  }
  importCache.set(key, { mtime, imports: out });
  return out;
}

/**
 * Fingerprint of everything a file's header depends on inside the project:
 * the transitive closure of its project-local imports, with the newest mtime
 * among them. When it changes, an import was edited, and a document the
 * server already holds open is elaborating against an environment that no
 * longer exists on disk.
 *
 * Lean's server re-reads a document's imports only when the document is
 * opened (or its header edited); editing an *imported* file leaves every
 * open importer on the old oleans until it is closed and reopened. This is
 * the same "Restart File" the VS Code extension asks for by hand, and it is
 * what made `lean-goal check` report an unknown constant that had been
 * defined and built ten seconds earlier.
 */
export function importClosureStamp(root, file) {
  const seen = new Set();
  const stack = [...projectImports(root, file)];   // a copy: the cached list must not be popped
  let newest = 0;
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch {}
    for (const q of projectImports(root, p)) if (!seen.has(q)) stack.push(q);
  }
  return `${seen.size}:${Math.floor(newest)}`;
}

/**
 * Replace the tactic on 1-based `line` — everything from its first non-blank
 * character to the end of the line — with `replacement`, continuation lines
 * indented to that column. Returns null for a blank or out-of-range line.
 * This is `try` on a line that already holds a (failing) tactic, which is
 * the common case once a proof exists and needs repair.
 */
export function spliceLine(text, line, replacement) {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return null;
  const cur = lines[line - 1];
  const indent = cur.length - cur.trimStart().length;
  if (!cur.trim()) return null;
  const pad = ' '.repeat(indent);
  const body = replacement.split('\n').map((l, k) => (k === 0 ? pad + l : pad + l)).join('\n');
  lines[line - 1] = body;
  return { text: lines.join('\n'), replaced: cur.trim(), col: indent + 1 };
}

/**
 * Drop the `trace: .> LEAN_PATH=…` lines Lake echoes into a failed
 * `setup-file` diagnostic: several hundred characters of search path per
 * line, none of it about what went wrong.
 */
export function stripTrace(msg) {
  return msg.split('\n').filter((l) => !/^\s*trace:\s/.test(l)).join('\n');
}

/**
 * Build-progress lines (`✔ [12/40] Built Foo`) that Lake's `setup-file` step
 * surfaces as info diagnostics at 1:1. They describe the build, not the file,
 * and a Mathlib-sized import closure produces dozens per open.
 */
export const BUILD_NOISE = /^[✔✖⚠ℹ]\s*\[\d+\/\d+\]/;
export function isBuildNoise(d) {
  return (d.severity === 3 || d.severity === 4) && BUILD_NOISE.test(d.message);
}

/** file:// URI ↔ path helpers (Lean servers use standard file URIs). */
export function uriToPath(uri) {
  if (!uri || !uri.startsWith('file://')) return null;
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
export function pathToUri(p) {
  return 'file://' + path.resolve(p).split(path.sep).map(encodeURIComponent).join('/');
}

/**
 * Apply LSP `contentChanges` to `text`: a change without a range replaces
 * the whole document, a ranged one splices. LSP positions count UTF-16 code
 * units, which is what JS string indices are, so no transcoding is needed.
 */
export function applyContentChanges(text, changes) {
  for (const ch of changes || []) {
    if (!ch.range) { text = ch.text; continue; }
    const start = lspOffset(text, ch.range.start);
    const end = Math.max(start, lspOffset(text, ch.range.end));
    text = text.slice(0, start) + ch.text + text.slice(end);
  }
  return text;
}

/** 0-based LSP (line, character) → offset, clamped to the line and the text. */
function lspOffset(text, pos) {
  let off = 0;
  for (let l = 0; l < pos.line; l++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  const eol = text.indexOf('\n', off);
  return Math.min(off + pos.character, eol < 0 ? text.length : eol);
}
