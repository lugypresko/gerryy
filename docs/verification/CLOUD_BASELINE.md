# Gerryy Cloud Baseline

## Source of truth

- Repository: https://github.com/lugypresko/gerryy
- Baseline branch: `feature/codespaces-baseline`
- Parent implementation branch: `feature/canonical-capture-verified`
- Source commit: `e56605a3ff5816611b6d98a19aab4d521d71feaa`
- Known-good episode: `episode-1790597409868-z2czr3ul`

The source commit preserves the previously verified server-authoritative Canonical Capture implementation. It does not redesign Capture, STT, Audio Production, Jerry behavior, or Video.

## Codespaces

The `.devcontainer` uses Node 22 Bookworm and installs FFmpeg from the Debian package repository. Dependencies are installed reproducibly with `npm ci`.

Start Jerry with:

```bash
npm run dev
```

The application listens on `0.0.0.0:3000`. Codespaces forwards port `3000` and opens it in a browser.

## Environment variable names

Configure values through Codespaces/User Secrets or the environment; never commit values:

- `GEMINI_API_KEY`
- `APP_URL`
- `JERRY_RECORDINGS_DIR` (optional; defaults to `./data/recordings`)

## Verification

The repository was checked out from the GitHub branch above and dependencies were installed from the lockfile. The project checks passed in the available Node environment:

- `npm ci`
- focused Canonical Capture/lifecycle tests: 6 passed, 0 failed
- `npm test`: 119 passed, 0 failed
- `npm run lint`: passed
- `npm run build`: passed
- `ffmpeg -version`: available
- `ffprobe -version`: available

The Codespaces image is configured to use Node 22 Bookworm and install FFmpeg/FFprobe with `apt-get`. The local Windows host used for this verification does not have Docker installed, so the devcontainer image itself was not built locally.

## Known limitations

- The known-good browser episode was produced on the local Windows runtime; automated tests do not prove browser microphone permission, device routing, Gemini live audio, or a real browser `RECORD → Jerry → STOP` flow in Codespaces.
- Codespaces needs a configured `GEMINI_API_KEY` for live Jerry/STT behavior.
- Canonical recordings and other runtime data are persisted under `JERRY_RECORDINGS_DIR`; they are not source-controlled and require deliberate artifact storage if they must survive Codespace deletion.
- The verified episode's raw files are not present in GitHub. The source implementation and metadata evidence are preserved, but the binary recording must remain archived separately.

## Local-only inventory before deleting the Windows repository

The following are not expected to be in GitHub and must be preserved separately if needed:

- Raw canonical episode data under `data/recordings/`, including the known-good episode and any processed audio artifacts.
- Local environment values in `.env` and any API-key files. Values must not be copied into GitHub; recreate them as Codespaces secrets.
- Browser/device state, microphone permissions, and the real-browser evidence from the Windows run.
- Any uncommitted work in other local worktrees. This baseline includes the verified Capture implementation, but it does not automatically include unrelated local documents or experiments.
