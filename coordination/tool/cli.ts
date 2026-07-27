import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/2020";
import { join } from "node:path";
import {
  defaultSchemaDirectory,
  DenoCommandRunner,
  type Mode,
  renderResolution,
  type ResolutionOutput,
  type ResolveOptions,
  ResolverError,
  SourceResolver,
} from "./resolver.ts";

export interface Resolver {
  resolve(options: ResolveOptions): Promise<ResolutionOutput>;
}

export interface CliDependencies {
  readonly resolver?: Resolver;
  readonly schemaDirectory?: string;
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const MODES: readonly Mode[] = ["application-direct", "mobile-transitive"];

const FLAGS = {
  "--mode": "mode",
  "--root": "root",
  "--workspace": "workspace",
  "--application": "application",
  "--override-file": "overrideFile",
} as const;

type FlagName = keyof typeof FLAGS;

function invalidInvocation(message: string): never {
  throw new ResolverError("invalid-invocation", message);
}

export function parseArguments(args: readonly string[]): ResolveOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const equals = token.indexOf("=");
    const flag = (equals === -1 ? token : token.slice(0, equals)) as FlagName;
    if (!(flag in FLAGS)) {
      invalidInvocation(`unknown argument: ${token}`);
    }
    let value: string;
    if (equals === -1) {
      const next = args[index + 1];
      if (next === undefined) {
        invalidInvocation(`missing value for ${flag}`);
      }
      value = next;
      index += 1;
    } else {
      value = token.slice(equals + 1);
    }
    values[FLAGS[flag]] = value;
  }

  const mode = values.mode ?? "";
  if (!MODES.includes(mode as Mode)) {
    invalidInvocation("mode must be application-direct or mobile-transitive");
  }
  if ((values.root ?? "").length === 0) {
    invalidInvocation("missing required argument for --root");
  }
  if ((values.workspace ?? "").length === 0) {
    invalidInvocation("missing required argument for --workspace");
  }
  const application = (values.application ?? "").length === 0 ? undefined : values.application;
  const overrideFile = (values.overrideFile ?? "").length === 0 ? undefined : values.overrideFile;
  if (mode === "mobile-transitive" && application === undefined) {
    invalidInvocation("mobile-transitive mode requires --application");
  }
  if (mode === "application-direct" && application !== undefined) {
    invalidInvocation("application-direct mode does not accept --application");
  }

  return {
    mode: mode as Mode,
    root: values.root,
    workspace: values.workspace,
    applicationPath: application,
    overrideFile,
  };
}

function compileOutputValidator(schemaDirectory: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(
    JSON.parse(
      Deno.readTextFileSync(join(schemaDirectory, "resolution-output-v1.schema.json")),
    ) as AnySchema,
  );
}

function diagnostic(reason: string, message: string): string {
  return `${JSON.stringify({ error: { reason, message } })}\n`;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  const schemaDirectory = dependencies.schemaDirectory ?? defaultSchemaDirectory();

  let options: ResolveOptions;
  try {
    options = parseArguments(args);
  } catch (error) {
    if (error instanceof ResolverError) {
      return { code: 2, stdout: "", stderr: diagnostic(error.reason, error.message) };
    }
    throw error;
  }

  const resolver = dependencies.resolver ??
    new SourceResolver(new DenoCommandRunner(), schemaDirectory);
  const validateOutput = compileOutputValidator(schemaDirectory);

  try {
    const output = await resolver.resolve(options);
    if (!validateOutput(output)) {
      throw new ResolverError("malformed-output", "resolution output failed its schema");
    }
    return { code: 0, stdout: renderResolution(output), stderr: "" };
  } catch (error) {
    if (error instanceof ResolverError) {
      return { code: 1, stdout: "", stderr: diagnostic(error.reason, error.message) };
    }
    return { code: 1, stdout: "", stderr: diagnostic("internal", "an unexpected error occurred") };
  }
}

if (import.meta.main) {
  const result = await runCli(Deno.args);
  const encoder = new TextEncoder();
  if (result.stdout.length > 0) {
    await Deno.stdout.write(encoder.encode(result.stdout));
  }
  if (result.stderr.length > 0) {
    await Deno.stderr.write(encoder.encode(result.stderr));
  }
  Deno.exit(result.code);
}
