# Contributing to Uldren Application

Thank you for your interest in contributing. Uldren Application is an open, Apache-2.0 licensed
repository. This document explains how contributions are accepted. Please also read
`CODE_OF_CONDUCT.md`.

## Licensing of contributions

The project is licensed under Apache License 2.0 (see `LICENSE`). By submitting a contribution, you
agree that it is provided under that same license.

## Individual Contributor License Agreement

An external contribution may be merged only from an individual who has an approved and completed
Individual Contributor License Agreement (CLA). While CLA enrollment is unavailable, an external
contribution cannot be merged. The CLA records the contributor's attestation that:

- They personally created the contribution and personally own it.
- It was not created within employment, contracting, consulting, sponsored, client, or other
  organizational work.
- No employer, client, school, or organization can claim ownership of it.
- They can grant the copyright and patent rights the CLA requires.
- Third-party material is identified and provided under a compatible license.

If ownership is ambiguous, the contribution is not merged.

CLA enrollment requires an approved Individual CLA, a durable public document location, a maintained
signing implementation, signature storage, and a required CLA status check. No CLA workflow runs and
no signatures are collected until those controls are configured.

## Organizational contributions

Organizationally owned contributions require an executed Corporate Contributor License Agreement
(CLA) and are not accepted without one:

- Employer-owned, client-owned, school-owned, and organization-sponsored contributions require an
  executed Corporate CLA.
- An executed Corporate CLA does not retroactively clear a contribution that was ineligible when it
  was submitted.
- AI-assisted or automated contributions remain the responsibility of the submitting individual and
  are subject to the same ownership attestation.

A contributor's email domain is only a review signal and is not treated as proof of ownership.

## How to contribute

1. Discuss significant changes in an issue before starting large work.
2. Fork the repository and create a short-lived branch named `<type>/<short-kebab-description>`,
   where `<type>` is one of `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `build`, `ci`,
   `perf`, or `revert`. Do not put issue or ticket identifiers in branch names.
3. Make focused changes that stay within the scope of your branch.
4. Write commit subjects as lower-case Conventional Commits, `<type>: <imperative description>`,
   with no trailers unless requested.
5. Before opening a pull request, run the non-mutating gate:

   ```sh
   just ci
   ```

   Also run `just test-integration` when your change affects integration behavior. Apply formatting
   locally with `just fmt`; the gate checks formatting and never reformats for you.
6. Open a pull request from your fork against `main`. Direct pushes to `main` are not permitted.

## Review and merge policy

- Every pull request must pass continuous integration and receive owner acceptance.
- The repository owner may accept and merge a pull request without second-person approval.
- Pull requests are merged with normal merge commits. Squash and rebase merging are disabled.
- Release tags are immutable semantic-version tags of the form `v<major>.<minor>.<patch>` and are
  never moved or deleted.

## Reporting security issues

Do not report security vulnerabilities through public issues, pull requests, or discussions. Follow
the private process in `SECURITY.md`.

## Enforcement boundaries

Maintainers may decline, request changes to, or close a contribution that does not meet the license,
CLA, ownership, quality, or scope requirements above, or that conflicts with the project's
architecture and review standards. Contribution decisions are made by the repository maintainers.
Conduct in project spaces is governed separately by `CODE_OF_CONDUCT.md`.
