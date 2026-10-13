set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# FlockFlasher — dev & release helpers. Run `just` to list recipes.

ROOT_DIR := justfile_directory()
VERSION := `node -p "require('./package.json').version"`

# Release contract — see REDeployments/docs/RELEASE.md. Single-project repo,
# so the tag is plain `v<version>`.
RELEASE_NAME := "flockflasher"
VERSION_FILES := "package.json package-lock.json"
RELEASE_TAG := "v" + VERSION

# electron-builder target for the CURRENT OS. macOS builds arm64 only — the
# amd64/x64 mac build was dropped, which also removes the manual latest-mac.yml
# stitching step described in the README. Run `just release` once per platform.
BUILDER_TARGET := if os() == "macos" { "--mac --arm64" } else if os() == "linux" { "--linux" } else { "--win" }

default:
    @just --list

# Start the local dev environment (electron-vite with HMR).
dev:
    npm run dev

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
# Version bumping. Edits package.json + package-lock.json only — no git commit,
# so you can review the change first. Normally you don't call these directly:
# `just release-patch` runs the bump, the build+publish and the release commit
# in one go.
# -----------------------------------------------------------------------------

# Bump the patch version (x.y.Z).
bump-patch:
    npm version patch --no-git-tag-version
    @echo "Bumped patch. To bump, build, publish, commit and tag in one step: just release-patch"

# Bump the minor version (x.Y.0).
bump-minor:
    npm version minor --no-git-tag-version
    @echo "Bumped minor. To bump, build, publish, commit and tag in one step: just release-minor"

# Bump the major version (X.0.0).
bump-major:
    npm version major --no-git-tag-version
    @echo "Bumped major. To bump, build, publish, commit and tag in one step: just release-major"

# -----------------------------------------------------------------------------
# Release: build + publish to GitHub Releases for the CURRENT OS. Run once per
# target machine (macOS arm64 / Windows / Linux), as described in the README.
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
# Release contract — see REDeployments/docs/RELEASE.md
#
#   just release-patch = _require-clean -> bump-patch -> release -> _release-commit
#
# `release` publishes the CURRENT OS's artifact only, so a full release is
# `just release-patch` on the FIRST machine (which bumps, publishes, commits
# and tags), then a bare `just release` on the other two after pulling that
# commit — same version, same GitHub Release, other platforms' artifacts.
#
# The steps run as sub-`just` processes, never as Just dependencies: just
# evaluates variables once at parse time, so VERSION would still hold the
# PRE-bump value if these ran as deps — the tag and the commit message would
# name the old version while package.json already said the new one.

# Releases come off a clean tree: the release commit must carry the version
# bump and nothing else, and a tag whose content is unprovable is worse than
# no tag at all. Commit your work first, with a message that describes it.
_require-clean:
    #!/usr/bin/env bash
    set -euo pipefail
    dirty=$(git status --porcelain -- . 2>/dev/null || true)
    if [ -n "$dirty" ]; then
        echo "release: uncommitted changes here — commit them first, with a" >&2
        echo "         message describing the work. The release commit that" >&2
        echo "         follows carries the version bump alone." >&2
        echo >&2
        printf '%s\n' "$dirty" >&2
        exit 1
    fi

# Explicit file list, never `git add -A`: the tree was clean before bump-patch
# ran, so the version files are the only legitimate change.
_release-commit:
    #!/usr/bin/env bash
    set -euo pipefail
    git add -- {{VERSION_FILES}}
    git commit -m "release {{RELEASE_NAME}} v{{VERSION}}"
    git tag -a "{{RELEASE_TAG}}" -m "release {{RELEASE_NAME}} v{{VERSION}}"
    git push
    git push origin "{{RELEASE_TAG}}"

# Bump the patch version, then build + publish for the current OS.
release-patch:
    just _require-clean
    just bump-patch
    just release
    just _release-commit

# Bump the minor version, then build + publish for the current OS.
release-minor:
    just _require-clean
    just bump-minor
    just release
    just _release-commit

# Bump the major version, then build + publish for the current OS.
release-major:
    just _require-clean
    just bump-major
    just release
    just _release-commit
