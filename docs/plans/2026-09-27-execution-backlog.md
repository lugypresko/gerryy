# Jerry podcast execution backlog

> This is an execution index for the existing architecture and implementation documents. Existing documents are intentionally left unchanged.

## Definition of done

The product is publishable only when a real Hebrew/English two-speaker session can be recorded, processed in seconds to a few minutes, validated, downloaded after refresh/restart, and replayed as balanced stereo. The raw capture, processed master, measurements, transcript/turn log, and processing report must remain available for comparison and rollback. Video/animation is a later consumer of the shared timeline and is not required for the audio POC.

## P0 — publishable audio path

### P0-01 — Reproduce and freeze the current failures

- Create deterministic stereo fixtures for unequal levels, silence, overlap, mono input, and damaged WebM.
- Capture one consented browser MediaRecorder fixture and retain hashes, decoder stderr, and timing.
- Add a real download/reload reproduction for the current `URL.revokeObjectURL`/zero-byte failure.
- Acceptance: each known failure has a failing executable test and a saved diagnostic artifact; no quality gate is weakened.

### P0-02 — Make recording ownership explicit

- Define one episode ID and lifecycle states: `recording`, `finalizing`, `processing`, `ready`, `blocked`, `failed`.
- Stop tracks and close audio resources exactly once; make finalization idempotent.
- Keep raw bytes immutable before any processing starts.
- Acceptance: repeated stop, refresh, and unmount do not lose the raw recording or create a false-ready episode.

### P0-03 — Persist raw capture durably

- Store raw WebM plus metadata under an episode-scoped immutable path.
- Persist source hashes, MIME/container data, duration, channel count, and capture timestamps.
- Keep storage independent of browser object URLs and React state.
- Acceptance: raw audio survives refresh and server restart and can be downloaded byte-for-byte.

### P0-04 — Recover browser capture and uploads

- Allocate the episode ID before recording and persist ordered chunks in IndexedDB as they arrive.
- Upload queued chunks with verified acknowledgements; remove local copies only under an explicit retention rule.
- Persist guest/Jerry sources and the full timeline; resume pending uploads after reload or network failure.
- Acceptance: reload during capture/save, retry without duplication, and browser quota failure are handled and visible.

### P0-05 — Add recoverable processing jobs

- Move decode, channel inspection, cleanup, loudness analysis, and export to a server worker using FFmpeg/ffprobe.
- Persist job status, progress, logs, tool versions, input hash, output hash, and failure reason.
- Retry transient failures without overwriting the raw source.
- Acceptance: a 10-second episode reaches a terminal state in seconds/few minutes and a failed job is diagnosable and retryable.

### P0-06 — Measure actual audio quality

- Measure each source and the mix using active speech windows, integrated loudness/LUFS, true peak, RMS, silence, clipping, and channel activity.
- Record guest↔Jerry loudness delta and detect a silent/missing channel.
- Do not use whole-file RMS as the only quality signal.
- Acceptance: the report identifies the weak speaker and rejects clipping, decode failure, missing channel, or excessive loudness delta.

### P0-07 — Produce the balanced stereo master

- Process the guest path independently with cleanup, leveling, compressor/limiter, and conservative headroom.
- Preserve Jerry's performance dynamics while applying only controlled gain/peak protection.
- Mix to an explicit stereo layout with a true-peak ceiling and versioned processing parameters.
- Acceptance: both speakers are audible and within the configured loudness tolerance; no clipping; output decodes fully; raw and master hashes differ when processing occurs.

### P0-08 — Gate and deliver the download

- Allow download only for a verified master with non-zero duration, valid decode, expected channels, measurements, and persisted bytes.
- Serve the server-side master, not a revoked in-memory object URL.
- Show `processing`, `ready`, `blocked`, and `failed` states with the exact monitor reason.
- Acceptance: download works after refresh/restart; downloaded bytes match the stored master hash; blocked exports cannot be downloaded.

### P0-09 — Preserve comparison and rollback

- Keep immutable raw, processed master, processing report, and job log for every episode.
- Add a versioned processing profile and a reprocess action that writes a new output version.
- Never replace a previously verified master in place.
- Acceptance: two versions can be compared and a prior verified output can be selected without re-recording.

## P1 — conversation quality and operations

### P1-01 — Support Hebrew/English code-switching

- Configure language detection/routing for Hebrew, English, and mixed turns.
- Preserve the original transcript, normalized transcript, speaker, timestamps, and confidence.
- Acceptance: mixed-language smoke fixtures do not rewrite English words as Hebrew or block the audio pipeline.

### P1-02 — Add overlap/interruption timeline

- Store one monotonic episode clock for guest speech, Jerry speech, interruptions, VAD, and generated audio.
- Preserve both sources during overlap and mark interruption boundaries for later animation.
- Acceptance: an overlap fixture produces two intact source tracks and a deterministic turn log.

### P1-03 — Make the monitor operational

- Monitor capture, source levels, VAD, transcription, Jerry generation, video/pose events, recording, processing, downloads, and errors.
- Correlate every event with episode ID, job ID, timestamp, state, and source.
- Persist enough recent history to diagnose a failed export after reload.
- Acceptance: one monitor view explains where a test episode failed without inspecting browser console manually.

### P1-04 — Release gate and documentation

- Add a real browser E2E test: start → speak both sources → stop → process → reload → download → hash/decode/measure.
- Document local setup, environment variables, data retention, rollback, and known limits.
- Tag only after the release gate passes; record the exact commit and processing profile.
- Acceptance: the gate passes on a clean checkout and the release can be rolled back to the last verified tag.

## Dependency order

`P0-01 → P0-02/P0-03 → P0-04 → P0-05 → P0-06 → P0-07 → P0-08 → P0-09 → P1-04`

`P1-01` can run after the capture/transcript contract is stable. `P1-02` depends on the shared episode clock. `P1-03` starts with P0-02 and expands as each pipeline stage is added.

## First execution slice

Start with `P0-01` and `P0-02`. Do not request more user recordings until the deterministic fixtures reproduce the decode, imbalance, zero-byte download, and lifecycle failures. The first POC checkpoint is a persisted raw file plus a persisted processing report for a synthetic two-speaker episode; the second is a verified balanced master downloadable after reload.
