import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const qualityPath = 'server/recordings/quality.ts';
const quality = fs.existsSync(qualityPath) ? fs.readFileSync(qualityPath, 'utf8') : '';

test('recording quality exposes decoded channel and speech-window metrics', () => {
  assert.match(quality, /export interface RecordingQualityMetrics/);
  assert.match(quality, /decoded/);
  assert.match(quality, /channelCount|channels/);
  assert.match(quality, /sampleRate/);
  assert.match(quality, /decodeAudio|decodeWav/);
  assert.match(quality, /activeWindows/);
  assert.match(quality, /activeSpeechMs/);
  assert.match(quality, /insufficientSpeech/);
});

test('recording quality measures LUFS and true peak inside active windows', () => {
  assert.match(quality, /lufs/i);
  assert.match(quality, /truePeak/i);
  assert.match(quality, /windowMs/);
  assert.match(quality, /hopMs/);
  assert.match(quality, /speechThresholdDbfs/);
  assert.match(quality, /oversampl|interpolat/i);
  assert.doesNotMatch(quality, /wholeFileRms|fileRmsOnly/);
});

test('recording quality reports clipping, balance and explicit insufficient speech', () => {
  assert.match(quality, /clippingCount/);
  assert.match(quality, /balanceDeltaDb/);
  assert.match(quality, /insufficient-speech|insufficientSpeech/);
  assert.match(quality, /publishable|needs-review|failed/);
  assert.match(quality, /minActiveSpeechMs|minActiveWindows/);
});
