/**
 * Package-wide constants for corvus.
 *
 * `MANAGED_EXTENSION_DIR_NAME` is kept in one place so switching the default managed
 * directory under omp's extensions folder (for example between `corvus` and `agent-memory`)
 * is a single-line change.
 */
export const CORVUS_VERSION = "0.1.0";
export const OWNER_MARKER = "corvus";
export const MANAGED_EXTENSION_DIR_NAME = "corvus";
export const LEGACY_EXTENSION_DIR_NAME = "agent-memory";
export const DEFAULT_EXTENSIONS_DIR = "~/.omp/agent/extensions";
export const EXTENSION_SOURCE_FILES = [
  "index.ts",
  "mapper.ts",
  "sink.ts",
  "bridge.ts",
  "tools.ts",
  "session-start.ts",
  "commands.ts",
] as const;
export const CONFIG_FILE_NAME = "config.json";
export const MANIFEST_FILE_NAME = "manifest.json";
export const MANAGED_FILES = [
  ...EXTENSION_SOURCE_FILES,
  CONFIG_FILE_NAME,
  MANIFEST_FILE_NAME,
] as const;

export const DEFAULT_SESSION_START_INJECTION = false;
export const DEFAULT_SESSION_START_MAX_CHARS = 2400;
export const DEFAULT_SESSION_START_MAX_ITEMS = 12;
export const DEFAULT_SESSION_START_TIMEOUT_MS = 1500;
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
