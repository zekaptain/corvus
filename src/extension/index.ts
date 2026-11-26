/**
 * omp extension for corvus (backed by agent-memory's `mem records` and `mem bridge`).
 *
 * Loaded once by omp; omp invokes the default export once per session (main and each
 * spawned subagent) inside the same process. All sessions share one mapper (state keyed
 * by session id), one `mem records` capture sink, one lazily spawned `mem bridge` client,
 * and one session-start memory injector.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, DEFAULT_TOOL_TIMEOUT_MS } from "./bridge.ts";
import {
  type OmpCommandDefinition,
  type OmpCommandMessage,
  registerCorvusCommands,
} from "./commands.ts";
import { OmpMapper } from "./mapper.ts";
import type { OmpContext, OmpHookPayload } from "./mapper.ts";
import { DEFAULT_SESSION_START_CONFIG, SessionStartInjector } from "./session-start.ts";
import type { SessionStartConfig } from "./session-start.ts";
import { RecordSink } from "./sink.ts";
import type { FailureReporter, SinkConfig } from "./sink.ts";
import { type OmpToolDefinition, registerMemoryTools } from "./tools.ts";

export interface OmpExtensionAPI {
  on: (event: string, handler: (payload: OmpHookPayload, ctx: OmpContext) => unknown) => void;
  registerTool?: (definition: OmpToolDefinition) => void;
  registerCommand?: (name: string, definition: OmpCommandDefinition) => void;
  sendMessage?: (message: OmpCommandMessage) => void;
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
  toolTimeoutMs?: unknown;
  tool_timeout_ms?: unknown;
  sessionStartInjection?: unknown;
  sessionStartMaxChars?: unknown;
  sessionStartMaxItems?: unknown;
  sessionStartTimeoutMs?: unknown;
}

export interface ExtensionConfig extends SinkConfig {
  toolTimeoutMs?: number;
  sessionStartInjection?: boolean;
  sessionStartMaxChars?: number;
  sessionStartMaxItems?: number;
  sessionStartTimeoutMs?: number;
}

export type LoadedExtensionConfig = ExtensionConfig;

export interface ExtensionOptions {
  configPath?: string;
  config?: ExtensionConfig;
  report?: FailureReporter;
  clock?: () => string;
}

function defaultConfigPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "config.json");
}

function parsePositiveTimeout(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function envExtensionConfig(): ExtensionConfig {
  const portRaw = process.env.AGENT_MEMORY_PORT;
  const portParsed = portRaw ? Number(portRaw) : undefined;
  const toolTimeoutMs = parsePositiveTimeout(process.env.CORVUS_TOOL_TIMEOUT_MS);
  return {
    mem: process.env.AGENT_MEMORY_MEM || "mem",
    home: process.env.AGENT_MEMORY_HOME || undefined,
    port:
      portParsed !== undefined && Number.isInteger(portParsed) && portParsed > 0
        ? portParsed
        : undefined,
    spoolOnly: process.env.AGENT_MEMORY_SPOOL_ONLY === "1",
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    sessionStartInjection: DEFAULT_SESSION_START_CONFIG.enabled,
    sessionStartMaxChars: DEFAULT_SESSION_START_CONFIG.maxChars,
    sessionStartMaxItems: DEFAULT_SESSION_START_CONFIG.maxItems,
    sessionStartTimeoutMs: DEFAULT_SESSION_START_CONFIG.timeoutMs,
  };
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
  const toolTimeoutMs =
    parsePositiveTimeout(stored.toolTimeoutMs) ??
    parsePositiveTimeout(stored.tool_timeout_ms) ??
    parsePositiveTimeout(process.env.CORVUS_TOOL_TIMEOUT_MS);
  return {
    config: {
      mem,
      home,
      port,
      spoolOnly: stored.spool_only === true || stored.spoolOnly === true,
      ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
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

export function loadSinkConfig(configPath: string): { config?: ExtensionConfig; error?: string } {
  return loadExtensionConfig(configPath);
}

export interface CaptureRuntime {
  attach: (pi: OmpExtensionAPI) => void;
  closeNow: () => void;
  readonly mapper: OmpMapper;
  readonly sink: RecordSink | null;
  readonly bridge: BridgeClient | null;
  readonly injector: SessionStartInjector | null;
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

  const emitWarning: FailureReporter = (message) => {
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

  let sinkReported = false;
  const reportSink: FailureReporter = (message) => {
    if (sinkReported) {
      return;
    }
    sinkReported = true;
    emitWarning(message);
  };

  let resolvedConfig: ExtensionConfig | undefined;
  let configError: string | undefined;
  if (options.config) {
    resolvedConfig = options.config;
  } else {
    const loaded = loadExtensionConfig(options.configPath ?? defaultConfigPath());
    resolvedConfig = loaded.config;
    configError = loaded.error;
  }

  let sink: RecordSink | null = null;
  let bridge: BridgeClient | null = null;
  let injector: SessionStartInjector | null = null;
  const toolTimeoutMs = resolvedConfig?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  if (resolvedConfig) {
    sink = new RecordSink(resolvedConfig, reportSink);
    const sessionStartCfg = toSessionStartConfig(resolvedConfig);
    bridge = new BridgeClient(
      {
        mem: resolvedConfig.mem,
        home: resolvedConfig.home,
        port: resolvedConfig.port,
        toolTimeoutMs,
      },
      emitWarning,
    );
    injector = new SessionStartInjector(bridge, sessionStartCfg, emitWarning);
  } else if (configError) {
    reportSink(`corvus: capture disabled; ${configError}`);
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
    injector,
    closeNow: () => {
      process.off("beforeExit", onBeforeExit);
      sink?.closeNow();
      bridge?.close();
    },
    attach(pi: OmpExtensionAPI): void {
      const instanceId = nextInstanceId++;
      activeInstances += 1;
      let instanceClosed = false;

      registerMemoryTools(pi, bridge, {
        toolTimeoutMs,
        disabledReason: configError,
        onContext: (ctx) => {
          lastCtx = ctx;
        },
      });

      registerCorvusCommands(pi, {
        sink,
        bridge,
        injector,
        disabledReason: configError,
        onContext: (ctx) => {
          lastCtx = ctx;
        },
      });

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
            reportSink(
              `corvus: error handling ${eventName} (${err instanceof Error ? err.message : err})`,
            );
          }

          if (eventName === "session_shutdown" && !instanceClosed) {
            instanceClosed = true;
            activeInstances = Math.max(0, activeInstances - 1);
            if (activeInstances === 0) {
              sink?.scheduleClose();
              bridge?.disconnectIdle();
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
