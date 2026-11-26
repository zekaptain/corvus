import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CORVUS_COMMAND_CUSTOM_TYPE,
  CORVUS_COMMAND_NAME,
  type OmpCommandDefinition,
  type OmpCommandMessage,
  getCorvusArgumentCompletions,
} from "../src/extension/commands.ts";
import { type OmpExtensionAPI, createRuntime } from "../src/extension/index.ts";
import {
  type OmpContext,
  type OmpHookPayload,
  OmpMapper,
  type OmpSessionEntry,
} from "../src/extension/mapper.ts";

class CommandSessionManager {
  sessionId: string;
  entries: OmpSessionEntry[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getEntries(): OmpSessionEntry[] {
    return this.entries;
  }

  getBranch(): OmpSessionEntry[] {
    return this.entries;
  }

  getLeafId(): string | null {
    return this.entries.length > 0 ? (this.entries[this.entries.length - 1].id ?? null) : null;
  }
}

class FakeCommandPi implements OmpExtensionAPI {
  readonly handlers = new Map<
    string,
    Array<(payload: OmpHookPayload, ctx: OmpContext) => unknown>
  >();
  readonly commands = new Map<string, OmpCommandDefinition>();
  readonly sentMessages: OmpCommandMessage[] = [];
  readonly pi = { VERSION: "19.2.1" };

  on(event: string, handler: (payload: OmpHookPayload, ctx: OmpContext) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, definition: OmpCommandDefinition): void {
    this.commands.set(name, definition);
  }

  sendMessage(message: OmpCommandMessage): void {
    this.sentMessages.push(message);
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

function writeFakeMem(
  dir: string,
  opts: {
    statusMode?: "reachable" | "unreachable";
    contextMode?: "ok" | "empty" | "degraded";
    recordsExit1?: boolean;
  } = {},
): { memBin: string; requestsLog: string } {
  const requestsLog = join(dir, "bridge-requests.jsonl");
  const scriptPath = join(dir, "mem-cmd.ts");
  const memBin = join(dir, "mem");

  const statusMode = opts.statusMode ?? "reachable";
  const contextMode = opts.contextMode ?? "ok";
  const recordsExit1 = opts.recordsExit1 ?? false;

  const script = `
import { appendFileSync } from "node:fs";
import * as readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("records")) {
  if (${JSON.stringify(recordsExit1)}) {
    process.stderr.write("records sink down\\n");
    process.exit(1);
  }
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (args.includes("bridge")) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    appendFileSync(${JSON.stringify(requestsLog)}, trimmed + "\\n");
    const req = JSON.parse(trimmed);
    if (req.op === "status") {
      if (${JSON.stringify(statusMode)} === "unreachable") {
        process.stdout.write(JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            reachable: false,
            reason: "ConnectionRefusedError: server offline",
            agent_id: "oh-my-pi",
            session_id: "sess-uuid-1",
            harness_session_id: req.harness_session_id,
            project: req.project ?? "corvus",
            server: "http://127.0.0.1:9494",
            spool_pending_lines: 3,
            spool_rejected_lines: 1,
          },
        }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            reachable: true,
            agent_id: "oh-my-pi",
            session_id: "sess-uuid-1",
            harness_session_id: req.harness_session_id,
            project: req.project ?? "corvus",
            server: "http://127.0.0.1:9494",
            events_this_session: { session_start: 1, user_msg: 2 },
            spool_pending_lines: 0,
            spool_rejected_lines: 0,
          },
        }) + "\\n");
      }
      continue;
    }
    if (req.op === "session_context") {
      const mode = ${JSON.stringify(contextMode)};
      if (mode === "degraded") {
        process.stdout.write(JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            degraded: true,
            reason: "Quack offline",
            retrieval_id: null,
            text: "",
            items: [],
            shown_count: 0,
            not_shown_count: 0,
            char_count: 0,
            max_chars: req.args?.max_chars ?? 2400,
          },
        }) + "\\n");
      } else if (mode === "empty") {
        process.stdout.write(JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            degraded: false,
            retrieval_id: "11111111-1111-4111-8111-111111111111",
            strategy: "session_start_v1",
            text: "",
            items: [],
            shown_count: 0,
            not_shown_count: 0,
            char_count: 0,
            max_chars: req.args?.max_chars ?? 2400,
          },
        }) + "\\n");
      } else {
        const text = "# Active memories\\n- [mem-101] (corvus/fact) Register /corvus instead of /memory";
        process.stdout.write(JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            degraded: false,
            retrieval_id: "22222222-2222-4222-8222-222222222222",
            strategy: "session_start_v1",
            text,
            items: [{ memory_id: "mem-101" }],
            shown_count: 1,
            not_shown_count: 2,
            char_count: text.length,
            max_chars: req.args?.max_chars ?? 2400,
          },
        }) + "\\n");
      }
      continue;
    }
    process.stdout.write(JSON.stringify({
      id: req.id,
      ok: false,
      error: { code: "unknown_op", message: "unsupported op" },
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
  return { memBin, requestsLog };
}

describe("/corvus slash command (MEM-43)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "corvus-cmd-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers /corvus (never /memory), tolerates minimal pi without registerCommand, and provides completions", () => {
    const minimalPi: OmpExtensionAPI = {
      on: () => undefined,
    };
    const rtMin = createRuntime({ config: { mem: "mem" }, report: () => undefined });
    rtMin.attach(minimalPi);
    rtMin.closeNow();

    const pi = new FakeCommandPi();
    const rt = createRuntime({ config: { mem: "mem" }, report: () => undefined });
    rt.attach(pi);
    assert.equal(pi.commands.has(CORVUS_COMMAND_NAME), true);
    assert.equal(pi.commands.has("memory"), false);

    const all = getCorvusArgumentCompletions("");
    assert.ok(all.length >= 6);
    assert.equal(
      all.some((c) => c.value.includes("approve")),
      false,
    );
    assert.deepEqual(
      getCorvusArgumentCompletions("inject ").map((c) => c.value),
      ["inject status", "inject on", "inject off", "inject preview"],
    );
    assert.deepEqual(
      getCorvusArgumentCompletions("s").map((c) => c.value),
      ["status"],
    );
    assert.deepEqual(getCorvusArgumentCompletions("nope"), []);
    rt.closeNow();
  });

  it("reports reachable ledger, sink, bridge, and injection state for '' and 'status' with UI updates", async () => {
    const { memBin } = writeFakeMem(tmpDir, { statusMode: "reachable" });
    const runtime = createRuntime({
      config: {
        mem: memBin,
        sessionStartInjection: false,
        sessionStartMaxChars: 2400,
        sessionStartMaxItems: 12,
        sessionStartTimeoutMs: 1500,
      },
      report: () => undefined,
    });
    const pi = new FakeCommandPi();
    runtime.attach(pi);
    const cmd = pi.commands.get(CORVUS_COMMAND_NAME);
    assert.ok(cmd);

    const sm = new CommandSessionManager("sid-cmd-1");
    const uiNotices: Array<{ msg: string; level?: string }> = [];
    const uiStatuses: Array<{ key: string; text: string }> = [];
    const ctx: OmpContext = {
      cwd: "/tmp/repos/corvus",
      hasUI: true,
      ui: {
        notify: (msg, level) => uiNotices.push({ msg, level }),
        setStatus: (key, text) => uiStatuses.push({ key, text }),
      },
      sessionManager: sm,
    };

    // Start capture sink by firing session_start
    pi.emitSync("session_start", {}, ctx);

    const resEmpty = await cmd.handler("", ctx);
    assert.match(resEmpty.content, /Ledger: reachable/);
    assert.match(resEmpty.content, /harness_session_id=sid-cmd-1/);
    assert.match(resEmpty.content, /project=corvus/);
    assert.match(resEmpty.content, /events_this_session=\{"session_start":1,"user_msg":2\}/);
    assert.match(resEmpty.content, /spool_pending_lines=0 spool_rejected_lines=0/);
    assert.match(resEmpty.content, /Capture sink: alive/);
    assert.match(resEmpty.content, /Bridge client: healthy/);
    assert.match(
      resEmpty.content,
      /Session-start injection: disabled \(source=config, maxChars=2400, maxItems=12, timeoutMs=1500, injectedInSession=false\)/,
    );

    assert.equal(pi.sentMessages.length, 1);
    assert.equal(pi.sentMessages[0].customType, CORVUS_COMMAND_CUSTOM_TYPE);
    assert.equal(pi.sentMessages[0].display, true);
    assert.equal(pi.sentMessages[0].content, resEmpty.content);
    assert.equal(uiNotices.length, 1);
    assert.equal(uiNotices[0].level, "info");
    assert.match(uiNotices[0].msg, /ledger=reachable/);
    assert.deepEqual(uiStatuses[0], { key: "corvus", text: "corvus: ok (inject:off)" });

    const resExplicit = await cmd.handler("  status  ", ctx);
    assert.match(resExplicit.content, /Ledger: reachable/);
    runtime.closeNow();
  });

  it("toggles session-start injection in-session via 'inject on/off/status' without modifying config.json", async () => {
    const { memBin } = writeFakeMem(tmpDir, { contextMode: "ok" });
    const cfgPath = join(tmpDir, "config.json");
    const initialCfg = JSON.stringify({ mem: memBin, sessionStartInjection: false }, null, 2);
    writeFileSync(cfgPath, initialCfg);

    const runtime = createRuntime({ configPath: cfgPath, report: () => undefined });
    const pi = new FakeCommandPi();
    runtime.attach(pi);
    const cmd = pi.commands.get(CORVUS_COMMAND_NAME);
    assert.ok(cmd);

    const sm1 = new CommandSessionManager("sid-toggle-1");
    const ctx1: OmpContext = { cwd: "/tmp/repos/corvus", hasUI: false, sessionManager: sm1 };

    // Initially off -> before_agent_start returns undefined
    assert.deepEqual(await pi.emitAsync("before_agent_start", {}, ctx1), [undefined]);

    // `/corvus inject status`
    const st0 = await cmd.handler("inject status", ctx1);
    assert.match(st0.content, /Session-start injection: disabled \(source=config/);

    // `/corvus inject on` takes effect immediately on a fresh session
    const onRes = await cmd.handler("inject on", ctx1);
    assert.match(onRes.content, /enabled for this session/);
    assert.match(onRes.content, /config\.json=false was not modified/);
    assert.match(onRes.content, /source=override/);

    const sm2 = new CommandSessionManager("sid-toggle-2");
    const ctx2: OmpContext = { cwd: "/tmp/repos/corvus", hasUI: false, sessionManager: sm2 };
    const injected = await pi.emitAsync("before_agent_start", {}, ctx2);
    assert.ok(injected[0] && typeof injected[0] === "object");
    const stAfter = await cmd.handler("inject", ctx2);
    assert.match(stAfter.content, /enabled \(source=override.*injectedInSession=true/);

    // `/corvus inject off` disables injection for subsequent sessions
    const offRes = await cmd.handler("inject off", ctx2);
    assert.match(offRes.content, /disabled for this session/);
    const sm3 = new CommandSessionManager("sid-toggle-3");
    const ctx3: OmpContext = { cwd: "/tmp/repos/corvus", hasUI: false, sessionManager: sm3 };
    assert.deepEqual(await pi.emitAsync("before_agent_start", {}, ctx3), [undefined]);

    // config.json on disk must remain untouched
    assert.equal(readFileSync(cfgPath, "utf8"), initialCfg);
    runtime.closeNow();
  });

  it("previews bounded session_start_v1 block via 'inject preview' including empty and degraded notices", async () => {
    const { memBin, requestsLog } = writeFakeMem(tmpDir, { contextMode: "ok" });
    const rtOk = createRuntime({
      config: {
        mem: memBin,
        sessionStartInjection: false,
        sessionStartMaxChars: 500,
        sessionStartMaxItems: 5,
      },
      report: () => undefined,
    });
    const piOk = new FakeCommandPi();
    rtOk.attach(piOk);
    const cmdOk = piOk.commands.get(CORVUS_COMMAND_NAME);
    assert.ok(cmdOk);
    const ctx: OmpContext = {
      cwd: "/tmp/repos/corvus",
      sessionManager: new CommandSessionManager("sid-preview"),
    };

    const previewRes = await cmdOk.handler("inject preview", ctx);
    assert.match(previewRes.content, /retrieval_id=22222222-2222-4222-8222-222222222222/);
    assert.match(previewRes.content, /shown_count=1 not_shown_count=2/);
    assert.match(previewRes.content, /char_count=\d+\/500/);
    assert.match(previewRes.content, /\[mem-101\]/);

    const sentReq = JSON.parse(readFileSync(requestsLog, "utf8").trim()) as Record<string, unknown>;
    assert.equal(sentReq.op, "session_context");
    assert.equal(sentReq.harness_session_id, "sid-preview");
    rtOk.closeNow();

    // Empty active memories
    const emptyDir = mkdtempSync(join(tmpdir(), "corvus-cmd-empty-"));
    try {
      const emptyMem = writeFakeMem(emptyDir, { contextMode: "empty" });
      const rtEmpty = createRuntime({
        config: { mem: emptyMem.memBin },
        report: () => undefined,
      });
      const piEmpty = new FakeCommandPi();
      rtEmpty.attach(piEmpty);
      const emptyRes = await piEmpty.commands
        .get(CORVUS_COMMAND_NAME)
        ?.handler("inject preview", ctx);
      assert.ok(emptyRes);
      assert.match(emptyRes.content, /No active memories matched/);
      rtEmpty.closeNow();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    // Degraded / unreachable ledger
    const degDir = mkdtempSync(join(tmpdir(), "corvus-cmd-deg-"));
    try {
      const degMem = writeFakeMem(degDir, { contextMode: "degraded" });
      const rtDeg = createRuntime({
        config: { mem: degMem.memBin },
        report: () => undefined,
      });
      const piDeg = new FakeCommandPi();
      rtDeg.attach(piDeg);
      const degRes = await piDeg.commands.get(CORVUS_COMMAND_NAME)?.handler("inject preview", ctx);
      assert.ok(degRes);
      assert.match(degRes.content, /ledger unreachable/i);
      rtDeg.closeNow();
    } finally {
      rmSync(degDir, { recursive: true, force: true });
    }
  });

  it("reports degraded/unreachable ledger and degraded capture sink cleanly without throwing", async () => {
    const { memBin } = writeFakeMem(tmpDir, { statusMode: "unreachable", recordsExit1: true });
    const warnings: string[] = [];
    const runtime = createRuntime({
      config: { mem: memBin },
      report: (m) => warnings.push(m),
    });
    const pi = new FakeCommandPi();
    runtime.attach(pi);
    const cmd = pi.commands.get(CORVUS_COMMAND_NAME);
    assert.ok(cmd);

    const ctx: OmpContext = {
      cwd: "/tmp/repos/corvus",
      hasUI: true,
      ui: {
        notify: () => undefined,
      },
      sessionManager: new CommandSessionManager("sid-degraded"),
    };
    pi.emitSync("session_start", {}, ctx);
    const deadline = Date.now() + 2_000;
    while (!runtime.sink?.isFailed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const res = await cmd.handler("status", ctx);
    assert.match(res.content, /Ledger: unreachable/);
    assert.match(res.content, /spool_pending_lines=3 spool_rejected_lines=1/);
    assert.match(res.content, /Capture sink: failed/);
    assert.match(res.content, /lastError:/);
    runtime.closeNow();

    // Also tolerate malformed config.json (sink=null, bridge=null, injector=null)
    const badCfg = join(tmpDir, "bad.json");
    writeFileSync(badCfg, "{bad");
    const rtBad = createRuntime({ configPath: badCfg, report: () => undefined });
    const piBad = new FakeCommandPi();
    rtBad.attach(piBad);
    const cmdBad = piBad.commands.get(CORVUS_COMMAND_NAME);
    assert.ok(cmdBad);

    const badStatus = await cmdBad.handler("status", { cwd: "/tmp/p" });
    assert.match(badStatus.content, /Ledger: unavailable/);
    assert.match(badStatus.content, /Capture sink: disabled/);

    const badToggle = await cmdBad.handler("inject on", { cwd: "/tmp/p" });
    assert.match(badToggle.content, /Cannot toggle session-start injection/);

    const badPreview = await cmdBad.handler("inject preview", { cwd: "/tmp/p" });
    assert.match(badPreview.content, /preview unavailable/);
    rtBad.closeNow();
  });

  it("handles 'help' and unknown/forbidden subcommands with concise usage text", async () => {
    const runtime = createRuntime({ config: { mem: "mem" }, report: () => undefined });
    const pi = new FakeCommandPi();
    runtime.attach(pi);
    const cmd = pi.commands.get(CORVUS_COMMAND_NAME);
    assert.ok(cmd);
    const ctx: OmpContext = { sessionManager: new CommandSessionManager("sid-help") };

    const helpRes = await cmd.handler("help", ctx);
    assert.match(helpRes.content, /Corvus commands:/);
    assert.match(helpRes.content, /\/corvus inject preview/);
    assert.match(helpRes.content, /mem review/);

    for (const badArgs of ["unknown", "approve", "inject approve", "inject on extra"]) {
      const badRes = await cmd.handler(badArgs, ctx);
      assert.match(badRes.content, /Unknown \/corvus/);
      assert.match(badRes.content, /Corvus commands:/);
    }
    runtime.closeNow();
  });

  it("OmpMapper ignores corvus-command custom_message and never emits it as user_msg", () => {
    const mapper = new OmpMapper();
    const sm = new CommandSessionManager("sid-cmd-mapper");
    const ctx: OmpContext = { cwd: "/tmp/p", sessionManager: sm };
    mapper.handle("session_start", {}, ctx, 1);

    const userMsg = { role: "user", content: "real prompt", timestamp: 1000 };
    const cmdMsg = {
      role: "custom",
      customType: CORVUS_COMMAND_CUSTOM_TYPE,
      content: "Corvus Status\nLedger: reachable",
      display: true,
      timestamp: 1010,
    };
    sm.entries.push({ type: "message", id: "u-1", message: userMsg });
    sm.entries.push({
      type: "custom_message",
      id: "c-1",
      customType: CORVUS_COMMAND_CUSTOM_TYPE,
      message: cmdMsg,
    });

    const userRecords = mapper.handle("message_end", { message: userMsg }, ctx, 1);
    assert.equal(userRecords.length, 1);
    assert.equal(userRecords[0].kind, "user_msg");
    assert.equal(userRecords[0].source_key, "u-1");

    const cmdRecords = mapper.handle("message_end", { message: cmdMsg }, ctx, 1);
    assert.deepEqual(cmdRecords, []);
  });
});
