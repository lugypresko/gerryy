import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const finalizerPath = 'src/audio/episodeFinalizer.ts';
const finalizer = fs.existsSync(finalizerPath) ? fs.readFileSync(finalizerPath, 'utf8') : '';
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');

test('episode finalizer exposes the deterministic finalization contract', () => {
  assert.match(finalizer, /export type PublishStatus/);
  assert.match(finalizer, /publishable/);
  assert.match(finalizer, /needs-review/);
  assert.match(finalizer, /failed/);
  assert.match(finalizer, /export interface EpisodeStemInput/);
  assert.match(finalizer, /export interface FinalizedEpisode/);
  assert.match(finalizer, /finalMaster/);
  assert.match(finalizer, /rawStems/);
  assert.match(finalizer, /publicationStatus/);
  assert.match(finalizer, /warnings/);
  assert.match(finalizer, /processingMs/);
});

test('episode finalizer has bounded balance, measurement, offline rendering, and publish gate', () => {
  assert.match(finalizer, /decodeAudioBlob/);
  assert.match(finalizer, /measureAudioBuffer/);
  assert.match(finalizer, /Math\.min\(.*12/);
  assert.match(finalizer, /Math\.max\(.*-6/);
  assert.match(finalizer, /OfflineAudioContext/);
  assert.match(finalizer, /startRendering/);
  assert.match(finalizer, /evaluatePublishGate/);
  assert.match(finalizer, /balanceDeltaDb/);
  assert.match(finalizer, /clippingCount/);
});

test('WebM decode failure preserves the original stereo master for review', () => {
  assert.match(finalizer, /isStereoWebmFallback/);
  assert.match(finalizer, /original stereo master preserved/);
  assert.match(finalizer, /publicationStatus: 'needs-review'/);
});

test('download is created only after finalization and failed output is blocked', () => {
  assert.match(studio, /finalizeEpisode\(/);
  assert.match(studio, /finalizedEpisode\?\.publicationStatus !== 'failed'/);
  assert.match(studio, /final-master|finalMaster/);
  assert.match(studio, /rawStems/);
  assert.doesNotMatch(studio, /setEpisodeAudioUrl\(url\);/);
});
