# Testing

## Test layout

Repository-level tests use the following layout:

```text
tests/
  contract/
  end-to-end/
  fixtures/
  integration/
  security/
```

Package- and app-level unit tests live beside their sources under `apps/*/test` and
`packages/*/test`. Native Rust tests live within the `native/` Cargo workspace.

Cross-repository coordination data has its schema and fixtures under `coordination/`:

```text
coordination/
  schema/
  test/
    fixtures/
      valid/
      invalid/
```

## Running tests

The root task interface is the entry point for tests:

```sh
just all               # ci plus the integration suite
just ci                # formatting check, static analysis, unit, and build gates
just schema-test       # coordination dependency schema fixtures
just test-integration  # integration suite
```

`just schema-test` validates the coordination dependency documents against
`coordination/schema/source-dependencies-v1.schema.json` and runs within `just ci`.

Continuous integration invokes the same `just` recipes rather than reproducing their logic in
workflow files.

## Placement and isolation

- Keep unit tests next to the code they cover; keep cross-cutting suites under `tests/`.
- Tests must not depend on developer-specific state or network access unless explicitly marked as
  integration or end-to-end.
- Integration and end-to-end suites carry their fixtures under `tests/fixtures/`.

## Review focus

Review each change skeptically across correctness, type safety, security, contract compliance, edge
cases, performance, API design, and test coverage. Trace behavior through Electron IPC and native
boundaries to the authoritative contract. Test observable effects rather than relying only on mocks
that copy the expected implementation.
