import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JerryHealthRegistry,
  JerryHealthSupervisor,
} from '../server/healthSupervisor.ts';

test('health supervisor keeps component state and bounded timeline', () => {
  const health = new JerryHealthSupervisor('s1', { maxEvents: 2 });
  health.record({ component: 'socket', event: 'connected', state: 'healthy', atMs: 1 });
  health.record({ component: 'stt', event: 'error', state: 'degraded', errorCode: 'stt_error', atMs: 2 });
  health.record({ component: 'stt', event: 'recovering', state: 'recovering', recoveryAction: 'restart_session', atMs: 3 });

  const snapshot = health.snapshot();
  assert.equal(snapshot.components.socket.state, 'healthy');
  assert.equal(snapshot.components.stt.state, 'recovering');
  assert.equal(snapshot.recentEvents.length, 2);
  assert.equal(snapshot.recentEvents[0].event, 'error');
});

test('failed safe dominates overall health', () => {
  const health = new JerryHealthSupervisor('s2');
  health.record({ component: 'live', event: 'ready', state: 'healthy' });
  health.record({ component: 'recording', event: 'failed', state: 'failed_safe' });
  assert.equal(health.snapshot().overall, 'failed_safe');
});

test('episode id is attached to snapshot', () => {
  const health = new JerryHealthSupervisor('s3');
  health.setEpisode('ep-1');
  assert.equal(health.snapshot().episodeId, 'ep-1');
});

test('registry bounds retained sessions', () => {
  const registry = new JerryHealthRegistry(2);
  registry.create('a');
  registry.create('b');
  registry.create('c');
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get('a'), undefined);
  assert.ok(registry.get('c'));
});


test('runtime monitor only degrades on newly observed audio underruns', () => {
  const server = fs.readFileSync('server.ts', 'utf8');
  assert.match(server, /let lastClientAudioUnderruns = 0/);
  assert.match(server, /const newAudioUnderruns = Math\.max\(0, audioUnderruns - lastClientAudioUnderruns\)/);
  assert.match(server, /newAudioUnderruns > 0/);
  assert.doesNotMatch(server, /maxLongTaskMs > 200 \|\| audioUnderruns > 0/);
});
