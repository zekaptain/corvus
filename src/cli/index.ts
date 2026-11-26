#!/usr/bin/env bun
/**
 * Command-line interface for managing the corvus omp extension.
 */

import {
  CORVUS_VERSION,
  DEFAULT_EXTENSIONS_DIR,
  DEFAULT_SESSION_START_MAX_CHARS,
  DEFAULT_SESSION_START_MAX_ITEMS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  MANAGED_EXTENSION_DIR_NAME,
} from "../constants.ts";
import {
  type CliIO,
  InstallerError,
  installExtension,
  statusExtension,
  uninstallExtension,
} from "./installer.ts";

interface ParsedFlags {
  dir?: string;
  mem?: string;
  home?: string;
  port?: number;
  spoolOnly?: boolean;
  sessionStartInjection?: boolean;
  sessionStartMaxChars?: number;
  sessionStartMaxItems?: number;
  sessionStartTimeoutMs?: number;
  json?: boolean;
  help: boolean;
  version: boolean;
}

function usageText(): string {
  return [
    `corvus ${CORVUS_VERSION} - manage the corvus omp extension`,
    "",
    "Usage:",
    "  corvus install   [--dir PATH] [--mem PATH] [--home PATH] [--port PORT] [--spool-only]",
    "                   [--[no-]session-start-injection] [--session-start-max-chars N]",
    "                   [--session-start-max-items N] [--session-start-timeout-ms N]",
    "  corvus status    [--dir PATH] [--mem PATH] [--home PATH] [--port PORT] [--spool-only]",
    "                   [--[no-]session-start-injection] [--session-start-max-chars N]",
    "                   [--session-start-max-items N] [--session-start-timeout-ms N] [--json]",
    "  corvus uninstall [--dir PATH]",
    "",
    "Options:",
    `  --dir PATH                     omp extensions directory (default: ${DEFAULT_EXTENSIONS_DIR})`,
    `                                 managed subdirectory: <dir>/${MANAGED_EXTENSION_DIR_NAME}/`,
    "  --mem PATH                     path to the agent-memory `mem` executable",
    "  --home PATH                    agent-memory data directory (default: $AGENT_MEMORY_HOME or ~/.agent-memory)",
    "  --port PORT                    agent-memory Quack port (default: $AGENT_MEMORY_PORT or 9494)",
    "  --spool-only                   write capture records directly to the spool",
    "  --session-start-injection      enable opt-in session-start memory injection (default: off)",
    "  --no-session-start-injection   disable session-start memory injection",
    `  --session-start-max-chars N    max characters for injected block (default: ${DEFAULT_SESSION_START_MAX_CHARS})`,
    `  --session-start-max-items N    max items for injected block (default: ${DEFAULT_SESSION_START_MAX_ITEMS})`,
    `  --session-start-timeout-ms N   bridge timeout in ms for session-start injection (default: ${DEFAULT_SESSION_START_TIMEOUT_MS})`,
    "  --json                         output status as JSON (with `corvus status`)",
    "  -h, --help                     show this help and exit",
    "  -v, --version                  show version and exit",
  ].join("\n");
}

function parsePositiveInt(raw: string, flagName: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InstallerError(`invalid ${flagName} ${raw}; expected positive integer`);
  }
  return parsed;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      flags.version = true;
      continue;
    }
    if (arg === "--spool-only") {
      flags.spoolOnly = true;
      continue;
    }
    if (arg === "--session-start-injection") {
      flags.sessionStartInjection = true;
      continue;
    }
    if (arg === "--no-session-start-injection") {
      flags.sessionStartInjection = false;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (
      arg === "--dir" ||
      arg === "--mem" ||
      arg === "--home" ||
      arg === "--port" ||
      arg === "--session-start-max-chars" ||
      arg === "--session-start-max-items" ||
      arg === "--session-start-timeout-ms"
    ) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new InstallerError(`${arg} requires a value`);
      }
      i += 1;
      if (arg === "--dir") flags.dir = value;
      else if (arg === "--mem") flags.mem = value;
      else if (arg === "--home") flags.home = value;
      else if (arg === "--port") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          throw new InstallerError(`invalid --port ${value}; expected integer 1..65535`);
        }
        flags.port = parsed;
      } else if (arg === "--session-start-max-chars") {
        flags.sessionStartMaxChars = parsePositiveInt(value, arg);
      } else if (arg === "--session-start-max-items") {
        flags.sessionStartMaxItems = parsePositiveInt(value, arg);
      } else if (arg === "--session-start-timeout-ms") {
        flags.sessionStartTimeoutMs = parsePositiveInt(value, arg);
      }
      continue;
    }
    if (arg.startsWith("--dir=")) {
      flags.dir = arg.slice("--dir=".length);
      continue;
    }
    if (arg.startsWith("--mem=")) {
      flags.mem = arg.slice("--mem=".length);
      continue;
    }
    if (arg.startsWith("--home=")) {
      flags.home = arg.slice("--home=".length);
      continue;
    }
    if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new InstallerError(`invalid --port ${raw}; expected integer 1..65535`);
      }
      flags.port = parsed;
      continue;
    }
    if (arg.startsWith("--session-start-max-chars=")) {
      flags.sessionStartMaxChars = parsePositiveInt(
        arg.slice("--session-start-max-chars=".length),
        "--session-start-max-chars",
      );
      continue;
    }
    if (arg.startsWith("--session-start-max-items=")) {
      flags.sessionStartMaxItems = parsePositiveInt(
        arg.slice("--session-start-max-items=".length),
        "--session-start-max-items",
      );
      continue;
    }
    if (arg.startsWith("--session-start-timeout-ms=")) {
      flags.sessionStartTimeoutMs = parsePositiveInt(
        arg.slice("--session-start-timeout-ms=".length),
        "--session-start-timeout-ms",
      );
      continue;
    }
    throw new InstallerError(`unknown argument: ${arg}`);
  }

  return flags;
}

export function runCli(
  argv: string[],
  io: CliIO = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
): number {
  if (argv.length === 0) {
    io.stdout(usageText());
    return 0;
  }

  const first = argv[0];
  if (first === "-h" || first === "--help") {
    io.stdout(usageText());
    return 0;
  }
  if (first === "-v" || first === "--version") {
    io.stdout(`corvus ${CORVUS_VERSION}`);
    return 0;
  }

  const command = first;
  let flags: ParsedFlags;
  try {
    flags = parseFlags(argv.slice(1));
  } catch (err) {
    io.stderr(`corvus: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  if (flags.help) {
    io.stdout(usageText());
    return 0;
  }
  if (flags.version) {
    io.stdout(`corvus ${CORVUS_VERSION}`);
    return 0;
  }

  try {
    switch (command) {
      case "install": {
        if (flags.json !== undefined) {
          throw new InstallerError("--json is supported only with status");
        }
        installExtension(
          {
            dir: flags.dir,
            mem: flags.mem,
            home: flags.home,
            port: flags.port,
            spoolOnly: flags.spoolOnly,
            sessionStartInjection: flags.sessionStartInjection,
            sessionStartMaxChars: flags.sessionStartMaxChars,
            sessionStartMaxItems: flags.sessionStartMaxItems,
            sessionStartTimeoutMs: flags.sessionStartTimeoutMs,
          },
          io,
        );
        return 0;
      }
      case "status": {
        const result = statusExtension(
          {
            dir: flags.dir,
            mem: flags.mem,
            home: flags.home,
            port: flags.port,
            spoolOnly: flags.spoolOnly,
            sessionStartInjection: flags.sessionStartInjection,
            sessionStartMaxChars: flags.sessionStartMaxChars,
            sessionStartMaxItems: flags.sessionStartMaxItems,
            sessionStartTimeoutMs: flags.sessionStartTimeoutMs,
            json: flags.json,
          },
          io,
        );
        return result.ok ? 0 : 1;
      }
      case "uninstall": {
        if (
          flags.mem !== undefined ||
          flags.home !== undefined ||
          flags.port !== undefined ||
          flags.spoolOnly !== undefined ||
          flags.sessionStartInjection !== undefined ||
          flags.sessionStartMaxChars !== undefined ||
          flags.sessionStartMaxItems !== undefined ||
          flags.sessionStartTimeoutMs !== undefined ||
          flags.json !== undefined
        ) {
          throw new InstallerError("uninstall accepts only --dir");
        }
        uninstallExtension({ dir: flags.dir }, io);
        return 0;
      }
      default:
        io.stderr(`corvus: unknown command ${command}`);
        io.stderr("Run `corvus --help` for usage.");
        return 1;
    }
  } catch (err) {
    io.stderr(`corvus: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
