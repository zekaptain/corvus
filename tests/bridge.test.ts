import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BridgeClient, buildBridgeArgs } from "../src/extension/bridge.ts";

function writeFakeBridgeScript(dir: string, bodyTs: string, name = "mem"): string {
  const scriptTs = join(dir, `${name}-bridge.ts`);
  const wrapper = join(dir, name);
  writeFileSync(scriptTs, bodyTs);
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptTs)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("BridgeClient — NDJSON transport", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "corvus-bridge-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds mem bridge CLI arguments cleanly", () => {
    assert.deepEqual(buildBridgeArgs({ mem: "mem" }), ["bridge", "--agent", "oh-my-pi"]);
    assert.deepEqual(
      buildBridgeArgs({
        mem: "/opt/bin/mem",
        home: "/tmp/h",
        port: 9595,
        agentId: "custom-agent",
      }),
      ["--home", "/tmp/h", "--port", "9595", "bridge", "--agent", "custom-agent"],
    );
  });

  it("lazily spawns once, forwards envelope fields, and parses chunked/out-of-order NDJSON responses", async () => {
    const argvLog = join(tempDir, "argv.log");
    const spawnCountLog = join(tempDir, "spawns.log");
    const fakeMem = writeFakeBridgeScript(
      tempDir,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
appendFileSync(${JSON.stringify(spawnCountLog)}, "spawn\\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(JSON.parse(line));
    idx = buf.indexOf("\\n");
  }
});

function handle(req: Record<string, unknown>) {
  if (req.op === "recall") {
    // Delay the first request slightly and emit its response in two chunks to test buffering & out-of-order ids.
    setTimeout(() => {
      const res = JSON.stringify({
        id: req.id,
        ok: true,
        result: {
          degraded: false,
          retrieval_id: "11111111-1111-1111-1111-111111111111",
          echoed: req,
          items: [],
        },
      }) + "\\n";
      const mid = Math.floor(res.length / 2);
      process.stdout.write(res.slice(0, mid));
      setTimeout(() => process.stdout.write(res.slice(mid)), 10);
    }, 35);
    return;
  }
  if (req.op === "review") {
    process.stdout.write(JSON.stringify({
      id: req.id,
      ok: false,
      error: { code: "validation_error", message: "agents cannot approve" },
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    id: req.id,
    ok: true,
    result: { reachable: true, echoed: req },
  }) + "\\n");
}
`,
    );

    const warnings: string[] = [];
    const client = new BridgeClient({ mem: fakeMem, home: "/tmp/ledger", port: 9696 }, (msg) =>
      warnings.push(msg),
    );

    // Lazy: nothing spawned before first call.
    assert.equal(client.statusSnapshot().running, false);

    // Concurrent calls: status finishes before chunked recall.
    const [r1, r2, r3] = await Promise.all([
      client.call(
        "recall",
        { harnessSessionId: "sid-1", cwd: "/work/repo", project: "repo" },
        { query: "adr" },
      ),
      client.call("status", { harnessSessionId: "sid-2", cwd: "/work/other" }, {}),
      client.call(
        "review",
        { harnessSessionId: "sid-1" },
        { action: "approve", memory_id: "m1", reason: "x" },
      ),
    ]);

    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.result.retrieval_id, "11111111-1111-1111-1111-111111111111");
      assert.deepEqual(r1.result.echoed, {
        id: "1",
        op: "recall",
        harness_session_id: "sid-1",
        cwd: "/work/repo",
        project: "repo",
        args: { query: "adr" },
      });
    }

    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.result.reachable, true);
      assert.deepEqual(r2.result.echoed, {
        id: "2",
        op: "status",
        harness_session_id: "sid-2",
        cwd: "/work/other",
        project: null,
        args: {},
      });
    }

    // Application-level validation_error does NOT tear down child or emit transport warnings.
    assert.equal(r3.ok, false);
    if (!r3.ok) {
      assert.equal(r3.transportFailure, false);
      assert.equal(r3.error.code, "validation_error");
      assert.equal(r3.error.message, "agents cannot approve");
    }

    assert.deepEqual(warnings, []);
    assert.equal(readFileSync(spawnCountLog, "utf8").trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(readFileSync(argvLog, "utf8").trim()), [
      "--home",
      "/tmp/ledger",
      "--port",
      "9696",
      "bridge",
      "--agent",
      "oh-my-pi",
    ]);

    const snap = client.statusSnapshot();
    assert.equal(snap.running, true);
    assert.ok(snap.pid !== null && snap.pid > 0);
    assert.equal(snap.totalCalls, 3);
    assert.equal(snap.failedCalls, 1);

    client.close();
    assert.equal(client.statusSnapshot().running, false);
    assert.deepEqual(warnings, []);
  });

  it("refuses blank harnessSessionId without spawning mem bridge", async () => {
    const spawnLog = join(tempDir, "should-not-exist");
    const fakeMem = writeFakeBridgeScript(
      tempDir,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(spawnLog)}, "spawned");
`,
    );

    const warnings: string[] = [];
    const client = new BridgeClient({ mem: fakeMem }, (msg) => warnings.push(msg));
    const res = await client.call("status", { harnessSessionId: "   " }, {});
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, "invalid_args");
      assert.equal(res.transportFailure, false);
    }
    assert.equal(client.statusSnapshot().running, false);
    assert.deepEqual(warnings, []);
    client.close();
  });

  it("enforces timeoutMs, kills a wedged child, reports once, and respawns cleanly on next call", async () => {
    const pidsFile = join(tempDir, "pids.log");
    const fakeMem = writeFakeBridgeScript(
      tempDir,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(pidsFile)}, String(process.pid) + "\\n");

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
      if (req.args?.hang) {
        // Intentionally never respond to wedge this bridge process.
        return;
      }
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true, pid: process.pid } }) + "\\n");
    }
    idx = buf.indexOf("\\n");
  }
});
`,
    );

    const warnings: string[] = [];
    const client = new BridgeClient({ mem: fakeMem, toolTimeoutMs: 80 }, (msg) =>
      warnings.push(msg),
    );

    // Call 1 hangs and times out.
    const res1 = await client.call("recall", { harnessSessionId: "sid-timeout" }, { hang: true });
    assert.equal(res1.ok, false);
    if (!res1.ok) {
      assert.equal(res1.error.code, "bridge_timeout");
      assert.equal(res1.transportFailure, true);
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /timed out/);
    assert.equal(client.statusSnapshot().running, false);
    assert.equal(client.isHealthy(), false);

    // Call 2 hangs and times out too — warning must NOT repeat.
    const res2 = await client.call("recall", { harnessSessionId: "sid-timeout" }, { hang: true });
    assert.equal(res2.ok, false);
    assert.equal(warnings.length, 1);

    // Call 3 succeeds on a freshly spawned child.
    const res3 = await client.call("status", { harnessSessionId: "sid-timeout" }, {});
    assert.equal(res3.ok, true);
    assert.equal(client.isHealthy(), true);
    const pids = readFileSync(pidsFile, "utf8").trim().split("\n");
    assert.equal(pids.length, 3);
    assert.notEqual(pids[0], pids[2]);

    client.close();
  });

  it("handles pre-aborted and mid-flight AbortSignal cancellation and respawns cleanly", async () => {
    const pidsFile = join(tempDir, "abort-pids.log");
    const fakeMem = writeFakeBridgeScript(
      tempDir,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(pidsFile)}, String(process.pid) + "\\n");

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
      if (req.args?.slow) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { late: true } }) + "\\n");
        }, 5000);
        return;
      }
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + "\\n");
    }
    idx = buf.indexOf("\\n");
  }
});
`,
    );

    const warnings: string[] = [];
    const client = new BridgeClient({ mem: fakeMem, toolTimeoutMs: 5000 }, (msg) =>
      warnings.push(msg),
    );

    // Pre-aborted signal returns immediately without spawning.
    const preAborted = new AbortController();
    preAborted.abort(new Error("already cancelled"));
    const res0 = await client.call(
      "recall",
      { harnessSessionId: "sid-abort" },
      { query: "x" },
      { signal: preAborted.signal },
    );
    assert.equal(res0.ok, false);
    if (!res0.ok) {
      assert.equal(res0.error.code, "aborted");
      assert.equal(res0.transportFailure, true);
    }
    assert.equal(client.statusSnapshot().running, false);

    // Mid-flight abort resolves promptly and tears down the wedged child.
    const controller = new AbortController();
    const pending = client.call(
      "recall",
      { harnessSessionId: "sid-abort" },
      { slow: true },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("deadline exceeded")), 40);
    const res1 = await pending;
    assert.equal(res1.ok, false);
    if (!res1.ok) {
      assert.equal(res1.error.code, "aborted");
      assert.equal(res1.transportFailure, true);
      assert.match(res1.error.message, /deadline exceeded/);
    }
    assert.equal(warnings.length, 1);

    // Subsequent normal call respawns and succeeds.
    const res2 = await client.call("status", { harnessSessionId: "sid-abort" }, {});
    assert.equal(res2.ok, true);
    client.close();
  });

  it("reports missing mem binary and crashing bridge strictly once across calls", async () => {
    const warnings1: string[] = [];
    const missingClient = new BridgeClient({ mem: "/nonexistent/mem-missing" }, (msg) =>
      warnings1.push(msg),
    );
    const m1 = await missingClient.call("recall", { harnessSessionId: "sid-m" }, { query: "a" });
    const m2 = await missingClient.call("status", { harnessSessionId: "sid-m" }, {});
    assert.equal(m1.ok, false);
    assert.equal(m2.ok, false);
    if (!m1.ok) assert.equal(m1.transportFailure, true);
    assert.equal(warnings1.length, 1);
    missingClient.close();

    const deadScript = join(tempDir, "dead-mem");
    writeFileSync(deadScript, "#!/bin/sh\necho 'bridge fatal' >&2\nexit 1\n");
    chmodSync(deadScript, 0o755);

    const warnings2: string[] = [];
    const deadClient = new BridgeClient({ mem: deadScript }, (msg) => warnings2.push(msg));
    const d1 = await deadClient.call("recall", { harnessSessionId: "sid-d" }, { query: "a" });
    const d2 = await deadClient.call("recall", { harnessSessionId: "sid-d" }, { query: "b" });
    assert.equal(d1.ok, false);
    assert.equal(d2.ok, false);
    assert.equal(warnings2.length, 1);
    assert.match(warnings2[0], /corvus:/);
    deadClient.close();
  });

  it("unrefs the bridge child and stdio streams so a live bridge never blocks process exit", () => {
    const pidFile = join(tempDir, "live-bridge.pid");
    const fakeMem = writeFakeBridgeScript(
      tempDir,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
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
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + "\\n");
    }
    idx = buf.indexOf("\\n");
  }
});
// Keep child alive waiting for stdin indefinitely.
setTimeout(() => {}, 15000);
`,
    );

    const bridgePath = resolve(import.meta.dir, "../src/extension/bridge.ts");
    const runner = join(tempDir, "run-unref.ts");
    writeFileSync(
      runner,
      `import { BridgeClient } from ${JSON.stringify(bridgePath)};
const client = new BridgeClient({ mem: ${JSON.stringify(fakeMem)} }, () => {});
await client.call("status", { harnessSessionId: "sid-unref" }, {});
// Intentionally do not call client.close(); process should exit immediately because child is unref'd.
`,
    );

    const t0 = Date.now();
    const proc = Bun.spawnSync([process.execPath, runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const elapsed = Date.now() - t0;
    assert.equal(proc.exitCode, 0, proc.stderr.toString());
    assert.ok(elapsed < 2_000, `expected prompt exit with unref'd bridge, took ${elapsed}ms`);

    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Child may already be gone.
    }
  });

  it("keeps the event loop alive while awaiting a delayed bridge response with no other active handles", () => {
    const pidFile = join(tempDir, "delayed-bridge.pid");
    const fakeMem = writeFakeBridgeScript(
      tempDir,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
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
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { delayed: true } }) + "\\n");
      }, 80);
    }
    idx = buf.indexOf("\\n");
  }
});
setTimeout(() => {}, 15000);
`,
    );

    const bridgePath = resolve(import.meta.dir, "../src/extension/bridge.ts");
    const runner = join(tempDir, "run-delayed.ts");
    writeFileSync(
      runner,
      `import assert from "node:assert/strict";
import { BridgeClient } from ${JSON.stringify(bridgePath)};
const client = new BridgeClient({ mem: ${JSON.stringify(fakeMem)}, toolTimeoutMs: 2000 }, () => {});
process.once("beforeExit", () => client.close());
const res = await client.call("recall", { harnessSessionId: "sid-delayed" }, { query: "q" });
assert.equal(res.ok, true, JSON.stringify(res));
if (res.ok) {
  assert.equal(res.result.delayed, true);
}
// No explicit client.close() here; process should still exit promptly once timer clears.
`,
    );

    const t0 = Date.now();
    const proc = Bun.spawnSync([process.execPath, runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const elapsed = Date.now() - t0;
    assert.equal(proc.exitCode, 0, proc.stderr.toString());
    assert.ok(elapsed >= 70 && elapsed < 2_000, `unexpected elapsed ${elapsed}ms`);

    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Child may already be gone.
    }
  });
});
