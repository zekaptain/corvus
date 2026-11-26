/**
 * Persistent NDJSON stdio client for `mem bridge`.
 *
 * Lazily spawns `<mem> [--home ...] [--port ...] bridge --agent oh-my-pi`, unrefs the child
 * and its stdio streams so idle sessions never block process exit, enforces per-call timeouts
 * and AbortSignals, kills/clears wedged children so future calls can respawn cleanly, and
 * reports failures at most once via the provided warning callback.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { FailureReporter } from "./sink.ts";

export interface BridgeConfig {
  mem: string;
  home?: string;
  port?: number;
  agent?: string;
  defaultTimeoutMs?: number;
}

export interface BridgeSessionContext {
  harnessSessionId: string;
  cwd?: string;
  project?: string;
}

export interface BridgeCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BridgeErrorPayload {
  code: string;
  message: string;
}

export type BridgeCallResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: BridgeErrorPayload };

export interface BridgeStatusSnapshot {
  running: boolean;
  healthy: boolean;
  pendingCount: number;
  closed: boolean;
  lastError: string | null;
}

interface PendingRequest {
  id: string;
  op: string;
  resolve: (result: BridgeCallResult<unknown>) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

const DEFAULT_BRIDGE_TIMEOUT_MS = 1_500;
const DEFAULT_AGENT_ID = "oh-my-pi";

export function buildBridgeArgs(config: BridgeConfig): string[] {
  const args: string[] = [];
  if (config.home) {
    args.push("--home", config.home);
  }
  if (config.port !== undefined) {
    args.push("--port", String(config.port));
  }
  args.push("bridge", "--agent", config.agent || DEFAULT_AGENT_ID);
  return args;
}

export class BridgeClient {
  private readonly config: BridgeConfig;
  private readonly report: FailureReporter;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  private child: ChildProcess | null = null;
  private closingChild: ChildProcess | null = null;
  private stdoutBuffer = "";
  private lastStderr = "";
  private nextRequestId = 0;
  private closed = false;
  private healthy = true;
  private reported = false;
  private lastError: string | null = null;

  constructor(config: BridgeConfig, report: FailureReporter) {
    this.config = config;
    this.report = report;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  }

  isHealthy(): boolean {
    return !this.closed && this.healthy;
  }

  statusSnapshot(): BridgeStatusSnapshot {
    return {
      running: this.child !== null,
      healthy: this.isHealthy(),
      pendingCount: this.pending.size,
      closed: this.closed,
      lastError: this.lastError,
    };
  }

  async call<T>(
    op: string,
    session: BridgeSessionContext,
    args: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<BridgeCallResult<T>> {
    if (this.closed) {
      return {
        ok: false,
        error: { code: "closed", message: "mem bridge client is closed" },
      };
    }

    const harnessSessionId = session.harnessSessionId?.trim();
    if (!harnessSessionId) {
      return {
        ok: false,
        error: { code: "invalid_args", message: "harnessSessionId is required" },
      };
    }

    if (options.signal?.aborted) {
      return {
        ok: false,
        error: { code: "aborted", message: "mem bridge call aborted" },
      };
    }

    const child = this.ensureChild();
    if (!child || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      return {
        ok: false,
        error: {
          code: "spawn_error",
          message: this.lastError ?? `could not start ${this.config.mem} bridge`,
        },
      };
    }

    const id = String(++this.nextRequestId);
    const envelope = {
      id,
      op,
      harness_session_id: harnessSessionId,
      cwd: session.cwd ?? null,
      project: session.project ?? null,
      args,
    };

    let line: string;
    try {
      line = `${JSON.stringify(envelope)}\n`;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: `could not serialize bridge request (${errorMessage(err)})`,
        },
      };
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<BridgeCallResult<T>>((resolve) => {
      const entry: PendingRequest = {
        id,
        op,
        resolve: resolve as (result: BridgeCallResult<unknown>) => void,
        timer: null,
        abortSignal: options.signal,
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) {
            return;
          }
          const detail = `mem bridge ${op} timed out after ${timeoutMs}ms`;
          this.settlePending(id, {
            ok: false,
            error: { code: "timeout", message: detail },
          });
          this.killWedgedChild(detail, "timeout");
        }, timeoutMs);
        entry.timer.unref?.();
      }

      if (options.signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) {
            return;
          }
          this.settlePending(id, {
            ok: false,
            error: { code: "aborted", message: "mem bridge call aborted" },
          });
        };
        entry.abortHandler = onAbort;
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, entry);

      try {
        child.stdin?.write(line, (err) => {
          if (err && this.pending.has(id)) {
            const detail = `mem bridge stdin write failed (${errorMessage(err)})`;
            this.settlePending(id, {
              ok: false,
              error: { code: "pipe_error", message: detail },
            });
            this.killWedgedChild(detail, "pipe_error");
          }
        });
      } catch (err) {
        const detail = `mem bridge stdin write failed (${errorMessage(err)})`;
        this.settlePending(id, {
          ok: false,
          error: { code: "pipe_error", message: detail },
        });
        this.killWedgedChild(detail, "pipe_error");
      }
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.settleAllPending("closed", "mem bridge client closed");

    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    if (!child) {
      return;
    }
    this.closingChild = child;
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) {
      try {
        stdin.end();
      } catch {
        // Ignore pipe errors during shutdown.
      }
    }
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);
  }

  private ensureChild(): ChildProcess | null {
    if (this.child) {
      return this.child;
    }
    const args = buildBridgeArgs(this.config);
    let child: ChildProcess;
    try {
      child = spawn(this.config.mem, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const detail = `could not start ${this.config.mem} bridge (${errorMessage(err)})`;
      this.healthy = false;
      this.lastError = detail;
      this.warnOnce(detail);
      return null;
    }

    this.child = child;
    this.stdoutBuffer = "";
    this.lastStderr = "";
    child.unref();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);

    child.stdin?.on("error", (err) => {
      if (this.child !== child || this.closed || this.closingChild === child) {
        return;
      }
      this.killWedgedChild(`mem bridge pipe failed (${errorMessage(err)})`, "pipe_error");
    });

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.child !== child) {
          return;
        }
        this.handleStdoutChunk(chunk);
      });
      child.stdout.on("error", (err) => {
        if (this.child !== child || this.closed || this.closingChild === child) {
          return;
        }
        this.killWedgedChild(`mem bridge stdout failed (${errorMessage(err)})`, "pipe_error");
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (this.child !== child) {
          return;
        }
        const lines = chunk
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 0) {
          this.lastStderr = lines[lines.length - 1];
        }
      });
      child.stderr.on("error", () => {
        // Ignore stderr pipe errors.
      });
    }

    child.on("error", (err) => {
      if (this.child !== child) {
        return;
      }
      const detail = `could not start ${this.config.mem} bridge (${errorMessage(err)})`;
      this.handleUnexpectedChildStop(child, "spawn_error", detail);
    });

    child.on("close", (code, signal) => {
      if (this.closingChild === child) {
        this.closingChild = null;
        return;
      }
      if (this.child !== child) {
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const extra = this.lastStderr ? `: ${this.lastStderr}` : "";
      this.handleUnexpectedChildStop(
        child,
        "process_exit",
        `mem bridge stopped (${reason})${extra}`,
      );
    });

    return child;
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      const trimmed = rawLine.trim();
      if (trimmed) {
        this.handleResponseLine(trimmed);
        if (!this.child) {
          return;
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponseLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.killWedgedChild(
        `mem bridge emitted invalid JSON (${errorMessage(err)})`,
        "protocol_error",
      );
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.killWedgedChild("mem bridge emitted non-object JSON response", "protocol_error");
      return;
    }
    const obj = parsed as {
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    };

    if (obj.id === undefined || obj.id === null) {
      return;
    }

    const id = String(obj.id);
    if (!this.pending.has(id)) {
      return;
    }

    this.healthy = true;
    this.lastError = null;

    if (obj.ok === true) {
      this.settlePending(id, {
        ok: true,
        result: obj.result,
      });
      return;
    }

    const errObj =
      obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)
        ? (obj.error as Record<string, unknown>)
        : {};
    const code = typeof errObj.code === "string" && errObj.code ? errObj.code : "bridge_error";
    const message =
      typeof errObj.message === "string" && errObj.message
        ? errObj.message
        : "mem bridge returned an error";
    this.settlePending(id, {
      ok: false,
      error: { code, message },
    });
  }

  private handleUnexpectedChildStop(child: ChildProcess, code: string, detail: string): void {
    if (this.child === child) {
      this.child = null;
      this.stdoutBuffer = "";
    }
    if (this.closed) {
      return;
    }
    this.healthy = false;
    this.lastError = detail;
    this.warnOnce(detail);
    this.settleAllPending(code, detail);
  }

  private killWedgedChild(detail: string, code: string): void {
    this.healthy = false;
    this.lastError = detail;
    this.warnOnce(detail);

    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    this.settleAllPending(code, detail);

    if (!child) {
      return;
    }
    this.closingChild = child;
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
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore already exited child.
    }
  }

  private settlePending(id: string, result: BridgeCallResult<unknown>): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.abortSignal && entry.abortHandler) {
      entry.abortSignal.removeEventListener("abort", entry.abortHandler);
      entry.abortHandler = undefined;
    }
    entry.resolve(result);
  }

  private settleAllPending(code: string, message: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settlePending(id, {
        ok: false,
        error: { code, message },
      });
    }
  }

  private warnOnce(detail: string): void {
    if (this.reported) {
      return;
    }
    this.reported = true;
    try {
      this.report(`corvus: ${detail}`);
    } catch {
      // Never let warning reporting crash omp.
    }
  }
}

function unrefStream(stream: unknown): void {
  if (stream && typeof (stream as { unref?: unknown }).unref === "function") {
    (stream as { unref: () => void }).unref();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
