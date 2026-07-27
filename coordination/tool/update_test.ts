import { nearestExistingDirectory, runUpdate } from "./update.ts";
import { type CommandResult, type CommandRunner, ResolverError } from "./resolver.ts";
import { resolve } from "node:path";

const SCHEMA_DIR = resolve(import.meta.dirname as string, "..", "schema");
const CORE_REPOSITORY = "https://github.com/uldrenai/uldren-core.git";
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

interface Capture {
  readonly calls: string[][];
}

interface Script {
  readonly lsRemote?: CommandResult;
  readonly status?: CommandResult;
}

function scriptedRunner(script: Script, capture?: Capture): CommandRunner {
  return {
    run(command, args, _cwd) {
      capture?.calls.push([command, ...args]);
      if (args[0] === "status") {
        return Promise.resolve(script.status ?? { code: 0, stdout: "", stderr: "" });
      }
      if (args[0] === "ls-remote") {
        return Promise.resolve(script.lsRemote ?? { code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected command" });
    },
  };
}

function lsRemote(...lines: string[]): CommandResult {
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return { code: 0, stdout: body, stderr: "" };
}

function statusLines(...lines: string[]): CommandResult {
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return { code: 0, stdout: body, stderr: "" };
}

function coordination(commit: string): string {
  return `${
    JSON.stringify(
      { schemaVersion: 1, dependencies: { core: { repository: CORE_REPOSITORY, commit } } },
      null,
      2,
    )
  }\n`;
}

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "uldren-update-" });
}

function permission(file: string): number {
  return (Deno.statSync(file).mode ?? 0) & 0o777;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

Deno.test("creates the coordination file when absent with the normal mode", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  const capture: Capture = { calls: [] };
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`) }, capture),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 0, "exit code");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "written content");
  assertEquals(permission(file), 0o644, "created mode");
  assertEquals(
    JSON.stringify(capture.calls),
    JSON.stringify([
      ["git", "status", "--porcelain", "--untracked-files=all", "--", file],
      ["git", "ls-remote", CORE_REPOSITORY, "refs/heads/main"],
    ]),
    "status probe runs even when absent, then argument-array ls-remote",
  );
  assertEquals(
    result.stdout,
    `${JSON.stringify({ update: { status: "created", commit: SHA_A } })}\n`,
    "stdout",
  );
});

Deno.test("updates only the commit and preserves formatting and mode", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  Deno.chmodSync(file, 0o640);
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_B}\trefs/heads/main`) }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 0, "exit code");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_B), "updated content");
  assertEquals(permission(file), 0o640, "preserved mode");
});

Deno.test("reports unchanged without mutating", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const before = Deno.statSync(file).mtime?.getTime();
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`) }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 0, "exit code");
  assertEquals(
    result.stdout,
    `${JSON.stringify({ update: { status: "unchanged", commit: SHA_A } })}\n`,
    "stdout",
  );
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "content preserved");
  assertEquals(Deno.statSync(file).mtime?.getTime(), before, "file not rewritten");
});

Deno.test("rejects a tracked but modified coordination file before ls-remote", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const capture: Capture = { calls: [] };
  const result = await runUpdate({
    runner: scriptedRunner({
      status: statusLines(" M coordination/source-dependencies.json"),
      lsRemote: lsRemote(`${SHA_B}\trefs/heads/main`),
    }, capture),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
  assert(capture.calls.every((call) => call[1] !== "ls-remote"), "ls-remote not reached");
});

Deno.test("rejects a staged coordination file", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({
      status: statusLines("M  coordination/source-dependencies.json"),
      lsRemote: lsRemote(`${SHA_B}\trefs/heads/main`),
    }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("rejects an existing untracked coordination file", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({
      status: statusLines("?? coordination/source-dependencies.json"),
      lsRemote: lsRemote(`${SHA_B}\trefs/heads/main`),
    }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("fails without mutation when the worktree status probe fails", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({ status: { code: 1, stdout: "", stderr: "fatal" } }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("worktree-status-failed"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("rejects a non-regular destination without mutating it", async () => {
  const dir = tempDir();
  const target = `${dir}/target.json`;
  Deno.writeTextFileSync(target, coordination(SHA_A));
  const link = `${dir}/source-dependencies.json`;
  Deno.symlinkSync(target, link);
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_B}\trefs/heads/main`) }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: link,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-not-regular"), "reason");
  assertEquals(Deno.readTextFileSync(target), coordination(SHA_A), "target preserved");
});

Deno.test("fails without mutation when main is missing", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote() }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("core-main-missing"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("fails without mutation on a malformed listing", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote("not-a-sha\trefs/heads/main") }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("core-main-malformed"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("fails without mutation on multiple references", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({
      lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`, `${SHA_B}\trefs/heads/main`),
    }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("core-main-ambiguous"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("fails without mutation when ls-remote fails", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, coordination(SHA_A));
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: { code: 128, stdout: "", stderr: "fatal" } }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("git-command-failed"), "reason");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "no mutation");
});

Deno.test("rejects an invalid existing document before any git call", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  Deno.writeTextFileSync(file, "{ not valid json");
  const capture: Capture = { calls: [] };
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`) }, capture),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("invalid-coordination"), "reason");
  assertEquals(Deno.readTextFileSync(file), "{ not valid json", "no mutation");
  assertEquals(capture.calls.length, 0, "no git command runs for an invalid document");
});

Deno.test("rejects a schema-invalid existing document", async () => {
  const file = `${tempDir()}/source-dependencies.json`;
  const invalid = `${JSON.stringify({ schemaVersion: 1, dependencies: {} }, null, 2)}\n`;
  Deno.writeTextFileSync(file, invalid);
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`) }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("invalid-coordination"), "reason");
  assertEquals(Deno.readTextFileSync(file), invalid, "no mutation");
});

Deno.test("creates the pin in a nested directory that does not yet exist", async () => {
  const file = `${tempDir()}/nested/dir/source-dependencies.json`;
  const result = await runUpdate({
    runner: scriptedRunner({ lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`) }),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: file,
  });
  assertEquals(result.code, 0, "exit code");
  assertEquals(Deno.readTextFileSync(file), coordination(SHA_A), "created content");
});

Deno.test("nearestExistingDirectory returns an existing directory", () => {
  const dir = tempDir();
  assertEquals(nearestExistingDirectory(dir), dir, "returns the directory itself");
});

Deno.test("nearestExistingDirectory ascends over an absent leaf", () => {
  const dir = tempDir();
  assertEquals(
    nearestExistingDirectory(`${dir}/absent/deeper`),
    dir,
    "ascends to the nearest existing ancestor",
  );
});

Deno.test("nearestExistingDirectory fails stably on a non-NotFound stat error", () => {
  const probed: string[] = [];
  const stat = (path: string): Deno.FileInfo => {
    probed.push(path);
    throw new Deno.errors.PermissionDenied("denied");
  };
  let reason: string | undefined;
  try {
    nearestExistingDirectory("/some/coordination", stat);
  } catch (error) {
    assert(error instanceof ResolverError, "throws a ResolverError");
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "coordination-unwritable", "reason");
  assertEquals(
    JSON.stringify(probed),
    JSON.stringify(["/some/coordination"]),
    "no parent traversal",
  );
});

Deno.test("nearestExistingDirectory rejects a non-directory path", () => {
  const dir = tempDir();
  const file = `${dir}/regular`;
  Deno.writeTextFileSync(file, "x");
  let reason: string | undefined;
  try {
    nearestExistingDirectory(file);
  } catch (error) {
    assert(error instanceof ResolverError, "throws a ResolverError");
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "coordination-unwritable", "reason");
});

Deno.test("produces deterministic output across runs", async () => {
  const first = `${tempDir()}/source-dependencies.json`;
  const second = `${tempDir()}/source-dependencies.json`;
  const script: Script = { lsRemote: lsRemote(`${SHA_A}\trefs/heads/main`) };
  await runUpdate({
    runner: scriptedRunner(script),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: first,
  });
  await runUpdate({
    runner: scriptedRunner(script),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: second,
  });
  assertEquals(Deno.readTextFileSync(first), Deno.readTextFileSync(second), "identical output");
  assertEquals(Deno.readTextFileSync(first), coordination(SHA_A), "canonical output");
});
