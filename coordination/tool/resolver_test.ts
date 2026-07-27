import {
  APPLICATION_REPOSITORY,
  type CommandResult,
  type CommandRunner,
  CORE_REPOSITORY,
  defaultSchemaDirectory,
  MOBILE_REPOSITORY,
  renderResolution,
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

async function writeConfig(sandbox: Sandbox, remoteDirectory: string | undefined): Promise<void> {
  const mapping = remoteDirectory === undefined
    ? ""
    : `[url "${remoteDirectory}"]\n\tinsteadOf = ${CORE_REPOSITORY}\n`;
  await Deno.writeTextFile(
    sandbox.config,
    `[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n${mapping}`,
  );
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix: "uld36-" });
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
  const sandbox: Sandbox = { root, env, config };
  await writeConfig(sandbox, undefined);
  return sandbox;
}

async function seedCore(env: Record<string, string>, directory: string): Promise<string> {
  await Deno.mkdir(directory, { recursive: true });
  await git(env, directory, "init", "--quiet");
  await git(env, directory, "config", "uploadpack.allowAnySHA1InWant", "true");
  await Deno.writeTextFile(join(directory, "README.md"), "core\n");
  await git(env, directory, "add", "README.md");
  await git(env, directory, "commit", "--quiet", "-m", "initial");
  return await git(env, directory, "rev-parse", "HEAD");
}

async function seedWorkTree(
  env: Record<string, string>,
  directory: string,
  coreCommit: string | undefined,
  origin: string = APPLICATION_REPOSITORY,
): Promise<string> {
  await Deno.mkdir(directory, { recursive: true });
  await git(env, directory, "init", "--quiet");
  if (origin.length > 0) {
    await git(env, directory, "remote", "add", "origin", origin);
  }
  await Deno.writeTextFile(join(directory, "README.md"), "consumer\n");
  await Deno.writeTextFile(join(directory, ".gitignore"), "/.uldren/\n");
  if (coreCommit !== undefined) {
    await Deno.mkdir(join(directory, "coordination"), { recursive: true });
    const document = {
      schemaVersion: 1,
      dependencies: { core: { repository: CORE_REPOSITORY, commit: coreCommit } },
    };
    await Deno.writeTextFile(
      join(directory, "coordination", "source-dependencies.json"),
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }
  await git(env, directory, "add", "--all");
  await git(env, directory, "commit", "--quiet", "-m", "initial");
  return await git(env, directory, "rev-parse", "HEAD");
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const sandbox = await makeSandbox();
  try {
    await run(sandbox);
  } finally {
    await Deno.remove(sandbox.root, { recursive: true }).catch(() => undefined);
  }
}

async function rejects(reason: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ResolverError && error.reason === reason) {
      return;
    }
    throw new Error(`expected ResolverError(${reason}), received ${String(error)}`);
  }
  throw new Error(`expected ResolverError(${reason}) but nothing was thrown`);
}

function real(path: string): string {
  return Deno.realPathSync(path);
}

Deno.test("application-direct resolves root Application and a managed Core", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    const rootCommit = await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);

    const output = await resolver.resolve({ mode: "application-direct", root: rootDir, workspace });

    if (output.resolved.length !== 2) {
      throw new Error(`expected two nodes, got ${output.resolved.length}`);
    }
    const [root, core] = output.resolved;
    if (
      root.name !== "application" || root.repository !== APPLICATION_REPOSITORY ||
      root.commit !== rootCommit || root.sourceKind !== "root" || root.path !== real(rootDir)
    ) {
      throw new Error(`unexpected root node: ${JSON.stringify(root)}`);
    }
    if (
      core.name !== "core" || core.repository !== CORE_REPOSITORY || core.commit !== coreCommit ||
      core.sourceKind !== "managed" || core.dirty
    ) {
      throw new Error(`unexpected core node: ${JSON.stringify(core)}`);
    }
    if ((await git(sandbox.env, core.path, "rev-parse", "--abbrev-ref", "HEAD")) !== "HEAD") {
      throw new Error("core checkout is not detached");
    }
  });
});

Deno.test("mobile-transitive emits Mobile -> Application -> Core", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const application = join(sandbox.root, "application");
    const applicationCommit = await seedWorkTree(sandbox.env, application, coreCommit);
    const mobile = join(sandbox.root, "mobile");
    const mobileCommit = await seedWorkTree(
      sandbox.env,
      mobile,
      undefined,
      "git@uldren:uldrenai/uldren-mobile.git",
    );
    const workspace = join(mobile, ".uldren/dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);

    const output = await resolver.resolve({
      mode: "mobile-transitive",
      root: mobile,
      workspace,
      applicationPath: application,
    });

    if (output.resolved.length !== 3) {
      throw new Error(`expected three nodes, got ${output.resolved.length}`);
    }
    const [rootNode, applicationNode, core] = output.resolved;
    if (
      rootNode.repository !== MOBILE_REPOSITORY || rootNode.commit !== mobileCommit ||
      rootNode.sourceKind !== "root"
    ) {
      throw new Error(`unexpected mobile node: ${JSON.stringify(rootNode)}`);
    }
    if (
      applicationNode.name !== "application" ||
      applicationNode.repository !== APPLICATION_REPOSITORY ||
      applicationNode.commit !== applicationCommit ||
      applicationNode.sourceKind !== "pre-resolved" || applicationNode.path !== real(application)
    ) {
      throw new Error(`unexpected application node: ${JSON.stringify(applicationNode)}`);
    }
    if (
      core.repository !== CORE_REPOSITORY || core.commit !== coreCommit ||
      core.sourceKind !== "managed"
    ) {
      throw new Error(`unexpected core node: ${JSON.stringify(core)}`);
    }
  });
});

Deno.test("managed reuse is deterministic and byte-identical", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    const options = { mode: "application-direct" as const, root: rootDir, workspace };

    const first = renderResolution(await resolver.resolve(options));
    const second = renderResolution(await resolver.resolve(options));
    if (first !== second) {
      throw new Error("resolution output was not byte-identical across runs");
    }
  });
});

Deno.test("a missing pinned commit is a specific credential-safe outcome", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, "0".repeat(40));
    const workspace = join(rootDir, ".uldren/dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    await rejects(
      "commit-unavailable",
      () => resolver.resolve({ mode: "application-direct", root: rootDir, workspace }),
    );
    if (await pathExists(join(workspace, "core"))) {
      throw new Error("a failed resolution left a checkout behind");
    }
  });
});

Deno.test("malformed coordination is rejected before filesystem mutation", async () => {
  await withSandbox(async (sandbox) => {
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, undefined);
    await Deno.mkdir(join(rootDir, "coordination"), { recursive: true });
    await Deno.writeTextFile(join(rootDir, "coordination", "source-dependencies.json"), "{ broken");
    const workspace = join(rootDir, ".uldren/dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    await rejects(
      "invalid-coordination",
      () => resolver.resolve({ mode: "application-direct", root: rootDir, workspace }),
    );
    if (await pathExists(join(rootDir, ".uldren"))) {
      throw new Error("a mutation occurred before validation");
    }
  });
});

Deno.test("a git failure never leaks credentials", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const base = environmentRunner(sandbox.env);
    const intercept: CommandRunner = {
      run(command, args, cwd): Promise<CommandResult> {
        if (args[0] === "fetch") {
          return Promise.resolve({
            code: 128,
            stdout: "",
            stderr: "fatal: could not read from https://carol:super-secret-token@example.com",
          });
        }
        return base.run(command, args, cwd);
      },
    };
    const resolver = new SourceResolver(intercept, SCHEMA_DIR);
    try {
      await resolver.resolve({ mode: "application-direct", root: rootDir, workspace });
      throw new Error("expected a failure");
    } catch (error) {
      if (!(error instanceof ResolverError)) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
      if (error.message.includes("super-secret-token")) {
        throw new Error("diagnostic leaked a credential");
      }
    }
  });
});

Deno.test("an existing non-Git destination is preserved", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const destination = join(workspace, "core");
    await Deno.mkdir(destination, { recursive: true });
    await Deno.writeTextFile(join(destination, "keep.txt"), "precious\n");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    await rejects(
      "destination-not-git",
      () => resolver.resolve({ mode: "application-direct", root: rootDir, workspace }),
    );
    if ((await Deno.readTextFile(join(destination, "keep.txt"))) !== "precious\n") {
      throw new Error("the existing destination was modified");
    }
  });
});

Deno.test("wrong repository identity, wrong HEAD, and dirty destinations are rejected without loss", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const destination = join(workspace, "core");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    const options = { mode: "application-direct" as const, root: rootDir, workspace };

    await Deno.mkdir(destination, { recursive: true });
    await git(sandbox.env, destination, "init", "--quiet");
    await git(
      sandbox.env,
      destination,
      "remote",
      "add",
      "origin",
      "https://github.com/uldrenai/other.git",
    );
    await Deno.writeTextFile(join(destination, "README.md"), "x\n");
    await git(sandbox.env, destination, "add", "README.md");
    await git(sandbox.env, destination, "commit", "--quiet", "-m", "x");
    await rejects("destination-repository-mismatch", () => resolver.resolve(options));

    await git(sandbox.env, destination, "remote", "set-url", "origin", CORE_REPOSITORY);
    await rejects("destination-commit-mismatch", () => resolver.resolve(options));
  });
});

Deno.test("filesystem probe failures surface as stable errors", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const sealed = join(rootDir, ".uldren");
    await Deno.mkdir(sealed, { recursive: true });
    await Deno.chmod(sealed, 0o000);
    const workspace = join(sealed, "dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    try {
      await rejects(
        "filesystem-error",
        () => resolver.resolve({ mode: "application-direct", root: rootDir, workspace }),
      );
    } finally {
      await Deno.chmod(sealed, 0o755).catch(() => undefined);
    }
  });
});

Deno.test("a symlinked managed directory that escapes the root is rejected", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const outside = join(sandbox.root, "outside");
    await Deno.mkdir(outside, { recursive: true });
    await Deno.symlink(outside, join(rootDir, ".uldren"));
    const workspace = join(rootDir, ".uldren/dependencies");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    await rejects(
      "path-escape",
      () => resolver.resolve({ mode: "application-direct", root: rootDir, workspace }),
    );
  });
});

Deno.test("root identity is verified across supported canonical remote forms", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    let index = 0;
    const accept = async (origin: string, extraRemote?: string) => {
      const dir = join(sandbox.root, `accept-${index++}`);
      await seedWorkTree(sandbox.env, dir, coreCommit, origin);
      if (extraRemote !== undefined) {
        await git(sandbox.env, dir, "remote", "add", "upstream", extraRemote);
      }
      const output = await resolver.resolve({
        mode: "application-direct",
        root: dir,
        workspace: join(dir, ".uldren/dependencies"),
      });
      if (output.resolved[0].repository !== APPLICATION_REPOSITORY) {
        throw new Error(`origin ${origin} did not resolve to the canonical identity`);
      }
    };
    const reject = async (origin: string) => {
      const dir = join(sandbox.root, `reject-${index++}`);
      await seedWorkTree(sandbox.env, dir, coreCommit, origin);
      await rejects("application-repository-mismatch", () =>
        resolver.resolve({
          mode: "application-direct",
          root: dir,
          workspace: join(dir, ".uldren/dependencies"),
        }));
    };

    await accept("https://github.com/uldrenai/uldren-application.git");
    await accept("git@github.com:uldrenai/uldren-application.git");
    await accept("git@uldren:uldrenai/uldren-application.git");
    await accept(
      "https://github.com/contributor/uldren-application.git",
      "git@github.com:uldrenai/uldren-application.git",
    );

    await reject("");
    await reject("https://github.com/uldrenai/other.git");
    await reject("https://example.com/uldrenai/uldren-application.git");
    await reject("https://user:token@github.com/uldrenai/uldren-application.git");
  });
});

Deno.test("concurrent resolutions are excluded by a proven lock overlap", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const options = { mode: "application-direct" as const, root: rootDir, workspace };

    let contenderOutcome = "not-run";
    const contender = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    const winner = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR, {
      afterLockAcquired: async () => {
        try {
          await contender.resolve(options);
          contenderOutcome = "unexpectedly-succeeded";
        } catch (error) {
          contenderOutcome = error instanceof ResolverError ? error.reason : "unexpected-error";
        }
      },
    });

    await winner.resolve(options);
    if (contenderOutcome !== "workspace-locked") {
      throw new Error(`contender outcome was ${contenderOutcome}`);
    }
    if ((await git(sandbox.env, join(workspace, "core"), "rev-parse", "HEAD")) !== coreCommit) {
      throw new Error("the surviving checkout is not at the pinned commit");
    }
    if (await pathExists(join(workspace, ".lock"))) {
      throw new Error("a lock was left behind");
    }
  });
});

Deno.test("a managed destination with a non-canonical-HTTPS origin is rejected without mutation", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const destination = join(workspace, "core");
    await Deno.mkdir(workspace, { recursive: true });
    await git(sandbox.env, sandbox.root, "clone", "--quiet", remote, destination);
    const sshOrigin = "git@github.com:uldrenai/uldren-core.git";
    await git(sandbox.env, destination, "remote", "set-url", "origin", sshOrigin);
    await git(sandbox.env, destination, "checkout", "--quiet", "--detach", coreCommit);
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);

    await rejects(
      "destination-repository-mismatch",
      () => resolver.resolve({ mode: "application-direct", root: rootDir, workspace }),
    );
    if (
      (await git(sandbox.env, destination, "config", "--get", "remote.origin.url")) !== sshOrigin
    ) {
      throw new Error("the existing destination origin was mutated");
    }
    if ((await git(sandbox.env, destination, "rev-parse", "HEAD")) !== coreCommit) {
      throw new Error("the existing destination HEAD was mutated");
    }
  });
});

Deno.test("clean and dirty overrides resolve and report dirty state", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const override = join(sandbox.root, "override");
    await git(sandbox.env, sandbox.root, "clone", "--quiet", remote, override);
    await git(sandbox.env, override, "checkout", "--quiet", "--detach", coreCommit);
    const overrideFile = join(sandbox.root, "local-overrides.json");
    await Deno.writeTextFile(
      overrideFile,
      `${JSON.stringify({ schemaVersion: 1, overrides: { core: { path: override } } }, null, 2)}\n`,
    );
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    const options = { mode: "application-direct" as const, root: rootDir, workspace, overrideFile };

    const clean = await resolver.resolve(options);
    if (clean.resolved[1].sourceKind !== "override" || clean.resolved[1].dirty) {
      throw new Error(`unexpected clean override: ${JSON.stringify(clean.resolved[1])}`);
    }
    await Deno.writeTextFile(join(override, "README.md"), "dirty\n");
    const dirty = await resolver.resolve(options);
    if (!dirty.resolved[1].dirty) {
      throw new Error("a dirty override was reported clean");
    }
  });
});

Deno.test("missing, non-Git, wrong-commit, malformed, and unknown overrides are rejected", async () => {
  await withSandbox(async (sandbox) => {
    const remote = join(sandbox.root, "remote");
    const coreCommit = await seedCore(sandbox.env, remote);
    await writeConfig(sandbox, remote);
    const rootDir = join(sandbox.root, "application");
    await seedWorkTree(sandbox.env, rootDir, coreCommit);
    const workspace = join(rootDir, ".uldren/dependencies");
    const overrideFile = join(sandbox.root, "local-overrides.json");
    const resolver = new SourceResolver(environmentRunner(sandbox.env), SCHEMA_DIR);
    const options = { mode: "application-direct" as const, root: rootDir, workspace, overrideFile };
    const write = (value: unknown) =>
      Deno.writeTextFile(overrideFile, `${JSON.stringify(value, null, 2)}\n`);

    await write({ schemaVersion: 1, overrides: { core: { path: join(sandbox.root, "nope") } } });
    await rejects("override-missing", () => resolver.resolve(options));

    const plain = join(sandbox.root, "plain");
    await Deno.mkdir(plain);
    await write({ schemaVersion: 1, overrides: { core: { path: plain } } });
    await rejects("override-not-git", () => resolver.resolve(options));

    const divergent = join(sandbox.root, "divergent");
    await git(sandbox.env, sandbox.root, "clone", "--quiet", remote, divergent);
    await Deno.writeTextFile(join(divergent, "README.md"), "changed\n");
    await git(sandbox.env, divergent, "add", "README.md");
    await git(sandbox.env, divergent, "commit", "--quiet", "-m", "second");
    await write({ schemaVersion: 1, overrides: { core: { path: divergent } } });
    await rejects("override-commit-mismatch", () => resolver.resolve(options));

    await Deno.writeTextFile(overrideFile, "{ broken");
    await rejects("invalid-overrides", () => resolver.resolve(options));

    await write({ schemaVersion: 1, overrides: { mobile: { path: remote } } });
    await rejects("invalid-overrides", () => resolver.resolve(options));
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}
