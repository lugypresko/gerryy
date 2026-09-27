import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
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

test('media jobs persist queued/running/succeeded state and recover running jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-jobs-'));
  const source = path.join(root, 'raw.webm');
  await fs.writeFile(source, Buffer.from('raw-media'));

  const result = runTs(`(async () => {
    const { RecordingMediaJobQueue } = await import('./server/recordings/jobs.ts');
    const queue = new RecordingMediaJobQueue(process.env.JOB_ROOT, {
      mediaProcessor: async ({ outputPath, appendLog }) => {
        await appendLog('fake processor ran');
        await (await import('node:fs/promises')).writeFile(outputPath, Buffer.from('processed'));
        return { toolVersions: { ffmpeg: 'fake', ffprobe: 'fake' }, probe: { duration: 1 } };
      },
    });
    const job = await queue.enqueue({ archiveId: 'archive-1', sourcePath: process.env.SOURCE_PATH });
    const queued = await queue.get(job.id);
    const succeeded = await queue.run(job.id);
    const stale = await queue.enqueue({ archiveId: 'archive-1', sourcePath: process.env.SOURCE_PATH });
    const stalePath = (await import('node:path')).join(process.env.JOB_ROOT, 'jobs', stale.id, 'job.json');
    const staleJob = JSON.parse(await (await import('node:fs/promises')).readFile(stalePath, 'utf8'));
    staleJob.status = 'running';
    await (await import('node:fs/promises')).writeFile(stalePath, JSON.stringify(staleJob));
    const recovered = new RecordingMediaJobQueue(process.env.JOB_ROOT, { mediaProcessor: async () => ({}) });
    const recoveredJobs = await recovered.recoverStaleJobs();
    return { queued: queued.status, succeeded: succeeded.status, log: succeeded.logs, outputPath: succeeded.outputPath, recovered: recoveredJobs[0]?.status };
  })()`, { JOB_ROOT: root, SOURCE_PATH: source });

  assert.equal(result.queued, 'queued');
  assert.equal(result.succeeded, 'succeeded');
  assert.ok(result.log.some((entry) => entry.message.includes('fake processor ran')));
  assert.equal(await fs.readFile(result.outputPath, 'utf8'), 'processed');
  assert.equal(result.recovered, 'queued');
});

test('recording routes expose asynchronous processing and read-only job status', () => {
  const server = fsSync.readFileSync(path.join(repoRoot, 'server.ts'), 'utf8');
  assert.match(server, /app\.post\(['"]\/api\/recordings\/:archiveId\/process['"]/);
  assert.match(server, /app\.get\(['"]\/api\/recordings\/jobs\/:jobId['"]/);
  assert.match(server, /res\.status\(202\)\.json\(job\)/);
});

test('real media processor preserves raw input and records ffmpeg/ffprobe metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-media-'));
  const source = path.join(root, 'raw.wav');
  const output = path.join(root, 'processed.wav');

  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-y', source], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    t.skip('ffmpeg is unavailable');
    return;
  }

  const result = runTs(`(async () => {
    const { processMedia } = await import('./server/recordings/media.ts');
    return processMedia({ inputPath: process.env.SOURCE_PATH, outputPath: process.env.OUTPUT_PATH });
  })()`, { SOURCE_PATH: source, OUTPUT_PATH: output });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.toolVersions.ffmpeg.available, true);
  assert.equal(result.toolVersions.ffprobe.available, true);
  assert.ok(result.probe.duration > 0);
  assert.equal((await fs.stat(source)).size > 0, true);
  assert.equal((await fs.stat(output)).size > 0, true);
});

