# Jerry Debug Monitor

## Endpoint

With the local server running, inspect the recent monitor events at:

```text
http://localhost:3000/api/jerry-debug
```

The response contains `maxEvents` and an `events` array. The buffer is in-memory and bounded to 200 events; restarting the server clears it.

## What is monitored

| Category | Examples |
|---|---|
| `socket` | WebSocket open/close/error, engine ready, malformed payload |
| `mic` | permission result, selected device, track state, activity start/stop |
| `pcm` | byte count, 16 kHz sample rate, RMS dB, peak |
| `noise` | input silence and clipping indicators |
| `stt` | interim/final text, authoritative result, fallback, timeout |
| `jerry-audio` | streamed output audio chunks and byte estimates |
| `animation` | state transitions such as listening/speaking/emphasis |
| `video` | pose asset loaded/error events; raw video is not stored |
| `recording` | graph mode, MediaRecorder chunks, MIME, final blob, errors |
| `turn-log` | speaker turn boundaries, previews, and relative timing |

## Healthy turn sequence

For a spoken guest turn, confirm the same `connectionId` and `turnId` are present in this order:

1. `guest-turn-start`
2. `guest-turn-end` with non-zero `audioBytes`
3. `authoritative-start`
4. `authoritative-success` or `authoritative-fallback`
5. `guest-transcript-forwarded`
6. one or more `jerry-audio` events
7. `jerry-turn-complete`

`authoritative-timeout`, `turn-aborted-no-transcript`, `stt-error`, `jerry-live-error`, or `recording-error` identify a broken boundary. The event metadata is intended to show which boundary failed without replaying or inspecting raw media.

## Privacy and retention

- Raw microphone PCM, recorded WebM, and video frames are not written to the debug buffer.
- Transcript fields are truncated previews for diagnosis.
- The buffer is process-local and disappears on server restart.
- Do not expose this endpoint publicly without adding authentication and access controls.
