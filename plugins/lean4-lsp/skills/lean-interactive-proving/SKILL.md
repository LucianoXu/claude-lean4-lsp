---
name: lean-interactive-proving
description: Use when writing, fixing, or exploring Lean 4 proofs — establishes the interactive workflow of testing candidate tactics against the live server before editing, searching the imported environment for lemmas, and gating on lake build
---

# Interactive Lean 4 Proving

The rule that matters: **never write a tactic into a file to find out whether it
works.** `lean-goal try` elaborates a candidate against the live server in about
a second and leaves the file untouched. Guessing in the editor instead costs a
full re-elaboration, and leaves broken text behind when the guess is wrong.

| Need | Tool |
|------|------|
| Goal at a position, goal at every `sorry` | `lean-goal goal` / `lean-goal sorries` |
| Does this tactic work? | `lean-goal try` — in memory, ~1 s, file unchanged |
| What lemma should I use? | `lean-goal hint`, `lean-goal search`, `lean-goal cmd` |
| Fast per-file diagnostics | `lean-goal check` |
| Hover types, go-to-definition, references | the LSP tool |
| Final acceptance | `lean-goal build` (fails on `sorry`, unlike bare `lake build`) |

## The loop

1. Write the **statement** with `sorry` as the proof. Get the goal:
   `lean-goal sorries <file>`
2. Don't know which lemma applies? Ask, in increasing cost:
   - `lean-goal search <file> <fragment>` — names in the *full imported
     environment* including Mathlib, with signatures (~1 s)
   - `lean-goal cmd <file> '#check @Foo.bar'` — exact statement of a known name;
     `#print` for a definition's body
   - `lean-goal hint <file>:<line>` — runs `exact?`, `simp?`, `rw?` at that
     `sorry` and reports what each suggests (~5 s). `rw?` also shows the goal
     each rewrite would leave.
3. **Verify before writing:** `lean-goal try <file>:<line> '<tactic>'`
   → `✓` means it closes the goal; `✗` prints the errors it would cause.
   Try several candidates in a row — each is about a second, and none of them
   touch the file.
4. Only now edit the file, with a tactic you have already seen succeed.
5. `lean-goal check <file>` after the edit, then `lean-goal build <file>` as the
   gate. Positions are 1-based throughout.

A tactic that needs a lemma you don't have yet: put `sorry` in the sub-branch,
and recurse. `sorries` will list every open goal.

## Reading the output

- `⊢ P` is the target; lines above it are hypotheses. Multiple goals appear in
  order, the first being the current focus.
- **`⚠ N error(s) were already present`** — stop and fix those first. A
  statement that fails to elaborate gives its own hypotheses the type `sorry`,
  so every goal and every candidate below it is meaningless until it is fixed.
- `⚠ still discharged by a sorry` from `try` — the candidate elaborated but
  proves nothing; the `sorry` is still doing the work.
- "No tactic goal at this position" — the position is outside a `by` block.
- `lean-goal build` reports `✗ compiles, but N declaration(s) still use sorry`.
  That is a failure: `lake build` exits 0 on a file full of `sorry`, so it alone
  never establishes that a proof is finished.

## Exploring unfamiliar API

`search` beats the LSP tool's `workspaceSymbol` for library work — the latter
indexes only the current project's ileans, so Mathlib names never appear in it.
Use the LSP tool for hover (signature + docstring at a use site) and
go-to-definition to read source; use `search`/`cmd` to find names in the first
place, and to reach anything under `.lake/packages`.

`cmd` elaborates at the end of the file, so it sees exactly the imports and
`open` namespaces that file has. Anything Lean accepts as a command works:
`#check`, `#print`, `#eval`, or a whole `example ... := by ...`.

## Troubleshooting

- The first query on a project starts a Lean server (up to ~1 min for
  Mathlib-sized imports); everything after is near-instant. `lean-goal status`
  lists warm servers, `lean-goal stop` frees their memory (several GB for
  Mathlib).
- Paths: `lean-goal` resolves the Lake root from each file, so relative paths
  work from anywhere and there is never a need to `cd`. The **LSP tool** is
  different — it resolves relative paths against the shell's working directory,
  so pass it absolute paths.
- Diagnostics reflect the live in-memory file, which is what makes them fast.
  `lean-goal build` is the ground truth.
