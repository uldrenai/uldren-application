import { resolve } from "node:path";

const WORKFLOWS = resolve(import.meta.dirname as string, "..", "..", ".github", "workflows");

interface Job {
  readonly name: string;
  readonly needs: readonly string[];
  readonly invokesIntegrity: boolean;
}

function read(name: string): string {
  return Deno.readTextFileSync(resolve(WORKFLOWS, name));
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function parseNeeds(body: readonly string[]): string[] {
  for (let index = 0; index < body.length; index += 1) {
    const match = body[index].match(/^ {4}needs:\s*(.*)$/);
    if (match === null) {
      continue;
    }
    const rest = match[1].trim();
    if (rest.startsWith("[")) {
      return rest
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter((item) => item.length > 0);
    }
    if (rest.length > 0) {
      return [rest.replace(/^["']|["']$/g, "")];
    }
    const items: string[] = [];
    for (let next = index + 1; next < body.length; next += 1) {
      const item = body[next].match(/^ {6}- (.+)$/);
      if (item === null) {
        break;
      }
      items.push(item[1].trim().replace(/^["']|["']$/g, ""));
    }
    return items;
  }
  return [];
}

function parseJobs(workflow: string): Job[] {
  const lines = workflow.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].replace(/\s+$/, "") !== "jobs:") {
    index += 1;
  }
  index += 1;
  const jobs: Job[] = [];
  let current: { name: string; body: string[] } | undefined;
  const finish = () => {
    if (current === undefined) {
      return;
    }
    jobs.push({
      name: current.name,
      needs: parseNeeds(current.body),
      invokesIntegrity: /just integrity-/.test(current.body.join("\n")),
    });
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && /^\S/.test(line)) {
      break;
    }
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch !== null) {
      finish();
      current = { name: jobMatch[1], body: [] };
    } else if (current !== undefined) {
      current.body.push(line);
    }
  }
  finish();
  return jobs;
}

function dependsOnIntegrity(
  name: string,
  jobs: Map<string, Job>,
  integrity: string,
  seen: Set<string>,
): boolean {
  if (name === integrity) {
    return true;
  }
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);
  const job = jobs.get(name);
  if (job === undefined) {
    return false;
  }
  return job.needs.some((need) => dependsOnIntegrity(need, jobs, integrity, seen));
}

function bypassingJob(workflow: string): string | undefined {
  const jobs = parseJobs(workflow);
  const integrity = jobs.find((job) => job.invokesIntegrity);
  if (integrity === undefined) {
    return "<missing-integrity-job>";
  }
  const byName = new Map(jobs.map((job) => [job.name, job]));
  for (const job of jobs) {
    if (job.name === integrity.name) {
      continue;
    }
    if (!dependsOnIntegrity(job.name, byName, integrity.name, new Set())) {
      return job.name;
    }
  }
  return undefined;
}

Deno.test("protected integrity runs before merge on pull requests and after merge on push", () => {
  const workflow = read("protected-integrity.yml");
  assert(workflow.includes("pull_request:"), "runs on pull_request to prevent an invalid merge");
  assert(workflow.includes("push:"), "retains a post-merge push check on main");
  assert(workflow.includes("branches: [main]"), "targets the protected main branch");
  assert(workflow.includes("just integrity-protected"), "invokes the protected integrity recipe");
});

Deno.test("workflows prepare exact dependencies before verification", () => {
  for (const name of ["protected-integrity.yml", "release.yml"]) {
    const workflow = read(name);
    const preparation = workflow.indexOf(
      "- run: just dependencies application-direct . .uldren/integrity",
    );
    const verification = workflow.indexOf("- run: just integrity-protected");
    assert(preparation >= 0 && preparation < verification, "preparation precedes verification");
    assert(!workflow.includes("--override-file"), "no workflow override selection");
    assert(!workflow.includes("continue-on-error"), "integrity failures cannot be ignored");
  }
});

Deno.test("pull-request CI runs transitive acceptance after the cached dependency gate", () => {
  const workflow = read("pull-request.yml");
  const gate = workflow.indexOf("- run: just ci");
  const acceptance = workflow.indexOf("- run: just integrity-acceptance");
  assert(gate >= 0 && acceptance > gate, "real CLI acceptance is a required CI step");
  assert(!workflow.includes("continue-on-error"), "acceptance failures cannot be ignored");
});

Deno.test("integrity recipes do not grant Deno filesystem write permission", () => {
  const justfile = Deno.readTextFileSync(resolve(WORKFLOWS, "../..", "justfile"));
  const invocations = justfile.split("\n").filter((line) =>
    line.includes("coordination/tool/integrity.ts")
  );
  assert(invocations.length === 2, "both protected and approved-tag entrypoints exist");
  for (const invocation of invocations) {
    assert(!invocation.includes("--allow-write"), "verification has no Deno write permission");
  }
});

Deno.test("the release workflow enforces integrity without coupling to the application version", () => {
  const workflow = read("release.yml");
  assert(workflow.includes('- "v[0-9]+.[0-9]+.[0-9]+"'), "triggers only on semver tags");
  assert(/just integrity-/.test(workflow), "invokes an integrity recipe");
  assert(
    !workflow.includes("github.ref_name"),
    "does not derive the core reference from the application release tag",
  );
  assert(
    !workflow.includes("RELEASE_TAG"),
    "does not pass the application tag as a core release reference",
  );
});

Deno.test("no non-integrity job in the shipped workflows can bypass the integrity gate", () => {
  for (const name of ["protected-integrity.yml", "release.yml"]) {
    const workflow = read(name);
    const jobs = parseJobs(workflow);
    assert(jobs.length > 0, `${name} must declare at least one job`);
    assert(
      jobs.some((job) => job.invokesIntegrity),
      `${name} must define a job that invokes the integrity recipe`,
    );
    const offender = bypassingJob(workflow);
    assert(
      offender === undefined,
      `${name}: job "${offender}" does not transitively depend on the integrity job`,
    );
  }
});

Deno.test("a reusable-workflow release job that skips the gate is detected as a bypass", () => {
  const bypass = [
    "name: release",
    "on:",
    "  push:",
    "    tags:",
    '      - "v[0-9]+.[0-9]+.[0-9]+"',
    "jobs:",
    "  dependency-integrity:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: just integrity-protected",
    "  publish:",
    "    uses: ./.github/workflows/publish.yml",
    "",
  ].join("\n");
  assertEquals(
    bypassingJob(bypass),
    "publish",
    "a reusable-workflow job with no dependency on the integrity job must be flagged",
  );
});

Deno.test("a reusable-workflow release job gated on the integrity job is accepted", () => {
  const gated = [
    "name: release",
    "on:",
    "  push:",
    "    tags:",
    '      - "v[0-9]+.[0-9]+.[0-9]+"',
    "jobs:",
    "  dependency-integrity:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: just integrity-protected",
    "  publish:",
    "    needs: [dependency-integrity]",
    "    uses: ./.github/workflows/publish.yml",
    "",
  ].join("\n");
  assertEquals(
    bypassingJob(gated),
    undefined,
    "a reusable-workflow job that depends on the integrity job must be accepted",
  );
});

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}
