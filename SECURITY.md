# Security Policy

## Supported Versions

We provide security fixes for the latest minor version line.

| Version | Supported |
|---------|-----------|
| 1.1.x   | ✓         |
| < 1.1   | ✗         |

## Reporting a Vulnerability

If you discover a security issue, please **do not** open a public issue.
Instead, email **wkq321@gmail.com** with:

- A description of the issue.
- Steps to reproduce (if possible).
- The affected version(s).

We'll acknowledge within 72 hours and aim to release a fix in the next patch version.

## Supply-chain Notes

- The app is built with `electron-builder` and published to
  [GitHub Releases](https://github.com/whalemindbass/yt-separator-releases/releases)
  via a scripted release flow that verifies asset checksums (`sha512` in `latest.yml`).
- Auto-updates use `electron-updater` and verify updates against the same manifest.
- ONNX model files are hosted on a dedicated GitHub Release
  (`models-v1`) and downloaded on demand. Files are pinned by URL.
- Bundled third-party binaries:
  - `yt-dlp` — https://github.com/yt-dlp/yt-dlp
  - `ffmpeg` — https://ffmpeg.org
- Runtime dependencies are pinned via `package-lock.json`.

## Data Handling

- No telemetry, no analytics.
- User video / audio is processed **locally** — nothing is uploaded to
  external servers other than the initial download from the URL the user provides
  (via `yt-dlp`) and the one-time model download from GitHub Releases.
