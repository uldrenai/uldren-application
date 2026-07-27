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

ci: fmt-check
    @if [ -f package.json ]; then pnpm run lint; pnpm run typecheck; pnpm run build; pnpm run test; fi
    @if [ -f native/Cargo.toml ]; then cargo clippy --manifest-path native/Cargo.toml --workspace --locked --all-targets -- -D warnings; cargo test --manifest-path native/Cargo.toml --workspace --locked; fi

all: ci test-integration
