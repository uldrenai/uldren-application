import {
  assertManagedIntegrity,
  parseIntegrityArguments,
  runIntegrity,
  selectResolvedNodes,
} from "./integrity.ts";
import {
  APPLICATION_REPOSITORY,
  CORE_REPOSITORY,
  defaultSchemaDirectory,
  type ResolvedNode,
  ResolverError,
  SourceResolver,
} from "./resolver.ts";
import { join } from "node:path";

const SCHEMA_DIR = defaultSchemaDirectory();

interface Sandbox {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly config: string;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function runnerFor(env: Record<string, string>) {
  return {
    async run(command: string, args: readonly string[], cwd: string) {
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

async function makeSandbox(): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix: "uld43-" });
  const home = join(root, "home");
  await Deno.mkdir(home);
  const config = join(root, "gitconfig");
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Uldren Test",
    GIT_AUTHOR_EMAIL: "test@uldren.local",
    GIT_COMMITTER_NAME: "Uldren Test",
    GIT_COMMITTER_EMAIL: "test@uldren.local",
  };
  await Deno.writeTextFile(
    config,
    `[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n`,
  );
  return { root, env, config };
}

async function redirectCore(sandbox: Sandbox, coreDirectory: string): Promise<void> {
  await Deno.writeTextFile(
    sandbox.config,
    `[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[url "${coreDirectory}"]\n\tinsteadOf = ${CORE_REPOSITORY}\n`,
  );
}

async function seedCore(sandbox: Sandbox): Promise<string> {
  const dir = join(sandbox.root, "core");
  await Deno.mkdir(dir, { recursive: true });
  await git(sandbox.env, dir, "init", "--quiet", "-b", "main");
  await git(sandbox.env, dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  await Deno.writeTextFile(join(dir, "README.md"), "core\n");
  await git(sandbox.env, dir, "add", "README.md");
  await git(sandbox.env, dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

async function writePin(dir: string, coreCommit: string): Promise<void> {
  const document = {
    schemaVersion: 1,
    dependencies: { core: { repository: CORE_REPOSITORY, commit: coreCommit } },
  };
  await Deno.writeTextFile(
    join(dir, "coordination", "source-dependencies.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

async function seedApplicationWithRemote(
  sandbox: Sandbox,
  coreCommit: string,
  origin: string,
): Promise<string> {
  const dir = join(sandbox.root, "application");
  await Deno.mkdir(join(dir, "coordination"), { recursive: true });
  await git(sandbox.env, dir, "init", "--quiet", "-b", "main");
  await git(sandbox.env, dir, "remote", "add", "origin", origin);
  await Deno.writeTextFile(
    join(dir, ".gitignore"),
    "/.uldren/\ncoordination/local-overrides.json\n",
  );
  await writePin(dir, coreCommit);
  await git(sandbox.env, dir, "add", "--all");
  await git(sandbox.env, dir, "commit", "--quiet", "-m", "pin");
  return dir;
}

function seedApplication(sandbox: Sandbox, coreCommit: string): Promise<string> {
  return seedApplicationWithRemote(sandbox, coreCommit, APPLICATION_REPOSITORY);
}

async function prepare(sandbox: Sandbox, application: string): Promise<void> {
  await new SourceResolver(runnerFor(sandbox.env), SCHEMA_DIR).resolve({
    mode: "application-direct",
    root: application,
    workspace: join(application, ".uldren/integrity"),
  });
}

function coreNode(overrides: Partial<ResolvedNode>): ResolvedNode {
  return {
    name: "core",
    repository: CORE_REPOSITORY,
    commit: "0".repeat(40),
    path: "/managed/core",
    sourceKind: "managed",
    dirty: false,
    ...overrides,
  };
}

function rootNode(overrides: Partial<ResolvedNode> = {}): ResolvedNode {
  return {
    name: "application",
    repository: APPLICATION_REPOSITORY,
    commit: "1".repeat(40),
    path: "/application",
    sourceKind: "root",
    dirty: false,
    ...overrides,
  };
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const sandbox = await makeSandbox();
  try {
    await run(sandbox);
  } finally {
    await Deno.remove(sandbox.root, { recursive: true }).catch(() => undefined);
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

Deno.test("accepts a commit reachable from protected main", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await prepare(sandbox, application);
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 0, `accepted; stderr=${result.stderr}`);
    assert(result.stdout.includes("protected-main"), "mode label");
    assert(result.stdout.includes(commit), "commit echoed");
  });
});

Deno.test("accepts a commit reachable from an approved release tag", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await git(sandbox.env, core, "tag", "v1.2.3");
    await Deno.writeTextFile(join(core, "README.md"), "core moved on\n");
    await git(sandbox.env, core, "commit", "--quiet", "-am", "advance main");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await prepare(sandbox, application);
    const result = await runIntegrity({
      mode: { kind: "release", tag: "v1.2.3" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 0, `accepted; stderr=${result.stderr}`);
    assert(result.stdout.includes("release-tag v1.2.3"), "release label");
  });
});

Deno.test("rejects a commit that is not reachable from main", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    await git(sandbox.env, core, "checkout", "--quiet", "-b", "side");
    await Deno.writeTextFile(join(core, "side.txt"), "side\n");
    await git(sandbox.env, core, "add", "side.txt");
    await git(sandbox.env, core, "commit", "--quiet", "-m", "side commit");
    const orphan = await git(sandbox.env, core, "rev-parse", "HEAD");
    await git(sandbox.env, core, "checkout", "--quiet", "main");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, orphan);
    await prepare(sandbox, application);
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("commit-not-reachable"), `reason; stderr=${result.stderr}`);
  });
});

Deno.test("rejects an unresolved dependency without attempting to obtain it", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    await redirectCore(sandbox, core);
    const application = await seedApplication(
      sandbox,
      "0123456789abcdef0123456789abcdef01234567",
    );
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("unresolved-dependency"), `reason; stderr=${result.stderr}`);
    assert(!await exists(join(application, ".uldren")), "verification creates no workspace");
  });
});

Deno.test("rejects a dirty application worktree", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await Deno.writeTextFile(join(application, "README.md"), "dirty\n");
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("application-dirty"), `reason; stderr=${result.stderr}`);
  });
});

Deno.test("rejects a coordination document that pins a branch", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, "main");
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("invalid-coordination"), `reason; stderr=${result.stderr}`);
  });
});

Deno.test("rejects a non-semver release tag before touching the repository", async () => {
  const result = await runIntegrity({
    mode: { kind: "release", tag: "main" },
    root: "/nonexistent",
    workspace: "/nonexistent/.uldren/integrity",
    runner: runnerFor({ PATH: Deno.env.get("PATH") ?? "" }),
    schemaDirectory: SCHEMA_DIR,
  });
  assertEquals(result.code, 1, "rejected");
  assert(result.stderr.includes("release-tag-invalid"), `reason; stderr=${result.stderr}`);
});

Deno.test("the trusted invocation contract requires an explicit mode", () => {
  let reason: string | undefined;
  try {
    parseIntegrityArguments(["--root", ".", "--workspace", ".uldren/integrity"]);
  } catch (error) {
    assert(error instanceof ResolverError, "ResolverError");
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "invalid-invocation", "mode is required");
});

Deno.test("the trusted invocation contract rejects a local override flag", () => {
  let reason: string | undefined;
  try {
    parseIntegrityArguments([
      "--mode",
      "protected",
      "--root",
      ".",
      "--workspace",
      ".uldren/integrity",
      "--override-file",
      "local.json",
    ]);
  } catch (error) {
    assert(error instanceof ResolverError, "ResolverError");
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "invalid-invocation", "override flag is rejected");
});

Deno.test("release mode requires an explicit release tag", () => {
  let reason: string | undefined;
  try {
    parseIntegrityArguments([
      "--mode",
      "release",
      "--root",
      ".",
      "--workspace",
      ".uldren/integrity",
    ]);
  } catch (error) {
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "invalid-invocation", "release tag is required");
});

Deno.test("rejects a present local override file with valid content", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await Deno.writeTextFile(
      join(application, "coordination", "local-overrides.json"),
      `${JSON.stringify({ schemaVersion: 1, overrides: { core: { path: core } } }, null, 2)}\n`,
    );
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("override-file-present"), `reason; stderr=${result.stderr}`);
  });
});

Deno.test("rejects a present local override file with malformed content", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await Deno.writeTextFile(
      join(application, "coordination", "local-overrides.json"),
      "{ broken",
    );
    const result = await runIntegrity({
      mode: { kind: "release", tag: "v1.0.0" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("override-file-present"), `reason; stderr=${result.stderr}`);
  });
});

Deno.test("rejects a dirty managed core checkout on reuse", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await prepare(sandbox, application);
    const workspace = join(application, ".uldren/integrity");
    const options = {
      mode: { kind: "protected" as const },
      root: application,
      workspace,
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    };
    const first = await runIntegrity(options);
    assertEquals(first.code, 0, `first run accepted; stderr=${first.stderr}`);
    await Deno.writeTextFile(join(workspace, "core", "README.md"), "tampered\n");
    const second = await runIntegrity(options);
    assertEquals(second.code, 1, "rejected");
    assert(second.stderr.includes("destination-dirty"), `reason; stderr=${second.stderr}`);
  });
});

Deno.test("rejects a managed core whose HEAD no longer matches the pin", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const first = await git(sandbox.env, core, "rev-parse", "HEAD");
    await Deno.writeTextFile(join(core, "README.md"), "second\n");
    await git(sandbox.env, core, "commit", "--quiet", "-am", "second on main");
    const second = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, second);
    await prepare(sandbox, application);
    const workspace = join(application, ".uldren/integrity");
    const options = {
      mode: { kind: "protected" as const },
      root: application,
      workspace,
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    };
    const initial = await runIntegrity(options);
    assertEquals(initial.code, 0, `initial run accepted; stderr=${initial.stderr}`);
    await writePin(application, first);
    await git(sandbox.env, application, "commit", "--quiet", "-am", "repin");
    const result = await runIntegrity(options);
    assertEquals(result.code, 1, "rejected");
    assert(
      result.stderr.includes("destination-commit-mismatch"),
      `reason; stderr=${result.stderr}`,
    );
  });
});

Deno.test("rejects an application root without the canonical repository identity", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplicationWithRemote(
      sandbox,
      commit,
      "https://example.com/not/uldren.git",
    );
    const result = await runIntegrity({
      mode: { kind: "protected" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(
      result.stderr.includes("application-repository-mismatch"),
      `reason; stderr=${result.stderr}`,
    );
  });
});

Deno.test("rejects a release when the approved core tag is unavailable", async () => {
  await withSandbox(async (sandbox) => {
    const core = await seedCore(sandbox);
    const commit = await git(sandbox.env, core, "rev-parse", "HEAD");
    await redirectCore(sandbox, core);
    const application = await seedApplication(sandbox, commit);
    await prepare(sandbox, application);
    const result = await runIntegrity({
      mode: { kind: "release", tag: "v9.9.9" },
      root: application,
      workspace: join(application, ".uldren/integrity"),
      runner: runnerFor(sandbox.env),
      schemaDirectory: SCHEMA_DIR,
    });
    assertEquals(result.code, 1, "rejected");
    assert(result.stderr.includes("reference-unavailable"), `reason; stderr=${result.stderr}`);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("integrity rejects duplicate, reordered, and extra graph nodes", () => {
  for (
    const resolved of [
      [rootNode(), coreNode({}), coreNode({})],
      [coreNode({}), rootNode()],
      [rootNode(), rootNode(), coreNode({})],
    ]
  ) {
    let reason: string | undefined;
    try {
      selectResolvedNodes({ schemaVersion: 1, resolved });
    } catch (error) {
      reason = (error as ResolverError).reason;
    }
    assertEquals(reason, "unresolved-dependency", "only the exact ordered graph is accepted");
  }
});

Deno.test("integrity CLI validates the transitive invocation and redacts invalid arguments", () => {
  const base = [
    "--mode",
    "protected",
    "--root",
    "/mobile",
    "--workspace",
    "/mobile/.uldren/dependencies",
  ];
  const options = parseIntegrityArguments([
    ...base,
    "--resolution-mode",
    "mobile-transitive",
    "--application",
    "/mobile/.uldren/dependencies/application",
  ]);
  assertEquals(options.resolutionMode, "mobile-transitive", "transitive mode selected");
  assertEquals(
    options.applicationPath,
    "/mobile/.uldren/dependencies/application",
    "application supplied",
  );
  for (
    const suffix of [
      ["--mode", "release"],
      ["--resolution-mode", "unknown"],
      ["--resolution-mode", "mobile-transitive"],
      ["--application", "/application"],
      ["--secret=credential-value"],
      ["--release-tag", "--secret=credential-value"],
      ["--toString", "credential-value"],
    ]
  ) {
    let rejected = false;
    try {
      parseIntegrityArguments([...base, ...suffix]);
    } catch (error) {
      rejected = error instanceof ResolverError && error.reason === "invalid-invocation";
      assert(!String(error).includes("credential-value"), "diagnostic does not echo values");
    }
    assert(rejected, "invalid invocation rejected");
  }
});

Deno.test("the integrity boundary treats a missing core dependency as unresolved", () => {
  let reason: string | undefined;
  try {
    selectResolvedNodes({ schemaVersion: 1, resolved: [rootNode()] });
  } catch (error) {
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "unresolved-dependency", "core is required");
});

Deno.test("the integrity boundary forbids an override result", () => {
  let reason: string | undefined;
  try {
    assertManagedIntegrity(rootNode(), coreNode({ sourceKind: "override" }));
  } catch (error) {
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "override-forbidden", "override results are forbidden");
});

Deno.test("the integrity boundary forbids a dirty managed core", () => {
  let reason: string | undefined;
  try {
    assertManagedIntegrity(rootNode(), coreNode({ dirty: true }));
  } catch (error) {
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "core-dirty", "a dirty managed core is forbidden");
});

Deno.test("the integrity boundary forbids a dirty application root", () => {
  let reason: string | undefined;
  try {
    assertManagedIntegrity(rootNode({ dirty: true }), coreNode({}));
  } catch (error) {
    reason = (error as ResolverError).reason;
  }
  assertEquals(reason, "application-dirty", "a dirty application root is forbidden");
});
