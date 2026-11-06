# Bundled binaries

`scripts/fetch-node.js` (run by `postinstall` and `just natives`) downloads the standalone Node.js
binary that runs the elevated flash and unmount subprocesses into `<platform>/` here
(`node`, `node.exe`; git-ignored). See the README, "Flashing runtime". electron-builder ships the
directory through `asarUnpack`.
