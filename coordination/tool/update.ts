import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/2020";
import { dirname, join, resolve } from "node:path";
import {
  type CommandRunner,
  CORE_REPOSITORY,
  DenoCommandRunner,
  ResolverError,
} from "./resolver.ts";

const CORE_MAIN_REF = "refs/heads/main";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CREATED_FILE_MODE = 0o644;

export interface UpdateDependencies {
  readonly runner?: CommandRunner;
  readonly schemaDirectory?: string;
  readonly coordinationFile?: string;
}

export interface UpdateResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DependencyEntry {
  readonly repository: string;
  readonly commit: string;
}

interface Coordination {
  readonly schemaVersion: number;
  readonly dependencies: { readonly core: DependencyEntry };
}

interface ExistingCoordination {
  readonly raw: string;
  readonly document: Coordination;
}

function diagnostic(reason: string, message: string): string {
  return `${JSON.stringify({ error: { reason, message } })}\n`;
}

function outcome(status: string, commit: string): string {
  return `${JSON.stringify({ update: { status, commit } })}\n`;
}

function defaultSchemaDirectory(): string {
  const here = import.meta.dirname;
  if (here === undefined) {
    throw new ResolverError("environment", "unable to resolve the updater module directory");
  }
  return resolve(here, "..", "schema");
}

function defaultCoordinationFile(): string {
  const here = import.meta.dirname;
  if (here === undefined) {
    throw new ResolverError("environment", "unable to resolve the updater module directory");
  }
  return resolve(here, "..", "source-dependencies.json");
}

export type DirectoryStat = (path: string) => Deno.FileInfo;

export function nearestExistingDirectory(
  directory: string,
  stat: DirectoryStat = (path) => Deno.statSync(path),
): string {
  let current = directory;
  while (true) {
    let info: Deno.FileInfo | undefined;
    try {
      info = stat(current);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new ResolverError(
          "coordination-unwritable",
          "the coordination directory could not be inspected",
        );
      }
    }
    if (info !== undefined) {
      if (!info.isDirectory) {
        throw new ResolverError(
          "coordination-unwritable",
          "the coordination directory path is not a directory",
        );
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new ResolverError(
        "coordination-unwritable",
        "no existing ancestor directory was found for the coordination path",
      );
    }
    current = parent;
  }
}

async function assertWorktreeClean(runner: CommandRunner, file: string): Promise<void> {
  const result = await runner.run(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", file],
    nearestExistingDirectory(dirname(file)),
  );
  if (result.code !== 0) {
    throw new ResolverError(
      "worktree-status-failed",
      "the coordination worktree status could not be determined",
    );
  }
  if (result.stdout.trim().length > 0) {
    throw new ResolverError(
      "coordination-dirty",
      "the coordination document has uncommitted changes",
    );
  }
}

async function resolveCoreMain(runner: CommandRunner): Promise<string> {
  const result = await runner.run("git", ["ls-remote", CORE_REPOSITORY, CORE_MAIN_REF], ".");
  if (result.code !== 0) {
    throw new ResolverError(
      "git-command-failed",
      "resolving the canonical Core main branch failed",
    );
  }
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
  if (lines.length === 0) {
    throw new ResolverError(
      "core-main-missing",
      "the canonical Core repository has no main branch",
    );
  }
  if (lines.length > 1) {
    throw new ResolverError(
      "core-main-ambiguous",
      "the canonical Core main branch resolved to multiple references",
    );
  }
  const fields = lines[0].split(/\s+/);
  if (fields.length !== 2 || fields[1] !== CORE_MAIN_REF) {
    throw new ResolverError(
      "core-main-malformed",
      "the canonical Core main reference listing was malformed",
    );
  }
  if (!COMMIT_PATTERN.test(fields[0])) {
    throw new ResolverError(
      "core-main-malformed",
      "the canonical Core main reference did not resolve to a commit SHA",
    );
  }
  return fields[0];
}

function loadExisting(file: string, validate: ValidateFunction): ExistingCoordination | undefined {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw new ResolverError(
      "coordination-unreadable",
      "the coordination document could not be read",
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ResolverError("invalid-coordination", "the coordination document is not valid JSON");
  }
  if (!validate(data)) {
    throw new ResolverError(
      "invalid-coordination",
      "the existing coordination document does not satisfy its schema",
    );
  }
  return { raw, document: data as Coordination };
}

function nextCoordination(
  existing: ExistingCoordination | undefined,
  commit: string,
): Coordination {
  const schemaVersion = existing?.document.schemaVersion ?? 1;
  const repository = existing?.document.dependencies.core.repository ?? CORE_REPOSITORY;
  return { schemaVersion, dependencies: { core: { repository, commit } } };
}

function serialize(document: Coordination): string {
  const ordered = {
    schemaVersion: document.schemaVersion,
    dependencies: {
      core: {
        repository: document.dependencies.core.repository,
        commit: document.dependencies.core.commit,
      },
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function destinationMode(file: string): number {
  let info: Deno.FileInfo | undefined;
  try {
    info = Deno.lstatSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return CREATED_FILE_MODE;
    }
    throw new ResolverError(
      "coordination-unwritable",
      "the coordination path could not be inspected",
    );
  }
  if (!info.isFile) {
    throw new ResolverError(
      "coordination-not-regular",
      "the coordination path is not a regular file",
    );
  }
  return (info.mode ?? CREATED_FILE_MODE) & 0o777;
}

function writeAtomic(file: string, contents: string): void {
  const directory = dirname(file);
  Deno.mkdirSync(directory, { recursive: true });
  const mode = destinationMode(file);
  const temporary = Deno.makeTempFileSync({
    dir: directory,
    prefix: ".source-dependencies-",
    suffix: ".json",
  });
  try {
    Deno.writeTextFileSync(temporary, contents);
    Deno.chmodSync(temporary, mode);
    Deno.renameSync(temporary, file);
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch {
      // Only the temporary file this process created is removed.
    }
    throw error;
  }
}

export async function runUpdate(dependencies: UpdateDependencies = {}): Promise<UpdateResult> {
  const schemaDirectory = dependencies.schemaDirectory ?? defaultSchemaDirectory();
  const coordinationFile = dependencies.coordinationFile ?? defaultCoordinationFile();
  const runner = dependencies.runner ?? new DenoCommandRunner();

  try {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(
      JSON.parse(
        Deno.readTextFileSync(join(schemaDirectory, "source-dependencies-v1.schema.json")),
      ) as AnySchema,
    );

    const existing = loadExisting(coordinationFile, validate);
    await assertWorktreeClean(runner, coordinationFile);
    const commit = await resolveCoreMain(runner);
    const next = nextCoordination(existing, commit);
    if (!validate(next)) {
      throw new ResolverError(
        "invalid-result",
        "the generated coordination document did not satisfy its schema",
      );
    }
    const serialized = serialize(next);
    if (existing !== undefined && existing.raw === serialized) {
      return { code: 0, stdout: outcome("unchanged", commit), stderr: "" };
    }
    writeAtomic(coordinationFile, serialized);
    return {
      code: 0,
      stdout: outcome(existing === undefined ? "created" : "updated", commit),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof ResolverError) {
      return { code: 1, stdout: "", stderr: diagnostic(error.reason, error.message) };
    }
    return { code: 1, stdout: "", stderr: diagnostic("internal", "an unexpected error occurred") };
  }
}

if (import.meta.main) {
  const result = await runUpdate();
  const encoder = new TextEncoder();
  if (result.stdout.length > 0) {
    await Deno.stdout.write(encoder.encode(result.stdout));
  }
  if (result.stderr.length > 0) {
    await Deno.stderr.write(encoder.encode(result.stderr));
  }
  Deno.exit(result.code);
}
