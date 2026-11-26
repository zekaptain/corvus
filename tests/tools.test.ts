import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import corvusExtension, { type OmpExtensionAPI, createRuntime } from "../src/extension/index.ts";
import type { OmpContext, OmpHookPayload } from "../src/extension/mapper.ts";
import type { OmpToolDefinition } from "../src/extension/tools.ts";

class FakeSessionManager {
  sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string {
    return `/tmp/sessions/${this.sessionId}.jsonl`;
  }

  getEntries() {
    return [];
  }

  getLeafId() {
    return null;
  }
}

class FakeToolPi implements OmpExtensionAPI {
  readonly handlers = new Map<
    string,
    Array<(payload: OmpHookPayload, ctx: OmpContext) => unknown>
  >();
  readonly tools = new Map<string, OmpToolDefinition>();
  readonly pi = { VERSION: "19.2.1" };
  actionMethodCalls: string[] = [];

  on(event: string, handler: (payload: OmpHookPayload, ctx: OmpContext) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerTool(definition: OmpToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  getAllTools(): unknown[] {
    this.actionMethodCalls.push("getAllTools");
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading",
    );
  }

  getActiveTools(): unknown[] {
    this.actionMethodCalls.push("getActiveTools");
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading",
    );
  }

  emit(event: string, payload: OmpHookPayload, ctx: OmpContext): unknown[] {
    const list = this.handlers.get(event) ?? [];
    return list.map((fn) => fn(payload, ctx));
  }
}

function mustTool(pi: FakeToolPi, name: string): OmpToolDefinition {
  const tool = pi.tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function writeFakeBridgeMem(dir: string, handlerBody: string): string {
  const scriptTs = join(dir, "mem-bridge-handler.ts");
  const wrapper = join(dir, "mem");
  writeFileSync(
    scriptTs,
    `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      const req = JSON.parse(line);
      handleReq(req);
    }
    idx = buf.indexOf("\\n");
  }
});

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function handleReq(req: { id: string | number; op: string; harness_session_id: string; cwd: string | null; project: string | null; args: Record<string, unknown> }) {
  ${handlerBody}
}
`,
  );
  writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$1" = "records" ] || [ "$3" = "records" ] || [ "$5" = "records" ]; then
  exec cat > /dev/null
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptTs)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("Native omp memory tools (MEM-40)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "corvus-tools-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers all 5 tools with plain JSON Schemas, excludes approve from review schema, and touches no action methods at load time", () => {
    const pi = new FakeToolPi();
    // Should tolerate missing config.json and must not call pi.getAllTools() or spawn mem on load.
    corvusExtension(pi);
    assert.deepEqual(pi.actionMethodCalls, []);
    assert.deepEqual([...pi.tools.keys()], ["recall", "remember", "cite", "review", "status"]);

    const recall = mustTool(pi, "recall");
    assert.equal(recall.parameters.type, "object");
    assert.deepEqual(recall.parameters.required, ["query"]);

    const remember = mustTool(pi, "remember");
    assert.deepEqual(remember.parameters.required, ["content", "type"]);

    const review = mustTool(pi, "review");
    assert.deepEqual(review.parameters.required, ["action", "memory_id", "reason"]);
    const props = review.parameters.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.action.enum, ["retire", "quarantine", "confirm", "flag_contradiction"]);
    assert.equal((props.action.enum as string[]).includes("approve"), false);
  });

  it("applies parameter defaults, forwards active sessionId/cwd across switches, and returns attribution-ready JSON envelopes", async () => {
    const requestsLog = join(tempDir, "bridge-requests.jsonl");
    const fakeMem = writeFakeBridgeMem(
      tempDir,
      `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(requestsLog)}, JSON.stringify(req) + "\\n");
      if (req.op === "recall") {
        send({
          id: req.id,
          ok: true,
          result: {
            degraded: false,
            retrieval_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            request_event_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            strategy: "text_match",
            candidates: 1,
            items: [{ memory_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", content: "Use Bun" }],
          },
        });
        return;
      }
      if (req.op === "cite") {
        send({
          id: req.id,
          ok: true,
          result: {
            degraded: false,
            answer_event_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
            links: 2,
          },
        });
        return;
      }
      if (req.op === "remember") {
        send({
          id: req.id,
          ok: true,
          result: {
            memory_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
            deduplicated: false,
            queued: false,
            status: "active",
          },
        });
        return;
      }
      if (req.op === "review") {
        send({
          id: req.id,
          ok: true,
          result: {
            memory_id: req.args.memory_id,
            action: req.args.action,
            queued: false,
            status: "retired",
          },
        });
        return;
      }
      send({
        id: req.id,
        ok: true,
        result: {
          reachable: true,
          agent_id: "oh-my-pi",
          harness_session_id: req.harness_session_id,
          project: req.project,
        },
      });
      `,
    );

    const cfgPath = join(tempDir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({ mem: fakeMem, home: "/tmp/h", port: 9555, toolTimeoutMs: 5000 }),
    );

    const warnings: string[] = [];
    const runtime = createRuntime({
      configPath: cfgPath,
      report: (msg) => warnings.push(msg),
    });
    const pi = new FakeToolPi();
    runtime.attach(pi);

    const sm = new FakeSessionManager("01a21959-5fc8-7591-89c4-66c0a6c50461");
    // Include a bogus ctx.sessionId to prove ctx.sessionManager.getSessionId() is always used.
    const ctx1 = {
      cwd: "/tmp/repos/corvus",
      mode: "print",
      hasUI: false,
      sessionId: "wrong-direct-prop",
      sessionManager: sm,
    } as unknown as OmpContext;

    // 1. recall without limit -> defaults to 8; test clamping on out-of-range limits.
    const recallRes = await mustTool(pi, "recall").execute(
      "tc-1",
      { query: "bun runtime" },
      undefined,
      undefined,
      ctx1,
    );
    assert.equal(recallRes.isError, false);
    const recallParsed = JSON.parse(recallRes.content[0].text) as Record<string, unknown>;
    assert.equal(recallParsed.retrieval_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert.deepEqual(recallRes.details, recallParsed);

    await mustTool(pi, "recall").execute(
      "tc-1b",
      { query: "clamp high", limit: 999 },
      undefined,
      undefined,
      ctx1,
    );
    await mustTool(pi, "recall").execute(
      "tc-1c",
      { query: "clamp low", limit: -3 },
      undefined,
      undefined,
      ctx1,
    );

    // 2. remember without confidence/importance/trust_level -> applies defaults 0.7 / 0.5 / "agent".
    const rememberRes = await mustTool(pi, "remember").execute(
      "tc-2",
      { content: "corvus uses plain JSON schema", type: "fact" },
      undefined,
      undefined,
      ctx1,
    );
    assert.equal(rememberRes.isError, false);
    assert.equal(
      (rememberRes.details as Record<string, unknown>).memory_id,
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    );

    // 3. Switch session & cwd on the same runtime -> forwards updated sessionId & cwd.
    sm.sessionId = "02b32060-6fd9-8602-90d5-77d1b7d61572";
    const ctx2: OmpContext = {
      cwd: "/tmp/repos/agent-memory",
      mode: "print",
      hasUI: false,
      sessionManager: sm,
    };

    const citeRes = await mustTool(pi, "cite").execute(
      "tc-3",
      {
        retrieval_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        memory_ids: ["cccccccc-cccc-cccc-cccc-cccccccccccc"],
      },
      undefined,
      undefined,
      ctx2,
    );
    assert.equal(citeRes.isError, false);
    const citeParsed = JSON.parse(citeRes.content[0].text) as Record<string, unknown>;
    assert.equal(citeParsed.answer_event_id, "dddddddd-dddd-dddd-dddd-dddddddddddd");

    const reviewRes = await mustTool(pi, "review").execute(
      "tc-4",
      {
        action: "retire",
        memory_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        reason: "superseded",
      },
      undefined,
      undefined,
      ctx2,
    );
    assert.equal(reviewRes.isError, false);

    const statusRes = await mustTool(pi, "status").execute("tc-5", {}, undefined, undefined, ctx2);
    assert.equal(statusRes.isError, false);
    assert.equal(
      (statusRes.details as Record<string, unknown>).harness_session_id,
      "02b32060-6fd9-8602-90d5-77d1b7d61572",
    );

    const sent = readFileSync(requestsLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(sent.length, 7);

    assert.equal(sent[0].harness_session_id, "01a21959-5fc8-7591-89c4-66c0a6c50461");
    assert.equal(sent[0].cwd, "/tmp/repos/corvus");
    assert.equal(sent[0].project, "corvus");
    assert.deepEqual(sent[0].args, { query: "bun runtime", limit: 8 });

    assert.deepEqual(sent[1].args, { query: "clamp high", limit: 50 });
    assert.deepEqual(sent[2].args, { query: "clamp low", limit: 1 });

    assert.deepEqual(sent[3].args, {
      content: "corvus uses plain JSON schema",
      type: "fact",
      confidence: 0.7,
      importance: 0.5,
      trust_level: "agent",
    });

    assert.equal(sent[4].harness_session_id, "02b32060-6fd9-8602-90d5-77d1b7d61572");
    assert.equal(sent[4].cwd, "/tmp/repos/agent-memory");
    assert.equal(sent[4].project, "agent-memory");
    assert.deepEqual(sent[4].args, {
      retrieval_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      memory_ids: ["cccccccc-cccc-cccc-cccc-cccccccccccc"],
    });

    assert.deepEqual(sent[5].args, {
      action: "retire",
      memory_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      reason: "superseded",
    });
    assert.deepEqual(sent[6].args, {});

    assert.deepEqual(warnings, []);
    // session_shutdown closes the bridge synchronously.
    pi.emit("session_shutdown", {}, ctx2);
    assert.equal(runtime.bridge?.statusSnapshot().running, false);
    runtime.closeNow();
  });

  it("refuses review(action='approve') immediately before invoking or spawning mem bridge", async () => {
    const spawnFlag = join(tempDir, "bridge-spawned");
    const fakeMem = writeFakeBridgeMem(
      tempDir,
      `require("node:fs").writeFileSync(${JSON.stringify(spawnFlag)}, "yes");`,
    );

    const runtime = createRuntime({
      config: { mem: fakeMem },
      report: () => {},
    });
    const pi = new FakeToolPi();
    runtime.attach(pi);

    const ctx: OmpContext = {
      cwd: "/tmp/proj",
      sessionManager: new FakeSessionManager("sid-no-approve"),
    };
    const res = await mustTool(pi, "review").execute(
      "tc-approve",
      {
        action: "approve",
        memory_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        reason: "self-approve attempt",
      },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(res.isError, true);
    const parsed = JSON.parse(res.content[0].text) as { error: string; message: string };
    assert.equal(parsed.error, "validation_error");
    assert.match(parsed.message, /cannot approve/);
    assert.equal(runtime.bridge?.statusSnapshot().running, false);
    assert.equal(runtime.bridge?.statusSnapshot().totalCalls, 0);
    runtime.closeNow();
  });

  it("handles bridge-level degraded/queued responses and bridge validation errors properly", async () => {
    const fakeMem = writeFakeBridgeMem(
      tempDir,
      `
      if (req.op === "recall") {
        send({ id: req.id, ok: true, result: { degraded: true, reason: "server down", retrieval_id: null, items: [] } });
        return;
      }
      if (req.op === "remember") {
        if (req.args.content === "bad") {
          send({ id: req.id, ok: false, error: { code: "validation_error", message: "invalid content" } });
          return;
        }
        send({ id: req.id, ok: true, result: { queued: true, memory_id: "m-queued", deduplicated: false, reason: "spooled" } });
        return;
      }
      if (req.op === "review") {
        send({ id: req.id, ok: true, result: { queued: true, memory_id: req.args.memory_id, action: req.args.action, reason: "spooled" } });
        return;
      }
      if (req.op === "cite") {
        send({ id: req.id, ok: true, result: { degraded: true, reason: "server down", links: 0 } });
        return;
      }
      send({ id: req.id, ok: true, result: { reachable: false, reason: "server down", harness_session_id: req.harness_session_id } });
      `,
    );

    const runtime = createRuntime({ config: { mem: fakeMem } });
    const pi = new FakeToolPi();
    runtime.attach(pi);
    const ctx: OmpContext = { cwd: "/tmp/p", sessionManager: new FakeSessionManager("sid-deg") };

    const recallDeg = await mustTool(pi, "recall").execute(
      "1",
      { query: "q" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(recallDeg.isError, false);
    assert.equal(recallDeg.details?.degraded, true);

    const citeDeg = await mustTool(pi, "cite").execute(
      "2",
      { retrieval_id: "r1" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(citeDeg.isError, false);
    assert.equal(citeDeg.details?.degraded, true);

    const statusDeg = await mustTool(pi, "status").execute("3", {}, undefined, undefined, ctx);
    assert.equal(statusDeg.isError, false);
    assert.equal(statusDeg.details?.reachable, false);

    // Spooled remember/review from mem bridge return isError: false.
    const remQueued = await mustTool(pi, "remember").execute(
      "4",
      { content: "save offline", type: "fact" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(remQueued.isError, false);
    assert.equal(remQueued.details?.queued, true);

    const revQueued = await mustTool(pi, "review").execute(
      "5",
      { action: "retire", memory_id: "m1", reason: "old" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(revQueued.isError, false);
    assert.equal(revQueued.details?.queued, true);

    // Bridge validation_error returns isError: true.
    const remBad = await mustTool(pi, "remember").execute(
      "6",
      { content: "bad", type: "fact" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(remBad.isError, true);
    assert.equal(remBad.details?.error, "validation_error");

    runtime.closeNow();
  });

  it("degrades cleanly on missing mem binary, notifies UI once, and returns appropriate isError flags", async () => {
    const uiNotices: Array<{ msg: string; level?: string }> = [];
    const runtime = createRuntime({
      config: { mem: "/nonexistent/corvus-missing-mem" },
    });
    const pi = new FakeToolPi();
    runtime.attach(pi);

    const ctx: OmpContext = {
      cwd: "/tmp/proj",
      hasUI: true,
      ui: {
        notify: (msg, level) => uiNotices.push({ msg, level }),
      },
      sessionManager: new FakeSessionManager("sid-missing-bin"),
    };

    const recallRes = await mustTool(pi, "recall").execute(
      "t1",
      { query: "test" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(recallRes.isError, false);
    assert.deepEqual(
      {
        degraded: recallRes.details?.degraded,
        retrieval_id: recallRes.details?.retrieval_id,
        items: recallRes.details?.items,
      },
      { degraded: true, retrieval_id: null, items: [] },
    );

    const citeRes = await mustTool(pi, "cite").execute(
      "t2",
      { memory_ids: ["m1"] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(citeRes.isError, false);
    assert.equal(citeRes.details?.degraded, true);
    assert.equal(citeRes.details?.links, 0);

    const statusRes = await mustTool(pi, "status").execute("t3", {}, undefined, undefined, ctx);
    assert.equal(statusRes.isError, false);
    assert.equal(statusRes.details?.reachable, false);
    assert.equal(statusRes.details?.harness_session_id, "sid-missing-bin");

    const remRes = await mustTool(pi, "remember").execute(
      "t4",
      { content: "x", type: "fact" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(remRes.isError, true);
    assert.equal(remRes.details?.queued, false);
    assert.equal(remRes.details?.degraded, true);

    const revRes = await mustTool(pi, "review").execute(
      "t5",
      { action: "confirm", memory_id: "m1", reason: "still true" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(revRes.isError, true);
    assert.equal(revRes.details?.queued, false);
    assert.equal(revRes.details?.degraded, true);

    // Only one warning emitted across all 5 bridge calls.
    assert.equal(uiNotices.length, 1);
    assert.equal(uiNotices[0].level, "warning");
    assert.match(uiNotices[0].msg, /corvus:/);

    runtime.closeNow();
  });

  it("enforces config.json toolTimeoutMs and AbortSignal on hung tools", async () => {
    const fakeMem = writeFakeBridgeMem(tempDir, "/* hang forever */");
    const cfgPath = join(tempDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ mem: fakeMem, toolTimeoutMs: 75 }));

    const warnings: string[] = [];
    const runtime = createRuntime({
      configPath: cfgPath,
      report: (msg) => warnings.push(msg),
    });
    const pi = new FakeToolPi();
    runtime.attach(pi);
    const ctx: OmpContext = {
      cwd: "/tmp/proj",
      sessionManager: new FakeSessionManager("sid-hung"),
    };

    const res1 = await mustTool(pi, "recall").execute(
      "t1",
      { query: "hang" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res1.isError, false);
    assert.equal(res1.details?.degraded, true);
    assert.match(String(res1.details?.reason), /timed out/);
    assert.equal(warnings.length, 1);

    const ac = new AbortController();
    const p2 = mustTool(pi, "remember").execute(
      "t2",
      { content: "abort me", type: "fact" },
      ac.signal,
      undefined,
      ctx,
    );
    setTimeout(() => ac.abort(new Error("user stopped")), 25);
    const res2 = await p2;
    assert.equal(res2.isError, true);
    assert.equal(res2.details?.queued, false);
    assert.equal(res2.details?.degraded, true);
    assert.match(String(res2.details?.reason), /user stopped/);

    runtime.closeNow();
  });

  it("refuses tool calls cleanly when sessionManager.getSessionId() is missing", async () => {
    const runtime = createRuntime({ config: { mem: "mem" }, report: () => {} });
    const pi = new FakeToolPi();
    runtime.attach(pi);

    const badCtx: OmpContext = { cwd: "/tmp/proj" };
    const res = await mustTool(pi, "recall").execute(
      "t0",
      { query: "hi" },
      undefined,
      undefined,
      badCtx,
    );
    assert.equal(res.isError, true);
    assert.equal(res.details?.error, "invalid_args");
    assert.equal(runtime.bridge?.statusSnapshot().totalCalls, 0);
    runtime.closeNow();
  });

  it("forwards all optional tool parameters, degrades on malformed config, and keeps bridge open until last session shuts down", async () => {
    const requestsLog = join(tempDir, "optional-requests.jsonl");
    const fakeMem = writeFakeBridgeMem(
      tempDir,
      `
      require("node:fs").appendFileSync(${JSON.stringify(requestsLog)}, JSON.stringify(req) + "\\n");
      send({ id: req.id, ok: true, result: { ok: true, op: req.op } });
      `,
    );

    const runtime = createRuntime({ config: { mem: fakeMem }, report: () => {} });
    const mainPi = new FakeToolPi();
    const subPi = new FakeToolPi();
    runtime.attach(mainPi);
    runtime.attach(subPi);

    const mainCtx: OmpContext = {
      cwd: "/tmp/proj",
      sessionManager: new FakeSessionManager("sid-main"),
    };
    const subCtx: OmpContext = {
      cwd: "/tmp/proj",
      sessionManager: new FakeSessionManager("sid-sub"),
    };

    await mustTool(mainPi, "recall").execute(
      "o1",
      { query: "schema", scopes: ["global"], limit: 12, types: ["decision", "fact"] },
      undefined,
      undefined,
      mainCtx,
    );
    await mustTool(mainPi, "remember").execute(
      "o2",
      {
        content: "Prefer Bun for tests",
        type: "preference",
        scope: "corvus",
        key: "test-runner",
        confidence: 0.9,
        importance: 0.8,
        trust_level: "user",
        supersedes: "11111111-1111-1111-1111-111111111111",
        source_event_ids: ["22222222-2222-2222-2222-222222222222"],
        valid_from: "2026-11-01T00:00:00Z",
        expires_at: "2027-11-01T00:00:00Z",
        valid_to: "2027-12-01T00:00:00Z",
      },
      undefined,
      undefined,
      mainCtx,
    );
    await mustTool(mainPi, "cite").execute(
      "o3",
      {
        retrieval_id: "33333333-3333-3333-3333-333333333333",
        memory_ids: ["44444444-4444-4444-4444-444444444444"],
        context_event_ids: ["55555555-5555-5555-5555-555555555555"],
        answer_event_id: "66666666-6666-6666-6666-666666666666",
      },
      undefined,
      undefined,
      mainCtx,
    );
    await mustTool(mainPi, "review").execute(
      "o4",
      {
        action: "flag_contradiction",
        memory_id: "44444444-4444-4444-4444-444444444444",
        reason: "conflicts with newer decision",
        related_memory_id: "77777777-7777-7777-7777-777777777777",
      },
      undefined,
      undefined,
      mainCtx,
    );

    // Main shuts down while subagent is still active -> bridge stays alive.
    mainPi.emit("session_shutdown", {}, mainCtx);
    assert.equal(runtime.bridge?.statusSnapshot().running, true);

    const subStatus = await mustTool(subPi, "status").execute(
      "o5",
      {},
      undefined,
      undefined,
      subCtx,
    );
    assert.equal(subStatus.isError, false);

    // Last active session shuts down -> bridge closes synchronously.
    subPi.emit("session_shutdown", {}, subCtx);
    assert.equal(runtime.bridge?.statusSnapshot().running, false);

    const sent = readFileSync(requestsLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(sent[0].args, {
      query: "schema",
      scopes: ["global"],
      limit: 12,
      types: ["decision", "fact"],
    });
    assert.deepEqual(sent[1].args, {
      content: "Prefer Bun for tests",
      type: "preference",
      scope: "corvus",
      key: "test-runner",
      confidence: 0.9,
      importance: 0.8,
      trust_level: "user",
      supersedes: "11111111-1111-1111-1111-111111111111",
      source_event_ids: ["22222222-2222-2222-2222-222222222222"],
      valid_from: "2026-11-01T00:00:00Z",
      expires_at: "2027-11-01T00:00:00Z",
      valid_to: "2027-12-01T00:00:00Z",
    });
    assert.deepEqual(sent[2].args, {
      retrieval_id: "33333333-3333-3333-3333-333333333333",
      memory_ids: ["44444444-4444-4444-4444-444444444444"],
      context_event_ids: ["55555555-5555-5555-5555-555555555555"],
      answer_event_id: "66666666-6666-6666-6666-666666666666",
    });
    assert.deepEqual(sent[3].args, {
      action: "flag_contradiction",
      memory_id: "44444444-4444-4444-4444-444444444444",
      reason: "conflicts with newer decision",
      related_memory_id: "77777777-7777-7777-7777-777777777777",
    });
    assert.equal(sent[4].harness_session_id, "sid-sub");

    runtime.closeNow();

    // Malformed config.json disables bridge cleanly without throwing during tool calls.
    const badCfg = join(tempDir, "bad-config.json");
    writeFileSync(badCfg, "{broken");
    const badErrors: string[] = [];
    const badRuntime = createRuntime({ configPath: badCfg, report: (m) => badErrors.push(m) });
    const badPi = new FakeToolPi();
    badRuntime.attach(badPi);
    const badRecall = await mustTool(badPi, "recall").execute(
      "b1",
      { query: "x" },
      undefined,
      undefined,
      mainCtx,
    );
    assert.equal(badRecall.isError, false);
    assert.equal(badRecall.details?.degraded, true);
    const badRemember = await mustTool(badPi, "remember").execute(
      "b2",
      { content: "x", type: "fact" },
      undefined,
      undefined,
      mainCtx,
    );
    assert.equal(badRemember.isError, true);
    assert.equal(badRemember.details?.queued, false);
    assert.equal(badErrors.length, 1);
    badRuntime.closeNow();
  });
});
