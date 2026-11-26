# Working on corvus

`corvus` is the standalone TypeScript extension for omp (oh-my-pi), backed by the
`agent-memory` Python ledger (`mem`).

## Architectural boundaries

- **Ledger ownership stays in `agent-memory`.** Never duplicate redaction, deterministic
  `uuid5` IDs, append-only lifecycle rules, spool storage, or Quack auth in TypeScript.
- **Zero external runtime npm dependencies.** `package.json` must have no runtime
  `dependencies` (devDependencies for TypeScript, Biome, and types are fine).
- **Zero runtime imports of `@oh-my-pi/*`.** omp's embedded Bun runtime does not expose
  `@oh-my-pi/*` packages to loaded extensions; keep all omp types structural in `src/extension/mapper.ts`
  and `src/extension/index.ts`.
- **Non-blocking capture.** Every omp hook handler must return synchronously (`undefined`)
  without waiting for `mem` or the ledger. Keep the `mem records` child process `unref()`'d,
  track in-flight pipe bytes via `stdin.write` callbacks (Bun leaves `writableLength` at 0),
  and report a missing, dead, or stalled `mem` process strictly once.
- **Safe installer ownership.** `corvus` owns only its managed extension directory
  (`<extensions-dir>/<MANAGED_EXTENSION_DIR_NAME>/`, marked by `manifest.json` with owner,
  version, and SHA-256 hashes of every managed file). Refuse foreign directories, unexpected
  user files, and user-modified managed files. Leave all other files in omp's folders untouched.
- **Isolated tests.** Always pass `--dir` pointing to temporary directories in tests. Never
  touch `~/.omp/` or any live `agent-memory` ledger.

## Repository layout

- `src/constants.ts`: Single source of truth for `CORVUS_VERSION`, `OWNER_MARKER`, and
  `MANAGED_EXTENSION_DIR_NAME`.
- `src/extension/`: Runtime extension files (`index.ts`, `mapper.ts`, `sink.ts`) copied into
  omp's extensions directory by the installer. Must remain self-contained with only relative
  imports between those three files and Node/Bun built-ins.
- `src/cli/`: Installer CLI (`install`, `status`, `uninstall`).
- `tests/`: Bun unit tests for event mapping, non-blocking sink, runtime guards, and installer CLI.

## Commands

```sh
bun install
bun run typecheck
bun run check
bun test
bun run ci
```

Use Conventional Commits (for example `feat(capture): ...`, `fix(installer): ...`).
