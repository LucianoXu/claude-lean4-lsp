# claude-lean4-lsp

A Claude Code plugin marketplace providing **lean4-lsp** — Lean 4 language-server integration with automatic Lake project-root detection, elan toolchain resolution, multi-project routing, and interactive proof-state queries via the bundled `lean-goal` CLI.

```bash
claude plugin marketplace add LucianoXu/claude-lean4-lsp
claude plugin install lean4-lsp@claude-lean4-lsp
```

See [plugins/lean4-lsp/README.md](plugins/lean4-lsp/README.md) for full documentation.

> **v0.2.0** replaces the former `lean4-lake-lsp` / `lean4-lean-lsp` pair with a single plugin that auto-detects Lake projects per file. If you have the old ones installed, uninstall both.

MIT licensed.
