set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list --unsorted

fmt:
    @deno fmt
    @deno fmt --ext md NOTICE
    @if [ -f package.json ]; then pnpm run fmt; fi
    @if [ -f native/Cargo.toml ]; then cargo fmt --manifest-path native/Cargo.toml --all; fi

fmt-check:
    @deno fmt --check
    @deno fmt --check --ext md NOTICE
    @if [ -f package.json ]; then pnpm run fmt:check; fi
    @if [ -f native/Cargo.toml ]; then cargo fmt --manifest-path native/Cargo.toml --all -- --check; fi

test-integration:
    @if [ -f package.json ]; then pnpm run test:integration; fi
    @if [ -f native/Cargo.toml ]; then cargo test --manifest-path native/Cargo.toml --workspace --locked --tests; fi

schema-test:
    @deno test --frozen --allow-read coordination/test/

dependencies-test:
    @deno test --frozen --allow-read --allow-write --allow-run --allow-env coordination/tool/

dependencies mode root workspace application="" override_file="":
    @deno run --frozen --allow-read --allow-write --allow-run=git --allow-env=TMPDIR coordination/tool/cli.ts --mode {{ quote(mode) }} --root {{ quote(root) }} --workspace {{ quote(workspace) }} --application {{ quote(application) }} --override-file {{ quote(override_file) }}

ci: fmt-check schema-test dependencies-test
    @if [ -f package.json ]; then pnpm run lint; pnpm run typecheck; pnpm run build; pnpm run test; fi
    @if [ -f native/Cargo.toml ]; then cargo clippy --manifest-path native/Cargo.toml --workspace --locked --all-targets -- -D warnings; cargo test --manifest-path native/Cargo.toml --workspace --locked; fi

all: ci test-integration
