# Releases

## Branch and tag model

- `main` is the only permanent branch; releases are immutable semantic-version tags of the form
  `v<major>.<minor>.<patch>`.
- A `release/<major>.<minor>` branch is created only when a released line needs parallel patch or
  security maintenance. There is no permanent `develop` branch.
- Pull requests merge with normal merge commits. Release tags are protected against updates and
  deletion.

## Artifacts and platforms

Desktop is the first-class release surface. arm64 and x86_64 are equally supported and each
architecture is built, signed, tested, and published as a distinct artifact:

- macOS: signed and notarized DMG and PKG.
- Windows: signed MSI and MSIX.
- Linux: signed RPM, signed DEB, and signed archive.

CLI, TUI, daemon, and web surfaces are compile-checked and excluded from release artifacts.
Releasing one of these surfaces requires updating this document and the release automation in the
same change.

## Distribution channels

The Uldren download site, GitHub Releases, Homebrew Cask, WinGet, Microsoft Store through MSIX where
policy permits, Uldren-hosted RPM and APT repositories, and direct signed archives.

## Release integrity

Every release is expected to publish checksums, dependency repository SHAs, build provenance, a
software bill of materials, license and notice material, update metadata, and architecture and
platform labels. Signing and notarization material comes from protected environments and is never
committed to the repository.

A release build must pass the dependency-integrity gate before publishing. The gate fails unless the
committed Core pin is an exact commit reachable from canonical protected Core `main` or an
explicitly approved immutable Core tag. The approved Core reference is independent of the
Application version: the release workflow verifies Core `main` reachability and never treats the
Application release tag as a Core reference. The same enforcement runs on protected `main` both
before merge, on pull requests targeting `main`, and after merge, on push to `main`.
