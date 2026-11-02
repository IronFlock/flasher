set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# FlockFlasher — dev & release helpers. Run `just` to list recipes.

# Release names (see the release section below); the tag is `v<version>`.
RELEASE_NAME := "flockflasher"
VERSION_FILE := "package.json"
# Every file _write-version changes; the release commit holds exactly these.
VERSION_FILES := "package.json package-lock.json"

# electron-builder target for the CURRENT OS. macOS builds arm64 only, for local
# use: macOS is not released (see .github/workflows/release.yml).
BUILDER_TARGET := if os() == "macos" { "--mac --arm64" } else if os() == "linux" { "--linux" } else { "--win" }

default:
    @just --list

# Start the local dev environment (electron-vite with HMR).
dev:
    npm run dev

# Static checks without changing files (`npm run lint` fixes): eslint and
# the type checks. The CI gate runs lint, test and build.
lint:
    npx eslint .
    npm run typecheck

# Run the unit tests (Vitest).
test:
    npm test

# Type-check + build the app bundle (no publish).
build:
    npm run build

# Build, then run the production bundle locally to verify it works (no publish).
preview: build
    npm run start

# -----------------------------------------------------------------------------
# Package: the installer of the CURRENT OS in dist/, never published. The
# release workflow runs the same recipes on one runner per OS (see
# .github/actions/package) and publishes from CI; locally this is the smoke
# build. A macOS build is not notarized, so it is for local use only.
# -----------------------------------------------------------------------------

# Natives, app bundle and installer of the current OS into dist/ (no publish).
package: natives build installer

# The packaging steps of `npm install` (CI skips them there): the bundled Node,
# the native modules for Electron and mountutils for the bundled Node.
natives:
    node scripts/prepare-natives.js

# The installer of the current OS from the built app bundle into dist/, with
# the latest*.yml file the in-app updater reads (no publish).
installer:
    npx --no-install electron-builder {{BUILDER_TARGET}} --publish never

# ------------------------------------------------------------------ release --
# Pull requests into main, from IronFlock/workflows (scripts/pr.sh at v1); see
# its README, "Pull requests from a laptop":
#   just merge [TITLE]      a no-release pull request from this feature branch
#   just release-patch      a release pull request (-minor, -major): the bump
#                           from main's version on top of this branch (or on a
#                           new branch release/v<x> from an up-to-date main)
# Both merge automatically once ci and security are green; a release pull
# request also builds every installer as a dry run first. The merge of a
# release pull request runs .github/workflows/release.yml: the Linux and
# Windows installers are built, published as the GitHub Release v<version>,
# and the tag v<version> is set. Nothing is built or published from a laptop.

# Writes the version; called by pr.sh with the next version.
_write-version version:
    npm version "{{version}}" --no-git-tag-version --allow-same-version

[positional-arguments]
_pr *args:
    #!/usr/bin/env bash
    set -euo pipefail
    script=$(mktemp)
    trap 'rm -f "$script"' EXIT
    gh api -H 'Accept: application/vnd.github.raw' \
        'repos/IronFlock/workflows/contents/scripts/pr.sh?ref=v1' > "$script"
    bash "$script" "$@"

[positional-arguments]
merge TITLE="":
    just _pr merge {{VERSION_FILE}} "$1"

release-patch:
    just _pr release patch {{RELEASE_NAME}} {{VERSION_FILE}} release.yml {{VERSION_FILES}}

release-minor:
    just _pr release minor {{RELEASE_NAME}} {{VERSION_FILE}} release.yml {{VERSION_FILES}}

release-major:
    just _pr release major {{RELEASE_NAME}} {{VERSION_FILE}} release.yml {{VERSION_FILES}}
