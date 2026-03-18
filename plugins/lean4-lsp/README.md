# claude-lean4-lsp

Lean 4 language server plugin for [Claude Code](https://claude.ai/claude-code).

Provides diagnostics, hover info, go-to-definition, and completions for `.lean` files via the Lean 4 built-in language server. This plugin brings the same real-time feedback mathematicians rely on in VS Code directly into Claude Code, reducing the effort of interactive theorem proving by surfacing type errors, unsolved goals, and `sorry` markers as you work.

## Two LSP Server Modes

This plugin provides two approaches to start the Lean 4 language server:

| Mode | Command | Best For |
|------|---------|----------|
| **Lake** (default) | `lake serve` | Lake projects with dependencies (e.g., Mathlib) |
| **Lean** (standalone) | `lean --server` | Standalone `.lean` files outside Lake projects |

## Prerequisites

- [Lean 4](https://lean-lang.org/lean4/doc/setup.html) installed with [Lake](https://github.com/leanprover/lean4/tree/master/src/lake) (included in standard Lean 4 installation)
- [Claude Code](https://claude.ai/claude-code) CLI

## Installation

### Option 1: From a Marketplace

```bash
# For Lake projects (recommended for most users):
claude plugin install lean4-lake-lsp

# For standalone .lean files:
claude plugin install lean4-lean-lsp
```

### Option 2: Local Plugin (single session)

Clone or download this repository, then launch Claude Code with the `--plugin-dir` flag:

```bash
git clone https://github.com/LucianoXu/claude-lean4-lsp.git
claude --plugin-dir ./claude-lean4-lsp
```

### Option 3: Manual Configuration (persistent)

Add the LSP configuration directly to your project's `.claude/settings.json`.

**Using `lake serve`** (for Lake projects):

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

`lake serve` respects your project's `lean-toolchain` file and resolves Lake dependencies (e.g., Mathlib) automatically. This is the same approach used by VS Code's Lean extension.

**Using `lean --server`** (for standalone files):

```json
{
  "lspServers": {
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
}
```

Use `lean --server` when working with standalone `.lean` files that are not part of a Lake project.

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
