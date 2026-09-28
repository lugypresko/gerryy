# Publishable bilingual podcast implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a recoverable two-speaker Hebrew/English podcast with verified balanced stereo exports and persistent downloads.

**Architecture:** Durable independent source capture feeds a server media worker; validation and loudness processing precede publication. Archive sources, versioned outputs and a shared timeline for later animation.

**Tech Stack:** Existing React/TypeScript, Express, WebSocket and Gemini integration; FFmpeg/ffprobe subprocesses, browser durable storage, Node tests and real browser download tests.

---

## Required context

Read `docs/JERRY_PRODUCT_ARCHITECTURE.md` first. Baseline is `e0b0105` in the feature worktree, not `C:\gerryy` main. This plan supersedes completion claims in earlier voice-processing plans; it does not imply those features have passed acceptance. No task below is completed by this documentation change.

Local HTTP/debug are available; full end-to-end publication is not verified and known defects prevent calling it ready. Do not ask the user for more trial recordings until deterministic fixtures reproduce and then pass the failure cases.

## Task execution rule

Each task is an independently reviewable commit. Execute the numbered actions separately. For behavioral work, first add an executable failing test, run it and confirm the expected failure; implement the smallest change; rerun the affected test and TypeScript checking; commit only the named files. Source-regex tests do not count as audio or browser acceptance.

Proposed new tests run with `node --import tsx --test tests/<name>.test.mjs`. Browser tests use the project's chosen browser tooling; if adding a Playwright test suite, pin the dependency, add `test:e2e`, and run `npm run test:e2e`. Keep private recordings out of fixtures and Git; use generated synthetic fixtures and consented spoken examples.

## Task 1 — Reproduce failures and establish evidence

Files: create `tests/audio-fixtures.test.mjs`, `scripts/generate-audio-fixtures.mjs`; inspect existing `tests/episode-finalizer.test.mjs`.

1. Generate stereo signals with known channel identity, deliberate gain difference, unequal speaking durations, silence and mono variants.
2. Add damaged-container fixture generation and assert full decode detects corruption, not merely ffprobe metadata.
3. Capture a browser-created two-source MediaRecorder fixture and compare browser/FFmpeg decoding; retain stderr and exit status.
4. Reproduce a URL-change/revocation failure with a real download; do not alter the quality gate to make it pass.
5. Record source hashes and baseline results. Run `node --import tsx --test tests/audio-fixtures.test.mjs`; expected known defects remain explicit until their owning tasks fix them.

## Task 2 — Fix recording lifecycle and resource ownership

Files: modify `src/JerryPodcastStudio.tsx`; create `src/audio/recordingSession.ts`, `tests/recording-session.test.mjs`.

1. Test that creating Jerry/Guest/master URLs neither stops the mic nor revokes other download URLs.
2. Separate unmount cleanup from per-URL cleanup; establish a single session owner for recorder resources.
3. Await final chunks/stops from all recorders before session cleanup; snapshot immutable chunks and timeline.
4. Prevent new capture/reset from destroying an active save/finalization job; expose an explicit state.
5. Verify two consecutive recordings, delayed stem stop, unmount and upload failure paths; run the task test and `npm run lint`.

## Task 3 — Durable, immutable server archive

Files: create `server/recordings/store.ts`, `server/recordings/routes.ts`, `tests/recording-store.test.mjs`; modify `server.ts`, `.env.example`, `.gitignore`.

1. Test ID validation, chunk ordering, identical retries, conflicting retries and incomplete manifests in a temporary directory.
2. Implement configured absolute storage root, binary chunk upload, SHA-256 acknowledgement and atomic manifest writes.
3. Reject missing/empty/invalid payloads and unsupported source names. Set bounded request sizes and local access constraints.
4. Preserve every original and version outputs by job ID; expose actual storage root in operator metadata.
5. Test restart reads and partial write recovery. Never overwrite a raw artifact to retry processing.

## Task 4 — Durable browser capture and upload recovery

Files: create `src/audio/recordingOutbox.ts`, `tests/recording-outbox.test.mjs`; modify `src/audio/recordingSession.ts`, `src/JerryPodcastStudio.tsx`.

1. Allocate episode ID before recording and persist ordered chunks to IndexedDB as they arrive.
2. Upload queued chunks; remove local copies only after verified server acknowledgement under an explicit retention rule.
3. Persist guest/Jerry sources, optional master and full timeline; never substitute a turn count for turn records.
4. Resume pending uploads after reload/network failure; display saved/pending status and storage errors.
5. Verify reload during capture/save, retry without duplication and browser quota failure. Document the bounded unflushed-tail risk; do not promise recovery of samples never emitted by the browser.

## Task 5 — Recoverable media processing jobs

Files: create `server/recordings/jobs.ts`, `server/recordings/media.ts`, `tests/recording-jobs.test.mjs`; modify recording routes.

1. Add prerequisite checks for FFmpeg and ffprobe and persist tool versions.
2. Implement bounded queue, job IDs, stage transitions, heartbeat and subprocess timeout/cancellation.
3. Assemble sources in sequence, probe format and fully decode; distinguish warning/recovery from clean decode.
4. On error retain raw artifacts and actionable diagnostics; do not create a successful-looking processed copy.
5. Test worker failure/restart/retry, corrupt media and missing channels using real subprocesses.

## Task 6 — Measure speech and final output correctly

Files: create `server/recordings/quality.ts`, `tests/recording-quality.test.mjs`; modify `src/audio/autoLeveler.ts`, `src/audio/recordingGraph.ts`.

1. Test equal-loudness speakers with unequal durations: difference should remain small despite pauses.
2. Measure each speaker's active windows separately and record evidence/insufficient-speech status; reject finite low-level noise as speech-only proof.
3. Measure integrated output LUFS, true peak, duration, channels and decode integrity after encoding.
4. Separate pre-processing input meters from post-processing output meters; label them correctly in debug.
5. Validate silence, single speaker, clipping, steady noise, quiet speech and wrong routing. Handle NaN/infinity explicitly.

## Task 7 — Produce balanced publication stereo

Files: create `server/recordings/processEpisode.ts`, `tests/episode-processing.test.mjs`; adapt `src/audio/episodeFinalizer.ts` to a server job client.

1. Build per-speaker correction from measured speech, preserving Jerry dynamics and limiting guest noise amplification.
2. Keep isolated source files; generate a two-channel listening mix with explicit configurable pan policy.
3. Encode archival WAV and downloadable stereo MP3; measure the encoded files against -16 LUFS ±1 LU, true peak <= -1 dBTP, speaker difference <=3 LU.
4. Store parameters, pipeline version and before/after report, then apply publication gate.
5. Test known unbalanced fixtures and compare duration/alignment, successful decode and waveform content. Listen to a consented speech A/B before declaring publishable.

## Task 8 — Persistent library and tested download

Files: create `src/components/RecordingLibrary.tsx`, `tests/recording-download.test.mjs`; modify recording routes and `src/JerryPodcastStudio.tsx`.

1. Add list/detail/job endpoints and persistent artifact download with correct MIME, extension, Content-Disposition and range behavior.
2. Show ready/review/failed separately from original availability; never gate forensic source recovery as though it were publication.
3. Restore library after refresh; bind UI state to archived job result, not stale live RMS.
4. In a real browser await the download event, save bytes, verify hash, decode and measure the actual downloaded file.
5. Repeat after server restart; assert stale links, missing files and interrupted downloads have clear errors.

## Task 9 — Hebrew, English and code-switching

Files: modify `server.ts`, `src/JerryPodcastStudio.tsx`; create `tests/bilingual-conversation.test.mjs` and a consented fixture manifest.

1. Remove persona instruction that treats a language switch as a recognition error.
2. Verify selected provider/model language capabilities against official documentation at implementation time; support explicit Hebrew/English/mixed session settings.
3. Apply matching behavior to authoritative transcription, interim transcription, text fallback and generated speech; preserve language rather than translating silently.
4. Test mixed sentences, English names, accents, numbers and negation with expected semantic transcripts.
5. Run actual provider-backed short dialogues in all three modes. Report separately what deterministic mocks and live calls prove.

## Task 10 — Interruption and shared episode clock

Files: modify `src/audio/turnLog.ts`, `src/JerryPodcastStudio.tsx`, `server.ts`; create `tests/episode-timeline.test.mjs`.

1. Unify recording sample offsets, playback intervals, turns and animation events under the episode ID.
2. Implement provider-supported cancellation or explicit stale-generation suppression; do not describe queue clearing alone as cancellation.
3. Compute actual overlap from played audio intervals and guest speech, preserving recorded samples.
4. Persist timeline and test reconnect, duplicate activity-end, late chunks and interruption during response.
5. Verify exported timeline bounds against final audio and document resampling/codec delay offsets.

## Task 11 — Operational monitor and failure recovery

Files: modify `docs/JERRY_DEBUG_MONITOR.md`, `server/recordings/jobs.ts`, `src/components/RecordingLibrary.tsx`; create `tests/recording-observability.test.mjs`.

1. Persist capture/upload/processing/verification/download events with episode and job IDs.
2. Display stage elapsed time, queue wait, end-to-end time, last heartbeat and actionable reason code.
3. Test failure injection at disk write, network upload, decode, processing and verification boundaries.
4. Show retry only for recoverable states; preserve and expose originals on every failure.
5. Verify monitor survives server restart and cannot confuse fallback bytes with processed audio.

## Task 12 — End-to-end release gate and documentation

Files: create `tests/e2e/podcast.spec.ts` and browser configuration if the suite is adopted; modify `package.json`, `docs/IMPLEMENTATION_STATUS.md`, existing voice plans.

1. Run controlled two-source browser capture -> durable archive -> worker -> measured output -> actual download.
2. Run 10-second, 2-minute and longer recordings; include background tab, headphones/device switch, permission denial and capture interruption.
3. Run real Hebrew, English and mixed conversations; require human listening approval on both speakers.
4. Benchmark processing against architecture targets; retain test artifacts/reports outside Git when private.
5. Run `npm test`, `npm run lint`, `npm run build` and the adopted E2E command. Green source checks alone cannot mark this task complete.
6. Update documentation from verified results; tag a tested release and record deployed commit plus rollback/data compatibility procedure.

## Dependencies and parallel work

Critical path: 1 -> 2/3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 12. Task 9 can run alongside media work with a separate write scope. Task 10 supplies the video-ready timeline and joins release acceptance. Task 11 accompanies each lifecycle stage. Avoid concurrent edits to the large Studio file; extract modules first.

## POC stop condition

A real two-speaker recording is preserved, successfully processed, measured and downloaded after page refresh; its downloaded bytes match the archive and both voices are audibly balanced. Show the raw/result pair and report to the user. Do not call a blocked download or unprocessed fallback a completed POC.

Video rendering starts only after this audio contract passes. Animation acceptance is a separate milestone using the persisted shared timeline.
