/**
 * omp capture and session-start injection extension for corvus
 * (backed by agent-memory's `mem records` and `mem bridge`).
 *
 * Loaded once by omp; omp invokes the default export once per session (main and each
 * spawned subagent) inside the same process. All sessions share one mapper (state keyed
 * by session id), one `mem records` child process, and one lazily spawned `mem bridge`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "./bridge.ts";
import { OmpMapper } from "./mapper.ts";
import type { OmpContext, OmpHookPayload } from "./mapper.ts";
import { DEFAULT_SESSION_START_CONFIG, SessionStartInjector } from "./session-start.ts";
import type { SessionStartConfig } from "./session-start.ts";
import { RecordSink } from "./sink.ts";
import type { FailureReporter, SinkConfig } from "./sink.ts";

export interface OmpExtensionAPI {
  on: (event: string, handler: (payload: OmpHookPayload, ctx: OmpContext) => unknown) => void;
  pi?: {
    VERSION?: string;
  };
}

export const HOOK_EVENTS = [
  "session_start",
  "session_before_switch",
  "session_switch",
  "session_before_branch",
  "session_branch",
  "session_clear",
  "before_subagent_spawn",
  "message_end",
  "tool_call",
  "turn_end",
  "session_compact",
  "session_stop",
  "agent_end",
  "session_shutdown",
] as const;

interface StoredConfig {
  mem?: unknown;
  home?: unknown;
  port?: unknown;
  spool_only?: unknown;
  spoolOnly?: unknown;
  sessionStartInjection?: unknown;
  sessionStartMaxChars?: unknown;
  sessionStartMaxItems?: unknown;
  sessionStartTimeoutMs?: unknown;
}

export interface ExtensionConfig extends SinkConfig {
  sessionStartInjection?: boolean;
  sessionStartMaxChars?: number;
  sessionStartMaxItems?: number;
  sessionStartTimeoutMs?: number;
}

export interface ExtensionOptions {
  configPath?: string;
  config?: ExtensionConfig;
  report?: FailureReporter;
  clock?: () => string;
}

function defaultConfigPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "config.json");
}

function envExtensionConfig(): ExtensionConfig {
  const portRaw = process.env.AGENT_MEMORY_PORT;
  const portParsed = portRaw ? Number(portRaw) : undefined;
  return {
    mem: process.env.AGENT_MEMORY_MEM || "mem",
    home: process.env.AGENT_MEMORY_HOME || undefined,
    port:
      portParsed !== undefined && Number.isInteger(portParsed) && portParsed > 0
        ? portParsed
        : undefined,
    spoolOnly: process.env.AGENT_MEMORY_SPOOL_ONLY === "1",
    sessionStartInjection: DEFAULT_SESSION_START_CONFIG.enabled,
    sessionStartMaxChars: DEFAULT_SESSION_START_CONFIG.maxChars,
    sessionStartMaxItems: DEFAULT_SESSION_START_CONFIG.maxItems,
    sessionStartTimeoutMs: DEFAULT_SESSION_START_CONFIG.timeoutMs,
  };
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function loadExtensionConfig(configPath: string): {
  config?: ExtensionConfig;
  error?: string;
} {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { config: envExtensionConfig() };
    }
    return { error: `could not read ${configPath} (${err instanceof Error ? err.message : err})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      error: `invalid JSON in ${configPath} (${err instanceof Error ? err.message : err})`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${configPath} must hold a JSON object` };
  }
  const stored = parsed as StoredConfig;
  const mem = typeof stored.mem === "string" && stored.mem.trim() ? stored.mem : undefined;
  if (!mem) {
    return { error: `${configPath} is missing a valid "mem" path` };
  }
  const home = typeof stored.home === "string" && stored.home.trim() ? stored.home : undefined;
  const port =
    typeof stored.port === "number" && Number.isInteger(stored.port) && stored.port > 0
      ? stored.port
      : undefined;
  return {
    config: {
      mem,
      home,
      port,
      spoolOnly: stored.spool_only === true || stored.spoolOnly === true,
      sessionStartInjection:
        typeof stored.sessionStartInjection === "boolean"
          ? stored.sessionStartInjection
          : DEFAULT_SESSION_START_CONFIG.enabled,
      sessionStartMaxChars: positiveIntOrDefault(
        stored.sessionStartMaxChars,
        DEFAULT_SESSION_START_CONFIG.maxChars,
      ),
      sessionStartMaxItems: positiveIntOrDefault(
        stored.sessionStartMaxItems,
        DEFAULT_SESSION_START_CONFIG.maxItems,
      ),
      sessionStartTimeoutMs: positiveIntOrDefault(
        stored.sessionStartTimeoutMs,
        DEFAULT_SESSION_START_CONFIG.timeoutMs,
      ),
    },
  };
}

export function loadSinkConfig(configPath: string): { config?: SinkConfig; error?: string } {
  return loadExtensionConfig(configPath);
}

export interface CaptureRuntime {
  attach: (pi: OmpExtensionAPI) => void;
  closeNow: () => void;
  readonly mapper: OmpMapper;
  readonly sink: RecordSink | null;
  readonly bridge: BridgeClient | null;
}

function toSessionStartConfig(config: ExtensionConfig): SessionStartConfig {
  return {
    enabled: config.sessionStartInjection ?? DEFAULT_SESSION_START_CONFIG.enabled,
    maxChars: positiveIntOrDefault(
      config.sessionStartMaxChars,
      DEFAULT_SESSION_START_CONFIG.maxChars,
    ),
    maxItems: positiveIntOrDefault(
      config.sessionStartMaxItems,
      DEFAULT_SESSION_START_CONFIG.maxItems,
    ),
    timeoutMs: positiveIntOrDefault(
      config.sessionStartTimeoutMs,
      DEFAULT_SESSION_START_CONFIG.timeoutMs,
    ),
  };
}

export function createRuntime(
  options: ExtensionOptions = {},
  harnessVersion?: string,
): CaptureRuntime {
  let lastCtx: OmpContext | undefined;
  let reportedOnce = false;

  const report: FailureReporter = (message) => {
    if (reportedOnce) {
      return;
    }
    reportedOnce = true;
    if (options.report) {
      options.report(message);
      return;
    }
    try {
      if (lastCtx?.hasUI && typeof lastCtx.ui?.notify === "function") {
        lastCtx.ui.notify(message, "warning");
        return;
      }
    } catch {
      // Fall back to stderr if UI notification throws.
    }
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // Ignore closed stderr.
    }
  };

  let resolvedConfig: ExtensionConfig | undefined;
  if (options.config) {
    resolvedConfig = options.config;
  } else {
    const loaded = loadExtensionConfig(options.configPath ?? defaultConfigPath());
    if (loaded.config) {
      resolvedConfig = loaded.config;
    } else if (loaded.error) {
      report(`corvus: capture disabled; ${loaded.error}`);
    }
  }

  let sink: RecordSink | null = null;
  let bridge: BridgeClient | null = null;
  let injector: SessionStartInjector | null = null;

  if (resolvedConfig) {
    sink = new RecordSink(resolvedConfig, report);
    const sessionStartCfg = toSessionStartConfig(resolvedConfig);
    bridge = new BridgeClient(
      {
        mem: resolvedConfig.mem,
        home: resolvedConfig.home,
        port: resolvedConfig.port,
        defaultTimeoutMs: sessionStartCfg.timeoutMs,
      },
      report,
    );
    injector = new SessionStartInjector(bridge, sessionStartCfg, report);
  }

  const mapper = new OmpMapper({
    harnessVersion,
    clock: options.clock,
  });

  let nextInstanceId = 1;
  let activeInstances = 0;

  const onBeforeExit = () => {
    sink?.closeNow();
    bridge?.close();
  };
  process.once("beforeExit", onBeforeExit);

  return {
    mapper,
    sink,
    bridge,
    closeNow: () => {
      process.off("beforeExit", onBeforeExit);
      sink?.closeNow();
      bridge?.close();
    },
    attach(pi: OmpExtensionAPI): void {
      const instanceId = nextInstanceId++;
      activeInstances += 1;
      let instanceClosed = false;

      pi.on("before_agent_start", async (_payload, ctx) => {
        lastCtx = ctx;
        if (!injector) {
          return undefined;
        }
        return injector.handleBeforeAgentStart(ctx);
      });

      for (const eventName of HOOK_EVENTS) {
        pi.on(eventName, (payload, ctx) => {
          lastCtx = ctx;
          try {
            const records = mapper.handle(eventName, payload, ctx, instanceId);
            if (sink) {
              for (const rec of records) {
                sink.write(rec);
              }
            }
          } catch (err) {
            report(
              `corvus: error handling ${eventName} (${err instanceof Error ? err.message : err})`,
            );
          }

          if (eventName === "session_shutdown" && !instanceClosed) {
            instanceClosed = true;
            activeInstances = Math.max(0, activeInstances - 1);
            if (activeInstances === 0) {
              sink?.scheduleClose();
              bridge?.close();
            }
          }
          // Return undefined so omp never treats this handler as blocking or mutating.
        });
      }
    },
  };
}

let sharedRuntime: CaptureRuntime | null = null;

export default function corvusExtension(pi: OmpExtensionAPI): void {
  if (!sharedRuntime) {
    sharedRuntime = createRuntime({}, pi?.pi?.VERSION);
  }
  sharedRuntime.attach(pi);
}
