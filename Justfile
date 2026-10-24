set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# FlockFlasher — dev & release helpers. Run `just` to list recipes.

ROOT_DIR := justfile_directory()
VERSION := `node -p "require('./package.json').version"`

# Release names (see the release section below); the tag is `v<version>`.
RELEASE_NAME := "flockflasher"
VERSION_FILE := "package.json"
# Every file _write-version changes; the release commit holds exactly these.
VERSION_FILES := "package.json package-lock.json"

# electron-builder target for the CURRENT OS. macOS builds arm64 only — the
# amd64/x64 mac build was dropped, which also removes the manual latest-mac.yml
# stitching step described in the README. Run `just release` once per platform.
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
# Release: build + publish to GitHub Releases for the CURRENT OS. Run once per
# target machine (macOS arm64 / Windows / Linux), from the tag that the merge
# of a release pull request set (see the release section below and the README).
# Uses GH_TOKEN from the environment or .env, else the gh CLI login; on macOS
# also APPLEID + APPLEIDPASS in .env for notarization.
# -----------------------------------------------------------------------------

# Build + publish the current OS's artifact to GitHub Releases.
release:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ROOT_DIR}}
    # Load secrets (GH_TOKEN, and on macOS APPLEID/APPLEIDPASS) from .env if present,
    # matching the project convention (scripts/notarize.js also reads .env via dotenv).
    # An already-exported GH_TOKEN in the shell still wins if .env doesn't define one.
    if [ -f .env ]; then set -a; . ./.env; set +a; fi
    # Without an explicit GH_TOKEN, use the gh CLI login (scoped to whatever the
    # account can reach, IronFlock/flasher included). A static PAT in .env dies
    # silently on revocation or when the repo moves to another owner.
    if [ -z "${GH_TOKEN:-}" ]; then
        GH_TOKEN="$(env -u GITHUB_TOKEN gh auth token 2>/dev/null || true)"
        export GH_TOKEN
    fi
    : "${GH_TOKEN:?set GH_TOKEN, or log in with gh auth login, to publish to GitHub Releases}"
    npm run build
    npx --no-install electron-builder {{BUILDER_TARGET}} --publish always

# ------------------------------------------------------------------ release --
# Pull requests into main, from IronFlock/workflows (scripts/pr.sh at v1); see
# its README, "Pull requests from a laptop":
#   just merge [TITLE]      a no-release pull request from this feature branch
#   just release-patch      a release pull request (-minor, -major): the bump
#                           from main's version on top of this branch (or on a
#                           new branch release/v<x> from an up-to-date main)
# Both merge automatically once ci and security are green. The merge of a
# release pull request sets the tag v<version> in CI; then publish the
# artifacts with a bare `just release` on each OS machine (macOS first: it
# notarizes), from that tag (`git fetch --tags && git switch --detach v<x>`),
# into the same GitHub Release.

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
