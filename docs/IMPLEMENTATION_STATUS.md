# Jerry LIVE implementation status

Updated: 2026-09-27
Version: `1.1.3`
Branch: `feature/jerry-live-animation-recording`

## Current implementation

- Jerry uses full-frame image pose-swap. No 2D puppet rig, layer extraction, or runtime video is used.
- The four pose assets are locked in the manifest with per-pose mouth anchors, preload, fallback, and short crossfade.
- Live conversation uses Gemini Live for low-latency interim transcription and response audio.
- Each push-to-talk turn is also buffered as 16 kHz PCM and finalized with full-turn Hebrew transcription before forwarding to Jerry.
- If authoritative transcription fails, the Live candidate is used as a fallback. If no transcript exists, the client receives an explicit `stt-error` instead of waiting indefinitely.
- Recording uses independent RMS auto-leveling, dynamics compression, and a master limiter for Jerry and the guest.
- The monitor remains centered while recording outputs preserve speaker separation.
- Recording produces a stereo master, dedicated Jerry/guest tracks when available, and `conversation.json` with relative turn timestamps.

## Recording outputs

When microphone permission is available, stopping a recording exposes:

1. Master stereo recording — Jerry left, guest right.
2. Jerry-only track.
3. Guest-only track.
4. `conversation.json` turn log.

If microphone permission is unavailable, the app falls back to Jerry-only recording and does not expose an empty guest track.

## Debug and self-diagnosis

The server maintains a bounded ring buffer of the last 200 conversation events:

```text
http://localhost:3000/api/jerry-debug
```

The monitor covers:

- socket/session lifecycle and engine readiness;
- microphone permissions, device, track state, PCM sample rate, RMS, peak, clipping, and silence/noise indicators;
- Live interim/final STT, authoritative STT, fallback, timeout, and forwarding to Jerry;
- Jerry transcript, streamed audio, turn completion, and playback chain;
- pose/animation transitions and visual asset load errors;
- master recording, speaker tracks, MediaRecorder chunks, MIME type, final blob, recording mode, and turn-log entries;
- malformed telemetry payloads as `socket-invalid-message` instead of uncaught JSON errors.

Only bounded metadata and text previews are recorded. Raw audio/video is not stored by the debug monitor.

Expected guest turn chain:

```text
guest-turn-start
  -> guest-turn-end
  -> authoritative-start
  -> authoritative-success | authoritative-fallback | authoritative-timeout
  -> guest-transcript-forwarded
  -> jerry-audio
  -> jerry-turn-complete
```

## Configuration and local run

The server reads the Gemini key from `GEMINI_API_KEY` or the local key file. For local development, create `.env` from `.env.example`; never commit the real key.

```powershell
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Verification

The current branch passes:

```text
npm test        # 35 tests passing
npm run lint
npm run build
```

The live WebSocket E2E path was verified for:

- `ready -> audio -> transcript -> turn-complete`;
- audio turn start/end and authoritative STT failure reporting;
- debug event collection through `/api/jerry-debug`.

Remaining device QA is a real spoken Hebrew microphone turn and a physical recording inspection with `ffprobe` or an audio editor.

## Git and rollback

Latest implementation commit: `795e958` (`feat: monitor full conversation media and recording chain`).

Rollback the latest commit:

```powershell
git revert 795e958
```

Rollback the previous STT timeout/debug monitor commit as a separate step if required:

```powershell
git revert 693852a
```
