import { type CliResult, type Resolver, runCli } from "./cli.ts";
import {
  APPLICATION_REPOSITORY,
  type CommandRunner,
  CORE_REPOSITORY,
  defaultSchemaDirectory,
  type ResolutionOutput,
  type ResolvedNode,
  SourceResolver,
} from "./resolver.ts";
import { join } from "node:path";

const SCHEMA_DIR = defaultSchemaDirectory();

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function environmentRunner(env: Record<string, string>): CommandRunner {
  return {
    async run(command, args, cwd) {
      const output = await new Deno.Command(command, {
        args: [...args],
        cwd,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: output.code, stdout: decode(output.stdout), stderr: decode(output.stderr) };
    },
  };
}

async function git(env: Record<string, string>, cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${decode(output.stderr)}`);
  }
  return decode(output.stdout).trim();
}

interface Fixture {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly rootDir: string;
  readonly workspace: string;
  readonly remote: string;
}

async function withFixture(
  coreCommit: string | "seed",
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "uld36-cli-" });
  try {
    const home = join(root, "home");
    await Deno.mkdir(home);
    const config = join(root, "gitconfig");
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: home,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Uldren Test",
      GIT_AUTHOR_EMAIL: "test@uldren.local",
      GIT_COMMITTER_NAME: "Uldren Test",
      GIT_COMMITTER_EMAIL: "test@uldren.local",
    };
    const remote = join(root, "remote");
    await Deno.mkdir(remote, { recursive: true });
    await git(env, remote, "init", "--quiet");
    await git(env, remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    await Deno.writeTextFile(join(remote, "README.md"), "core\n");
    await git(env, remote, "add", "README.md");
    await git(env, remote, "commit", "--quiet", "-m", "initial");
    const seeded = await git(env, remote, "rev-parse", "HEAD");
    await Deno.writeTextFile(
      config,
      `[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[url "${remote}"]\n\tinsteadOf = ${CORE_REPOSITORY}\n`,
    );
    const commit = coreCommit === "seed" ? seeded : coreCommit;
    const rootDir = join(root, "application");
    await Deno.mkdir(join(rootDir, "coordination"), { recursive: true });
    await git(env, rootDir, "init", "--quiet");
    await git(env, rootDir, "remote", "add", "origin", APPLICATION_REPOSITORY);
    await Deno.writeTextFile(join(rootDir, ".gitignore"), "/.uldren/\n");
    await Deno.writeTextFile(join(rootDir, "README.md"), "app\n");
    await Deno.writeTextFile(
      join(rootDir, "coordination", "source-dependencies.json"),
      `${
        JSON.stringify(
          { schemaVersion: 1, dependencies: { core: { repository: CORE_REPOSITORY, commit } } },
          null,
          2,
        )
      }\n`,
    );
    await git(env, rootDir, "add", "--all");
    await git(env, rootDir, "commit", "--quiet", "-m", "initial");
    await run({ root, env, rootDir, workspace: join(rootDir, ".uldren/dependencies"), remote });
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

function reasonOf(result: CliResult): string {
  const parsed = JSON.parse(result.stderr) as { error?: { reason?: string } };
  if (parsed.error?.reason === undefined) {
    throw new Error(`missing error reason in ${result.stderr}`);
  }
  return parsed.error.reason;
}

function envResolver(env: Record<string, string>): Resolver {
  return new SourceResolver(environmentRunner(env), SCHEMA_DIR);
}

Deno.test("cli emits a successful resolution as valid JSON", async () => {
  await withFixture("seed", async (fixture) => {
    const result = await runCli(
      ["--mode", "application-direct", "--root", fixture.rootDir, "--workspace", fixture.workspace],
      { resolver: envResolver(fixture.env), schemaDirectory: SCHEMA_DIR },
    );
    if (result.code !== 0 || result.stderr.length !== 0) {
      throw new Error(`unexpected failure: ${JSON.stringify(result)}`);
    }
    const output = JSON.parse(result.stdout) as ResolutionOutput;
    if (output.resolved.length !== 2) {
      throw new Error(`unexpected output: ${result.stdout}`);
    }
  });
});

Deno.test("cli reports invalid invocation with a stable reason", async () => {
  const result = await runCli(["--mode", "sideways", "--root", "/x", "--workspace", "/y"], {
    schemaDirectory: SCHEMA_DIR,
  });
  if (
    result.code !== 2 || reasonOf(result) !== "invalid-invocation" || result.stdout.length !== 0
  ) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
});

Deno.test("cli reports a missing required argument", async () => {
  const result = await runCli(["--mode", "application-direct", "--root", "/x"], {
    schemaDirectory: SCHEMA_DIR,
  });
  if (result.code !== 2 || reasonOf(result) !== "invalid-invocation") {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
});

Deno.test("cli reports invalid coordination", async () => {
  await withFixture("seed", async (fixture) => {
    await Deno.writeTextFile(
      join(fixture.rootDir, "coordination", "source-dependencies.json"),
      "{ broken",
    );
    const result = await runCli(
      ["--mode", "application-direct", "--root", fixture.rootDir, "--workspace", fixture.workspace],
      { resolver: envResolver(fixture.env), schemaDirectory: SCHEMA_DIR },
    );
    if (result.code !== 1 || reasonOf(result) !== "invalid-coordination") {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
  });
});

Deno.test("cli reports an unavailable pinned commit", async () => {
  await withFixture("0".repeat(40), async (fixture) => {
    const result = await runCli(
      ["--mode", "application-direct", "--root", fixture.rootDir, "--workspace", fixture.workspace],
      { resolver: envResolver(fixture.env), schemaDirectory: SCHEMA_DIR },
    );
    if (result.code !== 1 || reasonOf(result) !== "commit-unavailable") {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
  });
});

Deno.test("cli reports workspace lock contention", async () => {
  await withFixture("seed", async (fixture) => {
    await Deno.mkdir(join(fixture.workspace, ".lock"), { recursive: true });
    const result = await runCli(
      ["--mode", "application-direct", "--root", fixture.rootDir, "--workspace", fixture.workspace],
      { resolver: envResolver(fixture.env), schemaDirectory: SCHEMA_DIR },
    );
    if (result.code !== 1 || reasonOf(result) !== "workspace-locked") {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
  });
});

Deno.test("cli rejects malformed resolver output", async () => {
  const malformed: Resolver = {
    resolve(): Promise<ResolutionOutput> {
      return Promise.resolve({ schemaVersion: 1, resolved: [] });
    },
  };
  const result = await runCli(
    ["--mode", "application-direct", "--root", "/x", "--workspace", "/y"],
    { resolver: malformed, schemaDirectory: SCHEMA_DIR },
  );
  if (result.code !== 1 || reasonOf(result) !== "malformed-output") {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
});

Deno.test("cli rejects semantically invalid resolution graphs", async () => {
  const application: ResolvedNode = {
    name: "application",
    repository: APPLICATION_REPOSITORY,
    commit: "a".repeat(40),
    path: "/abs/application",
    sourceKind: "root",
    dirty: false,
  };
  const core: ResolvedNode = {
    name: "core",
    repository: CORE_REPOSITORY,
    commit: "b".repeat(40),
    path: "/abs/core",
    sourceKind: "managed",
    dirty: false,
  };
  const invalid: ResolutionOutput[] = [
    { schemaVersion: 1, resolved: [application] },
    { schemaVersion: 1, resolved: [core, application] },
    { schemaVersion: 1, resolved: [{ ...application, repository: CORE_REPOSITORY }, core] },
    { schemaVersion: 1, resolved: [{ ...application, sourceKind: "managed" }, core] },
    { schemaVersion: 1, resolved: [{ ...application, path: "relative/application" }, core] },
    { schemaVersion: 1, resolved: [application, core, core] },
    {
      schemaVersion: 1,
      resolved: [application, {
        ...core,
        repository: "https://user:token@github.com/uldrenai/uldren-core.git",
      }],
    },
    { schemaVersion: 1, resolved: [application, application] },
  ];
  for (const output of invalid) {
    const resolver: Resolver = { resolve: () => Promise.resolve(output) };
    const result = await runCli(
      ["--mode", "application-direct", "--root", "/x", "--workspace", "/y"],
      { resolver, schemaDirectory: SCHEMA_DIR },
    );
    if (result.code !== 1 || reasonOf(result) !== "malformed-output") {
      throw new Error(
        `expected malformed-output for ${JSON.stringify(output)}: ${JSON.stringify(result)}`,
      );
    }
  }
});

Deno.test("the executable CLI resolves against real repositories", async () => {
  await withFixture("seed", async (fixture) => {
    const cli = join(import.meta.dirname ?? ".", "cli.ts");
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--allow-read",
        "--allow-write",
        "--allow-run=git",
        "--allow-env=TMPDIR",
        cli,
        "--mode",
        "application-direct",
        "--root",
        fixture.rootDir,
        "--workspace",
        fixture.workspace,
      ],
      cwd: Deno.cwd(),
      env: {
        GIT_CONFIG_GLOBAL: fixture.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_SYSTEM: fixture.env.GIT_CONFIG_SYSTEM,
        GIT_AUTHOR_NAME: fixture.env.GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: fixture.env.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: fixture.env.GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: fixture.env.GIT_COMMITTER_EMAIL,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = decode(output.stdout);
    const stderr = decode(output.stderr);
    if (output.code !== 0 || stderr.length !== 0) {
      throw new Error(`smoke failed: code=${output.code} stderr=${stderr}`);
    }
    const parsed = JSON.parse(stdout) as ResolutionOutput;
    if (
      parsed.resolved.length !== 2 || parsed.resolved[0].name !== "application" ||
      parsed.resolved[1].name !== "core"
    ) {
      throw new Error(`unexpected smoke output: ${stdout}`);
    }
  });
});
