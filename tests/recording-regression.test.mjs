import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const graph = fs.readFileSync('src/audio/recordingGraph.ts', 'utf8');
const leveler = fs.readFileSync('src/audio/autoLeveler.ts', 'utf8');

test('recording channels are a stable Jerry-left and guest-right contract', () => {
  assert.match(graph, /export const RECORDING_CHANNELS = \{\s*jerry:\s*0,\s*guest:\s*1,\s*\} as const;/);
  assert.match(graph, /targetDbfs:\s*-18/);
  assert.match(graph, /gateDbfs:\s*-55/);
  assert.match(graph, /minGainDb:\s*-6/);
  assert.match(graph, /maxGainDb:\s*12/);
  assert.match(graph, /attackMs:\s*20/);
  assert.match(graph, /releaseMs:\s*300/);
});

test('RMS leveler is pure, gated, bounded, and smoothed', () => {
  assert.match(leveler, /export function rmsDbfs\(samples: Float32Array\): number/);
  assert.match(leveler, /export function targetGainDb\(/);
  assert.match(leveler, /if \(rmsDbfsValue <= config\.gateDbfs\) return 0/);
  assert.match(leveler, /Math\.min\(\s*config\.maxGainDb/);
  assert.match(leveler, /Math\.max\(config\.minGainDb/);
  assert.match(leveler, /attackMs/);
  assert.match(leveler, /releaseMs/);
});

test('recording graph creates independent source chains with compressors', () => {
  assert.match(graph, /export function createRecordingGraph\(/);
  assert.match(graph, /jerryChain/);
  assert.match(graph, /guestChain/);
  assert.match(graph, /createDynamicsCompressor\(\)/);
  assert.match(graph, /jerryChain\.compressor/);
  assert.match(graph, /guestChain\.compressor/);
});

test('merger routes Jerry to channel zero and guest to channel one', () => {
  assert.match(graph, /jerryChain\.output\.connect\(merger, 0, RECORDING_CHANNELS\.jerry\)/);
  assert.match(graph, /guestChain\.output\.connect\(merger, 0, RECORDING_CHANNELS\.guest\)/);
  assert.match(graph, /merger\.connect\(destination\)/);
  assert.match(graph, /createMediaStreamDestination\(\)/);
});

test('recording graph exposes cleanup without owning the centered monitor mix', () => {
  assert.match(graph, /cleanup: \(\) => void/);
  assert.match(graph, /monitorMix/);
  assert.match(graph, /centered monitor mix remains an integration responsibility/);
});

test('episode recording integrates the graph, reuses live mic, and cleans up after stop', () => {
  const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
  assert.match(studio, /createRecordingGraph\(ctx, \{ jerry: jerryRecordingInputRef\.current, guest: guestSource \}\)/);
  assert.match(studio, /liveMicStreamRef\.current[\s\S]{0,300}micStream = liveMicStreamRef\.current/);
  assert.match(studio, /streamToRecord = graph\.destination\.stream/);
  assert.match(studio, /finally \{[\s\S]{0,500}cleanupRecordingGraph\(\);[\s\S]{0,500}stopMicTracks\(\);/);
});

test('microphone failure falls back to a Jerry-only recording graph', () => {
  const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
  assert.match(studio, /createRecordingGraph\(ctx, \{ jerry: jerryRecordingInputRef\.current, guest: null \}\)/);
  assert.match(studio, /recordingModeRef\.current = 'jerry-only'/);
});
