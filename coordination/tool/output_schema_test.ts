import { Ajv2020, type AnySchema } from "ajv/2020";
import { defaultSchemaDirectory } from "./resolver.ts";
import { join } from "node:path";

const validate = (() => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(
    JSON.parse(
      Deno.readTextFileSync(join(defaultSchemaDirectory(), "resolution-output-v1.schema.json")),
    ) as AnySchema,
  );
})();

const APPLICATION = "https://github.com/uldrenai/uldren-application.git";
const CORE = "https://github.com/uldrenai/uldren-core.git";
const COMMIT = "a".repeat(40);

function graphWithCorePath(corePath: string): unknown {
  return {
    schemaVersion: 1,
    resolved: [
      {
        name: "application",
        repository: APPLICATION,
        commit: COMMIT,
        path: "/opt/uldren-application",
        sourceKind: "root",
        dirty: false,
      },
      {
        name: "core",
        repository: CORE,
        commit: COMMIT,
        path: corePath,
        sourceKind: "managed",
        dirty: false,
      },
    ],
  };
}

Deno.test("output schema accepts cross-platform absolute paths", () => {
  const accepted = [
    "/opt/uldren-core",
    "C:\\work\\uldren-core",
    "C:/work/uldren-core",
    "\\\\server\\share\\uldren-core",
  ];
  for (const path of accepted) {
    if (!validate(graphWithCorePath(path))) {
      throw new Error(`rejected valid absolute path ${path}: ${JSON.stringify(validate.errors)}`);
    }
  }
});

Deno.test("output schema rejects relative and drive-relative paths", () => {
  const rejected = [
    "uldren-core",
    "./uldren-core",
    "relative/uldren-core",
    "C:uldren-core",
    "\\bare",
    "\\\\server",
    "\\\\server\\",
  ];
  for (const path of rejected) {
    if (validate(graphWithCorePath(path))) {
      throw new Error(`accepted non-absolute path ${path}`);
    }
  }
});
