import { runUpdate } from "./update.ts";
import type { CommandResult, CommandRunner } from "./resolver.ts";
import { resolve } from "node:path";

const SCHEMA_DIR = resolve(import.meta.dirname as string, "..", "schema");
const CORE_REPOSITORY = "https://github.com/uldrenai/uldren-core.git";
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function environment(repo: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    HOME: repo,
  };
}

function runGit(env: Record<string, string>, cwd: string, args: string[]): void {
  const output = new Deno.Command("git", {
    args,
    cwd,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (output.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${decode(output.stderr)}`);
  }
}

function runner(env: Record<string, string>, lsRemote: CommandResult): CommandRunner {
  return {
    run(command, args, cwd) {
      if (args[0] === "ls-remote") {
        return Promise.resolve(lsRemote);
      }
      const output = new Deno.Command(command, {
        args: [...args],
        cwd,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      return Promise.resolve({
        code: output.code,
        stdout: decode(output.stdout),
        stderr: decode(output.stderr),
      });
    },
  };
}

function lsRemote(...lines: string[]): CommandResult {
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

interface Repo {
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly file: string;
}

function initRepo(): Repo {
  const repo = Deno.makeTempDirSync({ prefix: "uldren-git-" });
  const env = environment(repo);
  runGit(env, repo, ["init", "--quiet", "-b", "main"]);
  Deno.mkdirSync(`${repo}/coordination`);
  return { repo, env, file: `${repo}/coordination/source-dependencies.json` };
}

function commitPin(fixture: Repo, commit: string): void {
  Deno.writeTextFileSync(fixture.file, coordination(commit));
  runGit(fixture.env, fixture.repo, ["add", "coordination/source-dependencies.json"]);
  runGit(fixture.env, fixture.repo, ["commit", "--quiet", "-m", "add pin"]);
}

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
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

Deno.test("real git: absent untracked path is created", async () => {
  const fixture = initRepo();
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_A}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 0, "exit code");
  assertEquals(Deno.readTextFileSync(fixture.file), coordination(SHA_A), "created content");
});

Deno.test("real git: clean tracked pin is updated", async () => {
  const fixture = initRepo();
  commitPin(fixture, SHA_A);
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_B}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 0, "exit code");
  assertEquals(Deno.readTextFileSync(fixture.file), coordination(SHA_B), "updated content");
});

Deno.test("real git: modified tracked pin is rejected", async () => {
  const fixture = initRepo();
  commitPin(fixture, SHA_A);
  Deno.writeTextFileSync(fixture.file, coordination(SHA_B));
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_A}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assertEquals(Deno.readTextFileSync(fixture.file), coordination(SHA_B), "no mutation");
});

Deno.test("real git: staged pin change is rejected", async () => {
  const fixture = initRepo();
  commitPin(fixture, SHA_A);
  Deno.writeTextFileSync(fixture.file, coordination(SHA_B));
  runGit(fixture.env, fixture.repo, ["add", "coordination/source-dependencies.json"]);
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_A}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
});

Deno.test("real git: staged deletion of the tracked pin is not recreated", async () => {
  const fixture = initRepo();
  commitPin(fixture, SHA_A);
  runGit(fixture.env, fixture.repo, ["rm", "--quiet", "coordination/source-dependencies.json"]);
  assert(!exists(fixture.file), "precondition: file removed");
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_A}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assert(!exists(fixture.file), "deletion preserved, not recreated");
});

Deno.test("real git: unstaged deletion of the tracked pin is not recreated", async () => {
  const fixture = initRepo();
  commitPin(fixture, SHA_A);
  Deno.removeSync(fixture.file);
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_A}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assert(!exists(fixture.file), "deletion preserved, not recreated");
});

Deno.test("real git: existing untracked pin is rejected", async () => {
  const fixture = initRepo();
  Deno.writeTextFileSync(fixture.file, coordination(SHA_A));
  const result = await runUpdate({
    runner: runner(fixture.env, lsRemote(`${SHA_B}\trefs/heads/main`)),
    schemaDirectory: SCHEMA_DIR,
    coordinationFile: fixture.file,
  });
  assertEquals(result.code, 1, "exit code");
  assert(result.stderr.includes("coordination-dirty"), "reason");
  assertEquals(Deno.readTextFileSync(fixture.file), coordination(SHA_A), "no mutation");
});
