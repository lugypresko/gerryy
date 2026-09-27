import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const generator = path.resolve('scripts/generate-audio-fixtures.mjs');
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
}

async function probe(file) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(stdout);
}

async function decode(file) {
  try {
    const result = await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
    return { status: 0, stderr: result.stderr };
  } catch (error) {
    return {
      status: error.code ?? 1,
      stderr: error.stderr || String(error),
    };
  }
}

test('generated fixtures preserve channel identity, duration asymmetry, silence, and mono variants', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-audio-fixtures-'));
  const result = await run(process.execPath, [generator, '--output', output]);
  assert.equal(result.stderr, '', result.stderr);

  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.sourceHashes);
  assert.ok(manifest.baselineResults);

  const unbalanced = await probe(path.join(output, 'stereo-unbalanced.wav'));
  assert.equal(unbalanced.streams[0].channels, 2);
  assert.equal(manifest.expected.stereoUnbalanced.leftSpeaker, 'jerry');
  assert.equal(manifest.expected.stereoUnbalanced.rightSpeaker, 'guest');
  assert.deepEqual(manifest.expected.unequalSpeakingWindows, {
    jerryMs: 2500,
    guestMs: 2000,
  });

  const mono = await probe(path.join(output, 'mono.wav'));
  assert.equal(mono.streams[0].channels, 1);
  const silence = await probe(path.join(output, 'stereo-silence.wav'));
  assert.equal(silence.streams[0].channels, 2);
  assert.equal(Number(silence.format.duration), 2);

  const validDecode = await decode(path.join(output, 'stereo-unbalanced.wav'));
  assert.equal(validDecode.status, 0, validDecode.stderr);
  assert.equal(manifest.baselineResults['stereo-unbalanced.wav'].decode.status, 0);
});

test('damaged container is not accepted by full decode even when metadata is present', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-audio-damaged-'));
  await run(process.execPath, [generator, '--output', output]);
  const damaged = path.join(output, 'damaged-container.wav');
  const metadata = await probe(damaged).catch(() => null);
  const decodeResult = await decode(damaged);

  assert.ok(metadata || decodeResult.status !== 0, 'fixture must retain inspectable metadata or fail explicitly');
  assert.notEqual(decodeResult.status, 0, decodeResult.stderr);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.notEqual(manifest.baselineResults['damaged-container.wav'].decode.status, 0);
  assert.match(manifest.baselineResults['damaged-container.wav'].decode.stderr, /error|invalid|truncat|end of file/i);
});

test('browser MediaRecorder stereo fixture decodes through FFmpeg with retained diagnostics', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-audio-browser-'));
  await run(process.execPath, [generator, '--output', output]);
  const file = path.join(output, 'browser-mediarecorder.webm');
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  if (manifest.browserMediaRecorder.status !== 'captured') {
    assert.equal(manifest.browserMediaRecorder.captureMethod, 'MediaRecorder');
    assert.ok(manifest.browserMediaRecorder.error);
    return;
  }
  const media = await probe(file);
  const audio = media.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(media.format.format_name, 'matroska,webm');
  assert.equal(audio.codec_name, 'opus');
  assert.equal(audio.channels, 2);
  const decoded = await decode(file);
  assert.equal(decoded.status, 0, decoded.stderr);

  assert.equal(manifest.browserMediaRecorder.captureMethod, 'MediaRecorder');
  assert.equal(manifest.baselineResults['browser-mediarecorder.webm'].decode.status, decoded.status);
  assert.equal(typeof manifest.baselineResults['browser-mediarecorder.webm'].decode.stderr, 'string');
});

test('revoking a blob URL before download reproduces the save-order failure', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  URL.revokeObjectURL(url);
  await assert.rejects(fetch(url));

  const validUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const response = await fetch(validUrl);
  const downloaded = new Uint8Array(await response.arrayBuffer());
  URL.revokeObjectURL(validUrl);
  assert.deepEqual([...downloaded], [...bytes]);
});
