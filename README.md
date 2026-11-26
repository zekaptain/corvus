# corvus

Standalone TypeScript memory extension for [omp](https://omp.sh) backed by `agent-memory` (`mem`).

## What is included

- **Session capture extension** (`src/extension/`): Maps omp 19.1.1 lifecycle, message, tool,
  compaction, subagent, switch, fork, and branch hook events to `agent-memory` schema v1
  capture records and streams them non-blockingly to `mem records`.
- **Installer CLI** (`src/cli/`): Safely installs, checks status of, and uninstalls the managed
  extension directory under omp's extensions folder (`~/.omp/agent/extensions/corvus` by default,
  or `--dir <path>`), verifying ownership and file SHA-256 hashes via `manifest.json`.

## Requirements

- [Bun](https://bun.sh) (for development, typechecking, linting, and running tests/CLI)
- An initialized `agent-memory` installation providing the `mem` CLI

## Development

```sh
bun install
bun run typecheck
bun run check
bun test
```

## CLI usage

```sh
bun run src/cli/index.ts install [--dir PATH] [--mem PATH] [--home PATH] [--port PORT] [--spool-only]
bun run src/cli/index.ts status [--dir PATH] [--mem PATH] [--home PATH] [--port PORT] [--spool-only]
bun run src/cli/index.ts uninstall [--dir PATH]
```
