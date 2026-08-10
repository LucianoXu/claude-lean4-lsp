---
name: lean-interactive-proving
description: Use when writing, fixing, or exploring Lean 4 proofs — establishes the interactive workflow using LSP diagnostics, the lean-goal CLI for proof-goal states, and lake build for final verification
---

# Interactive Lean 4 Proving

Two complementary tools are available for Lean work, plus a final gate:

| Need | Tool | Why |
|------|------|-----|
| Proof goal at a position, goals at every `sorry`, fast per-file diagnostics | `lean-goal` CLI (on PATH) | Speaks Lean's custom `$/lean/plainGoal` protocol; keeps a warm server, so repeat queries are instant |
| Hover types/docs, go-to-definition, references, symbols | LSP tool | Standard code intelligence over the same live server |
| Final acceptance | `lake build` | The only verdict that counts; run it before declaring a proof done |

## Core loop for writing a proof

1. Put `sorry` where the proof is unfinished.
2. `lean-goal sorries <file>` — see every open goal with hypotheses.
3. Edit: replace one `sorry` with tactics (possibly introducing new `sorry`s).
4. `lean-goal check <file>` — errors/warnings in seconds (no `lake build` needed).
5. Inspect an intermediate state when stuck: `lean-goal goal <file>:<line>:<col>`
   — position at a tactic shows the goal *before* it; end of line shows the state *after* the line. Positions are 1-based.
6. Repeat until `check` reports no errors and no sorry warnings, then `lake build`.

## Reading goal output

- `⊢ P` — the target; lines above it are hypotheses.
- Multiple goals appear in order; the first is the current focus.
- `no goals` at a position after the final tactic means that branch is complete.
- "No tactic goal at this position" usually means the position is outside a `by` block — check line/col or query the `sorry` itself.

## Exploring unfamiliar API

- Hover (LSP) on any identifier for its signature and docstring.
- `goToDefinition` to read the source, including inside `.lake/packages` dependencies (served by the same project server).
- `workspaceSymbol` to find lemmas by name fragment.

## Troubleshooting

- First query on a project starts a Lean server (up to ~1 min for Mathlib-sized imports); later queries are instant. `lean-goal status` lists warm servers; `lean-goal stop` frees their memory.
- `lean-goal` and the LSP plugin auto-detect the Lake project root from each file's location and find elan even when it is not on PATH — no need to cd into the project first.
- Diagnostics reflect the live in-memory file. After large refactors or toolchain changes, `lean-goal stop` then re-query to get a fresh server.
