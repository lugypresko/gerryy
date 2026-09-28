import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSpeakerOverlap,
  createEpisodeClock,
  createEpisodeTimeline,
  validateTimelineBounds,
} from '../src/audio/turnLog.ts';

test('episode clock converts wall time to deterministic monotonic offsets', () => {
  const clock = createEpisodeClock({ originMs: 10_000 });

  assert.equal(clock.offsetAt(10_000), 0);
  assert.equal(clock.offsetAt(10_125), 125);
  assert.equal(clock.offsetAt(10_050), 125);
  assert.equal(clock.offsetAt(10_200), 200);
});

test('timeline ignores duplicate event ids and clamps late events without reordering', () => {
  const timeline = createEpisodeTimeline({ episodeId: 'episode-1', originMs: 1_000 });

  assert.deepEqual(timeline.append({ id: 'guest-start', type: 'speech-start', atMs: 1_100 }), {
    accepted: true,
    duplicate: false,
    late: false,
  });
  assert.deepEqual(timeline.append({ id: 'jerry-start', type: 'speech-start', atMs: 1_250 }), {
    accepted: true,
    duplicate: false,
    late: false,
  });
  assert.deepEqual(timeline.append({ id: 'guest-start', type: 'speech-start', atMs: 1_100 }), {
    accepted: false,
    duplicate: true,
    late: false,
  });
  assert.deepEqual(timeline.append({ id: 'late-event', type: 'speech-end', atMs: 1_050 }), {
    accepted: true,
    duplicate: false,
    late: true,
  });

  const events = timeline.events();
  assert.deepEqual(events.map((event) => event.offsetMs), [100, 250, 250]);
  assert.equal(events[2].late, true);
});

test('speaker overlap is the union of intersections, not double-counted by intervals', () => {
  const overlap = calculateSpeakerOverlap([
    { speaker: 'guest', startOffsetMs: 100, endOffsetMs: 500 },
    { speaker: 'jerry', startOffsetMs: 300, endOffsetMs: 700 },
    { speaker: 'guest', startOffsetMs: 350, endOffsetMs: 450 },
  ]);

  assert.equal(overlap.durationMs, 200);
  assert.deepEqual(overlap.intervals, [{ startOffsetMs: 300, endOffsetMs: 500 }]);
});

test('timeline export bounds reject negative, reversed, and out-of-range events', () => {
  const result = validateTimelineBounds([
    { id: 'ok', offsetMs: 100, endOffsetMs: 200 },
    { id: 'negative', offsetMs: -1 },
    { id: 'reversed', offsetMs: 400, endOffsetMs: 300 },
    { id: 'too-long', offsetMs: 900, endOffsetMs: 1_100 },
  ], 1_000);

  assert.equal(result.valid, false);
  assert.deepEqual(result.violations.map((violation) => violation.id), ['negative', 'reversed', 'too-long']);
});

test('timeline finalization reports bounded events and overlap against export duration', () => {
  const timeline = createEpisodeTimeline({ episodeId: 'episode-2', originMs: 5_000 });
  timeline.append({ id: 'guest', type: 'speech', speaker: 'guest', atMs: 5_100, endAtMs: 5_500 });
  timeline.append({ id: 'jerry', type: 'speech', speaker: 'jerry', atMs: 5_300, endAtMs: 5_800 });

  const finalized = timeline.finalize(1_000);
  assert.equal(finalized.episodeId, 'episode-2');
  assert.equal(finalized.durationMs, 1_000);
  assert.equal(finalized.overlap.durationMs, 200);
  assert.equal(finalized.bounds.valid, true);
});
