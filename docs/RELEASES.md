# Releases

## Branch and tag model

- `main` is the only permanent branch; releases are immutable semantic-version
  tags of the form `v<major>.<minor>.<patch>`.
- A `release/<major>.<minor>` branch is created only when a released line needs
  parallel patch or security maintenance. There is no permanent `develop`
  branch.
- Pull requests merge with normal merge commits. Release tags are protected
  against updates and deletion.

## Artifacts and platforms

Desktop is the first-class release surface. arm64 and x86_64 are equally
supported and each architecture is built, signed, tested, and published as a
distinct artifact:

- macOS: signed and notarized DMG and PKG.
- Windows: signed MSI and MSIX.
- Linux: signed RPM, signed DEB, and signed archive.

CLI, TUI, daemon, and web surfaces are compile-checked and excluded from release
artifacts. Releasing one of these surfaces requires updating this document and
the release automation in the same change.

## Distribution channels

The Uldren download site, GitHub Releases, Homebrew Cask, WinGet, Microsoft
Store through MSIX where policy permits, Uldren-hosted RPM and APT repositories,
and direct signed archives.

## Release integrity

Every release is expected to publish checksums, dependency repository SHAs,
build provenance, a software bill of materials, license and notice material,
update metadata, and architecture and platform labels. Signing and notarization
material comes from protected environments and is never committed to the
repository.
