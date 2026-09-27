# Jerry Voice Balance Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce a publishable Jerry recording in which guest and Jerry speech are consistently balanced, clean, non-clipped, and measurable before export.

**Architecture:** Keep guest microphone and Jerry audio as independent sources from capture through export. Apply browser echo cancellation/noise suppression only to the guest capture, use separate speech-aware leveling and dynamics chains, then create the stereo master with a conservative master limiter. Add objective telemetry and a publish gate so an unbalanced recording is rejected instead of silently exported.

**Tech Stack:** React/TypeScript, Web Audio API, `MediaRecorder`, Node test runner, existing debug monitor and recording graph.

---

## Quality contract

The implementation is considered ready for publication only when a spoken test recording satisfies all of these checks:

- Guest-versus-Jerry speech loudness delta is at most 2 dB over the active speech windows.
- No source or master sample clips; the master peak remains at or below the configured ceiling.
- Silence does not cause audible pumping or progressive gain runaway.
- Jerry retains audible pauses, sighs, chuckles, and energy changes.
- The stereo master remains Jerry-left/guest-right and the independent tracks remain available.
- A failed microphone, muted track, missing transcript, or unhealthy level produces a visible diagnostic and does not masquerade as a publishable episode.

## Task 1: Add a reproducible voice-balance baseline

**Files:**
- Create: `tests/voice-balance-regression.test.mjs`
- Modify: `docs/IMPLEMENTATION_STATUS.md`

**Steps:**

1. Add failing regression tests for the quality contract: independent source chains, guest-only capture processing, bounded level gains, master ceiling, and balance telemetry.
2. Run `npm test -- tests/voice-balance-regression.test.mjs` and verify the new assertions fail against the current implementation.
3. Document the baseline problem explicitly: the current graph applies the same aggressive dynamics configuration to Jerry and guest, and microphone capture currently requests browser `autoGainControl: true`.
4. Commit the failing tests and baseline documentation.

## Task 2: Fix microphone capture policy

**Files:**
- Modify: `src/JerryPodcastStudio.tsx:448-455`
- Modify: `src/JerryPodcastStudio.tsx:1429-1437`
- Test: `tests/voice-balance-regression.test.mjs`

**Steps:**

1. Add a shared capture-constraint constant or helper with `echoCancellation: true`, `noiseSuppression: true`, and `autoGainControl: false`.
2. Use the same constraints for the live microphone and recording fallback paths so the browser does not apply two different processing policies.
3. Preserve the existing device-selection and muted-track rejection behavior.
4. Add a test that both microphone acquisition paths disable browser AGC and enable AEC/noise suppression.
5. Run the focused test and `npm test`.
6. Commit the capture-policy change.

## Task 3: Make guest and Jerry processing intentionally different

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Modify: `src/audio/autoLeveler.ts` if a speech gate helper is needed
- Test: `tests/recording-regression.test.mjs`
- Test: `tests/voice-balance-regression.test.mjs`

**Steps:**

1. Define separate `GUEST_LEVEL_CONFIG` and `JERRY_LEVEL_CONFIG` values instead of passing one shared configuration to both chains.
2. Keep the guest chain responsive enough to repair a weak microphone, but cap its maximum gain and use a gate so room noise is not amplified.
3. Give Jerry a narrower, slower gain range and lighter compression so performance dynamics survive.
4. Keep the existing master limiter as the final safety boundary; do not use it as the primary balancing mechanism.
5. Pass per-source configuration into `createRecordingGraph` while retaining the public recording-channel contract.
6. Add tests proving the guest and Jerry chains receive distinct configs and that gains stay bounded during silence.
7. Run the focused recording tests and the complete test suite.
8. Commit the per-speaker processing change.

## Task 4: Add speech-aware level measurement

**Files:**
- Modify: `src/audio/recordingGraph.ts`
- Modify: `src/audio/autoLeveler.ts`
- Test: `tests/voice-balance-regression.test.mjs`

**Steps:**

1. Add a bounded speech-window detector using analyser samples: RMS, peak, silence duration, clipping count, and active speech duration.
2. Update the leveler only on active speech windows, not on silence or low-level room noise.
3. Track smoothed per-speaker level estimates and the current Guest↔Jerry delta.
4. Expose a compact `getMetrics()` result from the recording graph without storing raw PCM.
5. Add deterministic tests for silence, speech, clipping, gain bounds, and recovery after a loud segment.
6. Run `npm test` and `npm run lint`.
7. Commit the measurement and speech-gating change.

## Task 5: Add publication telemetry and a publish gate

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Modify: `server.ts` only if new debug event sanitization is required
- Modify: `docs/JERRY_DEBUG_MONITOR.md`
- Test: `tests/jerry-regression.test.mjs`

**Steps:**

1. Emit bounded `recording-levels` telemetry containing per-speaker RMS/LUFS estimate, peak, speech duration, silence duration, clipping count, and loudness delta.
2. Emit explicit events when balance is outside the publication threshold, when clipping occurs, or when the microphone becomes silent/muted.
3. Add a recording summary state with `publishable`, `needs-review`, or `failed` status.
4. Prevent or clearly warn on export when the recording is outside the quality contract; never delete the raw speaker tracks.
5. Update the debug monitor documentation with the healthy metrics and failure events.
6. Add tests that assert an unbalanced recording is marked `needs-review` and a balanced recording is publishable.
7. Run the complete test suite.
8. Commit the publication gate and diagnostics.

## Task 6: Handle overlap and interruption explicitly

**Files:**
- Modify: `src/JerryPodcastStudio.tsx`
- Modify: `src/audio/turnLog.ts`
- Modify: `server.ts` if server-side turn events need correlation
- Test: `tests/jerry-regression.test.mjs`

**Steps:**

1. Detect guest speech beginning while Jerry is speaking and record an interruption event with `connectionId` and `turnId`.
2. Stop or cancel Jerry generation according to the existing live protocol while preserving audio already received by both independent recording paths.
3. Add turn-log fields for interruption start/end and overlap duration.
4. Emit `guest-interruption-start`, `guest-interruption-end`, and `jerry-generation-cancelled` debug events.
5. Add tests for a normal turn, an interruption, and a turn that ends without transcript text.
6. Run the complete test suite and lint.
7. Commit the interruption telemetry change.

## Task 7: Validate with real recordings before release

**Files:**
- Create: `docs/qa/voice-balance-release-checklist.md`
- Modify: `docs/IMPLEMENTATION_STATUS.md`

**Steps:**

1. Record the same scripted 60-second conversation using speakers, wired headphones, Bluetooth headphones, and a second microphone if available.
2. Export the stereo master, Jerry track, guest track, and `conversation.json` for every device.
3. Inspect the files with `ffprobe` or an audio editor for channel routing, duration, peak, clipping, and loudness delta.
4. Compare the debug monitor events with the exported files and confirm that every failure has an actionable event.
5. Mark the release checklist passed only when all quality-contract thresholds pass on the target device.
6. Update the implementation status with the measured results.
7. Commit the QA checklist and measured acceptance result.

## Final verification

Run:

```powershell
npm test
npm run lint
npm run build
```

Then perform one real Hebrew spoken turn and one complete recording. Confirm:

```text
guest-turn-start
  -> recording-levels
  -> guest-transcript-forwarded
  -> jerry-audio
  -> recording-finalized
  -> publishable | needs-review
```

Only after the real recording passes the quality contract should the version be promoted for publication.
