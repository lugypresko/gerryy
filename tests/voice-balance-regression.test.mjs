import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const graph = fs.readFileSync('src/audio/recordingGraph.ts', 'utf8');
const leveler = fs.readFileSync('src/audio/autoLeveler.ts', 'utf8');
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');

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

test('microphone capture enables cleanup but delegates leveling to Jerry', () => {
  assert.match(studio, /MICROPHONE_CAPTURE_CONSTRAINTS/);
  assert.match(studio, /echoCancellation:\s*true/);
  assert.match(studio, /noiseSuppression:\s*true/);
  assert.match(studio, /autoGainControl:\s*true/);
  assert.equal((studio.match(/\.\.\.MICROPHONE_CAPTURE_CONSTRAINTS/g) || []).length, 2);
});

test('master output has an explicit conservative ceiling', () => {
  assert.match(graph, /MASTER_LIMITER_CONFIG[\s\S]{0,220}threshold:\s*-1/);
  assert.match(graph, /masterGain\.connect\(masterLimiter\)/);
  assert.match(graph, /masterLimiter\.connect\(destination\)/);
});

test('recording exposes balance telemetry and a publication decision', () => {
  assert.match(graph, /getMetrics/);
  for (const metric of [
    'guestRmsDbfs',
    'jerryRmsDbfs',
    'guestPeakDbfs',
    'jerryPeakDbfs',
    'guestClippingCount',
    'jerryClippingCount',
    'balanceDeltaDb',
  ]) {
    assert.match(graph, new RegExp(`\\b${metric}\\b`), `missing concrete telemetry metric: ${metric}`);
  }
  assert.match(studio, /recording-levels/);
  assert.match(studio, /publicationStatus/);
  assert.match(studio, /publishable/);
  assert.match(studio, /needs-review/);
  assert.match(studio, /failed/);
});

test('recording-levels telemetry is bounded and includes publication status', () => {
  assert.match(studio, /RECORDING_LEVELS_INTERVAL_MS/);
  assert.match(studio, /recording-levels/);
  assert.match(studio, /guestSilenceDurationMs/);
  assert.match(studio, /jerrySilenceDurationMs/);
  assert.match(studio, /guestActiveSpeechDurationMs/);
  assert.match(studio, /jerryActiveSpeechDurationMs/);
  assert.match(studio, /guestClippingCount/);
  assert.match(studio, /jerryClippingCount/);
  assert.match(studio, /balanceDeltaDb/);
  assert.match(studio, /publicationStatus/);
  assert.match(studio, /recordingTelemetryDetails/);
  assert.match(studio, /guestRmsDbfs:\s*boundedRecordingMetric/);
});

test('publication gate blocks failed audio and warns before needs-review downloads', () => {
  assert.match(studio, /function evaluateRecordingPublication/);
  assert.match(studio, /RECORDING_REVIEW_DELTA_DB = 3/);
  assert.match(studio, /RECORDING_FAILURE_DELTA_DB = 6/);
  assert.match(studio, /guestClippingCount \?\? 0\) > 0\) return 'failed'/);
  assert.match(studio, /if \(metrics\.balanceDeltaDb > RECORDING_REVIEW_DELTA_DB\) return 'needs-review'/);
  assert.match(studio, /handleEpisodeDownload/);
  assert.match(studio, /preventDefault/);
  assert.match(studio, /window\.confirm/);
});

test('recording graph measures speech windows without retaining raw PCM', () => {
  assert.match(leveler, /measureAudioWindow/);
  assert.match(graph, /createSpeechWindowMeter/);
  assert.match(graph, /getMetrics/);
  for (const metric of [
    'rmsDbfs',
    'peakDbfs',
    'silenceDurationMs',
    'activeSpeechDurationMs',
    'clippingCount',
    'isSpeech',
    'smoothedRmsDbfs',
  ]) {
    assert.match(leveler, new RegExp(`\\b${metric}\\b`), `missing speech metric: ${metric}`);
  }
  assert.doesNotMatch(graph, /Float32Array\\[\\]|rawPcm|pcmBuffer/i);
});

test('leveling is updated only for active speech windows and exposes bounded balance metrics', () => {
  assert.match(graph, /if \(jerryMeasurement\.isSpeech\)[\s\S]*?jerryChain\.leveler\.updateRmsDbfs/);
  assert.match(graph, /if \(guestMeasurement\.isSpeech\)[\s\S]*?guestChain\.leveler\.updateRmsDbfs/);
  assert.match(graph, /Math\.abs\([\s\S]*?balanceDeltaDb/);
  assert.match(graph, /getMetrics\(\): RecordingMetrics/);
  assert.match(graph, /guestRmsDbfs/);
  assert.match(graph, /jerryRmsDbfs/);
});

test('Guest preamp is bounded and does not alter Jerry gain', () => {
  const preamp = graph.match(/export const GUEST_PREAMP_CONFIG = \{([\s\S]*?)\} as const/);
  assert.ok(preamp);
  const defaultGain = Number(preamp[1].match(/defaultGainDb:\s*(-?\d+)/)[1]);
  const maxGain = Number(preamp[1].match(/maxGainDb:\s*(-?\d+)/)[1]);
  assert.equal(defaultGain, 6);
  assert.ok(defaultGain >= 0 && defaultGain <= maxGain);
  assert.equal(maxGain, 12);
  assert.match(graph, /jerryPreampDb:\s*0/);
});

test('Guest preamp is applied before the Guest analyser', () => {
  assert.match(graph, /source\.connect\(preamp\);\s*preamp\.connect\(analyser\);/);
  assert.match(graph, /sources\.guest,[\s\S]*?Math\.min\(GUEST_PREAMP_CONFIG\.defaultGainDb, GUEST_PREAMP_CONFIG\.maxGainDb\)/);
});
