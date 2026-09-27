import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const graph = fs.readFileSync('src/audio/recordingGraph.ts', 'utf8');
const leveler = fs.readFileSync('src/audio/autoLeveler.ts', 'utf8');

test('recording channels are a stable Jerry-left and guest-right contract', () => {
  assert.match(graph, /export const RECORDING_CHANNELS = \{\s*jerry:\s*0,\s*guest:\s*1,\s*\} as const;/);
});

test('recording channels use bounded, intentionally different level configurations', () => {
  const guestConfig = graph.match(/export const GUEST_LEVEL_CONFIG = \{([\s\S]*?)\} as const/);
  const jerryConfig = graph.match(/export const JERRY_LEVEL_CONFIG = \{([\s\S]*?)\} as const/);

  assert.ok(guestConfig, 'guest level config should be exported');
  assert.ok(jerryConfig, 'Jerry level config should be exported');
  assert.match(guestConfig[1], /targetDbfs:\s*-18/);
  assert.match(guestConfig[1], /gateDbfs:\s*-55/);
  assert.match(guestConfig[1], /minGainDb:\s*-6/);
  assert.match(guestConfig[1], /maxGainDb:\s*(?:[0-9]|1[0-2])\b/);
  assert.match(jerryConfig[1], /targetDbfs:\s*-18/);
  assert.match(jerryConfig[1], /gateDbfs:\s*-55/);
  assert.match(jerryConfig[1], /minGainDb:\s*-6/);
  assert.match(jerryConfig[1], /maxGainDb:\s*(?:[0-6])\b/);
  assert.notEqual(guestConfig[1].match(/maxGainDb:\s*(-?\d+)/)[1], jerryConfig[1].match(/maxGainDb:\s*(-?\d+)/)[1]);
});

test('recording channels use separate dynamics configurations with lighter, slower Jerry processing', () => {
  const guestConfig = graph.match(/export const GUEST_DYNAMICS_CONFIG[^=]*= \{([\s\S]*?)\};/);
  const jerryConfig = graph.match(/export const JERRY_DYNAMICS_CONFIG[^=]*= \{([\s\S]*?)\};/);

  assert.ok(guestConfig, 'guest dynamics config should be exported');
  assert.ok(jerryConfig, 'Jerry dynamics config should be exported');
  assert.notEqual(guestConfig[1], jerryConfig[1]);
  assert.match(guestConfig[1], /ratio:\s*(?:[4-9]|1\d|2\d)/);
  assert.match(jerryConfig[1], /ratio:\s*(?:1|2|3|4)(?:\.\d+)?/);
  assert.match(jerryConfig[1], /attack:\s*0\.01/);
  assert.match(jerryConfig[1], /release:\s*0\.25/);
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
  assert.match(graph, /createChannelChain\([\s\S]*?sources\.jerry,[\s\S]*?JERRY_LEVEL_CONFIG,[\s\S]*?JERRY_DYNAMICS_CONFIG,[\s\S]*?\)/);
  assert.match(graph, /createChannelChain\([\s\S]*?sources\.guest,[\s\S]*?GUEST_LEVEL_CONFIG,[\s\S]*?GUEST_DYNAMICS_CONFIG,[\s\S]*?\)/);
});

test('Guest has a conservative bounded preamp before analysis while Jerry stays at unity', () => {
  const preamp = graph.match(/export const GUEST_PREAMP_CONFIG = \{([\s\S]*?)\} as const/);
  assert.ok(preamp, 'Guest preamp config should be exported');
  assert.match(preamp[1], /defaultGainDb:\s*6/);
  assert.match(preamp[1], /maxGainDb:\s*12/);
  assert.match(graph, /const preamp = context\.createGain\(\);/);
  assert.match(graph, /preamp\.gain\.value = 10 \*\* \(preampGainDb \/ 20\);/);
  assert.match(graph, /source\.connect\(preamp\);\s*preamp\.connect\(analyser\);/);
  assert.match(graph, /jerryPreampDb:\s*0/);
});

test('RecordingMetrics exposes the applied Guest preamp for diagnostics', () => {
  assert.match(graph, /export interface RecordingMetrics/);
  assert.match(graph, /guestPreampDb:\s*number/);
  assert.match(graph, /jerryPreampDb:\s*number/);
  assert.match(graph, /getMetrics: \(\) => RecordingMetrics/);
  assert.match(graph, /guestPreampDb:[\s\S]*?GUEST_PREAMP_CONFIG\.defaultGainDb/);
});

test('merger routes Jerry to channel zero and guest to channel one', () => {
  assert.match(graph, /jerryChain\.output\.connect\(merger, 0, RECORDING_CHANNELS\.jerry\)/);
  assert.match(graph, /guestChain\.output\.connect\(merger, 0, RECORDING_CHANNELS\.guest\)/);
  assert.match(graph, /merger\.connect\(masterGain\)/);
  assert.match(graph, /masterGain\.connect\(masterLimiter\)/);
  assert.match(graph, /masterLimiter\.connect\(destination\)/);
  assert.match(graph, /createMediaStreamDestination\(\)/);
});

test('master limiter is the final recording safety boundary', () => {
  assert.match(graph, /const MASTER_LIMITER_CONFIG = \{[\s\S]*?threshold:\s*-1/);
  assert.match(graph, /const MASTER_LIMITER_CONFIG = \{[\s\S]*?ratio:\s*20/);
  assert.match(graph, /merger\.connect\(masterGain\);\s*masterGain\.connect\(masterLimiter\);\s*masterLimiter\.connect\(destination\);/);
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

test('recording graph exposes independent Jerry and guest destinations', () => {
  assert.match(graph, /jerryDestination: MediaStreamAudioDestinationNode/);
  assert.match(graph, /guestDestination: MediaStreamAudioDestinationNode \| null/);
  assert.match(graph, /jerryChain\.output\.connect\(jerryDestination\)/);
  assert.match(graph, /guestChain\.output\.connect\(guestDestination\)/);
});

test('master voice mix applies shared loudness target and -1 dB headroom limiter', () => {
  assert.match(graph, /MASTER_LIMITER_CONFIG/);
  assert.match(graph, /masterGain: GainNode/);
  assert.match(graph, /masterLimiter: DynamicsCompressorNode/);
  assert.match(graph, /masterGain\.gain\.value/);
  assert.match(graph, /masterGain\.connect\(masterLimiter\)/);
  assert.match(graph, /masterLimiter\.connect\(destination\)/);
  assert.match(graph, /threshold:\s*-1/);
});

test('episode recording creates separate speaker files and a conversation log', () => {
  const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
  const turnLog = fs.readFileSync('src/audio/turnLog.ts', 'utf8');
  assert.match(studio, /jerryTrackRecorderRef/);
  assert.match(studio, /guestTrackRecorderRef/);
  assert.match(studio, /episodeTurnLogUrl/);
  assert.match(turnLog, /startedAt/);
  assert.match(turnLog, /endedAt/);
  assert.match(studio, /conversation\.json/);
});

test('recording exposes input-device selection and rejects muted live tracks', () => {
  const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
  assert.match(studio, /audioInputDevices/);
  assert.match(studio, /selectedAudioInputId/);
  assert.match(studio, /enumerateDevices/);
  assert.match(studio, /deviceId:\s*\{\s*exact:\s*selectedAudioInputId/);
  assert.match(studio, /track\.muted/);
});
