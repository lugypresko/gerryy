# Jerry LIVE implementation status

Updated: 2026-09-27

## Current implementation

- Jerry uses full-frame image pose-swap. No 2D puppet rig, layer extraction, or runtime video is used.
- The four pose assets are locked in the manifest with per-pose mouth anchors and a short crossfade.
- Live and fallback conversation paths remain available.
- Recording uses independent RMS auto-leveling and dynamics compression for Jerry and the guest.
- The monitor remains centered while recording outputs preserve speaker separation.
- Recording produces a stereo master plus dedicated speaker files.
- Recording produces `conversation.json` with turn number, speaker, text, and timestamps relative to recording start.

## Recording outputs

When microphone permission is available, stopping a recording exposes:

1. Master stereo recording — Jerry left, guest right.
2. Jerry-only track.
3. Guest-only track.
4. `conversation.json` turn log.

If microphone permission is unavailable, the app falls back to Jerry-only recording and does not expose an empty guest track.

## Configuration

The server reads the Gemini key from `GEMINI_API_KEY`.

For local development, create `.env` in the project root and use `.env.example` as the template. Never commit the real key; `.env*` is ignored by Git.

Start locally with:

```powershell
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Verification

The current branch passes:

```text
npm test   # 25 tests passing
npm run lint
npm run build
```

The remaining verification that requires a browser/device is a real microphone recording: download all outputs and inspect the master with `ffprobe` or an audio editor.

## Git and rollback

The implementation is on branch `feature/jerry-live-animation-recording`. The speaker export and turn-log commit is `d85e0c8`.

To revert only that change:

```bash
git revert d85e0c8
```
