import { join, resolve } from "node:path";
import {
  type CommandRunner,
  defaultSchemaDirectory,
  DenoCommandRunner,
  type Mode,
  renderResolution,
  type ResolutionOutput,
  type ResolvedNode,
  ResolverError,
  SourceResolver,
} from "./resolver.ts";

const SEMVER_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const LOCAL_OVERRIDE_RELATIVE = "coordination/local-overrides.json";

export type IntegrityMode =
  | { readonly kind: "protected" }
  | { readonly kind: "release"; readonly tag: string };

export interface IntegrityOptions {
  readonly mode: IntegrityMode;
  readonly root: string;
  readonly workspace: string;
  readonly resolutionMode?: Mode;
  readonly applicationPath?: string;
  readonly runner?: CommandRunner;
  readonly schemaDirectory?: string;
  readonly exists?: (path: string) => boolean;
}

export interface IntegrityResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function pathExists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw new ResolverError("filesystem-error", "a filesystem probe failed");
  }
}

function diagnostic(policy: string, message: string): string {
  return `${JSON.stringify({ error: { policy, message } })}\n`;
}

function accepted(mode: string, commit: string, reachableFrom: string): string {
  return `${JSON.stringify({ integrity: { mode, commit, reachableFrom } })}\n`;
}

export function selectResolvedNodes(
  resolution: ResolutionOutput,
): { application: ResolvedNode; core: ResolvedNode } {
  const names = resolution.resolved.map((node) => node.name);
  const expected = names.length === 2 ? ["application", "core"] : ["mobile", "application", "core"];
  if (
    resolution.schemaVersion !== 1 ||
    names.length !== expected.length || names.some((name, index) => name !== expected[index])
  ) {
    throw new ResolverError(
      "unresolved-dependency",
      "resolution did not produce the ordered dependency graph",
    );
  }
  const application = resolution.resolved[resolution.resolved.length - 2];
  const core = resolution.resolved[resolution.resolved.length - 1];
  return { application, core };
}

export function assertManagedIntegrity(application: ResolvedNode, core: ResolvedNode): void {
  if (application.dirty) {
    throw new ResolverError(
      "application-dirty",
      "the application worktree has uncommitted changes",
    );
  }
  if (core.sourceKind !== "managed") {
    throw new ResolverError(
      "override-forbidden",
      "a local dependency override is not permitted in protected or release mode",
    );
  }
  if (core.dirty) {
    throw new ResolverError("core-dirty", "the managed core checkout has uncommitted changes");
  }
}

async function assertReachable(
  runner: CommandRunner,
  coreDirectory: string,
  commit: string,
  reference: string,
): Promise<void> {
  const fetch = await runner.run("git", ["fetch", "--quiet", "origin", reference], coreDirectory);
  if (fetch.code !== 0) {
    throw new ResolverError(
      "reference-unavailable",
      "the required canonical reference could not be fetched",
    );
  }
  const ancestor = await runner.run(
    "git",
    ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"],
    coreDirectory,
  );
  if (ancestor.code !== 0) {
    throw new ResolverError(
      "commit-not-reachable",
      "the pinned commit is not reachable from the required protected reference",
    );
  }
}

export async function runIntegrity(options: IntegrityOptions): Promise<IntegrityResult> {
  const runner = options.runner ?? new DenoCommandRunner();
  const schemaDirectory = options.schemaDirectory ?? defaultSchemaDirectory();
  const exists = options.exists ?? pathExists;

  try {
    if (options.mode.kind === "release" && !SEMVER_TAG.test(options.mode.tag)) {
      throw new ResolverError(
        "release-tag-invalid",
        "the release reference is not an immutable semantic-version tag",
      );
    }

    if (exists(join(options.root, LOCAL_OVERRIDE_RELATIVE))) {
      throw new ResolverError(
        "override-file-present",
        "a local dependency override file is not permitted in protected or release mode",
      );
    }

    const resolver = new SourceResolver(runner, schemaDirectory);
    const resolution = await resolver.verify({
      mode: options.resolutionMode ?? "application-direct",
      root: options.root,
      workspace: options.workspace,
      applicationPath: options.applicationPath,
    });

    const { application, core } = selectResolvedNodes(resolution);
    assertManagedIntegrity(application, core);

    const reference = options.mode.kind === "protected"
      ? "refs/heads/main"
      : `refs/tags/${options.mode.tag}`;
    await assertReachable(runner, core.path, core.commit, reference);

    const label = options.mode.kind === "protected"
      ? "protected-main"
      : `release-tag ${options.mode.tag}`;
    return {
      code: 0,
      stdout: options.resolutionMode === "mobile-transitive"
        ? renderResolution(resolution)
        : accepted(label, core.commit, reference),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof ResolverError) {
      return { code: 1, stdout: "", stderr: diagnostic(error.reason, error.message) };
    }
    return { code: 1, stdout: "", stderr: diagnostic("internal", "an unexpected error occurred") };
  }
}

const FLAGS = {
  "--mode": "mode",
  "--root": "root",
  "--workspace": "workspace",
  "--release-tag": "releaseTag",
  "--resolution-mode": "resolutionMode",
  "--application": "applicationPath",
} as const;

type FlagName = keyof typeof FLAGS;

function invalid(message: string): never {
  throw new ResolverError("invalid-invocation", message);
}

export function parseIntegrityArguments(args: readonly string[]): IntegrityOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const equals = token.indexOf("=");
    const flag = (equals === -1 ? token : token.slice(0, equals)) as FlagName;
    if (!Object.hasOwn(FLAGS, flag)) {
      invalid("unknown argument");
    }
    if (Object.hasOwn(values, FLAGS[flag])) {
      invalid("duplicate argument");
    }
    let value: string;
    if (equals === -1) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        invalid(`missing value for ${flag}`);
      }
      value = next;
      index += 1;
    } else {
      value = token.slice(equals + 1);
    }
    values[FLAGS[flag]] = value;
  }

  if ((values.root ?? "").length === 0) {
    invalid("missing required argument for --root");
  }
  if ((values.workspace ?? "").length === 0) {
    invalid("missing required argument for --workspace");
  }

  const resolutionMode = values.resolutionMode ?? "application-direct";
  if (resolutionMode !== "application-direct" && resolutionMode !== "mobile-transitive") {
    invalid("resolution mode must be application-direct or mobile-transitive");
  }
  if (resolutionMode === "mobile-transitive" && (values.applicationPath ?? "").length === 0) {
    invalid("mobile-transitive mode requires --application");
  }
  if (resolutionMode === "application-direct" && values.applicationPath !== undefined) {
    invalid("application-direct mode does not accept --application");
  }
  const consumer = { resolutionMode, applicationPath: values.applicationPath } as const;

  const modeValue = values.mode ?? "";
  if (modeValue === "protected") {
    if (values.releaseTag !== undefined) {
      invalid("protected mode does not accept --release-tag");
    }
    return {
      mode: { kind: "protected" },
      root: values.root,
      workspace: values.workspace,
      ...consumer,
    };
  }
  if (modeValue === "release") {
    if ((values.releaseTag ?? "").length === 0) {
      invalid("release mode requires --release-tag");
    }
    return {
      mode: { kind: "release", tag: values.releaseTag },
      root: values.root,
      workspace: values.workspace,
      ...consumer,
    };
  }
  invalid("--mode must be protected or release");
}

if (import.meta.main) {
  let result: IntegrityResult;
  try {
    const options = parseIntegrityArguments(Deno.args);
    result = await runIntegrity({
      ...options,
      root: resolve(options.root),
      workspace: resolve(options.workspace),
    });
  } catch (error) {
    if (error instanceof ResolverError) {
      result = { code: 2, stdout: "", stderr: diagnostic(error.reason, error.message) };
    } else {
      result = {
        code: 2,
        stdout: "",
        stderr: diagnostic("internal", "an unexpected error occurred"),
      };
    }
  }
  const encoder = new TextEncoder();
  if (result.stdout.length > 0) {
    await Deno.stdout.write(encoder.encode(result.stdout));
  }
  if (result.stderr.length > 0) {
    await Deno.stderr.write(encoder.encode(result.stderr));
  }
  Deno.exit(result.code);
}
