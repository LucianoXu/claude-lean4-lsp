# lean4-lsp

Lean 4 language server plugin for [Claude Code](https://claude.com/claude-code) — with automatic project-root detection, toolchain resolution, and interactive proof-state queries.

## Why this exists

Claude Code launches LSP servers from the **session root**. Lean's server must run from the **Lake project root** (where `lakefile.toml` and `lean-toolchain` live) — otherwise imports don't resolve and the wrong toolchain is used. A naive `"command": "lake serve"` config only works when you happen to open Claude Code exactly at the project root.

This plugin fixes that with a launcher proxy, and goes further:

- **Automatic project-root detection** — on every file open, walks up from the `.lean` file to the nearest `lakefile.toml`/`lakefile.lean` and runs `lake serve` there. Dependency sources under `.lake/packages/` are correctly served by the outer project. Standalone files (no lakefile) get `lean --server`. One plugin covers both modes — no need to choose at install time.
- **Multi-project sessions** — files from different Lake projects in one session each get their own correctly-rooted server; requests are routed per document.
- **elan discovery** — finds `lake`/`lean` via PATH, `$ELAN_HOME/bin`, or `~/.elan/bin`, so it works even when elan's bin dir was never added to PATH. Overridable with `LEAN4_LSP_LAKE` / `LEAN4_LSP_LEAN`.
- **Interactive proof states** — the bundled `lean-goal` CLI exposes Lean's `$/lean/plainGoal`, which generic LSP clients cannot reach: goals at any position and the goal at every `sorry`, backed by a warm background server.
- **Candidate tactics without editing** — `lean-goal try` splices a tactic over a `sorry` *in the server's in-memory copy*, reports whether it closes the goal, and reverts. About a second per candidate, and a wrong guess never reaches the file.
- **Library search that works on Mathlib** — `lean-goal search` queries the full imported environment through completion, ranked and resolved to real signatures. The LSP `workspaceSymbol` request only indexes the current project, so Mathlib names are invisible to it.
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
lean-goal sorries Closure.lean               # every sorry, with its goal
lean-goal goal Closure.lean:42:7             # tactic goals at a position
lean-goal try Closure.lean:42 'ring'         # does this tactic work? (file untouched)
lean-goal hint Closure.lean:42               # exact? / simp? / rw? suggestions
lean-goal search Closure.lean trace_smul     # find lemmas by name fragment
lean-goal cmd Closure.lean '#check @Foo.bar' # exact statement of a name
lean-goal check Closure.lean                 # diagnostics, in seconds
lean-goal build Closure.lean                 # lake build, and sorries fail it
lean-goal status / stop                      # warm servers, free their memory
```

Positions are 1-based. Without a column, the position defaults to the first `sorry` on the line — comments and string literals are skipped, so `-- TODO: sorry` is not mistaken for an open goal. The first query on a project starts a background server (up to ~1 min with Mathlib imports); subsequent queries are near-instant. Daemons idle out after 30 minutes, and are replaced automatically when the plugin is upgraded underneath them.

`lean-goal build` is deliberately stricter than `lake build`: a file whose declarations still use `sorry` compiles fine and exits 0, which for a proof is the one result that must not read as success. Pass `--allow-sorry` for work in progress.

A bundled skill (`lean-interactive-proving`) teaches Claude the workflow: get the goal, find the lemma, **verify the tactic with `try` before writing it**, then `check` and `build`.

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
| `LEAN4_LSP_MAX_MSG` | Truncate each diagnostic to N characters (default 4000) |
| `LEAN4_LSP_MAX_COMPLETIONS` / `LEAN4_LSP_MAX_HINT_LINES` | Result caps for `search` / `hint` (default 40 / 24) |
| `LEAN4_LSP_SILENCE_MS` | Fallback elaboration-quiet window for servers that never report progress (default 5 s) |

## Notes

- **Cold start**: the Lean watchdog loads its `.ilean` index asynchronously (5–20 s for a Mathlib-sized workspace), during which definition/symbol queries would return empty. The proxy absorbs this by retrying empty results while a server is younger than 45 s — so go-to-definition into Mathlib and `workspaceSymbol` across dependencies work from the first query.
- **Memory**: each project's server can use significant RAM (Mathlib: several GB). `lean-goal stop` and closing the session both free it.
- **Final verification**: the language server reflects live editor state; `lake build` remains the ground truth for CI-grade acceptance.
- **Development**: `node test/run-tests.mjs` runs the full suite (framing, root detection, proxy routing, and live `lean-goal` tests when a toolchain is installed).

## License

MIT
