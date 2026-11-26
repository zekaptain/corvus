/**
 * End-to-end, self-cleaning smoke test for Corvus + agent-memory.
 *
 * Phase A (always runs):
 *   1. Spawns a throwaway `agent-memory` server on a fresh temp dir + ephemeral port.
 *   2. Installs Corvus via `installExtension` into a throwaway omp extensions dir.
 *   3. Dynamically imports the installed extension, drives multi-session omp hooks,
 *      native memory tools, session-start injection + overflow, and `/corvus` commands.
 *   4. Verifies persisted ledger state directly via `mem sql --json`.
 *
 * Phase B (runs when `--omp <path>` is passed):
 *   Runs isolated headless `omp -p` checks (`/corvus status` and optional `--model` run)
 *   without touching `~/.omp/` or any live `agent-memory` home.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CliIO, installExtension, statusExtension } from "../src/cli/installer.ts";
import type {
  OmpCommandDefinition,
  OmpCommandMessage,
  OmpCommandResult,
} from "../src/extension/commands.ts";
import type { OmpExtensionAPI } from "../src/extension/index.ts";
import type { OmpContext, OmpHookPayload, OmpSessionEntry } from "../src/extension/mapper.ts";
import type { OmpToolDefinition, OmpToolResult } from "../src/extension/tools.ts";

interface SmokeArgs {
  mem: string;
  omp?: string;
  model?: string;
}

function parseSmokeArgs(argv: string[]): SmokeArgs {
  let mem = process.env.CORVUS_SMOKE_MEM || "mem";
  let omp: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mem") {
      const val = argv[++i];
      if (!val) throw new Error("--mem requires a value");
      mem = val;
    } else if (arg === "--omp") {
      const val = argv[++i];
      if (!val) throw new Error("--omp requires a value");
      omp = val;
    } else if (arg === "--model") {
      const val = argv[++i];
      if (!val) throw new Error("--model requires a value");
      model = val;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: bun run smoke [-- --mem <path>] [--omp <path>] [--model <provider/model>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { mem, omp, model };
}

const STRIPPED_ENV_KEYS = new Set([
  "AGENT_MEMORY_HOME",
  "AGENT_MEMORY_PORT",
  "AGENT_MEMORY_HOST",
  "AGENT_MEMORY_AGENT",
  "CORVUS_SESSION_START_INJECTION",
]);

function cleanEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED_ENV_KEYS.has(k) || k in overrides) {
      continue;
    }
    if (v !== undefined) {
      env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  return env;
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function runCommand(
  cmd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env ?? cleanEnv(),
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore.
      }
      reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
    }, options.timeoutMs ?? 30_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runMemSql<T = Record<string, unknown>>(
  mem: string,
  home: string,
  port: number,
  query: string,
): Promise<T[]> {
  const res = await runCommand(mem, [
    "--home",
    home,
    "--port",
    String(port),
    "sql",
    "--json",
    query,
  ]);
  if (res.code !== 0) {
    throw new Error(`mem sql failed (${res.code}): ${res.stderr || res.stdout}\nQuery: ${query}`);
  }
  return JSON.parse(res.stdout) as T[];
}

async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) {
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const extra = lastErr
    ? ` (last error: ${lastErr instanceof Error ? lastErr.message : lastErr})`
    : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${extra}`);
}

async function startMemServer(
  mem: string,
  home: string,
  port: number,
): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
  const child = spawn(
    mem,
    ["--home", home, "--port", String(port), "serve", "--export-interval-hours", "0"],
    {
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  let readyFromStdout = false;
  let exitedEarly: string | null = null;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    logs += chunk;
    if (chunk.includes("serving ")) {
      readyFromStdout = true;
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    logs += chunk;
  });
  child.on("exit", (code, signal) => {
    exitedEarly = `code=${code} signal=${signal}`;
  });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore.
        }
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  };

  try {
    await waitFor(
      async () => {
        if (exitedEarly) {
          throw new Error(`mem serve exited early (${exitedEarly}):\n${logs}`);
        }
        if (!readyFromStdout) {
          return false;
        }
        const ping = await runCommand(mem, [
          "--home",
          home,
          "--port",
          String(port),
          "sql",
          "--json",
          "SELECT 1 AS ok",
        ]);
        return ping.code === 0;
      },
      25_000,
      "mem serve readiness",
    );
    return { child, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

class SmokeSessionManager {
  private readonly sessionId: string;
  private readonly sessionFile: string;
  private readonly entries: OmpSessionEntry[] = [];
  private leafId: string | undefined;
  private readonly headerTs = Date.now();

  constructor(sessionId: string, sessionFile: string) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  getLeafId(): string | undefined {
    return this.leafId;
  }

  getEntries(): OmpSessionEntry[] {
    return [...this.entries];
  }

  getBranch(): OmpSessionEntry[] {
    return [...this.entries];
  }

  getHeader(): { timestamp: number } {
    return { timestamp: this.headerTs };
  }

  push(entry: OmpSessionEntry): string {
    const id = entry.id ?? `entry-${this.entries.length + 1}`;
    this.entries.push({ ...entry, id });
    this.leafId = id;
    return id;
  }
}

type HookFn = (payload: OmpHookPayload, ctx: OmpContext) => unknown;

class SmokeOmpPi implements OmpExtensionAPI {
  readonly pi = { VERSION: "19.2.1" };
  readonly handlers = new Map<string, HookFn[]>();
  readonly tools = new Map<string, OmpToolDefinition>();
  readonly commands = new Map<string, OmpCommandDefinition>();
  readonly sentMessages: OmpCommandMessage[] = [];
  readonly notifications: Array<{ message: string; level?: string }> = [];
  readonly statuses = new Map<string, string>();
  activeSessionManager?: SmokeSessionManager;

  on(eventName: string, handler: HookFn): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  registerTool(definition: OmpToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  registerCommand(name: string, definition: OmpCommandDefinition): void {
    this.commands.set(name, definition);
  }

  sendMessage(message: OmpCommandMessage): void {
    this.sentMessages.push(message);
    if (this.activeSessionManager) {
      this.activeSessionManager.push({
        type: "custom_message",
        customType: message.customType,
        message: {
          role: "custom",
          content: message.content,
          timestamp: Date.now(),
        },
      });
    }
  }

  emitSync(eventName: string, payload: OmpHookPayload, ctx: OmpContext): void {
    for (const handler of this.handlers.get(eventName) ?? []) {
      handler(payload, ctx);
    }
  }

  async emitBeforeAgentStart(
    payload: OmpHookPayload & { prompt?: string; systemPrompt?: string[] },
    ctx: OmpContext,
  ): Promise<
    Array<{
      message?: { customType: string; content: string; display: false; attribution: "agent" };
    }>
  > {
    const results: Array<{
      message?: { customType: string; content: string; display: false; attribution: "agent" };
    }> = [];
    for (const handler of this.handlers.get("before_agent_start") ?? []) {
      const out = await handler(payload, ctx);
      if (out && typeof out === "object") {
        results.push(
          out as {
            message?: { customType: string; content: string; display: false; attribution: "agent" };
          },
        );
      }
    }
    return results;
  }

  async runTool(
    toolCallId: string,
    name: string,
    params: Record<string, unknown>,
    ctx: OmpContext,
  ): Promise<OmpToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} is not registered`);
    }
    this.emitSync(
      "tool_call",
      { type: "tool_call", toolName: name, toolCallId, input: params },
      ctx,
    );
    const result = await tool.execute(toolCallId, params, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    const toolMsg = {
      role: "toolResult",
      toolCallId,
      toolName: name,
      content: [{ type: "text", text }],
      details: result.details,
      isError: Boolean(result.isError),
      timestamp: Date.now(),
    };
    this.activeSessionManager?.push({ type: "message", message: toolMsg });
    this.emitSync("message_end", { type: "message_end", message: toolMsg }, ctx);
    return result;
  }

  async runCommand(args: string, ctx: OmpContext): Promise<OmpCommandResult> {
    const cmd = this.commands.get("corvus");
    if (!cmd) {
      throw new Error("/corvus command is not registered");
    }
    return cmd.handler(args, ctx);
  }

  makeContext(sm: SmokeSessionManager, cwd: string): OmpContext {
    this.activeSessionManager = sm;
    return {
      cwd,
      hasUI: true,
      model: { provider: "smoke-provider", id: "smoke-model" },
      sessionManager: sm,
      ui: {
        notify: (message, level) => {
          this.notifications.push({ message, level });
        },
        setStatus: (key, text) => {
          this.statuses.set(key, text);
        },
      },
    };
  }
}

function quietIO(): CliIO {
  return {
    stdout: () => {},
    stderr: () => {},
  };
}

function parseDetails(result: OmpToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  assert.ok(text, "tool result missing text payload");
  return JSON.parse(text) as Record<string, unknown>;
}

async function runPhaseA(args: SmokeArgs, tmpRoot: string): Promise<void> {
  const memHome = join(tmpRoot, "mem-home");
  const ompHome = join(tmpRoot, "omp-home");
  const extensionsDir = join(ompHome, ".omp", "agent", "extensions");
  const sessionsDir = join(ompHome, ".omp", "agent", "sessions");
  const projectDir = join(tmpRoot, "corvus-smoke-repo");
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const port = await allocateEphemeralPort();
  console.log(`[phase-a] Initializing throwaway agent-memory home at ${memHome} (port ${port})...`);
  const initRes = await runCommand(args.mem, ["--home", memHome, "--port", String(port), "init"]);
  assert.equal(initRes.code, 0, `mem init failed: ${initRes.stderr || initRes.stdout}`);

  console.log("[phase-a] Starting throwaway mem serve...");
  const server = await startMemServer(args.mem, memHome, port);
  try {
    console.log("[phase-a] Installing Corvus into throwaway omp extensions dir...");
    const installRes = installExtension(
      {
        dir: extensionsDir,
        mem: args.mem,
        home: memHome,
        port,
        sessionStartInjection: true,
        sessionStartMaxChars: 300,
        sessionStartMaxItems: 10,
        sessionStartTimeoutMs: 2500,
      },
      quietIO(),
    );
    assert.equal(installRes.action, "installed");

    const statusRes = statusExtension({ dir: extensionsDir }, quietIO());
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.installed, true);
    assert.equal(statusRes.sessionStartInjection, true);
    assert.equal(statusRes.sessionStart?.maxChars, 300);

    const installedEntry = join(extensionsDir, "corvus", "index.ts");
    const mod = (await import(pathToFileURL(installedEntry).href)) as {
      default: (pi: OmpExtensionAPI) => void;
    };

    // --- Session 1: tools, capture, approve refusal, recall hit+miss, cite ---
    console.log("[phase-a] Driving Session 1 (tools, capture, approve refusal, recall, cite)...");
    const pi1 = new SmokeOmpPi();
    mod.default(pi1);

    assert.equal(pi1.commands.has("corvus"), true, "/corvus command must be registered");
    assert.equal(pi1.commands.has("memory"), false, "/memory must never be registered");
    for (const toolName of ["recall", "remember", "cite", "review", "status"]) {
      assert.equal(pi1.tools.has(toolName), true, `missing native tool ${toolName}`);
    }
    const reviewProps = (
      pi1.tools.get("review")?.parameters as {
        properties?: { action?: { enum?: string[] } };
      }
    )?.properties;
    assert.equal(
      reviewProps?.action?.enum?.includes("approve"),
      false,
      "review schema must never expose approve",
    );

    const sm1 = new SmokeSessionManager(
      "smoke-session-1",
      join(sessionsDir, "smoke-session-1.jsonl"),
    );
    const ctx1 = pi1.makeContext(sm1, projectDir);
    pi1.emitSync("session_start", { type: "session_start" }, ctx1);

    const userMsg1 = {
      role: "user",
      content: [{ type: "text", text: "Store project decisions and cite recalled guidance." }],
      attribution: "user",
      timestamp: Date.now(),
    };
    sm1.push({ type: "message", message: userMsg1 });
    pi1.emitSync("message_end", { type: "message_end", message: userMsg1 }, ctx1);

    const statusToolRes = await pi1.runTool("tc-status-1", "status", {}, ctx1);
    assert.equal(statusToolRes.isError, false);
    const statusJson = parseDetails(statusToolRes);
    assert.equal(statusJson.reachable, true);
    assert.equal(statusJson.agent_id, "oh-my-pi");
    assert.equal(statusJson.project, "corvus-smoke-repo");

    const rem1Res = await pi1.runTool(
      "tc-rem-1",
      "remember",
      {
        content: "Primary decision: always use strict NDJSON bridge protocol for omp memory.",
        type: "decision",
        importance: 0.9,
        trust_level: "user",
      },
      ctx1,
    );
    assert.equal(rem1Res.isError, false);
    const rem1Json = parseDetails(rem1Res);
    assert.equal(rem1Json.status, "active");
    const m1Id = String(rem1Json.memory_id);

    const rem2Res = await pi1.runTool(
      "tc-rem-2",
      "remember",
      {
        content: "Secondary decision: keep compact footer reservation intact across updates.",
        type: "decision",
        importance: 0.4,
        trust_level: "user",
      },
      ctx1,
    );
    assert.equal(rem2Res.isError, false);
    const rem2Json = parseDetails(rem2Res);
    assert.equal(rem2Json.status, "active");
    const m2Id = String(rem2Json.memory_id);

    const remToolRes = await pi1.runTool(
      "tc-rem-3",
      "remember",
      {
        content: "Tool observation that must remain quarantined until human review.",
        type: "observation",
        trust_level: "tool",
      },
      ctx1,
    );
    assert.equal(remToolRes.isError, false);
    const remToolJson = parseDetails(remToolRes);
    assert.equal(remToolJson.status, "quarantined");
    const quarId = String(remToolJson.memory_id);

    const approveAttempt = await pi1.runTool(
      "tc-approve-1",
      "review",
      {
        action: "approve",
        memory_id: quarId,
        reason: "smoke test self-approval refusal",
      },
      ctx1,
    );
    assert.equal(approveAttempt.isError, true);
    const approveJson = parseDetails(approveAttempt);
    assert.equal(approveJson.error, "validation_error");
    assert.ok(String(approveJson.message).includes("mem review"));

    const recallHit = await pi1.runTool(
      "tc-recall-hit",
      "recall",
      { query: "NDJSON bridge" },
      ctx1,
    );
    assert.equal(recallHit.isError, false);
    const recallHitJson = parseDetails(recallHit);
    assert.notEqual(recallHitJson.degraded, true);
    const hitItems = recallHitJson.items as Array<{ memory_id: string }>;
    assert.ok(hitItems.some((item) => item.memory_id === m1Id));
    assert.equal(
      hitItems.some((item) => item.memory_id === quarId),
      false,
      "quarantined memory must never appear in recall",
    );
    const recall1Id = String(recallHitJson.retrieval_id);

    const recallMiss = await pi1.runTool(
      "tc-recall-miss",
      "recall",
      { query: "zzzz_nonexistent_corvus_smoke_token" },
      ctx1,
    );
    assert.equal(recallMiss.isError, false);
    const recallMissJson = parseDetails(recallMiss);
    assert.notEqual(recallMissJson.degraded, true);
    assert.equal((recallMissJson.items as unknown[]).length, 0);
    const recallMissId = String(recallMissJson.retrieval_id);

    const citeRes = await pi1.runTool(
      "tc-cite-1",
      "cite",
      {
        retrieval_id: recall1Id,
        memory_ids: [m1Id],
      },
      ctx1,
    );
    assert.equal(citeRes.isError, false);
    const citeJson = parseDetails(citeRes);
    assert.equal(citeJson.links, 2);
    const placeholderId = String(citeJson.answer_event_id);
    assert.ok(placeholderId.length > 10);

    const assistantMsg1 = {
      role: "assistant",
      content: [{ type: "text", text: "Recorded the decisions and cited the NDJSON bridge rule." }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    sm1.push({ type: "message", message: assistantMsg1 });
    pi1.emitSync("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMsg1 }, ctx1);
    pi1.emitSync("agent_end", { type: "agent_end" }, ctx1);
    pi1.emitSync("session_shutdown", { type: "session_shutdown" }, ctx1);

    await waitFor(
      async () => {
        const rows = await runMemSql<{ kind: string }>(
          args.mem,
          memHome,
          port,
          "SELECT e.kind FROM events e JOIN sessions s USING (session_id) " +
            "WHERE s.agent_id = 'oh-my-pi' AND s.harness_session_id = 'smoke-session-1' " +
            "AND e.kind = 'session_end'",
        );
        return rows.length >= 1;
      },
      10_000,
      "Session 1 session_end flush",
    );

    // --- Session 2: before_agent_start injection + dedupe + /corvus commands ---
    console.log(
      "[phase-a] Driving Session 2 (session-start injection, dedupe, /corvus commands)...",
    );
    const pi2 = new SmokeOmpPi();
    mod.default(pi2);

    const sm2 = new SmokeSessionManager(
      "smoke-session-2",
      join(sessionsDir, "smoke-session-2.jsonl"),
    );
    const ctx2 = pi2.makeContext(sm2, projectDir);
    pi2.emitSync("session_start", { type: "session_start" }, ctx2);

    const userMsg2a = {
      role: "user",
      content: [{ type: "text", text: "What did we decide about the NDJSON bridge?" }],
      attribution: "user",
      timestamp: Date.now(),
    };
    sm2.push({ type: "message", message: userMsg2a });

    const injTurn1 = await pi2.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "What did we decide about the NDJSON bridge?",
        systemPrompt: ["base"],
      },
      ctx2,
    );
    assert.equal(injTurn1.length, 1);
    const injMsg = injTurn1[0]?.message;
    assert.ok(injMsg, "expected session-start injection message on turn 1");
    assert.equal(injMsg.customType, "corvus-memory");
    assert.equal(injMsg.display, false);
    assert.equal(injMsg.attribution, "agent");
    assert.ok(injMsg.content.length <= 300, `injected length ${injMsg.content.length} > 300`);
    assert.ok(injMsg.content.includes(m1Id), "injected block must include high-importance memory");
    assert.equal(
      injMsg.content.includes(m2Id),
      false,
      "tight 300-char budget should exclude second memory",
    );
    assert.equal(
      injMsg.content.includes(quarId),
      false,
      "quarantined memory must never be injected",
    );
    assert.ok(
      injMsg.content.includes("[retrieval_id: "),
      "injected block must include retrieval_id footer",
    );

    // Simulate omp appending the custom_message (making it leafId), then firing message_end for both.
    const injectedCustomMsg = {
      role: "custom",
      customType: "corvus-memory",
      content: injMsg.content,
      display: false,
      attribution: "agent",
      timestamp: Date.now(),
    };
    sm2.push({
      type: "custom_message",
      customType: "corvus-memory",
      message: injectedCustomMsg,
    });
    pi2.emitSync("message_end", { type: "message_end", message: userMsg2a }, ctx2);
    pi2.emitSync("message_end", { type: "message_end", message: injectedCustomMsg }, ctx2);

    // Turn 2 must be deduped.
    const userMsg2b = {
      role: "user",
      content: [{ type: "text", text: "Follow-up prompt" }],
      attribution: "user",
      timestamp: Date.now() + 10,
    };
    sm2.push({ type: "message", message: userMsg2b });
    const injTurn2 = await pi2.emitBeforeAgentStart(
      { type: "before_agent_start", prompt: "Follow-up prompt", systemPrompt: ["base"] },
      ctx2,
    );
    assert.equal(injTurn2.length, 0, "turn 2 must be deduped");
    pi2.emitSync("message_end", { type: "message_end", message: userMsg2b }, ctx2);

    // Exercise /corvus commands.
    const cmdStatus = await pi2.runCommand("status", ctx2);
    assert.ok(cmdStatus.content.includes("Ledger: reachable"));
    assert.ok(cmdStatus.content.includes("Capture sink: alive"));
    assert.ok(cmdStatus.content.includes("Bridge client: healthy"));
    assert.ok(cmdStatus.content.includes("Session-start injection: enabled (source=config"));
    assert.ok(cmdStatus.content.includes("injectedInSession=true"));

    const cmdPreview = await pi2.runCommand("inject preview", ctx2);
    assert.ok(cmdPreview.content.includes("shown_count=1"));
    assert.ok(cmdPreview.content.includes("not_shown_count=1"));
    assert.ok(cmdPreview.content.includes(m1Id));

    const cmdOff = await pi2.runCommand("inject off", ctx2);
    assert.ok(cmdOff.content.includes("disabled for this session"));
    assert.ok(cmdOff.content.includes("config.json=true was not modified"));

    const cmdInjectStatus = await pi2.runCommand("inject status", ctx2);
    assert.ok(
      cmdInjectStatus.content.includes("Session-start injection: disabled (source=override"),
    );

    const assistantMsg2 = {
      role: "assistant",
      content: [{ type: "text", text: "Confirmed the NDJSON bridge decision." }],
      stopReason: "stop",
      timestamp: Date.now() + 20,
    };
    sm2.push({ type: "message", message: assistantMsg2 });
    pi2.emitSync("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMsg2 }, ctx2);
    pi2.emitSync("agent_end", { type: "agent_end" }, ctx2);
    pi2.emitSync("session_shutdown", { type: "session_shutdown" }, ctx2);

    // --- Session 3: verify /corvus inject off skips injection, then /corvus inject on restores ---
    console.log("[phase-a] Driving Session 3 (verifying /corvus inject off/on toggle)...");
    const pi3 = new SmokeOmpPi();
    mod.default(pi3);
    const sm3 = new SmokeSessionManager(
      "smoke-session-3",
      join(sessionsDir, "smoke-session-3.jsonl"),
    );
    const ctx3 = pi3.makeContext(sm3, projectDir);
    pi3.emitSync("session_start", { type: "session_start" }, ctx3);

    const injOffRes = await pi3.emitBeforeAgentStart(
      { type: "before_agent_start", prompt: "Check off toggle", systemPrompt: ["base"] },
      ctx3,
    );
    assert.equal(injOffRes.length, 0, "override off should skip injection");

    const cmdOn = await pi3.runCommand("inject on", ctx3);
    assert.ok(cmdOn.content.includes("enabled for this session"));
    const injOnRes = await pi3.emitBeforeAgentStart(
      { type: "before_agent_start", prompt: "Check on toggle", systemPrompt: ["base"] },
      ctx3,
    );
    assert.equal(injOnRes.length, 1, "override on should inject");
    pi3.emitSync("session_shutdown", { type: "session_shutdown" }, ctx3);

    await waitFor(
      async () => {
        const rows = await runMemSql<{ harness_session_id: string }>(
          args.mem,
          memHome,
          port,
          "SELECT DISTINCT s.harness_session_id FROM events e JOIN sessions s USING (session_id) " +
            "WHERE s.agent_id = 'oh-my-pi' AND e.kind = 'session_end' " +
            "AND s.harness_session_id IN ('smoke-session-1', 'smoke-session-2', 'smoke-session-3')",
        );
        return rows.length === 3;
      },
      10_000,
      "all 3 smoke sessions to flush session_end",
    );

    // --- Direct DuckDB verification ---
    console.log("[phase-a] Verifying persisted DuckDB ledger rows via mem sql...");
    const sessions = await runMemSql<{
      harness_session_id: string;
      cwd: string;
      project: string;
    }>(
      args.mem,
      memHome,
      port,
      "SELECT harness_session_id, cwd, project FROM sessions " +
        "WHERE agent_id = 'oh-my-pi' ORDER BY harness_session_id",
    );
    assert.deepEqual(
      sessions.map((s) => [s.harness_session_id, s.cwd, s.project]),
      [
        ["smoke-session-1", projectDir, "corvus-smoke-repo"],
        ["smoke-session-2", projectDir, "corvus-smoke-repo"],
        ["smoke-session-3", projectDir, "corvus-smoke-repo"],
      ],
    );

    const s1Kinds = await runMemSql<{ kind: string }>(
      args.mem,
      memHome,
      port,
      "SELECT DISTINCT e.kind FROM events e JOIN sessions s USING (session_id) " +
        "WHERE s.harness_session_id = 'smoke-session-1'",
    );
    const kindSet = new Set(s1Kinds.map((r) => r.kind));
    for (const expected of [
      "session_start",
      "user_msg",
      "tool_call",
      "tool_result",
      "assistant_msg",
      "outcome",
      "session_end",
      "memory_write",
      "memory_recall",
    ]) {
      assert.ok(kindSet.has(expected), `missing event kind ${expected} in smoke-session-1`);
    }

    const corvusToolEvents = await runMemSql<{
      kind: string;
      payload_json: string;
    }>(
      args.mem,
      memHome,
      port,
      "SELECT e.kind, e.payload::JSON::VARCHAR AS payload_json " +
        "FROM events e JOIN sessions s USING (session_id) " +
        "WHERE s.harness_session_id = 'smoke-session-1' " +
        "AND e.kind IN ('tool_call', 'tool_result') " +
        "ORDER BY e.ts, e.kind",
    );
    assert.ok(
      corvusToolEvents.length >= 12 &&
        corvusToolEvents.every((row) => {
          const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
          return parsed.extension === "corvus" && typeof parsed.memory_op === "string";
        }),
      "all Corvus native tool_call/tool_result events must carry extension=corvus and memory_op",
    );

    const leakedCustomUserMsgs = await runMemSql<{ content: string }>(
      args.mem,
      memHome,
      port,
      "SELECT content FROM events e JOIN sessions s USING (session_id) " +
        "WHERE s.harness_session_id = 'smoke-session-2' AND e.kind = 'user_msg' " +
        "AND (content LIKE '%# Active memories%' OR content LIKE 'Corvus Status%')",
    );
    assert.equal(
      leakedCustomUserMsgs.length,
      0,
      "corvus-memory and corvus-command must never be recorded as user_msg",
    );

    const memStatuses = await runMemSql<{ memory_id: string; status: string }>(
      args.mem,
      memHome,
      port,
      "SELECT memory_id::VARCHAR AS memory_id, status FROM memory_status",
    );
    const statusMap = new Map(memStatuses.map((r) => [r.memory_id, r.status]));
    assert.equal(statusMap.get(m1Id), "active");
    assert.equal(statusMap.get(m2Id), "active");
    assert.equal(statusMap.get(quarId), "quarantined");

    const approvals = await runMemSql<{ cnt: number }>(
      args.mem,
      memHome,
      port,
      "SELECT count(*)::INTEGER AS cnt FROM memory_actions WHERE action = 'approve'",
    );
    assert.equal(approvals[0]?.cnt ?? 0, 0, "no in-omp approve actions may ever be persisted");

    const retrievals = await runMemSql<{
      retrieval_id: string;
      strategy: string;
      candidates: number;
      returned: number;
    }>(
      args.mem,
      memHome,
      port,
      "SELECT retrieval_id::VARCHAR AS retrieval_id, strategy, candidates, returned " +
        "FROM retrievals ORDER BY created_at",
    );
    const hitRow = retrievals.find((r) => r.retrieval_id === recall1Id);
    const missRow = retrievals.find((r) => r.retrieval_id === recallMissId);
    assert.ok(hitRow && hitRow.returned >= 1, "recall hit retrieval must record returned >= 1");
    assert.ok(missRow && missRow.returned === 0, "recall miss retrieval must record returned = 0");

    const ssRetrievals = retrievals.filter((r) => r.strategy === "session_start_v1");
    assert.ok(
      ssRetrievals.length >= 3,
      `expected >=3 session_start_v1 retrievals (turn 1 + preview + session 3), got ${ssRetrievals.length}`,
    );
    const firstSsId = ssRetrievals[0].retrieval_id;
    const ssItems = await runMemSql<{
      rank: number;
      memory_id: string;
      injected: boolean;
      status_at_recall: string;
    }>(
      args.mem,
      memHome,
      port,
      `SELECT rank, memory_id::VARCHAR AS memory_id, injected, status_at_recall FROM retrieval_items WHERE retrieval_id = '${firstSsId}' ORDER BY rank`,
    );
    assert.deepEqual(
      ssItems.map((item) => [item.memory_id, item.injected, item.status_at_recall]),
      [
        [m1Id, true, "active"],
        [m2Id, false, "active"],
      ],
    );

    const contextLinks = await runMemSql<{
      link_type: string;
      retrieval_id: string | null;
      memory_id: string | null;
    }>(
      args.mem,
      memHome,
      port,
      `SELECT link_type, retrieval_id::VARCHAR AS retrieval_id, memory_id::VARCHAR AS memory_id FROM context_links WHERE answer_event_id = '${placeholderId}' ORDER BY link_type`,
    );
    assert.deepEqual(contextLinks, [
      { link_type: "cited_memory", retrieval_id: null, memory_id: m1Id },
      { link_type: "retrieval", retrieval_id: recall1Id, memory_id: null },
    ]);

    console.log(
      "[phase-a] PASSED all Phase A live server, capture, tools, injection, command, and DuckDB checks!",
    );
  } finally {
    await server.stop();
  }
}

async function runPhaseB(args: SmokeArgs, tmpRoot: string): Promise<void> {
  if (!args.omp) {
    return;
  }
  const ompMemHome = join(tmpRoot, "phase-b-mem-home");
  const ompHome = join(tmpRoot, "phase-b-omp-home");
  const extensionsDir = join(ompHome, ".omp", "agent", "extensions");
  const ompSessionsDir = join(ompHome, ".omp", "agent", "sessions");
  const projectDir = join(tmpRoot, "phase-b-project");
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(ompSessionsDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const port = await allocateEphemeralPort();
  console.log(`[phase-b] Initializing throwaway Phase B home at ${ompMemHome} (port ${port})...`);
  const initRes = await runCommand(args.mem, [
    "--home",
    ompMemHome,
    "--port",
    String(port),
    "init",
  ]);
  assert.equal(initRes.code, 0, `mem init failed: ${initRes.stderr || initRes.stdout}`);

  const server = await startMemServer(args.mem, ompMemHome, port);
  try {
    installExtension(
      {
        dir: extensionsDir,
        mem: args.mem,
        home: ompMemHome,
        port,
        sessionStartInjection: true,
        sessionStartMaxChars: 1200,
        sessionStartMaxItems: 8,
        sessionStartTimeoutMs: 2500,
      },
      quietIO(),
    );

    const isolatedEnv = cleanEnv({
      HOME: ompHome,
      XDG_CONFIG_HOME: join(ompHome, ".config"),
      XDG_DATA_HOME: join(ompHome, ".local", "share"),
      XDG_CACHE_HOME: join(ompHome, ".cache"),
      PI_CODING_AGENT_DIR: join(ompHome, ".omp", "agent"),
      OMP_CODING_AGENT_DIR: join(ompHome, ".omp", "agent"),
    });

    console.log(
      `[phase-b] Running isolated headless ${args.omp} -p --mode json "/corvus status"...`,
    );
    const statusRun = await runCommand(
      args.omp,
      [
        "-p",
        "--mode",
        "json",
        "--cwd",
        projectDir,
        "--session-dir",
        ompSessionsDir,
        "/corvus status",
      ],
      { env: isolatedEnv, cwd: projectDir, timeoutMs: 60_000 },
    );
    assert.equal(
      statusRun.code,
      0,
      `omp /corvus status failed (${statusRun.code}): ${statusRun.stderr || statusRun.stdout}`,
    );
    assert.ok(
      statusRun.stdout.includes("corvus-command") || statusRun.stdout.includes("Ledger: reachable"),
      `Expected /corvus status output in omp JSON stream, got:\n${statusRun.stdout}`,
    );

    if (args.model) {
      console.log(`[phase-b] Running isolated headless omp model check (${args.model})...`);
      const modelRun = await runCommand(
        args.omp,
        [
          "-p",
          "--mode",
          "json",
          "--model",
          args.model,
          "--thinking",
          "off",
          "--cwd",
          projectDir,
          "--session-dir",
          ompSessionsDir,
          "Call the status tool and reply with the single word OK.",
        ],
        { env: isolatedEnv, cwd: projectDir, timeoutMs: 120_000 },
      );
      assert.equal(
        modelRun.code,
        0,
        `omp model run failed (${modelRun.code}): ${modelRun.stderr || modelRun.stdout}`,
      );

      await waitFor(
        async () => {
          const rows = await runMemSql<{ cnt: number }>(
            args.mem,
            ompMemHome,
            port,
            "SELECT count(*)::INTEGER AS cnt FROM sessions WHERE agent_id = 'oh-my-pi'",
          );
          return (rows[0]?.cnt ?? 0) >= 1;
        },
        10_000,
        "Phase B omp session capture in DuckDB",
      );
    }

    console.log("[phase-b] PASSED all Phase B live omp checks!");
  } finally {
    await server.stop();
  }
}

async function main(): Promise<void> {
  const args = parseSmokeArgs(process.argv.slice(2));
  const tmpRoot = mkdtempSync(join(tmpdir(), "corvus-smoke-"));
  try {
    await runPhaseA(args, tmpRoot);
    await runPhaseB(args, tmpRoot);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
