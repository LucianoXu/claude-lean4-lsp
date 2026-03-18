# lean4-lsp

Lean 4 language server plugin for [Claude Code](https://claude.ai/claude-code).

Provides diagnostics, hover info, go-to-definition, and completions for `.lean` files via the Lean 4 built-in language server.

## Prerequisites

- [Lean 4](https://lean-lang.org/lean4/doc/setup.html) installed with [Lake](https://github.com/leanprover/lean4/tree/master/src/lake) (included in standard Lean 4 installation)
- [Claude Code](https://claude.ai/claude-code) CLI

## Installation

```bash
claude plugin add /path/to/lean4-lsp
```

Or add the LSP configuration manually to your project's `.claude/settings.json`:

```json
{
  "lspServers": {
    "lean": {
      "command": "lake",
      "args": ["serve"],
      "transport": "stdio",
      "extensionToLanguage": {
        ".lean": "lean"
      },
      "initializationOptions": {},
      "settings": {},
      "maxRestarts": 3,
      "startupTimeout": 60000,
      "shutdownTimeout": 15000
    }
  }
}
```

The default uses `lake serve`, which respects your project's `lean-toolchain` file and resolves Lake dependencies (e.g., Mathlib) automatically. This is the same approach used by VS Code's Lean extension.

## Standalone Files (No Lake Project)

If you are working with standalone `.lean` files outside a Lake project, use `lean --server` instead:

```json
{
  "lean": {
    "command": "lean",
    "args": ["--server"],
    "transport": "stdio",
    "extensionToLanguage": {
      ".lean": "lean"
    },
    "initializationOptions": {},
    "settings": {},
    "maxRestarts": 3,
    "startupTimeout": 60000,
    "shutdownTimeout": 15000
  }
}
```

## What You Get

After installation, Claude Code will automatically:

- **Diagnostics**: See type errors, unsolved goals, and `sorry` markers after each file edit — no need to run `lake build` manually
- **Hover info**: Get type signatures and documentation for any identifier
- **Go-to-definition**: Navigate to source definitions across files and dependencies
- **Completions**: Get autocomplete suggestions while editing Lean code

## Notes

- **Startup time**: Lean's language server can take 10-60 seconds to initialize, especially for projects importing Mathlib. The default `startupTimeout` of 60 seconds accommodates this.
- **Memory usage**: Lean's server can use significant memory (2-8 GB) depending on your project's dependencies. Ensure sufficient RAM is available.
- **Goal state**: Standard LSP diagnostics will show errors and unsolved goals. For interactive tactic goal states (like VS Code's Lean Infoview), consider pairing this plugin with the [lean-lsp-mcp](https://github.com/leanprover/lean-lsp-mcp) MCP server.

## License

MIT
