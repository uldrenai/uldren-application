import { Ajv2020, type AnySchema } from "ajv/2020";

interface NegativeExpectation {
  readonly instancePath: string;
  readonly keyword: string;
  readonly params: Record<string, unknown>;
}

const testDir = import.meta.dirname;
if (testDir === undefined) {
  throw new Error("unable to resolve the coordination test directory");
}

const schema = JSON.parse(
  Deno.readTextFileSync(`${testDir}/../schema/source-dependencies-v1.schema.json`),
) as AnySchema;
const negativeExpectations = JSON.parse(
  Deno.readTextFileSync(`${testDir}/negative-expectations.json`),
) as Record<string, NegativeExpectation>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

function discover(kind: "valid" | "invalid"): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(`${testDir}/fixtures/${kind}`)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      names.push(entry.name);
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function matchesParams(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.keys(expected).every(
    (key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]),
  );
}

const validFixtures = discover("valid");
const invalidFixtures = discover("invalid");

if (validFixtures.length === 0) {
  throw new Error("the valid fixture corpus is empty");
}
if (invalidFixtures.length === 0) {
  throw new Error("the invalid fixture corpus is empty");
}

Deno.test("every negative fixture declares an expectation", () => {
  for (const name of invalidFixtures) {
    if (!Object.prototype.hasOwnProperty.call(negativeExpectations, name)) {
      throw new Error(`no expectation declared for ${name}`);
    }
  }
  for (const name of Object.keys(negativeExpectations)) {
    if (!invalidFixtures.includes(name)) {
      throw new Error(`expectation ${name} has no matching fixture`);
    }
  }
});

for (const name of validFixtures) {
  Deno.test(`valid/${name}`, () => {
    const document = JSON.parse(
      Deno.readTextFileSync(`${testDir}/fixtures/valid/${name}`),
    );
    if (!validate(document)) {
      throw new Error(`expected valid; errors=${JSON.stringify(validate.errors)}`);
    }
  });
}

for (const name of invalidFixtures) {
  Deno.test(`invalid/${name}`, () => {
    const document = JSON.parse(
      Deno.readTextFileSync(`${testDir}/fixtures/invalid/${name}`),
    );
    if (validate(document)) {
      throw new Error("expected the document to be rejected");
    }
    const expected = negativeExpectations[name];
    const matched = (validate.errors ?? []).some(
      (error) =>
        error.instancePath === expected.instancePath &&
        error.keyword === expected.keyword &&
        matchesParams(error.params as Record<string, unknown>, expected.params),
    );
    if (!matched) {
      throw new Error(
        `expected ${expected.keyword} at "${expected.instancePath}" with params ${
          JSON.stringify(expected.params)
        }; errors=${JSON.stringify(validate.errors)}`,
      );
    }
  });
}
