import { Ajv2020 } from "ajv/2020";
import { join, resolve } from "node:path";
import {
  APPLICATION_REPOSITORY,
  CORE_REPOSITORY,
  MOBILE_REPOSITORY,
  type ResolutionOutput,
} from "../../coordination/tool/resolver.ts";

const SOURCE = resolve(import.meta.dirname!, "../..");

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

class Fixture {
  readonly mobile: string;
  readonly workspace: string;
  readonly application: string;
  readonly core: string;
  readonly upstream: string;
  readonly env: Record<string, string>;

  constructor(readonly root: string) {
    this.mobile = join(root, "mobile");
    this.workspace = join(this.mobile, ".uldren/dependencies");
    this.application = join(this.workspace, "application");
    this.core = join(this.workspace, "core");
    this.upstream = join(root, "upstream-core");
    this.env = {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? root,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Uldren Test",
      GIT_AUTHOR_EMAIL: "test@uldren.local",
      GIT_COMMITTER_NAME: "Uldren Test",
      GIT_COMMITTER_EMAIL: "test@uldren.local",
      DENO_NO_UPDATE_CHECK: "1",
    };
    const cache = Deno.env.get("DENO_DIR");
    if (cache !== undefined) this.env.DENO_DIR = cache;
  }

  async run(command: string, args: string[], cwd: string): Promise<Result> {
    const output = await new Deno.Command(command, {
      args,
      cwd,
      env: this.env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  async git(cwd: string, ...args: string[]): Promise<string> {
    const result = await this.run("git", args, cwd);
    assert(result.code === 0, `fixture git operation failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  async init(path: string, repository: string): Promise<void> {
    await Deno.mkdir(path, { recursive: true });
    await this.git(path, "init", "--quiet", "-b", "main");
    await this.git(path, "remote", "add", "origin", repository);
    await Deno.writeTextFile(
      join(path, ".gitignore"),
      "/.uldren/\ncoordination/local-overrides.json\n",
    );
    await Deno.writeTextFile(join(path, "README.md"), "fixture\n");
  }

  async commit(path: string): Promise<string> {
    await this.git(path, "add", "--all");
    await this.git(path, "commit", "--quiet", "-m", "fixture");
    return await this.git(path, "rev-parse", "HEAD");
  }

  async seed(): Promise<void> {
    await Deno.writeTextFile(
      this.env.GIT_CONFIG_GLOBAL,
      `[protocol "file"]\nallow = always\n[url "${this.upstream}"]\ninsteadOf = ${CORE_REPOSITORY}\n`,
    );
    await this.init(this.upstream, CORE_REPOSITORY);
    const coreCommit = await this.commit(this.upstream);
    await this.git(this.upstream, "tag", "v1.2.3");
    await this.git(this.upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
    await this.init(this.application, APPLICATION_REPOSITORY);
    for (
      const file of [
        "deno.json",
        "deno.lock",
        "coordination/tool/cli.ts",
        "coordination/tool/resolver.ts",
        "coordination/tool/integrity.ts",
        "coordination/schema/source-dependencies-v1.schema.json",
        "coordination/schema/local-overrides-v1.schema.json",
        "coordination/schema/resolution-output-v1.schema.json",
      ]
    ) {
      const destination = join(this.application, file);
      await Deno.mkdir(resolve(destination, ".."), { recursive: true });
      await Deno.copyFile(join(SOURCE, file), destination);
    }
    await Deno.writeTextFile(
      join(this.application, "coordination/source-dependencies.json"),
      JSON.stringify({
        schemaVersion: 1,
        dependencies: { core: { repository: CORE_REPOSITORY, commit: coreCommit } },
      }),
    );
    const applicationCommit = await this.commit(this.application);
    await this.init(this.mobile, MOBILE_REPOSITORY);
    await Deno.mkdir(join(this.mobile, "coordination"));
    await Deno.writeTextFile(
      join(this.mobile, "coordination/source-dependencies.json"),
      JSON.stringify({
        schemaVersion: 1,
        dependencies: {
          application: { repository: APPLICATION_REPOSITORY, commit: applicationCommit },
        },
      }),
    );
    await this.commit(this.mobile);
    const prepared = await this.run("deno", [
      "run",
      "--cached-only",
      "--frozen",
      "--allow-read",
      "--allow-write",
      "--allow-run=git",
      "coordination/tool/cli.ts",
      "--mode",
      "mobile-transitive",
      "--root",
      this.mobile,
      "--workspace",
      this.workspace,
      "--application",
      this.application,
    ], this.application);
    assert(prepared.code === 0, `preparation failed: ${prepared.stderr}`);
  }

  verify(
    extra: string[] = [],
    application = this.application,
    workspace = this.workspace,
  ): Promise<Result> {
    return this.run("deno", [
      "run",
      "--cached-only",
      "--frozen",
      "--allow-read",
      "--allow-run=git",
      join(this.application, "coordination/tool/integrity.ts"),
      "--mode",
      extra.length === 0 ? "protected" : "release",
      ...extra,
      "--resolution-mode",
      "mobile-transitive",
      "--root",
      this.mobile,
      "--workspace",
      workspace,
      "--application",
      application,
    ], this.application);
  }
}

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "uldren-integrity-" });
  try {
    const fixture = new Fixture(await Deno.realPath(root));
    await fixture.seed();
    await run(fixture);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function snapshot(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(path: string): Promise<void> {
    for await (const entry of Deno.readDir(path)) {
      if (entry.name === ".git") continue;
      const full = join(path, entry.name);
      const name = full.slice(root.length);
      if (entry.isDirectory) {
        entries.push(`${name}/`);
        await walk(full);
      } else if (entry.isSymlink) {
        entries.push(`${name}->${await Deno.readLink(full)}`);
      } else {
        entries.push(`${name}:${JSON.stringify(Array.from(await Deno.readFile(full)))}`);
      }
    }
  }
  await walk(root);
  return JSON.stringify(entries.sort());
}

Deno.test("transitive integrity CLI verifies the real sibling graph without changing source or workspace", async () => {
  await withFixture(async (fixture) => {
    const before = await snapshot(fixture.mobile);
    const first = await fixture.verify();
    assert(first.code === 0, first.stderr);
    const output = JSON.parse(first.stdout) as ResolutionOutput;
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(
      await Deno.readTextFile(join(SOURCE, "coordination/schema/resolution-output-v1.schema.json")),
    ));
    assert(validate(output), "output matches the authoritative graph schema");
    assert(
      output.resolved.map((node) => node.name).join(",") === "mobile,application,core",
      "ordered graph",
    );
    for (const [index, path] of [fixture.mobile, fixture.application, fixture.core].entries()) {
      assert(output.resolved[index].path === path, "existing sibling paths preserved");
      assert(
        output.resolved[index].commit === await fixture.git(path, "rev-parse", "HEAD"),
        "exact heads",
      );
      assert(!output.resolved[index].dirty, "clean graph");
    }
    assert((await fixture.verify()).stdout === first.stdout, "deterministic repeated output");
    const release = await fixture.verify(["--release-tag", "v1.2.3"]);
    assert(release.code === 0, release.stderr);
    assert(release.stdout === first.stdout, "tag verification preserves the same exact graph");
    assert(await snapshot(fixture.mobile) === before, "no source, checkout, or workspace mutation");
  });
});

interface NegativeCase {
  readonly name: string;
  readonly reason: string;
  readonly alter: (fixture: Fixture) => Promise<void>;
  readonly invoke?: (fixture: Fixture) => Promise<Result>;
}

const cases: NegativeCase[] = [
  ...(["mobile", "application", "core"] as const).map((name) => ({
    name: `dirty ${name}`,
    reason: name === "core" ? "destination-dirty" : `${name}-dirty`,
    alter: async (fixture: Fixture) => {
      await Deno.writeTextFile(join(fixture[name], "README.md"), "dirty\n");
    },
  })),
  ...(["mobile", "application"] as const).flatMap((name) => [
    {
      name: `${name} override`,
      reason: "override-file-present",
      alter: async (fixture: Fixture) => {
        await Deno.writeTextFile(join(fixture[name], "coordination/local-overrides.json"), "{}");
      },
    },
    {
      name: `${name} dangling override symlink`,
      reason: "override-file-present",
      alter: async (fixture: Fixture) => {
        await Deno.symlink(
          join(fixture.root, "absent"),
          join(fixture[name], "coordination/local-overrides.json"),
        );
      },
    },
  ]),
  {
    name: "missing core",
    reason: "unresolved-dependency",
    alter: async (fixture) => {
      await Deno.rename(fixture.core, join(fixture.root, "saved-core"));
    },
  },
  {
    name: "non-git core",
    reason: "destination-not-git",
    alter: async (fixture) => {
      await Deno.rename(join(fixture.core, ".git"), join(fixture.root, "saved-git"));
    },
  },
  {
    name: "wrong core head",
    reason: "destination-commit-mismatch",
    alter: async (fixture) => {
      await Deno.writeTextFile(join(fixture.core, "README.md"), "different\n");
      await fixture.commit(fixture.core);
    },
  },
  ...(["mobile", "application", "core"] as const).map((name) => ({
    name: `wrong ${name} repository`,
    reason: name === "core" ? "destination-repository-mismatch" : `${name}-repository-mismatch`,
    alter: async (fixture: Fixture) => {
      await fixture.git(
        fixture[name],
        "remote",
        "set-url",
        "origin",
        "https://credential-value@example.invalid/wrong.git",
      );
    },
  })),
  {
    name: "locked workspace",
    reason: "workspace-locked",
    alter: async (fixture) => {
      await Deno.mkdir(join(fixture.workspace, ".lock"));
    },
  },
  {
    name: "core path escapes mobile",
    reason: "path-escape",
    alter: async (fixture) => {
      const outside = join(fixture.root, "outside-core");
      await Deno.rename(fixture.core, outside);
      await Deno.symlink(outside, fixture.core);
    },
  },
  {
    name: "application path escapes mobile",
    reason: "path-escape",
    alter: async (fixture) => {
      const outside = join(fixture.root, "outside-application");
      await Deno.rename(fixture.application, outside);
      await Deno.symlink(outside, fixture.application);
    },
  },
  {
    name: "unavailable approved tag",
    reason: "reference-unavailable",
    alter: async () => {},
    invoke: (fixture) => fixture.verify(["--release-tag", "v9.9.9"]),
  },
  {
    name: "unreachable core",
    reason: "commit-not-reachable",
    alter: async (fixture) => {
      await fixture.git(fixture.upstream, "checkout", "--quiet", "--orphan", "unrelated");
      await fixture.git(fixture.upstream, "commit", "--quiet", "-am", "unrelated");
      await fixture.git(fixture.upstream, "branch", "-f", "main", "HEAD");
    },
  },
  {
    name: "core unreachable from approved tag",
    reason: "commit-not-reachable",
    alter: async (fixture) => {
      await fixture.git(fixture.upstream, "checkout", "--quiet", "--orphan", "unrelated");
      await fixture.git(fixture.upstream, "commit", "--quiet", "-am", "unrelated");
      await fixture.git(fixture.upstream, "tag", "v2.0.0");
    },
    invoke: (fixture) => fixture.verify(["--release-tag", "v2.0.0"]),
  },
  {
    name: "workspace outside mobile",
    reason: "path-escape",
    alter: async () => {},
    invoke: (fixture) => fixture.verify([], fixture.application, fixture.root),
  },
  {
    name: "non-managed application path",
    reason: "application-path-mismatch",
    alter: async (fixture) => {
      const alternate = join(fixture.workspace, "other-application");
      await fixture.git(fixture.workspace, "clone", "--quiet", fixture.application, alternate);
    },
    invoke: (fixture) => fixture.verify([], join(fixture.workspace, "other-application")),
  },
];

for (const testCase of cases) {
  Deno.test(`transitive integrity CLI rejects ${testCase.name} without modifying checkouts`, async () => {
    await withFixture(async (fixture) => {
      await testCase.alter(fixture);
      const before = await snapshot(fixture.mobile);
      const result = await (testCase.invoke?.(fixture) ?? fixture.verify());
      assert(result.code === 1, `expected rejection: ${result.stdout} ${result.stderr}`);
      assert(result.stdout === "", "failures have no success output");
      assert(!result.stderr.includes("credential-value"), "diagnostic is credential-safe");
      assert(JSON.parse(result.stderr).error.policy === testCase.reason, result.stderr);
      assert(
        await snapshot(fixture.mobile) === before,
        "failed verification does not repair checkouts",
      );
    });
  });
}
