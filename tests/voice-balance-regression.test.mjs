import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const graph = fs.readFileSync('src/audio/recordingGraph.ts', 'utf8');

test('Guest and Jerry gain ceilings are bounded and distinct', () => {
  const guest = graph.match(/export const GUEST_LEVEL_CONFIG = \{([\s\S]*?)\} as const/);
  const jerry = graph.match(/export const JERRY_LEVEL_CONFIG = \{([\s\S]*?)\} as const/);

  assert.ok(guest);
  assert.ok(jerry);
  const guestMax = Number(guest[1].match(/maxGainDb:\s*(-?\d+)/)[1]);
  const jerryMax = Number(jerry[1].match(/maxGainDb:\s*(-?\d+)/)[1]);
  assert.ok(guestMax <= 12);
  assert.ok(jerryMax <= 6);
  assert.notEqual(guestMax, jerryMax);
});

test('Jerry dynamics are lighter and slower than Guest dynamics', () => {
  const guest = graph.match(/export const GUEST_DYNAMICS_CONFIG[^=]*= \{([\s\S]*?)\};/);
  const jerry = graph.match(/export const JERRY_DYNAMICS_CONFIG[^=]*= \{([\s\S]*?)\};/);

  assert.ok(guest);
  assert.ok(jerry);
  const guestRatio = Number(guest[1].match(/ratio:\s*([\d.]+)/)[1]);
  const jerryRatio = Number(jerry[1].match(/ratio:\s*([\d.]+)/)[1]);
  const guestAttack = Number(guest[1].match(/attack:\s*([\d.]+)/)[1]);
  const jerryAttack = Number(jerry[1].match(/attack:\s*([\d.]+)/)[1]);
  const guestRelease = Number(guest[1].match(/release:\s*([\d.]+)/)[1]);
  const jerryRelease = Number(jerry[1].match(/release:\s*([\d.]+)/)[1]);

  assert.ok(jerryRatio < guestRatio);
  assert.ok(jerryAttack > guestAttack);
  assert.ok(jerryRelease > guestRelease);
});

test('createRecordingGraph wires source-specific level and dynamics configs', () => {
  assert.match(graph, /function createChannelChain\(\s*context:[\s\S]*?levelConfig: AutoLevelerConfig,[\s\S]*?dynamicsConfig: DynamicsConfig/);
  assert.match(graph, /createChannelChain\([\s\S]*?sources\.jerry,[\s\S]*?JERRY_LEVEL_CONFIG,[\s\S]*?JERRY_DYNAMICS_CONFIG,[\s\S]*?\)/);
  assert.match(graph, /createChannelChain\([\s\S]*?sources\.guest,[\s\S]*?GUEST_LEVEL_CONFIG,[\s\S]*?GUEST_DYNAMICS_CONFIG,[\s\S]*?\)/);
  assert.match(graph, /dynamicsConfig\.threshold/);
  assert.match(graph, /dynamicsConfig\.release/);
});
