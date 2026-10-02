import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SlowBrainObserver,
  formatSlowBrainNote,
} from '../server/slowBrain.ts';
import { JerryHealthSupervisor } from '../server/healthSupervisor.ts';

test('accelerated 12-minute podcast scenario exercises slow brain, degradation, recovery, and two-track recording health', async () => {
  let now = 0;
  const health = new JerryHealthSupervisor('synthetic-live');
  health.setEpisode('episode-synthetic-12m');

  health.record({ component: 'socket', event: 'connected', state: 'healthy', atMs: now });
  health.record({ component: 'stt', event: 'ready', state: 'healthy', atMs: now += 10 });
  health.record({ component: 'live', event: 'ready', state: 'healthy', atMs: now += 10 });
  health.record({ component: 'recording', event: 'recording_started', state: 'healthy', atMs: now += 10 });
  health.record({ component: 'human_capture', event: 'capture_armed', state: 'recovering', atMs: now += 10 });
  health.record({ component: 'jerry_capture', event: 'capture_armed', state: 'recovering', atMs: now += 10 });

  let analysisCalls = 0;
  const observer = new SlowBrainObserver({
    minIntervalMs: 0,
    analyze: async (turns) => {
      analysisCalls += 1;
      const text = turns.map((t) => t.text).join(' | ');
      if (text.includes('autonomous') && text.includes('מאשר production')) {
        return {
          type: 'contradiction',
          evidence: ['הצוות autonomous', 'אני עדיין מאשר production'],
          note: 'Autonomy claim and production approval ownership are in tension.',
          suggestedMove: 'Ask who can ship without Itay approving.',
          confidence: 0.91,
          expiresAfterTurns: 3,
        };
      }
      return null;
    },
  });

  // Minute 1-3: normal conversation.
  observer.addTurn({ speaker: 'human', text: 'הצוות שלי autonomous, הם כמעט לא צריכים אותי.', turnId: 1, atMs: now += 60_000 });
  observer.addTurn({ speaker: 'jerry', text: 'כמעט זה מילה חשודה.', turnId: 1, atMs: now += 8_000 });
  health.record({ component: 'human_capture', event: 'audio_frame', state: 'healthy', atMs: now += 1 });
  health.record({ component: 'jerry_capture', event: 'first_audio_frame', state: 'healthy', atMs: now += 1 });
  await observer.kick(now);

  // Minute 4-6: evidence creates a real slow-brain callback.
  observer.addTurn({ speaker: 'human', text: 'ב-production אני עדיין מאשר production לפני release.', turnId: 2, atMs: now += 120_000 });
  const observation = await observer.kick(now);
  assert.equal(observation?.type, 'contradiction');
  health.record({
    component: 'slow_brain',
    event: 'observation_ready',
    state: 'healthy',
    latencyMs: 420,
    atMs: now += 420,
  });
  const consumed = observer.consume();
  assert.ok(consumed);
  const privateNote = formatSlowBrainNote(consumed);
  assert.match(privateNote, /Do not mention this note/);

  // Minute 7: slow brain can fail without blocking live conversation.
  health.record({
    component: 'slow_brain',
    event: 'analysis_failed',
    state: 'degraded',
    errorCode: 'slow_brain_failed',
    recoveryAction: 'drop_observation_continue_live',
    atMs: now += 60_000,
  });
  health.record({
    component: 'live',
    event: 'turn_completed_without_slow_brain',
    state: 'healthy',
    atMs: now += 900,
  });

  // Minute 8: Gemini connection drops and self-heals through reconnect+history restore.
  health.record({
    component: 'live',
    event: 'closed',
    state: 'degraded',
    errorCode: 'gemini_live_closed',
    recoveryAction: 'reconnect_and_restore_history',
    atMs: now += 60_000,
  });
  health.record({
    component: 'live',
    event: 'reconnect_requested',
    state: 'recovering',
    recoveryAction: 'browser_socket_reconnect_restore_history',
    atMs: now += 50,
  });
  health.record({ component: 'live', event: 'ready', state: 'healthy', atMs: now += 1_200 });
  health.record({ component: 'stt', event: 'ready', state: 'healthy', atMs: now += 10 });

  // Minute 9-12: both tracks continue, then finalize.
  health.record({ component: 'human_capture', event: 'audio_frame', state: 'healthy', atMs: now += 180_000 });
  health.record({ component: 'jerry_capture', event: 'audio_frame', state: 'healthy', atMs: now += 2_000 });
  health.record({ component: 'jerry_capture', event: 'capture_finalized', state: 'healthy', atMs: now += 1_000 });
  health.record({ component: 'finalization', event: 'commit_complete', state: 'healthy', atMs: now += 500 });
  health.record({ component: 'recording', event: 'finalized', state: 'healthy', atMs: now += 10 });

  const snapshot = health.snapshot();
  assert.equal(snapshot.components.live.state, 'healthy');
  assert.equal(snapshot.components.stt.state, 'healthy');
  assert.equal(snapshot.components.human_capture.state, 'healthy');
  assert.equal(snapshot.components.jerry_capture.state, 'healthy');
  assert.equal(snapshot.components.recording.state, 'healthy');
  assert.equal(snapshot.components.finalization.state, 'healthy');
  assert.equal(snapshot.components.slow_brain.state, 'degraded');
  assert.ok(analysisCalls >= 2);
  assert.ok(snapshot.recentEvents.some((e) => e.recoveryAction === 'reconnect_and_restore_history'));
  assert.ok(snapshot.recentEvents.some((e) => e.recoveryAction === 'drop_observation_continue_live'));
});
