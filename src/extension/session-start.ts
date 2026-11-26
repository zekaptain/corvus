/**
 * Opt-in session-start memory injection via omp's `before_agent_start` hook.
 *
 * Strictly adheres to MEM-41 probe findings and the Phase 1 bridge contract:
 * - Off by default (`sessionStartInjection: false`), overridable by `CORVUS_SESSION_START_INJECTION`.
 * - Injects via `{ message: { customType: "corvus-memory", content, display: false, attribution: "agent" } }`
 *   without ever reading or mutating `payload.systemPrompt`.
 * - Deduplicates per `(sessionId, compactionEpoch)` in memory AND inspects active branch entries
 *   strictly after the latest `compaction` entry so resume, fork, branch, and compaction work cleanly.
 * - Enforces tight timeout and fails open, reporting bridge failures at most once.
 */

import type { BridgeClient } from "./bridge.ts";
import type { OmpContext, OmpSessionEntry } from "./mapper.ts";
import type { FailureReporter } from "./sink.ts";

export const CORVUS_MEMORY_CUSTOM_TYPE = "corvus-memory";

export interface SessionStartConfig {
  enabled: boolean;
  maxChars: number;
  maxItems: number;
  timeoutMs: number;
}

export const DEFAULT_SESSION_START_CONFIG: SessionStartConfig = {
  enabled: false,
  maxChars: 2400,
  maxItems: 12,
  timeoutMs: 1500,
};

export interface SessionContextResult {
  degraded?: boolean;
  reason?: string;
  retrieval_id?: string | null;
  request_event_id?: string | null;
  strategy?: string;
  text?: string;
  items?: Array<Record<string, unknown>>;
  shown_count?: number;
  not_shown_count?: number;
  char_count?: number;
  max_chars?: number;
}

export interface SessionStartInjectionResult {
  message: {
    customType: typeof CORVUS_MEMORY_CUSTOM_TYPE;
    content: string;
    display: false;
    attribution: "agent";
  };
}

const SAMPLE_UUID = "00000000-0000-0000-0000-000000000000";

export function formatCitationFooter(retrievalId: string): string {
  return `\n\n[retrieval_id: ${retrievalId} — cite relied-upon memory IDs with cite]`;
}

const RESERVED_FOOTER_CHARS = formatCitationFooter(SAMPLE_UUID).length;

export function parseSessionStartEnvOverride(
  raw: string | undefined = process.env.CORVUS_SESSION_START_INJECTION,
): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return undefined;
}

export function isSessionStartEnabled(config: SessionStartConfig): boolean {
  return parseSessionStartEnvOverride() ?? config.enabled;
}

export function computeBridgeMaxChars(configuredMaxChars: number): number {
  const maxChars = Math.max(1, Math.floor(configuredMaxChars));
  if (maxChars > RESERVED_FOOTER_CHARS + 32) {
    return maxChars - RESERVED_FOOTER_CHARS;
  }
  return maxChars;
}

function trimLinesToBudget(text: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  if (text.length <= budget) {
    return text;
  }
  const lines = text.split("\n");
  const kept: string[] = [];
  let currentLength = 0;
  for (const line of lines) {
    const nextLength = kept.length === 0 ? line.length : currentLength + 1 + line.length;
    if (nextLength > budget) {
      break;
    }
    kept.push(line);
    currentLength = nextLength;
  }
  return kept.join("\n");
}

function trimToMaxChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const lineTrimmed = trimLinesToBudget(text, maxChars);
  if (lineTrimmed && (lineTrimmed.includes("\n") || !text.startsWith("# "))) {
    return lineTrimmed;
  }
  return text.slice(0, maxChars);
}

export function composeInjectedContent(
  rawText: string,
  retrievalId: string | null | undefined,
  configuredMaxChars: number,
): string | null {
  const maxChars = Math.max(1, Math.floor(configuredMaxChars));
  const text = rawText.trimEnd();
  if (!text) {
    return null;
  }

  const cleanRetrievalId = typeof retrievalId === "string" ? retrievalId.trim() : "";
  if (!cleanRetrievalId) {
    const out = trimToMaxChars(text, maxChars);
    return out || null;
  }

  const footer = formatCitationFooter(cleanRetrievalId);
  if (text.length + footer.length <= maxChars) {
    return `${text}${footer}`;
  }

  if (footer.length < maxChars) {
    const availableForText = maxChars - footer.length;
    const trimmed = trimLinesToBudget(text, availableForText);
    if (trimmed && (trimmed.includes("\n") || !text.startsWith("# "))) {
      return `${trimmed}${footer}`;
    }
  }

  const withoutFooter = trimToMaxChars(text, maxChars);
  return withoutFooter || null;
}

function getActiveBranchEntries(ctx: OmpContext | undefined): OmpSessionEntry[] {
  const sm = ctx?.sessionManager;
  if (!sm) {
    return [];
  }
  try {
    if (typeof sm.getBranch === "function") {
      const branch = sm.getBranch();
      if (Array.isArray(branch)) {
        return branch;
      }
    }
    if (typeof sm.getEntries === "function") {
      const entries = sm.getEntries();
      if (Array.isArray(entries)) {
        return entries;
      }
    }
  } catch {
    // Ignore broken sessionManager in defensive host environments.
  }
  return [];
}

function getSessionId(ctx: OmpContext | undefined): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  } catch {
    // Ignore broken sessionManager in defensive host environments.
  }
  return undefined;
}

export interface SessionStartStatusSnapshot {
  enabled: boolean;
  source: "override" | "env" | "config";
  maxChars: number;
  maxItems: number;
  timeoutMs: number;
  injectedInCurrentSession: boolean;
  configuredEnabled: boolean;
  envOverride: boolean | null;
  sessionOverride: boolean | null;
}

export class SessionStartInjector {
  private readonly bridge: BridgeClient;
  private readonly config: SessionStartConfig;
  private readonly report: FailureReporter;
  private readonly attemptedEpochs = new Set<string>();
  private readonly injectedSessions = new Set<string>();
  private enabledOverride: boolean | null = null;
  private reported = false;

  constructor(bridge: BridgeClient, config: SessionStartConfig, report: FailureReporter) {
    this.bridge = bridge;
    this.config = config;
    this.report = report;
  }

  getConfig(): SessionStartConfig {
    return { ...this.config };
  }

  setEnabledOverride(enabled: boolean | null): void {
    this.enabledOverride = enabled;
  }

  effectiveEnabledState(): { enabled: boolean; source: "override" | "env" | "config" } {
    if (this.enabledOverride !== null) {
      return { enabled: this.enabledOverride, source: "override" };
    }
    const env = parseSessionStartEnvOverride();
    if (env !== undefined) {
      return { enabled: env, source: "env" };
    }
    return { enabled: this.config.enabled, source: "config" };
  }

  statusSnapshot(sessionId?: string, ctx?: OmpContext): SessionStartStatusSnapshot {
    const effective = this.effectiveEnabledState();
    const env = parseSessionStartEnvOverride();
    const cleanSid =
      typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
    let injectedInCurrentSession = cleanSid ? this.injectedSessions.has(cleanSid) : false;
    if (!injectedInCurrentSession && ctx) {
      const entries = getActiveBranchEntries(ctx);
      let lastCompactionIdx = -1;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.type === "compaction") {
          lastCompactionIdx = i;
          break;
        }
      }
      const after = lastCompactionIdx >= 0 ? entries.slice(lastCompactionIdx + 1) : entries;
      injectedInCurrentSession = after.some(
        (entry) =>
          entry?.type === "custom_message" && entry?.customType === CORVUS_MEMORY_CUSTOM_TYPE,
      );
    }
    return {
      enabled: effective.enabled,
      source: effective.source,
      maxChars: this.config.maxChars,
      maxItems: this.config.maxItems,
      timeoutMs: this.config.timeoutMs,
      injectedInCurrentSession,
      configuredEnabled: this.config.enabled,
      envOverride: env ?? null,
      sessionOverride: this.enabledOverride,
    };
  }

  private reportOnce(message: string): void {
    if (this.reported) {
      return;
    }
    this.reported = true;
    try {
      this.report(message);
    } catch {
      // Never let warning reporting crash omp.
    }
  }

  async handleBeforeAgentStart(
    ctx: OmpContext | undefined,
  ): Promise<SessionStartInjectionResult | undefined> {
    if (!this.effectiveEnabledState().enabled) {
      return undefined;
    }

    const sessionId = getSessionId(ctx);
    if (!sessionId) {
      return undefined;
    }

    const entries = getActiveBranchEntries(ctx);
    let lastCompactionIdx = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.type === "compaction") {
        lastCompactionIdx = i;
        break;
      }
    }

    const compactionEpoch =
      lastCompactionIdx >= 0
        ? entries[lastCompactionIdx]?.id?.trim() || `compaction-${lastCompactionIdx}`
        : "root";
    const dedupeKey = `${sessionId}:${compactionEpoch}`;

    if (this.attemptedEpochs.has(dedupeKey)) {
      return undefined;
    }

    const entriesAfterCompaction =
      lastCompactionIdx >= 0 ? entries.slice(lastCompactionIdx + 1) : entries;
    const alreadyInjectedOnBranch = entriesAfterCompaction.some(
      (entry) =>
        entry?.type === "custom_message" && entry?.customType === CORVUS_MEMORY_CUSTOM_TYPE,
    );
    if (alreadyInjectedOnBranch) {
      this.attemptedEpochs.add(dedupeKey);
      this.injectedSessions.add(sessionId);
      return undefined;
    }

    try {
      const bridgeMaxChars = computeBridgeMaxChars(this.config.maxChars);
      const res = await this.bridge.call<SessionContextResult>(
        "session_context",
        {
          harnessSessionId: sessionId,
          cwd: ctx?.cwd,
        },
        {
          max_chars: bridgeMaxChars,
          max_items: this.config.maxItems,
        },
        {
          timeoutMs: this.config.timeoutMs,
        },
      );

      if (!res.ok) {
        if (!res.transportFailure && res.error.code !== "aborted" && res.error.code !== "closed") {
          this.reportOnce(
            `corvus: session-start memory injection error (${res.error.code}: ${res.error.message})`,
          );
        }
        return undefined;
      }

      const data = res.result;
      if (!data || data.degraded) {
        if (data?.degraded) {
          const reason = data.reason ? ` (${data.reason})` : "";
          this.reportOnce(`corvus: session-start memory injection degraded${reason}`);
        }
        return undefined;
      }

      if (typeof data.text !== "string" || !data.text.trim()) {
        return undefined;
      }

      const finalContent = composeInjectedContent(
        data.text,
        data.retrieval_id,
        this.config.maxChars,
      );
      if (!finalContent) {
        return undefined;
      }

      this.injectedSessions.add(sessionId);
      return {
        message: {
          customType: CORVUS_MEMORY_CUSTOM_TYPE,
          content: finalContent,
          display: false,
          attribution: "agent",
        },
      };
    } catch (err) {
      this.reportOnce(
        `corvus: session-start memory injection failed (${err instanceof Error ? err.message : err})`,
      );
      return undefined;
    } finally {
      this.attemptedEpochs.add(dedupeKey);
    }
  }
}
