/**
 * User-facing `/corvus` slash command registered via `pi.registerCommand`.
 *
 * Per MEM-41 probe findings:
 * - Registered as `/corvus` (omp 19.2.1 has a built-in `/memory` command that silently
 *   shadows `pi.registerCommand("memory", ...)`).
 * - Emits formatted output via `pi.sendMessage({ customType: "corvus-command", content, display: true })`
 *   so it surfaces in both headless and interactive runs without misclassifying as `user_msg`.
 * - Notifies interactive UI concisely via `ctx.ui.notify` and `ctx.ui.setStatus` when `ctx.hasUI`.
 * - Never exposes any `approve` subcommand (approval remains terminal-only via `mem review`).
 */

import type { BridgeClient, BridgeStatusSnapshot } from "./bridge.ts";
import { type OmpContext, projectOf } from "./mapper.ts";
import {
  type SessionContextResult,
  type SessionStartInjector,
  type SessionStartStatusSnapshot,
  composeInjectedContent,
  computeBridgeMaxChars,
} from "./session-start.ts";
import type { RecordSink, SinkStatusSnapshot } from "./sink.ts";

export const CORVUS_COMMAND_NAME = "corvus";
export const CORVUS_COMMAND_CUSTOM_TYPE = "corvus-command";
const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

export interface OmpCommandCompletion {
  value: string;
  label: string;
}

export interface OmpCommandResult {
  content: string;
}

export interface OmpCommandDefinition {
  description: string;
  getArgumentCompletions?: (prefix: string) => OmpCommandCompletion[];
  handler: (args: string, ctx?: OmpContext) => Promise<OmpCommandResult>;
}

export interface OmpCommandMessage {
  customType: typeof CORVUS_COMMAND_CUSTOM_TYPE;
  content: string;
  display: boolean;
}

export interface OmpCommandRegistrar {
  registerCommand?: (name: string, definition: OmpCommandDefinition) => void;
  sendMessage?: (message: OmpCommandMessage) => void;
}

export interface CommandRegistrationOptions {
  sink: RecordSink | null;
  bridge: BridgeClient | null;
  injector: SessionStartInjector | null;
  disabledReason?: string;
  statusTimeoutMs?: number;
  onContext?: (ctx: OmpContext) => void;
}

const COMMAND_COMPLETIONS: OmpCommandCompletion[] = [
  { value: "status", label: "status — Show ledger, capture, bridge, and injection status" },
  { value: "inject status", label: "inject status — Show session-start injection settings" },
  { value: "inject on", label: "inject on — Enable session-start injection for this session" },
  { value: "inject off", label: "inject off — Disable session-start injection for this session" },
  { value: "inject preview", label: "inject preview — Preview bounded session-start memories" },
  { value: "help", label: "help — Show /corvus command usage" },
];

export function getCorvusArgumentCompletions(prefix: string): OmpCommandCompletion[] {
  const normalized = (prefix ?? "").trimStart().toLowerCase();
  if (!normalized) {
    return [...COMMAND_COMPLETIONS];
  }
  return COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
}

export function formatCorvusUsage(): string {
  return [
    "Corvus commands:",
    "  /corvus                  Show Corvus status and diagnostics",
    "  /corvus status           Show ledger, capture, bridge, and injection status",
    "  /corvus inject status    Show session-start injection state and limits",
    "  /corvus inject on        Enable session-start injection for this session only",
    "  /corvus inject off       Disable session-start injection for this session only",
    "  /corvus inject preview   Preview the bounded active-memory block for this session",
    "  /corvus help             Show this help message",
    "",
    "Note: Memory approval is terminal-only via `mem review`.",
  ].join("\n");
}

function sessionFromContext(ctx: OmpContext | undefined): {
  harnessSessionId?: string;
  cwd?: string;
  project?: string;
} {
  let harnessSessionId: string | undefined;
  try {
    const raw = ctx?.sessionManager?.getSessionId?.();
    if (typeof raw === "string" && raw.trim()) {
      harnessSessionId = raw.trim();
    }
  } catch {
    // Ignore broken sessionManager in defensive host environments.
  }
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : undefined;
  const project = projectOf(cwd);
  return { harnessSessionId, cwd, project };
}

function formatSinkSection(sinkSnap: SinkStatusSnapshot | null, disabledReason?: string): string[] {
  if (!sinkSnap) {
    return [`Capture sink: disabled (${disabledReason ?? "configuration unavailable"})`];
  }
  const state = sinkSnap.failed
    ? "failed"
    : sinkSnap.disabled
      ? "closed"
      : sinkSnap.alive
        ? "alive"
        : sinkSnap.started
          ? "idle"
          : "standby";
  const lines = [
    `Capture sink: ${state} (started=${sinkSnap.started}, spoolOnly=${sinkSnap.spoolOnly}, inFlightBytes=${sinkSnap.inFlightBytes})`,
  ];
  if (sinkSnap.lastError) {
    lines.push(`  lastError: ${sinkSnap.lastError}`);
  }
  return lines;
}

function formatBridgeSection(
  bridgeSnap: BridgeStatusSnapshot | null,
  disabledReason?: string,
): string[] {
  if (!bridgeSnap) {
    return [`Bridge client: disabled (${disabledReason ?? "configuration unavailable"})`];
  }
  const state = bridgeSnap.closed ? "closed" : bridgeSnap.healthy ? "healthy" : "degraded";
  const lines = [
    `Bridge client: ${state} (running=${bridgeSnap.running}, pid=${bridgeSnap.pid ?? "none"}, pending=${bridgeSnap.pendingRequests}, calls=${bridgeSnap.totalCalls}, failed=${bridgeSnap.failedCalls})`,
  ];
  if (bridgeSnap.lastError) {
    lines.push(`  lastError: ${bridgeSnap.lastError}`);
  }
  return lines;
}

function formatInjectionSection(snap: SessionStartStatusSnapshot | null): string[] {
  if (!snap) {
    return ["Session-start injection: disabled (configuration unavailable)"];
  }
  const lines = [
    `Session-start injection: ${snap.enabled ? "enabled" : "disabled"} (source=${snap.source}, maxChars=${snap.maxChars}, maxItems=${snap.maxItems}, timeoutMs=${snap.timeoutMs}, injectedInSession=${snap.injectedInCurrentSession})`,
  ];
  if (snap.source === "override") {
    lines.push(
      `  in-session override active (config.json=${snap.configuredEnabled}; persistent change requires \`corvus install --${snap.enabled ? "session-start-injection" : "no-session-start-injection"}\`)`,
    );
  }
  return lines;
}

function emitOutput(
  pi: OmpCommandRegistrar,
  ctx: OmpContext | undefined,
  content: string,
  summary: string,
  level: "info" | "warning" = "info",
  uiStatus?: string,
): OmpCommandResult {
  try {
    pi.sendMessage?.({
      customType: CORVUS_COMMAND_CUSTOM_TYPE,
      content,
      display: true,
    });
  } catch {
    // Ignore host sendMessage errors.
  }
  try {
    if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(summary, level);
    }
  } catch {
    // Ignore host UI notification errors.
  }
  if (uiStatus !== undefined) {
    try {
      if (ctx?.hasUI && typeof ctx.ui?.setStatus === "function") {
        ctx.ui.setStatus(CORVUS_COMMAND_NAME, uiStatus);
      }
    } catch {
      // Ignore host UI setStatus errors.
    }
  }
  return { content };
}

async function handleStatus(
  pi: OmpCommandRegistrar,
  ctx: OmpContext | undefined,
  options: CommandRegistrationOptions,
): Promise<OmpCommandResult> {
  const session = sessionFromContext(ctx);
  const sinkSnap = options.sink ? options.sink.statusSnapshot() : null;
  const bridgeSnapBefore = options.bridge ? options.bridge.statusSnapshot() : null;
  const injSnap = options.injector
    ? options.injector.statusSnapshot(session.harnessSessionId, ctx)
    : null;

  let ledgerLines: string[];
  let ledgerReachable = false;
  let statusBadge = "corvus: degraded";

  if (!options.bridge) {
    ledgerLines = [`Ledger: unavailable (${options.disabledReason ?? "bridge disabled"})`];
    statusBadge = "corvus: disabled";
  } else if (!session.harnessSessionId) {
    ledgerLines = ["Ledger: not queried (no active session id from sessionManager)"];
    statusBadge = "corvus: no-session";
  } else {
    const res = await options.bridge.call<Record<string, unknown>>(
      "status",
      {
        harnessSessionId: session.harnessSessionId,
        cwd: session.cwd,
        project: session.project,
      },
      {},
      { timeoutMs: options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS },
    );

    if (!res.ok) {
      ledgerLines = [`Ledger: unreachable (${res.error.code}: ${res.error.message})`];
    } else {
      const s = res.result;
      ledgerReachable = s.reachable === true;
      const eventsStr =
        s.events_this_session && typeof s.events_this_session === "object"
          ? JSON.stringify(s.events_this_session)
          : "{}";
      if (ledgerReachable) {
        statusBadge = `corvus: ok (${injSnap?.enabled ? "inject:on" : "inject:off"})`;
        ledgerLines = [
          `Ledger: reachable (server=${String(s.server ?? "unknown")}, agent=${String(s.agent_id ?? "oh-my-pi")})`,
          `  session_id=${String(s.session_id ?? "none")} harness_session_id=${String(s.harness_session_id ?? session.harnessSessionId)} project=${String(s.project ?? session.project ?? "none")}`,
          `  events_this_session=${eventsStr}`,
          `  spool_pending_lines=${String(s.spool_pending_lines ?? 0)} spool_rejected_lines=${String(s.spool_rejected_lines ?? 0)}`,
        ];
      } else {
        ledgerLines = [
          `Ledger: unreachable (${String(s.reason ?? "unknown reason")})`,
          `  server=${String(s.server ?? "unknown")} agent=${String(s.agent_id ?? "oh-my-pi")} project=${String(s.project ?? session.project ?? "none")}`,
          `  spool_pending_lines=${String(s.spool_pending_lines ?? 0)} spool_rejected_lines=${String(s.spool_rejected_lines ?? 0)}`,
        ];
      }
    }
  }

  const bridgeSnapAfter = options.bridge ? options.bridge.statusSnapshot() : bridgeSnapBefore;
  const content = [
    "Corvus Status",
    ...ledgerLines,
    ...formatSinkSection(sinkSnap, options.disabledReason),
    ...formatBridgeSection(bridgeSnapAfter, options.disabledReason),
    ...formatInjectionSection(injSnap),
  ].join("\n");

  const sinkLabel = sinkSnap ? (sinkSnap.failed ? "failed" : "ok") : "disabled";
  const summary = `corvus: ledger=${ledgerReachable ? "reachable" : "unreachable"}, sink=${sinkLabel}, inject=${injSnap?.enabled ? "on" : "off"}`;
  const level = ledgerReachable && !sinkSnap?.failed ? "info" : "warning";
  return emitOutput(pi, ctx, content, summary, level, statusBadge);
}

async function handleInjectPreview(
  pi: OmpCommandRegistrar,
  ctx: OmpContext | undefined,
  options: CommandRegistrationOptions,
): Promise<OmpCommandResult> {
  const session = sessionFromContext(ctx);
  if (!options.bridge || !options.injector) {
    const reason = options.disabledReason ?? "memory bridge is disabled";
    const msg = `Session-start injection preview unavailable (${reason}).`;
    return emitOutput(pi, ctx, msg, msg, "warning");
  }
  if (!session.harnessSessionId) {
    const msg =
      "Session-start injection preview unavailable (missing active session id from sessionManager).";
    return emitOutput(pi, ctx, msg, msg, "warning");
  }

  const injSnap = options.injector.statusSnapshot(session.harnessSessionId, ctx);
  const bridgeMaxChars = computeBridgeMaxChars(injSnap.maxChars);
  const res = await options.bridge.call<SessionContextResult>(
    "session_context",
    {
      harnessSessionId: session.harnessSessionId,
      cwd: session.cwd,
      project: session.project,
    },
    {
      max_chars: bridgeMaxChars,
      max_items: injSnap.maxItems,
    },
    { timeoutMs: injSnap.timeoutMs },
  );

  if (!res.ok) {
    const msg = `Session-start injection preview failed (${res.error.code}: ${res.error.message}).`;
    return emitOutput(pi, ctx, msg, msg, "warning");
  }

  const data = res.result;
  if (!data || data.degraded) {
    const reason = data?.reason ?? "ledger unreachable";
    const msg = `Session-start injection preview unavailable: memory ledger unreachable (${reason}).`;
    return emitOutput(pi, ctx, msg, msg, "warning");
  }

  const retrievalId = data.retrieval_id ?? null;
  const shown = typeof data.shown_count === "number" ? data.shown_count : 0;
  const notShown = typeof data.not_shown_count === "number" ? data.not_shown_count : 0;
  const rawText = typeof data.text === "string" ? data.text : "";

  const composed = rawText.trim()
    ? composeInjectedContent(rawText, retrievalId, injSnap.maxChars)
    : null;

  const header = [
    `Session-start injection preview (enabled=${injSnap.enabled}, source=${injSnap.source})`,
    `retrieval_id=${retrievalId ?? "none"} shown_count=${shown} not_shown_count=${notShown} char_count=${composed ? composed.length : 0}/${injSnap.maxChars}`,
  ];

  if (!composed) {
    const content = [
      ...header,
      "No active memories matched for this session/project (nothing would be injected).",
    ].join("\n");
    return emitOutput(
      pi,
      ctx,
      content,
      `corvus inject preview: 0 memories (${notShown} not shown)`,
      "info",
    );
  }

  const content = [...header, "---", composed].join("\n");
  return emitOutput(
    pi,
    ctx,
    content,
    `corvus inject preview: ${shown} shown, ${notShown} overflow (${composed.length}/${injSnap.maxChars} chars)`,
    "info",
  );
}

export function buildCorvusCommand(
  pi: OmpCommandRegistrar,
  options: CommandRegistrationOptions,
): OmpCommandDefinition {
  return {
    description: "Inspect Corvus memory status or toggle/preview session-start memory injection",
    getArgumentCompletions: getCorvusArgumentCompletions,
    async handler(args: string, ctx?: OmpContext): Promise<OmpCommandResult> {
      if (ctx) {
        options.onContext?.(ctx);
      }

      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase() ?? "status";

      if (sub === "status" && tokens.length <= 1) {
        return handleStatus(pi, ctx, options);
      }

      if (sub === "help" && tokens.length === 1) {
        const usage = formatCorvusUsage();
        return emitOutput(pi, ctx, usage, "corvus: usage printed", "info");
      }

      if (sub === "inject") {
        const action = tokens[1]?.toLowerCase() ?? "status";
        if (tokens.length > 2) {
          const content = `Unknown /corvus inject arguments: ${tokens.slice(1).join(" ")}\n\n${formatCorvusUsage()}`;
          return emitOutput(pi, ctx, content, "corvus: unknown inject arguments", "warning");
        }
        if (action === "status") {
          const session = sessionFromContext(ctx);
          const snap = options.injector
            ? options.injector.statusSnapshot(session.harnessSessionId, ctx)
            : null;
          const content = formatInjectionSection(snap).join("\n");
          const summary = snap
            ? `corvus inject: ${snap.enabled ? "on" : "off"} (source=${snap.source})`
            : "corvus inject: disabled";
          return emitOutput(pi, ctx, content, summary, "info");
        }
        if (action === "on" || action === "off") {
          if (!options.injector) {
            const msg = `Cannot toggle session-start injection (${options.disabledReason ?? "extension disabled"}).`;
            return emitOutput(pi, ctx, msg, msg, "warning");
          }
          const next = action === "on";
          options.injector.setEnabledOverride(next);
          const session = sessionFromContext(ctx);
          const snap = options.injector.statusSnapshot(session.harnessSessionId, ctx);
          const content = [
            `Session-start injection is now ${next ? "enabled" : "disabled"} for this session (in-session override; persistent config.json=${snap.configuredEnabled} was not modified).`,
            `Use \`corvus install --${next ? "session-start-injection" : "no-session-start-injection"}\` to persist across sessions.`,
            ...formatInjectionSection(snap),
          ].join("\n");
          return emitOutput(
            pi,
            ctx,
            content,
            `corvus inject: ${next ? "enabled" : "disabled"} (in-session)`,
            "info",
            `corvus: inject:${next ? "on" : "off"}`,
          );
        }
        if (action === "preview") {
          return handleInjectPreview(pi, ctx, options);
        }
        const content = `Unknown /corvus inject subcommand: ${tokens[1]}\n\n${formatCorvusUsage()}`;
        return emitOutput(
          pi,
          ctx,
          content,
          `corvus: unknown subcommand inject ${tokens[1]}`,
          "warning",
        );
      }

      const content = `Unknown /corvus subcommand: ${tokens.join(" ")}\n\n${formatCorvusUsage()}`;
      return emitOutput(
        pi,
        ctx,
        content,
        `corvus: unknown subcommand ${tokens.join(" ")}`,
        "warning",
      );
    },
  };
}

export function registerCorvusCommands(
  pi: OmpCommandRegistrar,
  options: CommandRegistrationOptions,
): void {
  if (typeof pi.registerCommand !== "function") {
    return;
  }
  pi.registerCommand(CORVUS_COMMAND_NAME, buildCorvusCommand(pi, options));
}
