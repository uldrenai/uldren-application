# Tooling

## Authoritative task interface

Every Uldren repository exposes the same root task interface, and this repository provides it
through `justfile`:

```sh
just all               # ci plus the integration suite
just ci                # non-mutating authoritative pull-request gate
just fmt               # format sources in place (local developer operation)
just fmt-check         # verify formatting without modifying files
just test-integration  # integration suite
```

`just ci` is non-mutating and matches the required pull-request checks. Continuous integration
invokes these same recipes rather than reproducing their commands in workflow files. `just all` is
allowed to include more expensive local diagnostics than the per-pull-request gate.

## Conditional execution

Each recipe checks for a `package.json` (pnpm/Turborepo) and a `native/Cargo.toml` (Cargo) workspace
and runs the corresponding gate when its manifest exists. `just ci` changes no files.

## Coordination schema

`just schema-test` validates the coordination dependency documents against
`coordination/schema/source-dependencies-v1.schema.json` with Ajv in JSON Schema 2020-12 mode. It is
non-mutating, runs within `just ci`, and pins Ajv through `deno.json` and `deno.lock`.

`just dependencies` resolves the pinned source dependencies into a managed checkout under
`.uldren/dependencies`; it is mutating and is not part of `just ci`. `just dependencies-test`
exercises the resolver in `coordination/tool/` against temporary Git repositories, is non-mutating,
and runs within `just ci`.

`just update-dependencies` resolves the current head of the canonical Core `main` branch and writes
the immutable commit into `coordination/source-dependencies.json`; it is mutating and is not part of
`just ci`. It follows `main` only at explicit update time, validates the document against its
schema, writes atomically, and refuses to modify an invalid document.
`just update-dependencies-test` runs the updater tests in isolation with an injected command
boundary; `just ci` also exercises them through `just dependencies-test`.

## Toolchain responsibilities

The workspace assigns these responsibilities:

- TypeScript: pnpm with Turborepo, strict `tsconfig`, type-aware ESLint, Prettier for formatting,
  and `knip` for unused code and dependencies.
- Markdown: Deno's built-in dprint formatter, configured by `deno.json`, with in-place formatting
  through `just fmt` and non-mutating verification through `just fmt-check`.
- Rust (native crates): `cargo fmt --check`, `cargo clippy` with warnings denied, `cargo test`,
  `cargo deny`, and coverage enforcement.
- Repository-wide continuous integration: EditorConfig, Conventional Commit validation, Dependabot,
  secret scanning, CodeQL, `actionlint`, `zizmor`, `shellcheck`, `shfmt`, `markdownlint-cli2`,
  `lychee`, `taplo`, JSON Schema validation, and software bill-of-materials and license generation.

Formatting commands in continuous integration always check; the mutating `just fmt` is a local
developer operation.

## Configuration authority

Where a tool's configuration file exists, that configuration is authoritative. This document
summarizes intent; it is not a substitute for the committed tool configuration.
