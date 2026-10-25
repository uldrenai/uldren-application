import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/2020";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<CommandResult>;
}

export class DenoCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    const output = await new Deno.Command(command, {
      args: [...args],
      cwd,
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
}

export class ResolverError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ResolverError";
    this.reason = reason;
  }
}

export const CORE_REPOSITORY = "https://github.com/uldrenai/uldren-core.git";
export const APPLICATION_REPOSITORY = "https://github.com/uldrenai/uldren-application.git";
export const MOBILE_REPOSITORY = "https://github.com/uldrenai/uldren-mobile.git";

const COORDINATION_RELATIVE = "coordination/source-dependencies.json";
const MANAGED_DEPENDENCY = "core";

const CANONICAL_HOSTS = new Set(["github.com", "uldren"]);
const CANONICAL_OWNER = "uldrenai";
const APPLICATION_REPOSITORY_NAME = "uldren-application";
const MOBILE_REPOSITORY_NAME = "uldren-mobile";

interface RepositoryIdentity {
  readonly owner: string;
  readonly repository: string;
}

export function repositoryIdentity(remote: string): RepositoryIdentity | undefined {
  const https = remote.match(/^https:\/\/([^/@]+)\/([^/@]+)\/(.+?)(?:\.git)?$/);
  if (https !== null && CANONICAL_HOSTS.has(https[1])) {
    return { owner: https[2], repository: https[3] };
  }
  const scp = remote.match(/^git@([^:/]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (scp !== null && CANONICAL_HOSTS.has(scp[1])) {
    return { owner: scp[2], repository: scp[3] };
  }
  const ssh = remote.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh !== null && CANONICAL_HOSTS.has(ssh[1])) {
    return { owner: ssh[2], repository: ssh[3] };
  }
  return undefined;
}

function isCanonicalRemote(remote: string, repositoryName: string): boolean {
  const identity = repositoryIdentity(remote);
  return identity !== undefined && identity.owner === CANONICAL_OWNER &&
    identity.repository === repositoryName;
}

export type Mode = "application-direct" | "mobile-transitive";
export type SourceKind = "root" | "pre-resolved" | "managed" | "override";

export interface ResolvedNode {
  readonly name: string;
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly sourceKind: SourceKind;
  readonly dirty: boolean;
}

export interface ResolutionOutput {
  readonly schemaVersion: number;
  readonly resolved: readonly ResolvedNode[];
}

export interface ResolveOptions {
  readonly mode: Mode;
  readonly root: string;
  readonly workspace: string;
  readonly applicationPath?: string;
  readonly overrideFile?: string;
}

export type VerifyOptions = Omit<ResolveOptions, "overrideFile">;

interface DependencySpec {
  readonly repository: string;
  readonly commit: string;
}

interface Coordination {
  readonly schemaVersion: number;
  readonly dependencies: { readonly core: DependencySpec };
}

interface OverrideSpec {
  readonly path: string;
}

interface Overrides {
  readonly schemaVersion: number;
  readonly overrides: { readonly core?: OverrideSpec };
}

function firstValidationMessage(validate: ValidateFunction): string {
  const error = validate.errors?.[0];
  if (error === undefined || error === null) {
    return "document did not satisfy its schema";
  }
  const location = error.instancePath.length > 0 ? error.instancePath : "/";
  return `${location} ${error.message ?? "is invalid"}`;
}

function statOrUndefined(path: string): Deno.FileInfo | undefined {
  try {
    return Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw new ResolverError("filesystem-error", "a filesystem probe failed");
  }
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (statOrUndefined(current) === undefined) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function containWithin(canonicalRoot: string, target: string): string {
  const absoluteTarget = resolve(target);
  const existing = nearestExistingAncestor(absoluteTarget);
  const realExisting = Deno.realPathSync(existing);
  const tail = relative(existing, absoluteTarget);
  const candidate = tail.length === 0 ? realExisting : join(realExisting, tail);
  const within = relative(canonicalRoot, candidate);
  if (within.length === 0 || within.startsWith("..") || isAbsolute(within)) {
    throw new ResolverError("path-escape", "resolved path escapes the consumer root");
  }
  return candidate;
}

class Git {
  constructor(private readonly runner: CommandRunner) {}

  private async attempt(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return await this.runner.run("git", args, cwd);
  }

  private async require(
    cwd: string,
    args: readonly string[],
    operation: string,
  ): Promise<CommandResult> {
    const result = await this.attempt(cwd, args);
    if (result.code !== 0) {
      throw new ResolverError("git-command-failed", `git ${operation} failed`);
    }
    return result;
  }

  async isWorkTree(dir: string): Promise<boolean> {
    const result = await this.attempt(dir, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) {
      return false;
    }
    try {
      return Deno.realPathSync(dir) === result.stdout.trim();
    } catch {
      return false;
    }
  }

  async head(dir: string): Promise<string> {
    return (await this.require(dir, ["rev-parse", "HEAD"], "rev-parse")).stdout.trim();
  }

  async isClean(dir: string): Promise<boolean> {
    return (await this.require(dir, ["status", "--porcelain"], "status")).stdout.trim().length ===
      0;
  }

  async isDetached(dir: string): Promise<boolean> {
    const result = await this.attempt(dir, ["symbolic-ref", "--quiet", "HEAD"]);
    return result.code !== 0;
  }

  async remoteUrls(dir: string): Promise<string[]> {
    const names = await this.attempt(dir, ["remote"]);
    if (names.code !== 0) {
      return [];
    }
    const urls: string[] = [];
    for (
      const name of names.stdout.split("\n").map((line) => line.trim()).filter((line) =>
        line.length > 0
      )
    ) {
      const url = await this.attempt(dir, ["config", "--get", `remote.${name}.url`]);
      if (url.code === 0 && url.stdout.trim().length > 0) {
        urls.push(url.stdout.trim());
      }
    }
    return urls;
  }

  async originEquals(dir: string, expected: string): Promise<boolean> {
    const url = await this.attempt(dir, ["config", "--get", "remote.origin.url"]);
    return url.code === 0 && url.stdout.trim() === expected;
  }

  async commitPresent(dir: string, commit: string): Promise<boolean> {
    const result = await this.attempt(dir, ["cat-file", "-e", `${commit}^{commit}`]);
    return result.code === 0;
  }

  async materialize(dir: string, repository: string, commit: string): Promise<void> {
    await this.require(dir, ["init", "--quiet"], "init");
    await this.require(dir, ["remote", "add", "origin", repository], "remote configuration");
    const fetch = await this.attempt(dir, ["fetch", "--quiet", "--no-tags", "origin", commit]);
    if (fetch.code !== 0 || !(await this.commitPresent(dir, commit))) {
      throw new ResolverError(
        "commit-unavailable",
        "the pinned commit is not available from the repository",
      );
    }
    await this.require(dir, ["checkout", "--quiet", "--detach", commit], "checkout");
  }
}

class WorkspaceLock {
  private held = false;
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    Deno.mkdirSync(dirname(this.lockPath), { recursive: true });
    try {
      Deno.mkdirSync(this.lockPath);
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new ResolverError("workspace-locked", "another resolver holds the workspace lock");
      }
      throw error;
    }
    this.held = true;
  }

  release(): void {
    if (!this.held) {
      return;
    }
    try {
      Deno.removeSync(this.lockPath);
    } catch {
      // Only a lock this process created is ever removed; a failure here is non-fatal.
    }
    this.held = false;
  }
}

export interface ResolverHooks {
  readonly afterLockAcquired?: () => Promise<void>;
}

export class SourceResolver {
  private readonly git: Git;
  private readonly validateCoordination: ValidateFunction;
  private readonly validateOverrides: ValidateFunction;
  private readonly validateOutput: ValidateFunction;
  private readonly afterLockAcquired?: () => Promise<void>;

  constructor(runner: CommandRunner, schemaDirectory: string, hooks: ResolverHooks = {}) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    this.git = new Git(runner);
    this.afterLockAcquired = hooks.afterLockAcquired;
    this.validateCoordination = ajv.compile(
      JSON.parse(
        Deno.readTextFileSync(join(schemaDirectory, "source-dependencies-v1.schema.json")),
      ) as AnySchema,
    );
    this.validateOverrides = ajv.compile(
      JSON.parse(
        Deno.readTextFileSync(join(schemaDirectory, "local-overrides-v1.schema.json")),
      ) as AnySchema,
    );
    this.validateOutput = ajv.compile(
      JSON.parse(
        Deno.readTextFileSync(join(schemaDirectory, "resolution-output-v1.schema.json")),
      ) as AnySchema,
    );
  }

  async resolve(options: ResolveOptions): Promise<ResolutionOutput> {
    return await this.inspect(options, true);
  }

  async verify(options: VerifyOptions): Promise<ResolutionOutput> {
    return await this.inspect({ ...options, overrideFile: undefined }, false);
  }

  private async inspect(options: ResolveOptions, materialize: boolean): Promise<ResolutionOutput> {
    const rootName = options.mode === "mobile-transitive" ? "mobile" : "application";
    const rootRepository = options.mode === "mobile-transitive"
      ? MOBILE_REPOSITORY
      : APPLICATION_REPOSITORY;
    const rootRepositoryName = options.mode === "mobile-transitive"
      ? MOBILE_REPOSITORY_NAME
      : APPLICATION_REPOSITORY_NAME;
    const canonicalRoot = await this.verifiedRoot(rootName, rootRepositoryName, options.root);
    const rootNode = await this.describeWorkTree(rootName, rootRepository, canonicalRoot, "root");
    if (!materialize) {
      this.assertProtectedWorkTree(rootNode);
    }

    const nodes: ResolvedNode[] = [rootNode];
    let coordinationDirectory = canonicalRoot;

    if (options.mode === "mobile-transitive") {
      if (options.applicationPath === undefined) {
        throw new ResolverError(
          "missing-application",
          "mobile-transitive mode requires an application path",
        );
      }
      const canonicalApplication = await this.canonicalWorkTree(
        options.applicationPath,
        "application",
      );
      if (!materialize) {
        const managedWorkspace = containWithin(canonicalRoot, options.workspace);
        const expectedApplication = containWithin(
          canonicalRoot,
          join(managedWorkspace, "application"),
        );
        if (canonicalApplication !== expectedApplication) {
          throw new ResolverError(
            "application-path-mismatch",
            "application is not the managed checkout",
          );
        }
        if (!(await this.git.originEquals(canonicalApplication, APPLICATION_REPOSITORY))) {
          throw new ResolverError(
            "application-repository-mismatch",
            "application has a noncanonical origin",
          );
        }
      }
      const application = await this.describeWorkTree(
        "application",
        APPLICATION_REPOSITORY,
        canonicalApplication,
        "pre-resolved",
      );
      if (!materialize) {
        this.assertProtectedWorkTree(application);
      }
      nodes.push(application);
      coordinationDirectory = canonicalApplication;
    }

    const coordination = this.loadCoordination(join(coordinationDirectory, COORDINATION_RELATIVE));
    const overrides = this.loadOverrides(options.overrideFile);

    const dependency = coordination.dependencies.core;
    const override = overrides?.overrides.core;
    nodes.push(
      override === undefined
        ? await this.resolveManaged(dependency, canonicalRoot, options.workspace, materialize)
        : await this.resolveOverride(dependency, override, options.overrideFile as string),
    );

    const output = { schemaVersion: 1, resolved: nodes };
    if (!materialize && !this.validateOutput(output)) {
      throw new ResolverError("malformed-output", "resolution output failed its schema");
    }
    return output;
  }

  private assertProtectedWorkTree(node: ResolvedNode): void {
    try {
      Deno.lstatSync(join(node.path, "coordination/local-overrides.json"));
      throw new ResolverError(
        "override-file-present",
        "local dependency override files are forbidden",
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    if (node.dirty) {
      throw new ResolverError(
        `${node.name}-dirty`,
        "the consumer worktree has uncommitted changes",
      );
    }
  }

  private async verifiedRoot(
    label: string,
    repositoryName: string,
    path: string,
  ): Promise<string> {
    const canonical = await this.canonicalWorkTree(path, label);
    const remotes = await this.git.remoteUrls(canonical);
    if (!remotes.some((url) => isCanonicalRemote(url, repositoryName))) {
      throw new ResolverError(
        `${label}-repository-mismatch`,
        `${label} root has no remote for the canonical ${label} repository`,
      );
    }
    return canonical;
  }

  private async canonicalWorkTree(path: string, label: string): Promise<string> {
    const absolute = resolve(path);
    const info = statOrUndefined(absolute);
    if (info === undefined) {
      throw new ResolverError(`${label}-missing`, `${label} path does not exist`);
    }
    if (!info.isDirectory) {
      throw new ResolverError(`${label}-invalid`, `${label} path is not a directory`);
    }
    const canonical = Deno.realPathSync(absolute);
    if (!(await this.git.isWorkTree(canonical))) {
      throw new ResolverError(`${label}-not-git`, `${label} path is not a Git work tree`);
    }
    return canonical;
  }

  private async describeWorkTree(
    name: string,
    repository: string,
    canonicalPath: string,
    sourceKind: SourceKind,
  ): Promise<ResolvedNode> {
    return {
      name,
      repository,
      commit: await this.git.head(canonicalPath),
      path: canonicalPath,
      sourceKind,
      dirty: !(await this.git.isClean(canonicalPath)),
    };
  }

  private loadCoordination(file: string): Coordination {
    const data = this.readJson(file, "invalid-coordination", "coordination document");
    if (!this.validateCoordination(data)) {
      throw new ResolverError(
        "invalid-coordination",
        `coordination document is invalid: ${firstValidationMessage(this.validateCoordination)}`,
      );
    }
    return data as Coordination;
  }

  private loadOverrides(file: string | undefined): Overrides | undefined {
    if (file === undefined || statOrUndefined(file) === undefined) {
      return undefined;
    }
    const data = this.readJson(file, "invalid-overrides", "overrides document");
    if (!this.validateOverrides(data)) {
      throw new ResolverError(
        "invalid-overrides",
        `overrides document is invalid: ${firstValidationMessage(this.validateOverrides)}`,
      );
    }
    return data as Overrides;
  }

  private readJson(file: string, reason: string, label: string): unknown {
    let text: string;
    try {
      text = Deno.readTextFileSync(file);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new ResolverError(reason, `${label} was not found`);
      }
      throw new ResolverError(reason, `${label} could not be read`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ResolverError(reason, `${label} is not valid JSON`);
    }
  }

  private async resolveManaged(
    dependency: DependencySpec,
    canonicalRoot: string,
    workspace: string,
    materialize: boolean,
  ): Promise<ResolvedNode> {
    const managedDirectory = containWithin(canonicalRoot, workspace);
    const destination = containWithin(canonicalRoot, join(managedDirectory, MANAGED_DEPENDENCY));
    const node: ResolvedNode = {
      name: MANAGED_DEPENDENCY,
      repository: dependency.repository,
      commit: dependency.commit,
      path: destination,
      sourceKind: "managed",
      dirty: false,
    };
    if (!materialize) {
      if (statOrUndefined(join(managedDirectory, ".lock")) !== undefined) {
        throw new ResolverError("workspace-locked", "another resolver holds the workspace lock");
      }
      if (statOrUndefined(destination) === undefined) {
        throw new ResolverError("unresolved-dependency", "the managed core checkout is missing");
      }
      await this.verifyReusable(destination, dependency);
      return node;
    }
    const lock = new WorkspaceLock(join(managedDirectory, ".lock"));
    lock.acquire();
    try {
      if (this.afterLockAcquired !== undefined) {
        await this.afterLockAcquired();
      }
      if (statOrUndefined(destination) === undefined) {
        await this.createManaged(destination, dependency);
      } else {
        await this.verifyReusable(destination, dependency);
      }
      return node;
    } finally {
      lock.release();
    }
  }

  private async verifyReusable(destination: string, dependency: DependencySpec): Promise<void> {
    if (!(await this.git.isWorkTree(destination))) {
      throw new ResolverError(
        "destination-not-git",
        "existing dependency path is not a managed Git checkout",
      );
    }
    if (!(await this.git.originEquals(destination, dependency.repository))) {
      throw new ResolverError(
        "destination-repository-mismatch",
        "existing dependency checkout has a different repository",
      );
    }
    if ((await this.git.head(destination)) !== dependency.commit) {
      throw new ResolverError(
        "destination-commit-mismatch",
        "existing dependency checkout is at a different commit",
      );
    }
    if (!(await this.git.isClean(destination))) {
      throw new ResolverError(
        "destination-dirty",
        "existing dependency checkout has uncommitted changes",
      );
    }
  }

  private async createManaged(destination: string, dependency: DependencySpec): Promise<void> {
    const parent = dirname(destination);
    Deno.mkdirSync(parent, { recursive: true });
    const staging = Deno.makeTempDirSync({ dir: parent, prefix: ".core-staging-" });
    try {
      await this.git.materialize(staging, dependency.repository, dependency.commit);
      if ((await this.git.head(staging)) !== dependency.commit) {
        throw new ResolverError("head-mismatch", "managed checkout is not at the pinned commit");
      }
      if (!(await this.git.isDetached(staging))) {
        throw new ResolverError("not-detached", "managed checkout is not at a detached HEAD");
      }
      if (!(await this.git.isClean(staging))) {
        throw new ResolverError("checkout-dirty", "managed checkout is not clean");
      }
      Deno.renameSync(staging, destination);
    } catch (error) {
      try {
        Deno.removeSync(staging, { recursive: true });
      } catch {
        // Only the staging directory this process created is removed.
      }
      throw error;
    }
  }

  private async resolveOverride(
    dependency: DependencySpec,
    override: OverrideSpec,
    overrideFile: string,
  ): Promise<ResolvedNode> {
    const base = dirname(resolve(overrideFile));
    const overridePath = resolve(base, override.path);
    if (statOrUndefined(overridePath) === undefined) {
      throw new ResolverError("override-missing", "override path does not exist");
    }
    const canonical = Deno.realPathSync(overridePath);
    if (!(await this.git.isWorkTree(canonical))) {
      throw new ResolverError("override-not-git", "override path is not a Git work tree");
    }
    if ((await this.git.head(canonical)) !== dependency.commit) {
      throw new ResolverError(
        "override-commit-mismatch",
        "override work tree is not at the pinned commit",
      );
    }
    return {
      name: MANAGED_DEPENDENCY,
      repository: dependency.repository,
      commit: dependency.commit,
      path: canonical,
      sourceKind: "override",
      dirty: !(await this.git.isClean(canonical)),
    };
  }
}

export function renderResolution(output: ResolutionOutput): string {
  const ordered = {
    schemaVersion: output.schemaVersion,
    resolved: output.resolved.map((node) => ({
      name: node.name,
      repository: node.repository,
      commit: node.commit,
      path: node.path,
      sourceKind: node.sourceKind,
      dirty: node.dirty,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function defaultSchemaDirectory(): string {
  const here = import.meta.dirname;
  if (here === undefined) {
    throw new ResolverError("environment", "unable to resolve the resolver module directory");
  }
  return resolve(here, "..", "schema");
}
