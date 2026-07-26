# Development

This document describes the developer workflow. Repository modification rules
for automated agents belong in `AGENTS.md`.

## Prerequisites

- [`just`](https://github.com/casey/just) for the root task interface.
- The Node and pnpm versions pinned by `package.json` and the package manager
  declaration when working with the TypeScript workspace.
- The Rust toolchain pinned by the native workspace when working with
  `native/Cargo.toml`.

## Branch and change workflow

- `main` is the only permanent branch. Direct commits to `main` are prohibited.
- Work happens on short-lived branches named `<type>/<short-kebab-description>`
  using the Conventional Commit types (`feat`, `fix`, `docs`, `chore`,
  `refactor`, `test`, `build`, `ci`, `perf`, `revert`). Branch names never
  contain ticket identifiers.
- Commit subjects use Conventional Commits: `<type>: <lower-case imperative
  description>`, with no ticket identifiers or trailers unless the repository
  explicitly requires them.
- Pull requests merge with normal merge commits; squash and rebase merging are
  disabled.

## Before opening a pull request

Run the non-mutating gate:

```sh
just ci
```

`just ci` is the authoritative pull-request gate and does not modify tracked
files. Use `just fmt` locally to apply formatting; continuous integration runs
`just fmt-check` and never reformats.

## Further reading

- [TESTING.md](TESTING.md) — test layout and how to run tests.
- [TOOLING.md](TOOLING.md) — the task interface and toolchain responsibilities.
- [RELEASES.md](RELEASES.md) — branch, tag, and release model.
