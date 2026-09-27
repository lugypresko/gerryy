import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processEpisode } from '../server/recordings/processEpisode.ts';

const SAMPLE_RATE = 48_000;

function writeMonoWav(filePath, { gain, activeMs = 2400, durationMs = 3000, frequency = 440 }) {
  const frames = Math.round(SAMPLE_RATE * durationMs / 1000);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame++) {
    const timeMs = frame * 1000 / SAMPLE_RATE;
    const sample = timeMs < activeMs
      ? Math.sin(2 * Math.PI * frequency * frame / SAMPLE_RATE) * gain
      : 0;
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), 44 + frame * 2);
  }
  return fs.writeFile(filePath, buffer);
}

function mediaJob(outputPath) {
  return {
    status: 'succeeded',
    outputPath,
    toolVersions: {
      ffmpeg: { command: 'ffmpeg', available: true, version: 'ffmpeg-test' },
      ffprobe: { command: 'ffprobe', available: true, version: 'ffprobe-test' },
    },
    probe: { duration: 3, streams: [{ codec_type: 'audio', channels: 1 }] },
    outputProbe: { duration: 3, streams: [{ codec_type: 'audio', channels: 1 }] },
    logs: ['media-job-complete'],
  };
}

test('processes independent stems into a balanced explicit stereo publication master', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-episode-processing-'));
  const jerryPath = path.join(root, 'jerry.wav');
  const guestPath = path.join(root, 'guest.wav');
  await writeMonoWav(jerryPath, { gain: 0.16, frequency: 12000 });
  await writeMonoWav(guestPath, { gain: 0.05, frequency: 16000 });

  const result = await processEpisode({
    episodeId: 'episode-test-1',
    outputDir: root,
    rawStems: { jerry: jerryPath, guest: guestPath },
    mediaJob: mediaJob(path.join(root, 'media-job.wav')),
  });

  assert.equal(result.publicationStatus, 'publishable', JSON.stringify(result.report, null, 2));
  assert.equal(result.report.schemaVersion, 1);
  assert.equal(result.report.pipelineVersion, 'jerry-publication-stereo-v1');
  assert.deepEqual(result.report.stereoPolicy.channelMap, { left: 'jerry', right: 'guest' });
  assert.equal(result.report.stereoPolicy.panPolicy, 'hard-separated-archive-master');
  assert.equal(result.report.mediaJob.status, 'succeeded');
  assert.equal(result.report.rawStems.jerry, jerryPath);
  assert.equal(result.report.rawStems.guest, guestPath);
  assert.ok(result.report.qualityBefore);
  assert.ok(result.report.qualityAfter);
  assert.ok(result.report.gainsDb.guest > result.report.gainsDb.jerry);
  assert.ok(result.outputPath.endsWith('master-stereo.wav'));
  assert.equal((await fs.stat(result.outputPath)).isFile(), true);
});

test('rejects insufficient speech without replacing or deleting raw stems', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-episode-processing-silent-'));
  const jerryPath = path.join(root, 'jerry.wav');
  const guestPath = path.join(root, 'guest.wav');
  await writeMonoWav(jerryPath, { gain: 0, activeMs: 0, frequency: 440 });
  await writeMonoWav(guestPath, { gain: 0, activeMs: 0, frequency: 660 });

  const result = await processEpisode({
    episodeId: 'episode-test-silent',
    outputDir: root,
    rawStems: { jerry: jerryPath, guest: guestPath },
    mediaJob: mediaJob(path.join(root, 'media-job.wav')),
  });

  assert.equal(result.publicationStatus, 'failed');
  assert.match(result.report.reasons.join(' '), /insufficient-speech/);
  assert.equal((await fs.stat(jerryPath)).isFile(), true);
  assert.equal((await fs.stat(guestPath)).isFile(), true);
  await assert.rejects(fs.stat(result.outputPath));
});
