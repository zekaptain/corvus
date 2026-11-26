/**
 * Safe install / status / uninstall logic for corvus.
 *
 * Owns strictly `<extensionsDir>/<MANAGED_EXTENSION_DIR_NAME>/`, guarded by an ownership
 * manifest (`manifest.json`) storing the owner marker, version, and SHA-256 hashes of
 * every managed file. Refuses to modify or remove foreign directories, unexpected user
 * files, or user-modified managed files.
 */

import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE_NAME,
  CORVUS_VERSION,
  DEFAULT_EXTENSIONS_DIR,
  EXTENSION_SOURCE_FILES,
  MANAGED_EXTENSION_DIR_NAME,
  MANAGED_FILES,
  MANIFEST_FILE_NAME,
  OWNER_MARKER,
} from "../constants.ts";

const PAYLOAD_FILES = [...EXTENSION_SOURCE_FILES, CONFIG_FILE_NAME] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class InstallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallerError";
  }
}

export interface InstallOptions {
  dir?: string;
  mem?: string;
  home?: string;
  port?: number;
  spoolOnly?: boolean;
  /** Override source directory containing `index.ts`, `mapper.ts`, `sink.ts` (for tests). */
  sourceDir?: string;
}

export interface StatusOptions {
  dir?: string;
  mem?: string;
  home?: string;
  port?: number;
  spoolOnly?: boolean;
  sourceDir?: string;
}

export interface UninstallOptions {
  dir?: string;
}

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

interface Manifest {
  managed_by: string;
  version: string;
  files: Record<string, string>;
}

interface InstalledConfig {
  managed_by?: unknown;
  mem?: unknown;
  home?: unknown;
  port?: unknown;
  spool_only?: unknown;
}

type InspectionResult =
  | { state: "absent" }
  | { state: "invalid"; reason: string }
  | {
      state: "managed";
      manifest: Manifest;
      modified: string[];
      missing: string[];
      diskBytes: Record<string, Buffer>;
    };

export function expandTilde(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function defaultSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "extension");
}

export function findExecutableOnPath(command: string): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    const abs = resolve(expandTilde(command));
    return isExecutableFile(abs) ? abs : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const entry of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!entry) continue;
    const candidate = join(entry, command);
    if (isExecutableFile(candidate)) {
      return resolve(candidate);
    }
  }
  return undefined;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveMemForInstall(given?: string): string {
  const candidate = given ?? process.env.AGENT_MEMORY_MEM;
  if (candidate) {
    const resolved =
      candidate.includes("/") || candidate.includes("\\")
        ? resolve(expandTilde(candidate))
        : findExecutableOnPath(candidate);
    if (!resolved || !isExecutableFile(resolved)) {
      throw new InstallerError(`${candidate} is not an executable mem command`);
    }
    return resolved;
  }
  const found = findExecutableOnPath("mem");
  if (!found) {
    throw new InstallerError(
      "could not find an executable `mem` command on PATH; pass --mem <path>",
    );
  }
  return found;
}

function resolveHome(given?: string): string {
  const raw = given ?? process.env.AGENT_MEMORY_HOME ?? "~/.agent-memory";
  return resolve(expandTilde(raw));
}

function resolvePort(given?: number): number {
  if (given !== undefined) {
    if (!Number.isInteger(given) || given <= 0 || given > 65535) {
      throw new InstallerError(`invalid --port ${given}; expected integer 1..65535`);
    }
    return given;
  }
  const envPort = process.env.AGENT_MEMORY_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new InstallerError(`invalid AGENT_MEMORY_PORT=${envPort}`);
    }
    return parsed;
  }
  return 9494;
}

function resolveExtensionsDir(given?: string): string {
  const raw = given ?? DEFAULT_EXTENSIONS_DIR;
  return resolve(expandTilde(raw));
}

function buildConfigBytes(
  memPath: string,
  homePath: string,
  port: number,
  spoolOnly: boolean,
): Buffer {
  const payload = {
    managed_by: OWNER_MARKER,
    mem: memPath,
    home: homePath,
    port,
    spool_only: spoolOnly,
  };
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildDesiredFiles(
  sourceDir: string,
  memPath: string,
  homePath: string,
  port: number,
  spoolOnly: boolean,
): Record<string, { data: Buffer; mode: number }> {
  const files: Record<string, { data: Buffer; mode: number }> = {};
  const hashes: Record<string, string> = {};

  for (const name of EXTENSION_SOURCE_FILES) {
    const srcPath = join(sourceDir, name);
    let data: Buffer;
    try {
      const st = statSync(srcPath);
      if (!st.isFile()) {
        throw new InstallerError(`bundled extension file ${srcPath} is missing`);
      }
      data = readFileSync(srcPath);
    } catch (err) {
      if (err instanceof InstallerError) throw err;
      throw new InstallerError(`bundled extension file ${srcPath} is missing`);
    }
    files[name] = { data, mode: 0o644 };
    hashes[name] = sha256Hex(data);
  }

  const configData = buildConfigBytes(memPath, homePath, port, spoolOnly);
  files[CONFIG_FILE_NAME] = { data: configData, mode: 0o600 };
  hashes[CONFIG_FILE_NAME] = sha256Hex(configData);

  const manifest: Manifest = {
    managed_by: OWNER_MARKER,
    version: CORVUS_VERSION,
    files: hashes,
  };
  files[MANIFEST_FILE_NAME] = {
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    mode: 0o644,
  };

  return files;
}

function parseManifest(manifestPath: string): Manifest | null {
  try {
    const st = lstatSync(manifestPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.managed_by !== OWNER_MARKER) {
      return null;
    }
    if (typeof obj.version !== "string" || !obj.version.trim()) {
      return null;
    }
    if (!obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) {
      return null;
    }
    const rawFiles = obj.files as Record<string, unknown>;
    const fileKeys = Object.keys(rawFiles).sort();
    const expectedKeys = [...PAYLOAD_FILES].sort();
    if (
      fileKeys.length !== expectedKeys.length ||
      fileKeys.some((k, idx) => k !== expectedKeys[idx])
    ) {
      return null;
    }
    const cleanFiles: Record<string, string> = {};
    for (const key of expectedKeys) {
      const val = rawFiles[key];
      if (typeof val !== "string" || !SHA256_RE.test(val)) {
        return null;
      }
      cleanFiles[key] = val;
    }
    return {
      managed_by: OWNER_MARKER,
      version: obj.version,
      files: cleanFiles,
    };
  } catch {
    return null;
  }
}

function readInstalledConfig(configPath: string): InstalledConfig | null {
  try {
    const st = lstatSync(configPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as InstalledConfig)
      : null;
  } catch {
    return null;
  }
}

function inspectTarget(target: string): InspectionResult {
  let targetStat: ReturnType<typeof lstatSync>;
  try {
    targetStat = lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return {
      state: "invalid",
      reason: `${target} cannot be inspected (${err instanceof Error ? err.message : err})`,
    };
  }

  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return {
      state: "invalid",
      reason: `${target} exists and is not a ${OWNER_MARKER} extension directory`,
    };
  }

  const manifest = parseManifest(join(target, MANIFEST_FILE_NAME));
  if (!manifest) {
    return {
      state: "invalid",
      reason: `${target} was not installed by ${OWNER_MARKER} (missing or invalid ${MANIFEST_FILE_NAME})`,
    };
  }

  const managedSet = new Set<string>(MANAGED_FILES);
  const entries = readdirSync(target);
  const extras = entries.filter((name) => !managedSet.has(name)).sort();
  if (extras.length > 0) {
    return {
      state: "invalid",
      reason: `${target} contains files not managed by ${OWNER_MARKER} (${extras.join(", ")})`,
    };
  }

  const badEntries: string[] = [];
  for (const name of entries) {
    const entryPath = join(target, name);
    const st = lstatSync(entryPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      badEntries.push(name);
    }
  }
  if (badEntries.length > 0) {
    return {
      state: "invalid",
      reason: `${target} contains unexpected non-file entries (${badEntries.sort().join(", ")})`,
    };
  }

  const modified: string[] = [];
  const missing: string[] = [];
  const diskBytes: Record<string, Buffer> = {};

  for (const name of PAYLOAD_FILES) {
    const filePath = join(target, name);
    if (!existsSync(filePath)) {
      missing.push(name);
      continue;
    }
    const bytes = readFileSync(filePath);
    diskBytes[name] = bytes;
    if (sha256Hex(bytes) !== manifest.files[name]) {
      modified.push(name);
    }
  }

  return {
    state: "managed",
    manifest,
    modified,
    missing,
    diskBytes,
  };
}

function writeAtomic(filePath: string, data: Buffer, mode: number): void {
  const dir = dirname(filePath);
  const tempDir = mkdtempSync(join(dir, ".tmp-"));
  const tempFile = join(tempDir, "part");
  try {
    writeFileSync(tempFile, data);
    chmodSync(tempFile, mode);
    renameSync(tempFile, filePath);
  } catch (err) {
    throw new InstallerError(
      `${filePath} cannot be written (${err instanceof Error ? err.message : err}); nothing was changed`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function countOtherExtensions(extensionsDir: string): number {
  try {
    if (!statSync(extensionsDir).isDirectory()) {
      return 0;
    }
    return readdirSync(extensionsDir).filter((name) => name !== MANAGED_EXTENSION_DIR_NAME).length;
  } catch {
    return 0;
  }
}

function formatOthersLine(extensionsDir: string): string | null {
  const count = countOtherExtensions(extensionsDir);
  if (count === 0) return null;
  const noun = count === 1 ? "other extension" : "other extensions";
  const verb = count === 1 ? "was" : "were";
  return `${count} ${noun} ${verb} left alone`;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function formatMemCommand(mem: string, home?: string, port?: number, spoolOnly?: boolean): string {
  const parts = [mem];
  if (home) {
    parts.push("--home", home);
  }
  if (port !== undefined) {
    parts.push("--port", String(port));
  }
  parts.push("records");
  if (spoolOnly) {
    parts.push("--spool-only");
  }
  return parts.map(shellQuote).join(" ");
}

export function installExtension(
  options: InstallOptions,
  io: CliIO = defaultIO(),
): { target: string; action: "installed" | "updated" | "unchanged" } {
  const extensionsDir = resolveExtensionsDir(options.dir);
  const memPath = resolveMemForInstall(options.mem);
  const homePath = resolveHome(options.home);
  const port = resolvePort(options.port);
  const spoolOnly = Boolean(options.spoolOnly);
  const sourceDir = options.sourceDir ?? defaultSourceDir();

  if (existsSync(extensionsDir)) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(extensionsDir);
    } catch (err) {
      throw new InstallerError(
        `${extensionsDir} cannot be accessed (${err instanceof Error ? err.message : err})`,
      );
    }
    if (!st.isDirectory()) {
      throw new InstallerError(`${extensionsDir} exists and is not a directory`);
    }
  } else {
    const parent = dirname(extensionsDir);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new InstallerError(
        `${parent} does not exist. omp reads ~/.omp/agent/extensions or a project's .omp/extensions; pass --dir`,
      );
    }
    try {
      mkdirSync(extensionsDir);
    } catch (err) {
      throw new InstallerError(
        `${extensionsDir} cannot be created (${err instanceof Error ? err.message : err})`,
      );
    }
  }

  const target = join(extensionsDir, MANAGED_EXTENSION_DIR_NAME);
  const desired = buildDesiredFiles(sourceDir, memPath, homePath, port, spoolOnly);
  const inspected = inspectTarget(target);

  if (inspected.state === "invalid") {
    throw new InstallerError(`${inspected.reason}; nothing was changed`);
  }

  if (inspected.state === "managed") {
    if (inspected.missing.length > 0 || inspected.modified.length > 0) {
      const problems: string[] = [];
      if (inspected.modified.length > 0) {
        problems.push(`user-modified file(s): ${inspected.modified.join(", ")}`);
      }
      if (inspected.missing.length > 0) {
        problems.push(`missing file(s): ${inspected.missing.join(", ")}`);
      }
      throw new InstallerError(
        `${target} has ${problems.join(" and ")}; refusing to overwrite. Nothing was changed`,
      );
    }

    const unchanged = MANAGED_FILES.every((name) => {
      const onDisk = readFileSync(join(target, name));
      return onDisk.equals(desired[name].data);
    });
    if (unchanged) {
      io.stdout(`already installed in ${target}; nothing to change`);
      io.stdout(`runs: ${formatMemCommand(memPath, homePath, port, spoolOnly)}`);
      const others = formatOthersLine(extensionsDir);
      if (others) io.stdout(others);
      return { target, action: "unchanged" };
    }

    for (const name of PAYLOAD_FILES) {
      const dest = join(target, name);
      const { data, mode } = desired[name];
      if (!inspected.diskBytes[name]?.equals(data)) {
        writeAtomic(dest, data, mode);
      }
    }
    const manifestEntry = desired[MANIFEST_FILE_NAME];
    writeAtomic(join(target, MANIFEST_FILE_NAME), manifestEntry.data, manifestEntry.mode);

    io.stdout(`updated ${OWNER_MARKER} extension in ${target}`);
    io.stdout(`runs: ${formatMemCommand(memPath, homePath, port, spoolOnly)}`);
    const others = formatOthersLine(extensionsDir);
    if (others) io.stdout(others);
    io.stdout("Start a new omp session to pick up the change.");
    return { target, action: "updated" };
  }

  // Fresh install: stage in a sibling temp directory and atomically rename into place.
  const staging = mkdtempSync(join(extensionsDir, `.${MANAGED_EXTENSION_DIR_NAME}.`));
  try {
    for (const name of MANAGED_FILES) {
      const dest = join(staging, name);
      writeFileSync(dest, desired[name].data);
      chmodSync(dest, desired[name].mode);
    }
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new InstallerError(
      `${target} cannot be written (${err instanceof Error ? err.message : err}); nothing was changed`,
    );
  }

  io.stdout(`installed ${OWNER_MARKER} extension in ${target}`);
  io.stdout(`runs: ${formatMemCommand(memPath, homePath, port, spoolOnly)}`);
  const others = formatOthersLine(extensionsDir);
  if (others) io.stdout(others);
  io.stdout("Start a new omp session to pick up the change.");
  return { target, action: "installed" };
}

export function statusExtension(options: StatusOptions, io: CliIO = defaultIO()): boolean {
  const extensionsDir = resolveExtensionsDir(options.dir);
  const target = join(extensionsDir, MANAGED_EXTENSION_DIR_NAME);
  const sourceDir = options.sourceDir ?? defaultSourceDir();
  const inspected = inspectTarget(target);

  if (inspected.state === "absent") {
    io.stdout(`${target} (not installed)`);
    return false;
  }

  if (inspected.state === "invalid") {
    io.stdout(`${target} (${inspected.reason})`);
    return false;
  }

  const installedCfg = readInstalledConfig(join(target, CONFIG_FILE_NAME));
  const memForComparison =
    options.mem !== undefined
      ? resolveMemForStatus(options.mem)
      : process.env.AGENT_MEMORY_MEM
        ? resolveMemForStatus(process.env.AGENT_MEMORY_MEM)
        : typeof installedCfg?.mem === "string" && installedCfg.mem
          ? installedCfg.mem
          : (findExecutableOnPath("mem") ?? "mem");

  const homePath = resolveHome(
    options.home ??
      (process.env.AGENT_MEMORY_HOME
        ? undefined
        : typeof installedCfg?.home === "string"
          ? installedCfg.home
          : undefined),
  );
  const port = resolvePort(
    options.port ??
      (process.env.AGENT_MEMORY_PORT
        ? undefined
        : typeof installedCfg?.port === "number"
          ? installedCfg.port
          : undefined),
  );
  const spoolOnly =
    options.spoolOnly ??
    (typeof installedCfg?.spool_only === "boolean" ? installedCfg.spool_only : false);

  const desired = buildDesiredFiles(sourceDir, memForComparison, homePath, port, spoolOnly);

  const fileStates: Record<string, string> = {};
  for (const name of PAYLOAD_FILES) {
    if (inspected.missing.includes(name)) {
      fileStates[name] = "missing";
    } else if (inspected.modified.includes(name)) {
      fileStates[name] = "modified";
    } else if (inspected.diskBytes[name]?.equals(desired[name].data)) {
      fileStates[name] = "installed";
    } else {
      fileStates[name] = name === CONFIG_FILE_NAME ? "differs" : "out of date";
    }
  }

  io.stdout(`${target} (${OWNER_MARKER} v${inspected.manifest.version})`);
  const width = Math.max(...Object.keys(fileStates).map((k) => k.length));
  for (const [name, state] of Object.entries(fileStates)) {
    io.stdout(`  ${name.padEnd(width)}  ${state}`);
  }

  if (typeof installedCfg?.mem === "string") {
    io.stdout(
      `runs: ${formatMemCommand(
        installedCfg.mem,
        typeof installedCfg.home === "string" ? installedCfg.home : undefined,
        typeof installedCfg.port === "number" ? installedCfg.port : undefined,
        installedCfg.spool_only === true,
      )}`,
    );
  }
  const others = formatOthersLine(extensionsDir);
  if (others) io.stdout(others);

  return (
    inspected.manifest.version === CORVUS_VERSION &&
    Object.values(fileStates).every((state) => state === "installed")
  );
}

function resolveMemForStatus(given: string): string {
  if (isAbsolute(given) || given.includes("/") || given.includes("\\")) {
    return resolve(expandTilde(given));
  }
  return findExecutableOnPath(given) ?? given;
}

export function uninstallExtension(
  options: UninstallOptions,
  io: CliIO = defaultIO(),
): { target: string; removed: boolean } {
  const extensionsDir = resolveExtensionsDir(options.dir);
  const target = join(extensionsDir, MANAGED_EXTENSION_DIR_NAME);
  const inspected = inspectTarget(target);

  if (inspected.state === "absent") {
    io.stdout(`${target} is not installed; nothing to change`);
    const others = formatOthersLine(extensionsDir);
    if (others) io.stdout(others);
    return { target, removed: false };
  }

  if (inspected.state === "invalid") {
    throw new InstallerError(`${inspected.reason}; nothing was changed`);
  }

  if (inspected.missing.length > 0 || inspected.modified.length > 0) {
    const problems: string[] = [];
    if (inspected.modified.length > 0) {
      problems.push(`user-modified file(s): ${inspected.modified.join(", ")}`);
    }
    if (inspected.missing.length > 0) {
      problems.push(`missing file(s): ${inspected.missing.join(", ")}`);
    }
    throw new InstallerError(
      `${target} has ${problems.join(" and ")}; refusing to remove. Nothing was changed`,
    );
  }

  try {
    for (const name of MANAGED_FILES) {
      const filePath = join(target, name);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
    rmdirSync(target);
  } catch (err) {
    throw new InstallerError(
      `${target} cannot be removed (${err instanceof Error ? err.message : err})`,
    );
  }

  io.stdout(`removed ${OWNER_MARKER} extension from ${target}`);
  const others = formatOthersLine(extensionsDir);
  if (others) io.stdout(others);
  io.stdout("Start a new omp session to pick up the change.");
  return { target, removed: true };
}

function defaultIO(): CliIO {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}
