/**
 * Session-bound native memory tools registered into omp via `pi.registerTool`.
 *
 * All persistence, redaction, deterministic uuid5 IDs, quarantine screening, spooling,
 * and recorded recall SQL live in `agent-memory` behind `mem bridge`.
 */

import type { BridgeCallResult, BridgeClient, BridgeOp } from "./bridge.ts";
import { AGENT_ID, type OmpContext, projectOf } from "./mapper.ts";

export const MEMORY_TOOL_NAMES = ["recall", "remember", "cite", "review", "status"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export const DEFAULT_RECALL_LIMIT = 8;
export const MAX_RECALL_LIMIT = 50;
export const DEFAULT_CONFIDENCE = 0.7;
export const DEFAULT_IMPORTANCE = 0.5;
export const DEFAULT_TRUST_LEVEL = "agent";

const MEMORY_TYPES = ["fact", "preference", "decision", "procedure", "observation", "profile"];
const TRUST_LEVELS = ["user", "agent", "tool"];
// Human-only approval invariant: `approve` is intentionally omitted from the tool schema.
const AGENT_REVIEW_ACTIONS = ["retire", "quarantine", "confirm", "flag_contradiction"];

export interface OmpToolUpdate {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface OmpToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: OmpToolUpdate) => void) | undefined,
    ctx: OmpContext,
  ) => Promise<OmpToolResult>;
}

export interface OmpToolRegistrar {
  registerTool?: (definition: OmpToolDefinition) => void;
}

export interface ToolRegistrationOptions {
  toolTimeoutMs?: number;
  onContext?: (ctx: OmpContext) => void;
  disabledReason?: string;
}

function jsonResult(payload: Record<string, unknown>, isError = false): OmpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
    isError,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampRecallLimit(value: unknown): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_RECALL_LIMIT;
  return Math.max(1, Math.min(MAX_RECALL_LIMIT, raw));
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
    // Broken sessionManager is handled below as a missing session id.
  }
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : undefined;
  const project = projectOf(cwd);
  return { harnessSessionId, cwd, project };
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

async function callBridgeOrDegrade(
  op: BridgeOp,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: OmpContext | undefined,
  bridge: BridgeClient | null,
  options: ToolRegistrationOptions,
  onTransportDegraded: (
    reason: string,
    session: { harnessSessionId: string; cwd?: string; project?: string },
  ) => OmpToolResult,
): Promise<OmpToolResult> {
  if (ctx) {
    options.onContext?.(ctx);
  }
  const session = sessionFromContext(ctx);
  if (!session.harnessSessionId) {
    return jsonResult(
      {
        error: "invalid_args",
        message: "missing active session id from ctx.sessionManager.getSessionId()",
      },
      true,
    );
  }

  if (!bridge) {
    return onTransportDegraded(options.disabledReason ?? "memory bridge is disabled", {
      harnessSessionId: session.harnessSessionId,
      cwd: session.cwd,
      project: session.project,
    });
  }

  const res: BridgeCallResult<Record<string, unknown>> = await bridge.call(
    op,
    {
      harnessSessionId: session.harnessSessionId,
      cwd: session.cwd,
      project: session.project,
    },
    args,
    {
      timeoutMs: options.toolTimeoutMs,
      signal,
    },
  );

  if (res.ok) {
    return jsonResult(res.result, false);
  }

  if (res.transportFailure) {
    return onTransportDegraded(res.error.message, {
      harnessSessionId: session.harnessSessionId,
      cwd: session.cwd,
      project: session.project,
    });
  }

  return jsonResult(
    {
      error: res.error.code,
      message: res.error.message,
    },
    true,
  );
}

export function buildToolDefinitions(
  bridge: BridgeClient | null,
  options: ToolRegistrationOptions = {},
): OmpToolDefinition[] {
  const recallTool: OmpToolDefinition = {
    name: "recall",
    label: "Recall Memory",
    description:
      "Search memory. Returns ranked active memories with a retrieval_id for cite.\n" +
      "query: free text; empty returns the most important recent memories.\n" +
      'scopes: default ["global", <project>]. types: fact, preference, decision, procedure,\n' +
      "observation, profile. Every call is logged with what was returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "Free-text search query (empty string returns the most important recent memories).",
        },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: 'Scopes to search; defaults to ["global", <project>].',
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RECALL_LIMIT,
          default: DEFAULT_RECALL_LIMIT,
          description: "Maximum number of memories to return (1 to 50, default 8).",
        },
        types: {
          type: "array",
          items: { type: "string", enum: MEMORY_TYPES },
          description: "Optional filter by memory type.",
        },
      },
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const args = compactRecord({
        query: stringValue(params?.query) ?? "",
        scopes: optionalStringArray(params?.scopes),
        limit: clampRecallLimit(params?.limit),
        types: optionalStringArray(params?.types),
      });
      return callBridgeOrDegrade("recall", args, signal, ctx, bridge, options, (reason) =>
        jsonResult(
          {
            degraded: true,
            reason,
            retrieval_id: null,
            items: [],
          },
          false,
        ),
      );
    },
  };

  const rememberTool: OmpToolDefinition = {
    name: "remember",
    label: "Remember",
    description:
      "Store one durable memory: a fact, preference, decision, procedure, observation,\n" +
      "or profile attribute. Not for transient task state. trust_level: user (the user said\n" +
      "it), agent (you inferred it), tool (came from tool output; quarantined until the user\n" +
      "approves it). Content with invisible or direction-changing characters or\n" +
      "instruction-like text is also written quarantined regardless of trust_level and waits\n" +
      "for the user to approve it with `mem review`.\n" +
      "Pass supersedes=<memory_id> when correcting an existing memory. Identical content\n" +
      "in the same scope is confirmed rather than duplicated.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content", "type"],
      properties: {
        content: {
          type: "string",
          minLength: 1,
          description: "Durable memory statement to store.",
        },
        type: {
          type: "string",
          enum: MEMORY_TYPES,
          description: "Memory category.",
        },
        scope: {
          type: "string",
          description: 'Scope for the memory (defaults to current project or "global").',
        },
        key: {
          type: "string",
          description: "Optional short lookup key.",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: DEFAULT_CONFIDENCE,
          description: "Confidence score between 0 and 1 (default 0.7).",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: DEFAULT_IMPORTANCE,
          description: "Importance score between 0 and 1 (default 0.5).",
        },
        trust_level: {
          type: "string",
          enum: TRUST_LEVELS,
          default: DEFAULT_TRUST_LEVEL,
          description: "Provenance trust level (default agent).",
        },
        supersedes: {
          type: "string",
          description: "Optional UUID of an older memory this supersedes.",
        },
        source_event_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional source event UUIDs.",
        },
        valid_from: {
          type: "string",
          description: "Optional ISO-8601 start timestamp.",
        },
        expires_at: {
          type: "string",
          description: "Optional ISO-8601 expiration timestamp.",
        },
        valid_to: {
          type: "string",
          description: "Optional ISO-8601 end timestamp.",
        },
      },
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const args = compactRecord({
        content: stringValue(params?.content) ?? "",
        type: stringValue(params?.type) ?? "",
        scope: stringValue(params?.scope),
        key: stringValue(params?.key),
        confidence: numberValue(params?.confidence, DEFAULT_CONFIDENCE),
        importance: numberValue(params?.importance, DEFAULT_IMPORTANCE),
        trust_level: stringValue(params?.trust_level) ?? DEFAULT_TRUST_LEVEL,
        supersedes: stringValue(params?.supersedes),
        source_event_ids: optionalStringArray(params?.source_event_ids),
        valid_from: stringValue(params?.valid_from),
        expires_at: stringValue(params?.expires_at),
        valid_to: stringValue(params?.valid_to),
      });
      return callBridgeOrDegrade("remember", args, signal, ctx, bridge, options, (reason) =>
        jsonResult(
          {
            queued: false,
            degraded: true,
            reason,
          },
          true,
        ),
      );
    },
  };

  const citeTool: OmpToolDefinition = {
    name: "cite",
    label: "Cite Memory",
    description:
      "Record what an answer was based on: the recall it used and the memories it relied\n" +
      "on. Call it when you answer using recalled memory. Without answer_event_id a\n" +
      "placeholder answer event is created and returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        retrieval_id: {
          type: "string",
          description: "UUID returned by recall.",
        },
        memory_ids: {
          type: "array",
          items: { type: "string" },
          description: "Memory UUIDs relied on in the answer.",
        },
        context_event_ids: {
          type: "array",
          items: { type: "string" },
          description: "Event UUIDs relied on in the answer.",
        },
        answer_event_id: {
          type: "string",
          description: "Optional explicit assistant_msg event UUID.",
        },
      },
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const args = compactRecord({
        retrieval_id: stringValue(params?.retrieval_id),
        memory_ids: optionalStringArray(params?.memory_ids),
        context_event_ids: optionalStringArray(params?.context_event_ids),
        answer_event_id: stringValue(params?.answer_event_id),
      });
      return callBridgeOrDegrade("cite", args, signal, ctx, bridge, options, (reason) =>
        jsonResult(
          {
            degraded: true,
            reason,
            links: 0,
          },
          false,
        ),
      );
    },
  };

  const reviewTool: OmpToolDefinition = {
    name: "review",
    label: "Review Memory",
    description:
      "Change a memory's standing. action: retire (wrong or obsolete), quarantine (hide\n" +
      "until the user reviews it), confirm (still true), flag_contradiction (conflicts with\n" +
      "related_memory_id). reason is required. You cannot approve a quarantined memory:\n" +
      "only the user can, with `mem review`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "memory_id", "reason"],
      properties: {
        action: {
          type: "string",
          enum: AGENT_REVIEW_ACTIONS,
          description: "Review action (agents cannot approve quarantined memories).",
        },
        memory_id: {
          type: "string",
          description: "UUID of the memory being reviewed.",
        },
        reason: {
          type: "string",
          minLength: 1,
          description: "Required reason for this review action.",
        },
        related_memory_id: {
          type: "string",
          description: "Conflicting memory UUID when action is flag_contradiction.",
        },
      },
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (ctx) {
        options.onContext?.(ctx);
      }
      if (params?.action === "approve") {
        return jsonResult(
          {
            error: "validation_error",
            message:
              "omp sessions cannot approve memories; only the user can approve with `mem review`",
          },
          true,
        );
      }
      const args = compactRecord({
        action: stringValue(params?.action) ?? "",
        memory_id: stringValue(params?.memory_id) ?? "",
        reason: stringValue(params?.reason) ?? "",
        related_memory_id: stringValue(params?.related_memory_id),
      });
      return callBridgeOrDegrade("review", args, signal, ctx, bridge, options, (reason) =>
        jsonResult(
          {
            queued: false,
            degraded: true,
            reason,
          },
          true,
        ),
      );
    },
  };

  const statusTool: OmpToolDefinition = {
    name: "status",
    label: "Memory Status",
    description:
      "Whether the memory server is reachable, this session's id, how much is waiting\n" +
      "in the spool, and how many records the ledger rejected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async (_toolCallId, _params, signal, _onUpdate, ctx) =>
      callBridgeOrDegrade("status", {}, signal, ctx, bridge, options, (reason, session) =>
        jsonResult(
          {
            reachable: false,
            reason,
            agent_id: AGENT_ID,
            harness_session_id: session.harnessSessionId,
            project: session.project ?? null,
          },
          false,
        ),
      ),
  };

  return [recallTool, rememberTool, citeTool, reviewTool, statusTool];
}

export function registerMemoryTools(
  pi: OmpToolRegistrar,
  bridge: BridgeClient | null,
  options: ToolRegistrationOptions = {},
): void {
  if (typeof pi.registerTool !== "function") {
    return;
  }
  for (const tool of buildToolDefinitions(bridge, options)) {
    pi.registerTool(tool);
  }
}
