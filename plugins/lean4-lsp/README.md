# lean4-lsp

Lean 4 language server plugin for [Claude Code](https://claude.com/claude-code) — with automatic project-root detection, toolchain resolution, and interactive proof-state queries.

## Why this exists

Claude Code launches LSP servers from the **session root**. Lean's server must run from the **Lake project root** (where `lakefile.toml` and `lean-toolchain` live) — otherwise imports don't resolve and the wrong toolchain is used. A naive `"command": "lake serve"` config only works when you happen to open Claude Code exactly at the project root.

This plugin fixes that with a launcher proxy, and goes further:

- **Automatic project-root detection** — on every file open, walks up from the `.lean` file to the nearest `lakefile.toml`/`lakefile.lean` and runs `lake serve` there. Dependency sources under `.lake/packages/` are correctly served by the outer project. Standalone files (no lakefile) get `lean --server`. One plugin covers both modes — no need to choose at install time.
- **Multi-project sessions** — files from different Lake projects in one session each get their own correctly-rooted server; requests are routed per document.
- **elan discovery** — finds `lake`/`lean` via PATH, `$ELAN_HOME/bin`, or `~/.elan/bin`, so it works even when elan's bin dir was never added to PATH. Overridable with `LEAN4_LSP_LAKE` / `LEAN4_LSP_LEAN`.
- **Interactive proof states** — the bundled `lean-goal` CLI exposes Lean's `$/lean/plainGoal`, which generic LSP clients cannot reach: goals at any position, the goal at every `sorry`, and fast per-file diagnostics, backed by a warm background server.
- **Clear failures** — a missing toolchain produces an actionable message (what was searched, how to install), not a bare `ENOENT`.

## Prerequisites

- [Lean 4 via elan](https://lean-lang.org/lean4/doc/setup.html)
- Node.js ≥ 18 (or Bun/Deno) — used by the launcher; without any JS runtime the plugin degrades to a plain server with PATH fixes only
- Claude Code ≥ 2.1

## Installation

```bash
claude plugin marketplace add LucianoXu/claude-lean4-lsp
claude plugin install lean4-lsp@claude-lean4-lsp
```

Or for a single session from a checkout: `claude --plugin-dir ./claude-lean4-lsp/plugins/lean4-lsp`

> Upgrading from `lean4-lake-lsp` / `lean4-lean-lsp` (≤ 0.1.0): uninstall both — this plugin replaces the pair, and Claude Code lets only one server claim `.lean` files anyway.

## What you get

**Automatically, after every edit to a `.lean` file** — diagnostics from the live server: type errors, unsolved goals, sorry warnings. No `lake build` round-trips while iterating.

**Via the LSP tool** — hover (types + docstrings), go-to-definition (including into Mathlib sources), find-references, document/workspace symbols, call hierarchy.

**Via `lean-goal`** (on PATH in Claude Code's Bash tool):

```
lean-goal goal Formalization/Closure.lean:42:7    # tactic goals at a position
lean-goal sorries Formalization/Closure.lean      # every sorry, with its goal
lean-goal check Formalization/Closure.lean        # elaborate + diagnostics, in seconds
lean-goal status                                  # warm servers
lean-goal stop                                    # free their memory
```

Positions are 1-based. Without a column, the position defaults to the first `sorry` on the line. The first query on a project starts a background server (up to ~1 min with Mathlib imports); subsequent queries are near-instant. Daemons idle out after 30 minutes.

A bundled skill (`lean-interactive-proving`) teaches Claude the sorry-driven workflow: `sorries` → edit → `check` → `lake build` as the final gate.

## Configuration (environment variables)

| Variable | Effect |
|----------|--------|
| `LEAN4_LSP_LAKE` / `LEAN4_LSP_LEAN` | Absolute paths overriding binary discovery |
| `LEAN4_LSP_MODE=lake\|lean` | Force one server mode for all files |
| `LEAN4_LSP_DEBUG=1` | Verbose proxy routing log on stderr |
| `LEAN4_LSP_LOG_FILE` | Wire-level trace of all LSP traffic to a file (debugging) |
| `LEAN4_LSP_WARMUP_MS` / `LEAN4_LSP_RETRY_MS` | Cold-start empty-result retry window / delay (defaults 45 s / 2 s) |
| `LEAN4_LSP_IDLE_MS` | lean-goal daemon idle timeout (default 30 min) |
| `LEAN4_LSP_TIMEOUT_MS` | lean-goal query timeout (default 5 min) |

## Notes

- **Cold start**: the Lean watchdog loads its `.ilean` index asynchronously (5–20 s for a Mathlib-sized workspace), during which definition/symbol queries would return empty. The proxy absorbs this by retrying empty results while a server is younger than 45 s — so go-to-definition into Mathlib and `workspaceSymbol` across dependencies work from the first query.
- **Memory**: each project's server can use significant RAM (Mathlib: several GB). `lean-goal stop` and closing the session both free it.
- **Final verification**: the language server reflects live editor state; `lake build` remains the ground truth for CI-grade acceptance.
- **Development**: `node test/run-tests.mjs` runs the full suite (framing, root detection, proxy routing, and live `lean-goal` tests when a toolchain is installed).

## License

MIT
