# Uldren Application

Uldren Application is the public repository for Uldren's desktop, CLI, TUI, daemon, and web
surfaces, together with operating-system integration, packaging, and the application-side adapters
that connect those surfaces to the Uldren Core domain engine. It is licensed under Apache-2.0.

Uldren keeps domain behavior in a runtime-agnostic Rust core (`uldren-core`) and keeps this
repository thin by injecting environment-specific implementations through typed contracts. Desktop
is a tier-one product. CLI, TUI, daemon, and web remain compile-checked surfaces and are excluded
from release artifacts.

## Architecture

The repository uses a pnpm workspace managed by Turborepo for TypeScript, an Electron desktop host
rendering a React UI, and a native Rust layer reached through bindings to `uldren-core`. CLI, TUI,
daemon, and web surfaces reuse the application host, native adapter, lifecycle, configuration,
security policy, and packaging infrastructure.

The root `justfile` detects the pnpm workspace and native Cargo workspace. Each recipe activates the
relevant toolchain only when its manifest is present, while `just ci` remains non-mutating.

## Repository map

```text
uldren-application/
  apps/         desktop, cli, tui, daemon, web
  coordination/ schema and tests
  docs/
    DEVELOPMENT.md
    TESTING.md
    TOOLING.md
    RELEASES.md
  native/       Rust crates: host-bridge, uniffi-adapter
  packages/     contracts, host, ui-react, view-models, logging, credentials
  packaging/    platform installers and manifests
  tests/        contract, integration, security, end-to-end, fixtures
  .editorconfig
  .gitattributes
  .gitignore
  justfile
  LICENSE
  README.md
  SECURITY.md
```

Workspace manifests and package public entry points define the authoritative directory membership
and dependency boundaries.

## Prerequisites

- [`just`](https://github.com/casey/just) for the root task interface.
- The Node and pnpm versions pinned by the workspace when `package.json` is present.
- The Rust toolchain pinned by the native workspace when `native/Cargo.toml` is present.

## Bootstrap and common commands

With `just` installed, list the available recipes:

```sh
just --list
```

The root task interface is:

```sh
just all               # ci plus the integration suite
just ci                # non-mutating authoritative pull-request gate
just fmt               # format sources in place (local developer operation)
just fmt-check         # verify formatting without modifying files
just test-integration  # integration suite
```

Recipes activate TypeScript and Rust commands according to the manifests in the checkout.

## License and contributions

This repository is licensed under Apache-2.0; see [LICENSE](LICENSE). Apache-2.0 does not grant
rights to Uldren trademarks, official signing identities, hosted services, private mobile source, or
distribution accounts.

External contributions are accepted only under the repository contribution terms and required
Individual Contributor License Agreement.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open
public issues for security reports.
