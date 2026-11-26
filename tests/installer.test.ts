import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli } from "../src/cli/index.ts";
import { sha256Hex } from "../src/cli/installer.ts";
import {
  CONFIG_FILE_NAME,
  CORVUS_VERSION,
  EXTENSION_SOURCE_FILES,
  MANAGED_EXTENSION_DIR_NAME,
  MANAGED_FILES,
  MANIFEST_FILE_NAME,
  OWNER_MARKER,
} from "../src/constants.ts";

function createTestCli() {
  return (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(argv, {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    return {
      code,
      stdout: out.join("\n"),
      stderr: err.join("\n"),
    };
  };
}

describe("corvus installer CLI", () => {
  let rootDir: string;
  let extDir: string;
  let homeDir: string;
  let memBin: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "corvus-cli-test-"));
    extDir = join(rootDir, "omp", "agent", "extensions");
    mkdirSync(extDir, { recursive: true });
    homeDir = join(rootDir, "ledger-home");
    mkdirSync(homeDir, { recursive: true });
    memBin = join(rootDir, "mem");
    writeFileSync(memBin, "#!/bin/sh\ncat > /dev/null\n");
    chmodSync(memBin, 0o755);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("installs, reports status, updates cleanly, and uninstalls using --dir", () => {
    const cli = createTestCli();
    const target = join(extDir, MANAGED_EXTENSION_DIR_NAME);

    // Initially not installed
    const st0 = cli(["status", "--dir", extDir]);
    assert.equal(st0.code, 1);
    assert.match(st0.stdout, /not installed/);

    // Install
    const inst = cli([
      "install",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "9555",
    ]);
    assert.equal(inst.code, 0, inst.stderr);
    assert.match(inst.stdout, /installed corvus extension/);
    assert.ok(statSync(target).isDirectory());

    // Config permissions and manifest hashes
    assert.equal(statSync(join(target, CONFIG_FILE_NAME)).mode & 0o777, 0o600);
    const cfg = JSON.parse(readFileSync(join(target, CONFIG_FILE_NAME), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(cfg.managed_by, OWNER_MARKER);
    assert.equal(cfg.mem, memBin);
    assert.equal(cfg.home, homeDir);
    assert.equal(cfg.port, 9555);
    assert.equal(cfg.spool_only, false);

    const manifest = JSON.parse(readFileSync(join(target, MANIFEST_FILE_NAME), "utf8")) as {
      managed_by: string;
      version: string;
      files: Record<string, string>;
    };
    assert.equal(manifest.managed_by, OWNER_MARKER);
    assert.equal(manifest.version, CORVUS_VERSION);
    for (const file of [...EXTENSION_SOURCE_FILES, CONFIG_FILE_NAME]) {
      assert.equal(manifest.files[file], sha256Hex(readFileSync(join(target, file))));
    }

    // Status exits 0 and shows every payload file installed
    const st1 = cli([
      "status",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "9555",
    ]);
    assert.equal(st1.code, 0, st1.stdout);
    for (const file of [...EXTENSION_SOURCE_FILES, CONFIG_FILE_NAME]) {
      assert.match(st1.stdout, new RegExp(`${file}\\s+installed`));
    }

    // Idempotent reinstall leaves file inodes unchanged
    const inodesBefore = Object.fromEntries(
      MANAGED_FILES.map((name) => [name, statSync(join(target, name)).ino]),
    );
    const reinst = cli([
      "install",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "9555",
    ]);
    assert.equal(reinst.code, 0, reinst.stderr);
    assert.match(reinst.stdout, /nothing to change/);
    const inodesAfter = Object.fromEntries(
      MANAGED_FILES.map((name) => [name, statSync(join(target, name)).ino]),
    );
    assert.deepEqual(inodesAfter, inodesBefore);

    // Changing port causes status to report differs, and reinstall updates cleanly
    const stPort = cli([
      "status",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "9666",
    ]);
    assert.equal(stPort.code, 1);
    assert.match(stPort.stdout, /differs/);

    const upd = cli([
      "install",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "9666",
    ]);
    assert.equal(upd.code, 0, upd.stderr);
    assert.match(upd.stdout, /updated corvus extension/);
    const updatedCfg = JSON.parse(readFileSync(join(target, CONFIG_FILE_NAME), "utf8")) as {
      port: number;
    };
    assert.equal(updatedCfg.port, 9666);
    assert.equal(cli(["status", "--dir", extDir]).code, 0);

    // Uninstall removes managed directory and leaves extensions parent intact
    const uninst = cli(["uninstall", "--dir", extDir]);
    assert.equal(uninst.code, 0, uninst.stderr);
    assert.match(uninst.stdout, /removed corvus extension/);
    assert.equal(existsSync(target), false);
    assert.equal(statSync(extDir).isDirectory(), true);

    // Re-running uninstall is a clean no-op
    const reuninst = cli(["uninstall", "--dir", extDir]);
    assert.equal(reuninst.code, 0);
    assert.match(reuninst.stdout, /not installed/);
  });

  it("leaves sibling extensions and files in --dir untouched", () => {
    const cli = createTestCli();
    const siblingFile = join(extDir, "custom-guard.ts");
    writeFileSync(siblingFile, "export default function () {}\n");
    const siblingDir = join(extDir, "agent-memory");
    mkdirSync(siblingDir);
    writeFileSync(join(siblingDir, "index.ts"), "// existing extension\n");

    const inst = cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]);
    assert.equal(inst.code, 0, inst.stderr);
    assert.match(inst.stdout, /2 other extensions were left alone/);
    assert.equal(readFileSync(siblingFile, "utf8"), "export default function () {}\n");
    assert.equal(readFileSync(join(siblingDir, "index.ts"), "utf8"), "// existing extension\n");

    const uninst = cli(["uninstall", "--dir", extDir]);
    assert.equal(uninst.code, 0, uninst.stderr);
    assert.match(uninst.stdout, /2 other extensions were left alone/);
    assert.equal(readFileSync(siblingFile, "utf8"), "export default function () {}\n");
    assert.equal(readFileSync(join(siblingDir, "index.ts"), "utf8"), "// existing extension\n");
  });

  it("creates missing extensions dir when parent exists and refuses when parent is missing", () => {
    const cli = createTestCli();
    const freshAgentDir = join(rootDir, "fresh-omp", "agent");
    mkdirSync(freshAgentDir, { recursive: true });
    const freshExtDir = join(freshAgentDir, "extensions");

    const inst = cli(["install", "--dir", freshExtDir, "--mem", memBin, "--home", homeDir]);
    assert.equal(inst.code, 0, inst.stderr);
    assert.equal(existsSync(join(freshExtDir, MANAGED_EXTENSION_DIR_NAME, "index.ts")), true);

    const missingParentExtDir = join(rootDir, "does-not-exist", "extensions");
    const bad = cli(["install", "--dir", missingParentExtDir, "--mem", memBin, "--home", homeDir]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /does not exist/);
  });

  it("refuses foreign directories, files, symlinks, and unexpected user files", () => {
    const cli = createTestCli();
    const target = join(extDir, MANAGED_EXTENSION_DIR_NAME);

    // 1. Foreign directory without manifest.json
    mkdirSync(target);
    writeFileSync(join(target, "index.ts"), "// user's own extension\n");
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 1);
    assert.equal(cli(["status", "--dir", extDir]).code, 1);
    assert.equal(cli(["uninstall", "--dir", extDir]).code, 1);
    assert.equal(readFileSync(join(target, "index.ts"), "utf8"), "// user's own extension\n");
    rmSync(target, { recursive: true, force: true });

    // 2. Foreign manifest with wrong owner marker
    mkdirSync(target);
    writeFileSync(
      join(target, MANIFEST_FILE_NAME),
      JSON.stringify({ managed_by: "someone-else", version: "1.0.0", files: {} }),
    );
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 1);
    assert.equal(cli(["uninstall", "--dir", extDir]).code, 1);
    rmSync(target, { recursive: true, force: true });

    // 3. Regular file at target path
    writeFileSync(target, "not a directory\n");
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 1);
    assert.equal(cli(["uninstall", "--dir", extDir]).code, 1);
    assert.equal(readFileSync(target, "utf8"), "not a directory\n");
    unlinkSync(target);

    // 4. Symlink at target path
    const realElsewhere = join(rootDir, "elsewhere");
    mkdirSync(realElsewhere);
    symlinkSync(realElsewhere, target);
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 1);
    assert.equal(cli(["uninstall", "--dir", extDir]).code, 1);
    unlinkSync(target);

    // 5. Unexpected user file inside an otherwise managed directory
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 0);
    const userNote = join(target, "notes.txt");
    writeFileSync(userNote, "keep me\n");
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 1);
    assert.equal(cli(["status", "--dir", extDir]).code, 1);
    assert.equal(cli(["uninstall", "--dir", extDir]).code, 1);
    assert.equal(readFileSync(userNote, "utf8"), "keep me\n");
  });

  it("refuses to overwrite or delete user-modified or missing managed files", () => {
    const cli = createTestCli();
    const target = join(extDir, MANAGED_EXTENSION_DIR_NAME);

    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 0);

    // User edits mapper.ts
    const mapperPath = join(target, "mapper.ts");
    const modifiedContent = `${readFileSync(mapperPath, "utf8")}\n// local user edit\n`;
    writeFileSync(mapperPath, modifiedContent);

    const stMod = cli(["status", "--dir", extDir]);
    assert.equal(stMod.code, 1);
    assert.match(stMod.stdout, /mapper\.ts\s+modified/);

    const instMod = cli([
      "install",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "9777",
    ]);
    assert.equal(instMod.code, 1);
    assert.match(instMod.stderr, /user-modified/);
    assert.equal(readFileSync(mapperPath, "utf8"), modifiedContent);

    const uninstMod = cli(["uninstall", "--dir", extDir]);
    assert.equal(uninstMod.code, 1);
    assert.match(uninstMod.stderr, /user-modified/);
    assert.equal(readFileSync(mapperPath, "utf8"), modifiedContent);

    // Missing managed file also refuses install and uninstall
    unlinkSync(mapperPath);
    const stMiss = cli(["status", "--dir", extDir]);
    assert.equal(stMiss.code, 1);
    assert.match(stMiss.stdout, /mapper\.ts\s+missing/);
    assert.equal(cli(["install", "--dir", extDir, "--mem", memBin, "--home", homeDir]).code, 1);
    assert.equal(cli(["uninstall", "--dir", extDir]).code, 1);
  });

  it("validates --mem, --port, and runs end-to-end via the CLI entrypoint", async () => {
    const cli = createTestCli();
    const badMem = join(rootDir, "not-executable");
    writeFileSync(badMem, "echo nope\n");

    const badMemRes = cli(["install", "--dir", extDir, "--mem", badMem, "--home", homeDir]);
    assert.equal(badMemRes.code, 1);
    assert.match(badMemRes.stderr, /not an executable/);

    const badPortRes = cli([
      "install",
      "--dir",
      extDir,
      "--mem",
      memBin,
      "--home",
      homeDir,
      "--port",
      "0",
    ]);
    assert.equal(badPortRes.code, 1);
    assert.match(badPortRes.stderr, /invalid --port/);

    // Drive the actual CLI script in a subprocess against a temp dir and capture records.
    const capturedPath = join(rootDir, "captured.jsonl");
    const fakeMem = join(rootDir, "fake-mem");
    writeFileSync(fakeMem, `#!/bin/sh\ncat > "${capturedPath}"\n`);
    chmodSync(fakeMem, 0o755);

    const cliEntry = resolve(import.meta.dir, "../src/cli/index.ts");
    const proc = Bun.spawnSync(
      [
        process.execPath,
        cliEntry,
        "install",
        "--dir",
        extDir,
        "--mem",
        fakeMem,
        "--home",
        homeDir,
        "--port",
        "9888",
        "--spool-only",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    assert.equal(proc.exitCode, 0, proc.stderr.toString());

    // Load the installed extension directly from `<extDir>/corvus/index.ts` in a subprocess.
    const installedIndex = join(extDir, MANAGED_EXTENSION_DIR_NAME, "index.ts");
    const runner = join(rootDir, "drive-installed.ts");
    writeFileSync(
      runner,
      `import corvusExtension from ${JSON.stringify(installedIndex)};
const handlers = new Map();
corvusExtension({
  pi: { VERSION: "19.1.1" },
  on(ev, fn) {
    const list = handlers.get(ev) ?? [];
    list.push(fn);
    handlers.set(ev, list);
  },
});
const sm = {
  getSessionId: () => "sid-installed-e2e",
  getSessionFile: () => "/tmp/s.jsonl",
  getEntries: () => [{ type: "model_change", id: "11111111", timestamp: "2026-11-25T03:00:00.000Z" }],
  getLeafId: () => "11111111",
};
const ctx = { cwd: "/tmp/proj", mode: "print", hasUI: false, sessionManager: sm };
for (const fn of handlers.get("session_start") ?? []) fn({}, ctx);
for (const fn of handlers.get("session_shutdown") ?? []) fn({}, ctx);
await new Promise((r) => setTimeout(r, 120));
`,
    );

    const extProc = Bun.spawnSync([process.execPath, runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(extProc.exitCode, 0, extProc.stderr.toString());
    const lines = readFileSync(capturedPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; harness_session_id: string });
    assert.deepEqual(
      lines.map((l) => [l.kind, l.harness_session_id]),
      [
        ["session_start", "sid-installed-e2e"],
        ["session_end", "sid-installed-e2e"],
      ],
    );
  });
});
