import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();

function runTs(expression, env = {}) {
  const script = `console.log(JSON.stringify(await ${expression}));`;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }));
}

test('jobs persist episode identity, stage events, elapsed time, heartbeat, and fallback mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-observability-'));
  const source = path.join(root, 'raw.webm');
  await fs.writeFile(source, Buffer.from('raw-media'));

  const result = runTs(`(async () => {
    const { RecordingMediaJobQueue } = await import('./server/recordings/jobs.ts');
    const queue = new RecordingMediaJobQueue(process.env.JOB_ROOT, {
      heartbeatIntervalMs: 0,
      mediaProcessor: async ({ outputPath, appendLog }) => {
        await appendLog('fake processor ran');
        await (await import('node:fs/promises')).writeFile(outputPath, Buffer.from('processed'));
        return { toolVersions: { ffmpeg: { available: true, command: 'fake' }, ffprobe: { available: true, command: 'fake' } }, probe: { duration: 1 }, outputProbe: { duration: 1 } };
      },
    });
    const job = await queue.enqueue({ archiveId: 'episode-1', episodeId: 'episode-1', sourcePath: process.env.SOURCE_PATH, processingMode: 'fallback' });
    const completed = await queue.run(job.id);
    const events = await queue.getEvents(job.id);
    return { completed, events };
  })()`, { JOB_ROOT: root, SOURCE_PATH: source });

  assert.equal(result.completed.episodeId, 'episode-1');
  assert.equal(result.completed.processingMode, 'fallback');
  assert.equal(result.completed.status, 'succeeded');
  assert.ok(result.events.some((event) => event.stage === 'processing' && event.event === 'queued'));
  assert.ok(result.events.some((event) => event.stage === 'processing' && event.event === 'started'));
  assert.ok(result.events.some((event) => event.stage === 'processing' && event.heartbeat === true));
  assert.ok(result.events.some((event) => event.stage === 'verification' && event.event === 'succeeded'));
  assert.ok(result.events.some((event) => event.stage === 'processing' && event.event === 'succeeded'));
  for (const event of result.events) {
    assert.equal(event.episodeId, 'episode-1');
    assert.ok(event.reasonCode);
    assert.equal(typeof event.elapsedMs, 'number');
  }
});

test('failed jobs become retryable, preserve failure reason, and become terminal after max attempts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-retry-'));
  const source = path.join(root, 'raw.webm');
  await fs.writeFile(source, Buffer.from('raw-media'));

  const result = runTs(`(async () => {
    const { RecordingMediaJobQueue } = await import('./server/recordings/jobs.ts');
    const queue = new RecordingMediaJobQueue(process.env.JOB_ROOT, {
      maxAttempts: 2,
      mediaProcessor: async () => { throw new Error('processor exploded'); },
    });
    const job = await queue.enqueue({ archiveId: 'episode-2', episodeId: 'episode-2', sourcePath: process.env.SOURCE_PATH });
    const first = await queue.run(job.id);
    const retry = await queue.retry(job.id);
    const second = await queue.run(retry.id);
    return { first, retry, second, events: await queue.getEvents(job.id) };
  })()`, { JOB_ROOT: root, SOURCE_PATH: source });

  assert.equal(result.first.status, 'retryable');
  assert.equal(result.first.failureReasonCode, 'processor_failed');
  assert.equal(result.retry.status, 'queued');
  assert.equal(result.second.status, 'failed');
  assert.ok(result.events.some((event) => event.event === 'retryable' && event.reasonCode === 'processor_failed'));
  assert.ok(result.events.some((event) => event.event === 'failed' && event.reasonCode === 'max_attempts_exceeded'));
});

test('server exposes event history and explicit retry wiring without changing browser code', () => {
  const server = fsSync.readFileSync(path.join(repoRoot, 'server.ts'), 'utf8');
  assert.match(server, /app\.get\(['"]\/api\/recordings\/jobs\/:jobId\/events['"]/);
  assert.match(server, /app\.post\(['"]\/api\/recordings\/jobs\/:jobId\/retry['"]/);
  assert.match(server, /recordObservabilityEvent\(['"]capture['"]/);
  assert.match(server, /recordObservabilityEvent\(['"]upload['"]/);
  assert.match(server, /recordObservabilityEvent\(['"]download['"]/);
});

