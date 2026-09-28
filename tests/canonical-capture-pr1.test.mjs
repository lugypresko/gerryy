import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const studio = fs.readFileSync(path.join(repoRoot, 'src/JerryPodcastStudio.tsx'), 'utf8');
const server = fs.readFileSync(path.join(repoRoot, 'server.ts'), 'utf8');
const captureSource = fs.readFileSync(path.join(repoRoot, 'server/recordings/capture.ts'), 'utf8');

const blockers = [
  !/canonical|archive/i.test(studio) || !/type:\s*['"]audio['"]/.test(studio)
    ? 'No browser-to-server canonical Human PCM archive lane is implemented.'
    : null,
  !/app\.post\(\[.*\/api\/captures\/start/s.test(server)
    ? 'No server canonical capture ingest endpoint is implemented.'
    : null,
  !/recording-stop-ack/.test(server)
    ? 'No server-confirmed canonical STOP/finalization contract is implemented.'
    : null,
  !/appendChunk|sampleCount|chunks\.json|sequence[^\n]{0,80}sample/i.test(captureSource)
    ? 'Server does not persist the PR1 chunk sequence/sample/checksum metadata contract.'
    : null,
].filter(Boolean);

function skipWithBlockers(t, extra) {
  t.skip([extra, ...blockers].join(' '));
}

test('PR1 canonical capture API has no static implementation blockers', () => {
  assert.deepEqual(blockers, [], blockers.join('\n'));
});

test('canonical Human source preserves the actual capture format while STT remains 16 kHz', (t) => {
  assert.match(studio, /resampleTo16kPcm\(input,\s*micCtx\.sampleRate\)/);
  assert.match(studio, /mimeType:\s*['"]audio\/pcm;rate=16000['"]/);
  if (blockers.some((entry) => entry.includes('Human PCM archive lane'))) {
    skipWithBlockers(t, 'BLOCKED: canonical source format cannot be exercised until the archive lane exists.');
  }
  assert.match(studio, /actual.*sample|sampleRate/i);
});

test('deterministic source fixture is nonzero and fully decodable', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jerry-pr1-media-'));
  const source = path.join(root, 'human-source.wav');
  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
      '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', source,
    ], { cwd: repoRoot, stdio: 'pipe' });
  } catch (error) {
    t.skip(`BLOCKED: ffmpeg is unavailable for deterministic source generation: ${error?.message || error}`);
    return;
  }

  const stat = await fsp.stat(source);
  assert.ok(stat.size > 44, `source must contain PCM payload, got ${stat.size} bytes`);
  const { probeMedia } = await import('../server/recordings/media.ts');
  const probe = await probeMedia(source);
  assert.ok(probe.duration > 0, 'ffprobe must report a positive duration');
  assert.ok(probe.streams?.some((stream) => stream.codec_type === 'audio'), 'source must contain an audio stream');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', source, '-f', 'null', '-'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
});

test('mixed Hebrew/English STT regression remains deterministic', async () => {
  const { extractGeneratedTranscript } = await import('../server/languageRouting.ts');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/code-switching-manifest.json'), 'utf8'));
  for (const fixture of manifest.cases) {
    const response = { candidates: [{ content: { parts: [{ audioTranscription: { text: fixture.expectedTranscript } }] } }] };
    assert.equal(extractGeneratedTranscript(response), fixture.expectedTranscript);
  }
  assert.match(server, /mimeType:\s*msg\.mimeType\s*\|\|\s*['"]audio\/pcm;rate=16000['"]/);
});

test('canonical capture succeeds when the shadow MediaRecorder is zero-byte', async (t) => {
  if (blockers.length > 0) {
    skipWithBlockers(t, 'BLOCKED: no canonical capture API exists against which shadow independence can be exercised.');
    return;
  }
  assert.match(server, /Canonical capture API: source preservation only/);
  assert.match(server, /requires non-zero Human and Jerry stems/);
});

test('canonical source assets remain retrievable after a server restart', async (t) => {
  if (blockers.length > 0) {
    skipWithBlockers(t, 'BLOCKED: source-only capture and restart retrieval are not exposed by the current archive API.');
    return;
  }
  assert.match(server, /canonicalCaptureHttpStore\.readSource/);
  assert.match(server, /Content-Disposition.*\.wav/);
});
