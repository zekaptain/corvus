import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BridgeClient, buildBridgeArgs } from "../src/extension/bridge.ts";
import { type OmpExtensionAPI, createRuntime } from "../src/extension/index.ts";
import type { OmpContext, OmpHookPayload, OmpSessionEntry } from "../src/extension/mapper.ts";
import {
  CORVUS_MEMORY_CUSTOM_TYPE,
  composeInjectedContent,
  computeBridgeMaxChars,
  formatCitationFooter,
} from "../src/extension/session-start.ts";

class BranchSessionManager {
  sessionId: string;
  entries: OmpSessionEntry[];
  branchEntries?: OmpSessionEntry[];

  constructor(
    sessionId: string,
    entries: OmpSessionEntry[] = [],
    branchEntries?: OmpSessionEntry[],
  ) {
    this.sessionId = sessionId;
    this.entries = [...entries];
    this.branchEntries = branchEntries ? [...branchEntries] : undefined;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getEntries(): OmpSessionEntry[] {
    return this.entries;
  }

  getBranch(): OmpSessionEntry[] {
    return this.branchEntries ?? this.entries;
  }

  getLeafId(): string | null {
    const active = this.getBranch();
    return active.length > 0 ? (active[active.length - 1].id ?? null) : null;
  }
}

class FakePi implements OmpExtensionAPI {
  readonly handlers = new Map<
    string,
    Array<(payload: OmpHookPayload, ctx: OmpContext) => unknown>
  >();
  readonly pi = { VERSION: "19.2.1" };

  on(event: string, handler: (payload: OmpHookPayload, ctx: OmpContext) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emitAsync(event: string, payload: OmpHookPayload, ctx: OmpContext): Promise<unknown[]> {
    const list = this.handlers.get(event) ?? [];
    const results: unknown[] = [];
    for (const fn of list) {
      results.push(await fn(payload, ctx));
    }
    return results;
  }

  emitSync(event: string, payload: OmpHookPayload, ctx: OmpContext): unknown[] {
    const list = this.handlers.get(event) ?? [];
    return list.map((fn) => fn(payload, ctx));
  }
}

function makeCtx(
  sm: BranchSessionManager | undefined,
  overrides: Partial<OmpContext> = {},
): OmpContext {
  return {
    cwd: "/tmp/corvus-workspace",
    mode: "print",
    hasUI: false,
    sessionManager: sm,
    ...overrides,
  };
}

function makeBeforeAgentStartPayload(prompt = "Hello"): OmpHookPayload & {
  prompt: string;
  systemPrompt: string[];
} {
  return {
    type: "before_agent_start",
    reason: "prompt",
    prompt,
    systemPrompt: ["segment-1", "segment-2", "segment-3", "segment-4", "segment-5"],
  } as OmpHookPayload & { prompt: string; systemPrompt: string[] };
}

interface FakeBridgeScriptOptions {
  dir: string;
  mode?:
    | "ok"
    | "empty"
    | "degraded"
    | "hang"
    | "exit1"
    | "badjson"
    | "oversized"
    | "error_response";
  delayMs?: number;
  retrievalId?: string;
  memoriesText?: string;
}

function writeFakeMem(opts: FakeBridgeScriptOptions): {
  memBin: string;
  bridgeLogPath: string;
  bridgeArgvPath: string;
  bridgeSpawnMarker: string;
} {
  const bridgeLogPath = join(opts.dir, "bridge-requests.jsonl");
  const bridgeArgvPath = join(opts.dir, "bridge-argv.json");
  const bridgeSpawnMarker = join(opts.dir, "bridge-spawned");
  const scriptPath = join(opts.dir, "fake-mem.mjs");
  const memBin = join(opts.dir, "mem");

  const mode = opts.mode ?? "ok";
  const delayMs = opts.delayMs ?? 0;
  const retrievalId = opts.retrievalId ?? "11111111-2222-4333-8444-555555555555";
  const memoriesText =
    opts.memoriesText ??
    [
      "# Active memories",
      "- [mem-aaa-111] (corvus/decision) Always keep capture hooks strictly synchronous",
      "- [mem-bbb-222] (global/preference) Prefer concise NDJSON bridge envelopes",
    ].join("\n");

  const script = `
import { appendFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("records")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (args.includes("bridge")) {
  writeFileSync(${JSON.stringify(bridgeSpawnMarker)}, "1\\n");
  writeFileSync(${JSON.stringify(bridgeArgvPath)}, JSON.stringify(args) + "\\n");

  const mode = ${JSON.stringify(mode)};
  const delayMs = ${JSON.stringify(delayMs)};
  const retrievalId = ${JSON.stringify(retrievalId)};
  const memoriesText = ${JSON.stringify(memoriesText)};

  if (mode === "exit1") {
    process.stderr.write("bridge fatal startup error\\n");
    process.exit(1);
  }
  if (mode === "badjson") {
    process.stdout.write("{not-valid-json\\n");
    await new Promise((r) => setTimeout(r, 50));
    process.exit(0);
  }
  if (mode === "hang") {
    await new Promise((r) => setTimeout(r, 15000));
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    appendFileSync(${JSON.stringify(bridgeLogPath)}, trimmed + "\\n");
    const req = JSON.parse(trimmed);
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (mode === "error_response") {
      process.stdout.write(JSON.stringify({
        id: req.id,
        ok: false,
        error: { code: "internal_error", message: "boom" },
      }) + "\\n");
      continue;
    }
    if (mode === "degraded") {
      process.stdout.write(JSON.stringify({
        id: req.id,
        ok: true,
        result: {
          degraded: true,
          reason: "Quack server unreachable",
          retrieval_id: null,
          request_event_id: null,
          strategy: "session_start_v1",
          text: "",
          items: [],
          shown_count: 0,
          not_shown_count: 0,
          char_count: 0,
          max_chars: req.args?.max_chars ?? 2400,
        },
      }) + "\\n");
      continue;
    }
    if (mode === "empty") {
      process.stdout.write(JSON.stringify({
        id: req.id,
        ok: true,
        result: {
          degraded: false,
          retrieval_id: retrievalId,
          request_event_id: "evt-empty-1",
          strategy: "session_start_v1",
          text: "",
          items: [],
          shown_count: 0,
          not_shown_count: 0,
          char_count: 0,
          max_chars: req.args?.max_chars ?? 2400,
        },
      }) + "\\n");
      continue;
    }
    if (mode === "oversized") {
      const longLines = [
        "# Active memories",
        "- [mem-1] (corvus/fact) " + "A".repeat(80),
        "- [mem-2] (corvus/fact) " + "B".repeat(80),
        "- [mem-3] (corvus/fact) " + "C".repeat(80),
        "- [mem-4] (corvus/fact) " + "D".repeat(80),
      ].join("\\n");
      process.stdout.write(JSON.stringify({
        id: req.id,
        ok: true,
        result: {
          degraded: false,
          retrieval_id: retrievalId,
          strategy: "session_start_v1",
          text: longLines,
          items: [{ memory_id: "mem-1" }, { memory_id: "mem-2" }],
          shown_count: 4,
          not_shown_count: 0,
          char_count: longLines.length,
          max_chars: req.args?.max_chars ?? 2400,
        },
      }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({
      id: req.id,
      ok: true,
      result: {
        degraded: false,
        retrieval_id: retrievalId,
        request_event_id: "evt-1",
        strategy: "session_start_v1",
        text: memoriesText,
        items: [
          { memory_id: "mem-aaa-111", scope: "corvus", type: "decision" },
          { memory_id: "mem-bbb-222", scope: "global", type: "preference" },
        ],
        shown_count: 2,
        not_shown_count: 0,
        char_count: memoriesText.length,
        max_chars: req.args?.max_chars ?? 2400,
      },
    }) + "\\n");
  }
}
`;

  writeFileSync(scriptPath, script, "utf8");
  writeFileSync(
    memBin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
  );
  chmodSync(memBin, 0o755);

  return { memBin, bridgeLogPath, bridgeArgvPath, bridgeSpawnMarker };
}

describe("BridgeClient — NDJSON stdio client", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "corvus-bridge-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds mem bridge arguments cleanly", () => {
    assert.deepEqual(buildBridgeArgs({ mem: "/bin/mem" }), ["bridge", "--agent", "oh-my-pi"]);
    assert.deepEqual(
      buildBridgeArgs({ mem: "/bin/mem", home: "/tmp/h", port: 9555, agent: "oh-my-pi" }),
      ["--home", "/tmp/h", "--port", "9555", "bridge", "--agent", "oh-my-pi"],
    );
  });

  it("kills wedged child on timeout, warns once, and respawns cleanly on next call", async () => {
    const controlPath = join(tmpDir, "mode.txt");
    writeFileSync(controlPath, "hang");
    const scriptPath = join(tmpDir, "switchable-mem.mjs");
    const memBin = join(tmpDir, "mem");
    writeFileSync(
      scriptPath,
      `
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
const mode = readFileSync(${JSON.stringify(controlPath)}, "utf8").trim();
if (mode === "hang") {
  await new Promise((r) => setTimeout(r, 10000));
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const req = JSON.parse(line.trim());
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { pong: req.id } }) + "\\n");
  }
}
`,
    );
    writeFileSync(
      memBin,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
    );
    chmodSync(memBin, 0o755);

    const warnings: string[] = [];
    const client = new BridgeClient({ mem: memBin, defaultTimeoutMs: 80 }, (msg) =>
      warnings.push(msg),
    );

    const t0 = Date.now();
    const res1 = await client.call("status", { harnessSessionId: "sid-1", cwd: "/tmp/repo" });
    const elapsed = Date.now() - t0;
    assert.equal(res1.ok, false);
    if (!res1.ok) {
      assert.equal(res1.error.code, "timeout");
    }
    assert.ok(elapsed < 1000, `expected timeout promptly, took ${elapsed}ms`);
    assert.equal(warnings.length, 1);
    assert.equal(client.isHealthy(), false);
    assert.equal(client.statusSnapshot().running, false);

    // Next call respawns a fresh child cleanly once server recovers
    writeFileSync(controlPath, "ok");
    const res2 = await client.call<{ pong: string }>(
      "status",
      { harnessSessionId: "sid-1", cwd: "/tmp/repo" },
      {},
      { timeoutMs: 1000 },
    );
    assert.equal(res2.ok, true);
    if (res2.ok) {
      assert.equal(res2.result.pong, "2");
    }
    assert.equal(client.isHealthy(), true);
    assert.equal(warnings.length, 1);

    client.close();
    assert.equal(client.statusSnapshot().closed, true);
    const resAfterClose = await client.call("status", { harnessSessionId: "sid-1" });
    assert.equal(resAfterClose.ok, false);
    if (!resAfterClose.ok) {
      assert.equal(resAfterClose.error.code, "closed");
    }
  });

  it("supports AbortSignal pre-aborted and mid-flight without spawning or leaking", async () => {
    const { memBin, bridgeSpawnMarker } = writeFakeMem({ dir: tmpDir, mode: "hang" });
    const client = new BridgeClient({ mem: memBin, defaultTimeoutMs: 5000 }, () => undefined);

    const preAborted = new AbortController();
    preAborted.abort();
    const res1 = await client.call(
      "session_context",
      { harnessSessionId: "sid-abort" },
      {},
      { signal: preAborted.signal },
    );
    assert.equal(res1.ok, false);
    if (!res1.ok) assert.equal(res1.error.code, "aborted");
    assert.equal(existsSync(bridgeSpawnMarker), false);

    const midController = new AbortController();
    setTimeout(() => midController.abort(), 30);
    const res2 = await client.call(
      "session_context",
      { harnessSessionId: "sid-abort" },
      {},
      { signal: midController.signal, timeoutMs: 5000 },
    );
    assert.equal(res2.ok, false);
    if (!res2.ok) assert.equal(res2.error.code, "aborted");
    client.close();
  });

  it("unrefs child and streams so an idle bridge never blocks process exit", () => {
    const { memBin } = writeFakeMem({ dir: tmpDir, mode: "ok" });
    const bridgePath = resolve(import.meta.dir, "../src/extension/bridge.ts");
    const runner = join(tmpDir, "unref-bridge.ts");
    writeFileSync(
      runner,
      `import { BridgeClient } from ${JSON.stringify(bridgePath)};
const client = new BridgeClient({ mem: ${JSON.stringify(memBin)} }, () => {});
const res = await client.call("session_context", { harnessSessionId: "sid-unref", cwd: "/tmp/p" });
if (!res.ok) process.exit(2);
// Intentionally do not call client.close(); process must still exit promptly.
`,
    );

    const t0 = Date.now();
    const proc = Bun.spawnSync([process.execPath, runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const elapsed = Date.now() - t0;
    assert.equal(proc.exitCode, 0, proc.stderr.toString());
    assert.ok(elapsed < 2000, `expected prompt exit with unref'd bridge, took ${elapsed}ms`);
  });
});

describe("Session-start injection via before_agent_start (MEM-39)", () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "corvus-inject-test-"));
    savedEnv = process.env.CORVUS_SESSION_START_INJECTION;
    Reflect.deleteProperty(process.env, "CORVUS_SESSION_START_INJECTION");
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      Reflect.deleteProperty(process.env, "CORVUS_SESSION_START_INJECTION");
    } else {
      process.env.CORVUS_SESSION_START_INJECTION = savedEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is off by default and never spawns mem bridge when disabled", async () => {
    const { memBin, bridgeSpawnMarker } = writeFakeMem({ dir: tmpDir, mode: "ok" });
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ mem: memBin }));

    const runtime = createRuntime({ configPath: cfgPath, report: () => undefined });
    const pi = new FakePi();
    runtime.attach(pi);

    const sm = new BranchSessionManager("sid-default-off");
    const payload = makeBeforeAgentStartPayload();
    const originalSysPrompt = [...payload.systemPrompt];
    const results = await pi.emitAsync("before_agent_start", payload, makeCtx(sm));

    assert.deepEqual(results, [undefined]);
    assert.deepEqual(payload.systemPrompt, originalSysPrompt);
    assert.equal(existsSync(bridgeSpawnMarker), false);
    runtime.closeNow();
  });

  it("supports CORVUS_SESSION_START_INJECTION=1/true and 0/false env overrides over config.json", async () => {
    const { memBin, bridgeSpawnMarker } = writeFakeMem({ dir: tmpDir, mode: "ok" });
    const cfgDisabled = join(tmpDir, "cfg-disabled.json");
    writeFileSync(cfgDisabled, JSON.stringify({ mem: memBin, sessionStartInjection: false }));

    process.env.CORVUS_SESSION_START_INJECTION = "true";
    const rt1 = createRuntime({ configPath: cfgDisabled, report: () => undefined });
    const pi1 = new FakePi();
    rt1.attach(pi1);
    const res1 = await pi1.emitAsync(
      "before_agent_start",
      makeBeforeAgentStartPayload(),
      makeCtx(new BranchSessionManager("sid-env-on")),
    );
    assert.ok(res1[0] && typeof res1[0] === "object");
    rt1.closeNow();

    // Now config has true, but env "0" disables without spawning bridge
    const dir2 = mkdtempSync(join(tmpdir(), "corvus-inject-envoff-"));
    try {
      const mem2 = writeFakeMem({ dir: dir2, mode: "ok" });
      const cfgEnabled = join(dir2, "cfg-enabled.json");
      writeFileSync(cfgEnabled, JSON.stringify({ mem: mem2.memBin, sessionStartInjection: true }));
      process.env.CORVUS_SESSION_START_INJECTION = "0";
      const rt2 = createRuntime({ configPath: cfgEnabled, report: () => undefined });
      const pi2 = new FakePi();
      rt2.attach(pi2);
      const res2 = await pi2.emitAsync(
        "before_agent_start",
        makeBeforeAgentStartPayload(),
        makeCtx(new BranchSessionManager("sid-env-off")),
      );
      assert.deepEqual(res2, [undefined]);
      assert.equal(existsSync(mem2.bridgeSpawnMarker), false);
      rt2.closeNow();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
    assert.equal(existsSync(bridgeSpawnMarker), true);
  });

  it("injects once on turn 1 with retrieval_id and memory_ids, preserves systemPrompt, and skips turn 2", async () => {
    const retrievalId = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const { memBin, bridgeLogPath, bridgeArgvPath } = writeFakeMem({
      dir: tmpDir,
      mode: "ok",
      retrievalId,
    });
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mem: memBin,
        home: join(tmpDir, "home"),
        port: 9555,
        sessionStartInjection: true,
        sessionStartMaxChars: 2400,
        sessionStartMaxItems: 10,
        sessionStartTimeoutMs: 1200,
      }),
    );

    const warnings: string[] = [];
    const runtime = createRuntime({ configPath: cfgPath, report: (m) => warnings.push(m) });
    const pi = new FakePi();
    runtime.attach(pi);

    const sm = new BranchSessionManager("01a21959-5fc8-7591-89c4-66c0a6c50461");
    const ctx = makeCtx(sm, { cwd: "/tmp/my-repo" });
    const payload1 = makeBeforeAgentStartPayload("First prompt");
    const originalSys = [...payload1.systemPrompt];

    // Turn 1
    const res1 = await pi.emitAsync("before_agent_start", payload1, ctx);
    assert.equal(res1.length, 1);
    const injection = res1[0] as {
      message: {
        customType: string;
        content: string;
        display: boolean;
        attribution: string;
      };
      systemPrompt?: unknown;
    };
    assert.equal(injection.systemPrompt, undefined);
    assert.deepEqual(payload1.systemPrompt, originalSys);
    assert.equal(injection.message.customType, CORVUS_MEMORY_CUSTOM_TYPE);
    assert.equal(injection.message.display, false);
    assert.equal(injection.message.attribution, "agent");
    assert.ok(injection.message.content.length <= 2400);
    assert.match(injection.message.content, /mem-aaa-111/);
    assert.match(injection.message.content, /mem-bbb-222/);
    assert.match(injection.message.content, new RegExp(retrievalId));

    // Verify bridge CLI args and envelope
    const argv = JSON.parse(readFileSync(bridgeArgvPath, "utf8")) as string[];
    assert.deepEqual(argv, [
      "--home",
      join(tmpDir, "home"),
      "--port",
      "9555",
      "bridge",
      "--agent",
      "oh-my-pi",
    ]);
    const logged = readFileSync(bridgeLogPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].op, "session_context");
    assert.equal(logged[0].harness_session_id, "01a21959-5fc8-7591-89c4-66c0a6c50461");
    assert.equal(logged[0].cwd, "/tmp/my-repo");
    assert.deepEqual(logged[0].args, {
      max_chars: computeBridgeMaxChars(2400),
      max_items: 10,
    });

    // Turn 2 in same session: returns undefined without calling mem bridge again
    const res2 = await pi.emitAsync(
      "before_agent_start",
      makeBeforeAgentStartPayload("Second"),
      ctx,
    );
    assert.deepEqual(res2, [undefined]);
    const loggedAfter = readFileSync(bridgeLogPath, "utf8").trim().split("\n");
    assert.equal(loggedAfter.length, 1);
    assert.deepEqual(warnings, []);

    pi.emitSync("session_shutdown", {}, ctx);
    runtime.closeNow();
  });

  it("always enforces configuredMaxChars even when bridge returns oversized text", async () => {
    const retrievalId = "11111111-2222-4333-8444-555555555555";
    const { memBin } = writeFakeMem({ dir: tmpDir, mode: "oversized", retrievalId });
    const maxChars = 220;
    const runtime = createRuntime({
      config: {
        mem: memBin,
        sessionStartInjection: true,
        sessionStartMaxChars: maxChars,
        sessionStartMaxItems: 12,
        sessionStartTimeoutMs: 1500,
      },
      report: () => undefined,
    });
    const pi = new FakePi();
    runtime.attach(pi);

    const res = await pi.emitAsync(
      "before_agent_start",
      makeBeforeAgentStartPayload(),
      makeCtx(new BranchSessionManager("sid-budget")),
    );
    const injection = res[0] as { message: { content: string } };
    assert.ok(injection.message.content.length <= maxChars);
    assert.match(injection.message.content, /mem-1/);
    assert.match(injection.message.content, new RegExp(retrievalId));

    // Tiny budget where footer itself cannot fit with any line still stays <= maxChars
    const tiny = composeInjectedContent(
      "# Active memories\n- [mem-1] (global/fact) Hello world",
      retrievalId,
      45,
    );
    assert.ok(tiny !== null && tiny.length <= 45);
    const exactBlock = "# Active memories\n- [mem-1] (global/fact) Short";
    assert.equal(
      composeInjectedContent(
        exactBlock,
        retrievalId,
        exactBlock.length + formatCitationFooter(retrievalId).length,
      )?.includes(retrievalId),
      true,
    );
    runtime.closeNow();
  });

  it("handles resume, fork, branch, and post-compaction lifecycle rules per MEM-41", async () => {
    const { memBin, bridgeLogPath } = writeFakeMem({ dir: tmpDir, mode: "ok" });

    // 1. Resumed session (fresh extension instance, custom_message already on branch) -> skips
    const rtResume = createRuntime({
      config: { mem: memBin, sessionStartInjection: true },
      report: () => undefined,
    });
    const piResume = new FakePi();
    rtResume.attach(piResume);
    const resumeSm = new BranchSessionManager("sid-resumed", [
      { type: "message", id: "u1", message: { role: "user", content: "earlier" } },
      { type: "custom_message", id: "m1", customType: CORVUS_MEMORY_CUSTOM_TYPE },
    ]);
    assert.deepEqual(
      await piResume.emitAsync(
        "before_agent_start",
        makeBeforeAgentStartPayload(),
        makeCtx(resumeSm),
      ),
      [undefined],
    );
    assert.equal(existsSync(bridgeLogPath), false);
    rtResume.closeNow();

    // 2. Forked session (new sessionId, copied custom_message in branch) -> skips
    const rtFork = createRuntime({
      config: { mem: memBin, sessionStartInjection: true },
      report: () => undefined,
    });
    const piFork = new FakePi();
    rtFork.attach(piFork);
    const forkSm = new BranchSessionManager("sid-forked-new", [
      { type: "message", id: "u1", message: { role: "user", content: "earlier" } },
      { type: "custom_message", id: "m1", customType: CORVUS_MEMORY_CUSTOM_TYPE },
    ]);
    assert.deepEqual(
      await piFork.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), makeCtx(forkSm)),
      [undefined],
    );
    assert.equal(existsSync(bridgeLogPath), false);
    rtFork.closeNow();

    // 3. Branched session (branched before custom_message: absent from getBranch(), even if in getEntries()) -> injects
    const rtBranch = createRuntime({
      config: { mem: memBin, sessionStartInjection: true },
      report: () => undefined,
    });
    const piBranch = new FakePi();
    rtBranch.attach(piBranch);
    const branchSm = new BranchSessionManager(
      "sid-branched",
      [
        { type: "message", id: "u1", message: { role: "user", content: "root" } },
        { type: "custom_message", id: "m-other-branch", customType: CORVUS_MEMORY_CUSTOM_TYPE },
      ],
      [{ type: "message", id: "u1", message: { role: "user", content: "root" } }],
    );
    const branchRes = await piBranch.emitAsync(
      "before_agent_start",
      makeBeforeAgentStartPayload(),
      makeCtx(branchSm),
    );
    assert.ok(branchRes[0] && typeof branchRes[0] === "object");

    // 4. Post-compaction prompt: compaction entry after earlier custom_message -> injects once for new epoch, skips turn 2
    const compSm = new BranchSessionManager("sid-compacted", [
      { type: "message", id: "u1", message: { role: "user", content: "turn 1" } },
      { type: "custom_message", id: "m1", customType: CORVUS_MEMORY_CUSTOM_TYPE },
      { type: "compaction", id: "comp-epoch-1" },
    ]);
    const compRes1 = await piBranch.emitAsync(
      "before_agent_start",
      makeBeforeAgentStartPayload("after compact 1"),
      makeCtx(compSm),
    );
    assert.ok(compRes1[0] && typeof compRes1[0] === "object");
    const compRes2 = await piBranch.emitAsync(
      "before_agent_start",
      makeBeforeAgentStartPayload("after compact 2"),
      makeCtx(compSm),
    );
    assert.deepEqual(compRes2, [undefined]);

    const calls = readFileSync(bridgeLogPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { harness_session_id: string }).harness_session_id);
    assert.deepEqual(calls, ["sid-branched", "sid-compacted"]);
    rtBranch.closeNow();
  });

  it("records retrieval on empty memories (text: '') and skips turn 2 without warning", async () => {
    const { memBin, bridgeLogPath } = writeFakeMem({ dir: tmpDir, mode: "empty" });
    const warnings: string[] = [];
    const runtime = createRuntime({
      config: { mem: memBin, sessionStartInjection: true },
      report: (m) => warnings.push(m),
    });
    const pi = new FakePi();
    runtime.attach(pi);

    const sm = new BranchSessionManager("sid-empty-memories");
    const ctx = makeCtx(sm);
    assert.deepEqual(await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), ctx), [
      undefined,
    ]);
    assert.deepEqual(await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), ctx), [
      undefined,
    ]);

    const calls = readFileSync(bridgeLogPath, "utf8").trim().split("\n");
    assert.equal(calls.length, 1);
    assert.deepEqual(warnings, []);
    runtime.closeNow();
  });

  it("fails open and warns at most once on hung, dead, missing, malformed, or degraded bridge", async () => {
    // 1. Hung bridge > sessionStartTimeoutMs
    const dirHung = mkdtempSync(join(tmpdir(), "corvus-hung-"));
    try {
      const { memBin } = writeFakeMem({ dir: dirHung, mode: "hang" });
      const notified: Array<{ msg: string; level?: string }> = [];
      const runtime = createRuntime({
        config: {
          mem: memBin,
          sessionStartInjection: true,
          sessionStartTimeoutMs: 100,
        },
      });
      const pi = new FakePi();
      runtime.attach(pi);
      const sm = new BranchSessionManager("sid-hung");
      const ctx = makeCtx(sm, {
        hasUI: true,
        ui: {
          notify: (msg, level) => notified.push({ msg, level }),
        },
      });

      const t0 = Date.now();
      const res1 = await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), ctx);
      const elapsed = Date.now() - t0;
      assert.deepEqual(res1, [undefined]);
      assert.ok(elapsed < 1000, `hung bridge should fail open promptly, took ${elapsed}ms`);
      assert.equal(notified.length, 1);
      assert.equal(notified[0].level, "warning");
      assert.match(notified[0].msg, /timed out/);

      // Turn 2 must not stall or warn again
      const t1 = Date.now();
      const res2 = await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), ctx);
      assert.deepEqual(res2, [undefined]);
      assert.ok(Date.now() - t1 < 50);
      assert.equal(notified.length, 1);
      runtime.closeNow();
    } finally {
      rmSync(dirHung, { recursive: true, force: true });
    }

    // 2. Dead bridge, missing binary, malformed JSON, degraded response
    for (const scenario of ["exit1", "missing", "badjson", "degraded", "error_response"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `corvus-fail-${scenario}-`));
      try {
        const memBin =
          scenario === "missing"
            ? join(dir, "nonexistent-mem")
            : writeFakeMem({ dir, mode: scenario }).memBin;
        const warnings: string[] = [];
        const runtime = createRuntime({
          config: {
            mem: memBin,
            sessionStartInjection: true,
            sessionStartTimeoutMs: 500,
          },
          report: (m) => warnings.push(m),
        });
        const pi = new FakePi();
        runtime.attach(pi);
        const sm = new BranchSessionManager(`sid-${scenario}`);
        const ctx = makeCtx(sm);

        assert.deepEqual(
          await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), ctx),
          [undefined],
        );
        assert.deepEqual(
          await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), ctx),
          [undefined],
        );
        assert.equal(warnings.length, 1, `expected 1 warning for ${scenario}`);
        runtime.closeNow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("tolerates missing sessionManager / sessionId during utility commands without spawning", async () => {
    const { memBin, bridgeSpawnMarker } = writeFakeMem({ dir: tmpDir, mode: "ok" });
    const runtime = createRuntime({
      config: { mem: memBin, sessionStartInjection: true },
      report: () => undefined,
    });
    const pi = new FakePi();
    runtime.attach(pi);

    assert.deepEqual(
      await pi.emitAsync("before_agent_start", makeBeforeAgentStartPayload(), makeCtx(undefined)),
      [undefined],
    );
    assert.deepEqual(
      await pi.emitAsync(
        "before_agent_start",
        makeBeforeAgentStartPayload(),
        makeCtx(new BranchSessionManager("")),
      ),
      [undefined],
    );
    assert.equal(existsSync(bridgeSpawnMarker), false);
    runtime.closeNow();
  });
});
