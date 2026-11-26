/**
 * Persistent NDJSON stdio client for `agent-memory`'s `mem bridge`.
 *
 * Contract:
 * - Lazily spawns `<mem> [--home <home>] [--port <port>] bridge --agent oh-my-pi` on first call.
 * - Unrefs the child process and stdio streams so a live bridge never blocks omp exit.
 * - Serializes NDJSON requests with unique ids and matches NDJSON responses line-by-line.
 * - Enforces bounded per-call timeouts combined with caller `AbortSignal`.
 * - Resolves cleanly on timeout, abort, crash, or missing binary, kills/clears any wedged
 *   child so the next call can respawn cleanly, and reports transport failures at most once.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { FailureReporter } from "./sink.ts";

export const DEFAULT_BRIDGE_AGENT_ID = "oh-my-pi";
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export type BridgeOp = "recall" | "remember" | "cite" | "review" | "status" | "session_context";

export interface BridgeConfig {
  mem: string;
  home?: string;
  port?: number;
  agentId?: string;
  toolTimeoutMs?: number;
}

export interface BridgeSessionRef {
  harnessSessionId: string;
  cwd?: string;
  project?: string;
}

export interface BridgeCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BridgeError {
  code: string;
  message: string;
}

export type BridgeCallResult<T = Record<string, unknown>> =
  | { ok: true; result: T }
  | { ok: false; error: BridgeError; transportFailure?: boolean };

export interface BridgeStatusSnapshot {
  running: boolean;
  pid: number | null;
  pendingRequests: number;
  totalCalls: number;
  failedCalls: number;
  lastError: string | null;
  healthy: boolean;
}

interface PendingRequest {
  id: string;
  resolve: (result: BridgeCallResult<Record<string, unknown>>) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupSignal: () => void;
}

export function buildBridgeArgs(config: BridgeConfig): string[] {
  const args: string[] = [];
  if (config.home) {
    args.push("--home", config.home);
  }
  if (config.port !== undefined) {
    args.push("--port", String(config.port));
  }
  args.push("bridge", "--agent", config.agentId ?? DEFAULT_BRIDGE_AGENT_ID);
  return args;
}

export class BridgeClient {
  private readonly config: BridgeConfig;
  private readonly report: FailureReporter;
  private readonly defaultTimeoutMs: number;

  private child: ChildProcess | null = null;
  private closingChild: ChildProcess | null = null;
  private retiredChildren = new WeakSet<ChildProcess>();
  private stdoutBuffer = "";
  private lastStderr = "";
  private nextRequestId = 0;
  private pending = new Map<string, PendingRequest>();

  private reported = false;
  private totalCalls = 0;
  private failedCalls = 0;
  private lastError: string | null = null;

  constructor(config: BridgeConfig, report: FailureReporter) {
    this.config = config;
    this.report = report;
    this.defaultTimeoutMs =
      typeof config.toolTimeoutMs === "number" &&
      Number.isFinite(config.toolTimeoutMs) &&
      config.toolTimeoutMs > 0
        ? config.toolTimeoutMs
        : DEFAULT_TOOL_TIMEOUT_MS;
  }

  isHealthy(): boolean {
    return this.lastError === null;
  }

  statusSnapshot(): BridgeStatusSnapshot {
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      pendingRequests: this.pending.size,
      totalCalls: this.totalCalls,
      failedCalls: this.failedCalls,
      lastError: this.lastError,
      healthy: this.isHealthy(),
    };
  }

  async call<T = Record<string, unknown>>(
    op: BridgeOp,
    session: BridgeSessionRef,
    args: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<BridgeCallResult<T>> {
    this.totalCalls += 1;

    const harnessSessionId = session.harnessSessionId?.trim();
    if (!harnessSessionId) {
      this.failedCalls += 1;
      return {
        ok: false,
        error: { code: "invalid_args", message: "harness_session_id is required" },
        transportFailure: false,
      };
    }

    if (options.signal?.aborted) {
      this.failedCalls += 1;
      return {
        ok: false,
        error: { code: "aborted", message: abortReasonMessage(options.signal) },
        transportFailure: true,
      };
    }

    if (!this.child) {
      const startError = this.start();
      if (startError) {
        this.failedCalls += 1;
        return {
          ok: false,
          error: { code: "bridge_unavailable", message: startError },
          transportFailure: true,
        };
      }
    }

    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || stdin.writableEnded) {
      const message = `mem bridge is unavailable (${this.lastError ?? "stdin not writable"})`;
      this.failedCalls += 1;
      this.reportOnce(message);
      this.teardownChild(true);
      return {
        ok: false,
        error: { code: "bridge_unavailable", message },
        transportFailure: true,
      };
    }

    const id = String(++this.nextRequestId);
    const timeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : this.defaultTimeoutMs;

    const envelope = {
      id,
      op,
      harness_session_id: harnessSessionId,
      cwd: session.cwd ?? null,
      project: session.project ?? null,
      args,
    };

    let serialized: string;
    try {
      serialized = `${JSON.stringify(envelope)}\n`;
    } catch (err) {
      this.failedCalls += 1;
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: `could not serialize bridge request (${errorMessage(err)})`,
        },
        transportFailure: false,
      };
    }

    return new Promise<BridgeCallResult<T>>((resolve) => {
      let settled = false;

      const finish = (result: BridgeCallResult<Record<string, unknown>>) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        cleanupSignal();
        if (result.ok) {
          this.lastError = null;
        } else {
          this.failedCalls += 1;
        }
        resolve(result as BridgeCallResult<T>);
      };

      const onTimeout = () => {
        if (settled) {
          return;
        }
        const message = `mem bridge timed out after ${timeoutMs}ms on ${op}`;
        this.lastError = message;
        this.reportOnce(message);
        // Kill the wedged child so subsequent calls respawn a clean bridge process.
        finish({
          ok: false,
          error: { code: "bridge_timeout", message },
          transportFailure: true,
        });
        this.failAllPending("bridge_timeout", message);
        this.teardownChild(true);
      };

      // Keep the active request timer ref'd so Bun does not drain the event loop while
      // awaiting an unref'd bridge child; finish() clears it on every completion path.
      const timer = setTimeout(onTimeout, timeoutMs);

      let cleanupSignal = () => {};
      if (options.signal) {
        const onAbort = () => {
          if (settled) {
            return;
          }
          const message = `mem bridge ${op} aborted (${abortReasonMessage(options.signal)})`;
          this.lastError = message;
          this.reportOnce(message);
          finish({
            ok: false,
            error: { code: "aborted", message },
            transportFailure: true,
          });
          // An aborted in-flight request may leave the single-threaded stdio child wedged.
          this.failAllPending("bridge_unavailable", "mem bridge reset after aborted call");
          this.teardownChild(true);
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        cleanupSignal = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pending.set(id, {
        id,
        resolve: finish,
        timer,
        cleanupSignal,
      });

      try {
        stdin.write(serialized, (err) => {
          if (err && !settled) {
            const message = `mem bridge pipe failed (${errorMessage(err)})`;
            this.lastError = message;
            this.reportOnce(message);
            finish({
              ok: false,
              error: { code: "bridge_unavailable", message },
              transportFailure: true,
            });
            this.failAllPending("bridge_unavailable", message);
            this.teardownChild(true);
          }
        });
      } catch (err) {
        if (!settled) {
          const message = `could not write to mem bridge (${errorMessage(err)})`;
          this.lastError = message;
          this.reportOnce(message);
          finish({
            ok: false,
            error: { code: "bridge_unavailable", message },
            transportFailure: true,
          });
          this.failAllPending("bridge_unavailable", message);
          this.teardownChild(true);
        }
      }
    });
  }

  /**
   * Synchronously close the active bridge process (safe in `session_shutdown` and `beforeExit`).
   */
  close(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.closingChild = child;
    this.failAllPending("bridge_unavailable", "mem bridge closed");
    this.teardownChild(false);
  }

  private start(): string | null {
    const args = buildBridgeArgs(this.config);
    this.stdoutBuffer = "";
    this.lastStderr = "";

    let child: ChildProcess;
    try {
      child = spawn(this.config.mem, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const message = `could not start ${this.config.mem} (${errorMessage(err)})`;
      this.lastError = message;
      this.reportOnce(message);
      return message;
    }

    this.child = child;
    child.unref();

    const stdin = child.stdin;
    if (stdin) {
      (stdin as unknown as { unref?: () => void }).unref?.();
      stdin.on("error", (err) => {
        if (this.closingChild === child || this.child !== child) {
          return;
        }
        const message = `mem bridge pipe failed (${errorMessage(err)})`;
        this.lastError = message;
        this.reportOnce(message);
        this.failAllPending("bridge_unavailable", message);
        this.teardownChild(true);
      });
    }

    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding("utf8");
      (stdout as unknown as { unref?: () => void }).unref?.();
      stdout.on("data", (chunk: string) => {
        if (this.child !== child) {
          return;
        }
        this.handleStdoutChunk(chunk);
      });
      stdout.on("error", () => {
        // Ignore stdout stream errors during teardown.
      });
    }

    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding("utf8");
      (stderr as unknown as { unref?: () => void }).unref?.();
      stderr.on("data", (chunk: string) => {
        const lines = chunk
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 0) {
          this.lastStderr = lines[lines.length - 1];
        }
      });
      stderr.on("error", () => {
        // Ignore stderr pipe errors.
      });
    }

    child.on("error", (err) => {
      if (this.closingChild === child || this.retiredChildren.has(child)) {
        return;
      }
      const message = `could not start ${this.config.mem} (${errorMessage(err)})`;
      this.lastError = message;
      this.reportOnce(message);
      if (this.child === child) {
        this.failAllPending("bridge_unavailable", message);
        this.teardownChild(true);
      }
    });

    child.on("close", (code, signal) => {
      const wasClosing = this.closingChild === child;
      const wasRetired = this.retiredChildren.has(child);
      if (wasClosing) {
        this.closingChild = null;
      }
      if (this.child === child) {
        this.child = null;
        this.stdoutBuffer = "";
      }
      if (wasRetired || (wasClosing && (code === 0 || code === null))) {
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const extra = this.lastStderr ? `: ${this.lastStderr}` : "";
      const message = `mem bridge stopped (${detail})${extra}`;
      this.lastError = message;
      this.reportOnce(message);
      this.failAllPending("bridge_unavailable", message);
    });

    return null;
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const rawId = obj.id;
    if (rawId === null || rawId === undefined) {
      return;
    }
    const id = String(rawId);
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }

    if (obj.ok === true) {
      const result =
        obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)
          ? (obj.result as Record<string, unknown>)
          : {};
      entry.resolve({ ok: true, result });
      return;
    }

    const errObj =
      obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)
        ? (obj.error as Record<string, unknown>)
        : {};
    const code = typeof errObj.code === "string" && errObj.code ? errObj.code : "internal_error";
    const message =
      typeof errObj.message === "string" && errObj.message ? errObj.message : "bridge error";
    entry.resolve({
      ok: false,
      error: { code, message },
      transportFailure: false,
    });
  }

  private failAllPending(code: string, message: string): void {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      entry.resolve({
        ok: false,
        error: { code, message },
        transportFailure: true,
      });
    }
  }

  private teardownChild(forceKill: boolean): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    if (!child) {
      return;
    }
    if (forceKill) {
      this.retiredChildren.add(child);
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore if already exited.
      }
      try {
        child.stdin?.destroy();
      } catch {
        // Ignore.
      }
      try {
        child.stdout?.destroy();
      } catch {
        // Ignore.
      }
      try {
        child.stderr?.destroy();
      } catch {
        // Ignore.
      }
      return;
    }
    try {
      const stdin = child.stdin;
      if (stdin && !stdin.destroyed && !stdin.writableEnded) {
        stdin.end();
      }
    } catch {
      // Ignore pipe errors during clean shutdown.
    }
    try {
      child.stdout?.destroy();
    } catch {
      // Ignore.
    }
    try {
      child.stderr?.destroy();
    } catch {
      // Ignore.
    }
  }

  private reportOnce(detail: string): void {
    if (this.reported) {
      return;
    }
    this.reported = true;
    try {
      this.report(`corvus: ${detail}`);
    } catch {
      // Never let failure reporting crash omp.
    }
  }
}

function abortReasonMessage(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }
  return "request aborted";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
