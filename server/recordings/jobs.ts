import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaProcessingError, processMedia, type MediaProcessingResult } from './media';

export type RecordingMediaJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface RecordingMediaJobLogEntry {
  at: string;
  message: string;
}

export interface RecordingMediaJob {
  id: string;
  archiveId: string;
  status: RecordingMediaJobStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  sourcePath: string;
  outputPath: string;
  rawPreserved: true;
  toolVersions?: MediaProcessingResult['toolVersions'];
  probe?: MediaProcessingResult['probe'];
  outputProbe?: MediaProcessingResult['outputProbe'];
  error?: string;
  logs: RecordingMediaJobLogEntry[];
}

export interface RecordingMediaJobQueueOptions {
  mediaProcessor?: typeof processMedia;
  now?: () => Date;
}

export interface EnqueueRecordingMediaJobInput {
  archiveId: string;
  sourcePath: string;
}

function jobDir(rootDir: string, id: string): string {
  return path.join(rootDir, 'jobs', id);
}

function jobStatePath(rootDir: string, id: string): string {
  return path.join(jobDir(rootDir, id), 'job.json');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
  await fs.rename(tempPath, filePath);
}

export class RecordingMediaJobQueue {
  private readonly mediaProcessor: typeof processMedia;
  private readonly now: () => Date;

  constructor(private readonly rootDir: string, options: RecordingMediaJobQueueOptions = {}) {
    this.mediaProcessor = options.mediaProcessor || processMedia;
    this.now = options.now || (() => new Date());
  }

  async enqueue(input: EnqueueRecordingMediaJobInput): Promise<RecordingMediaJob> {
    const source = await fs.stat(input.sourcePath).catch(() => null);
    if (!source?.isFile() || source.size === 0) throw new Error('Raw recording source is missing or empty');
    const id = crypto.randomUUID();
    const createdAt = this.now().toISOString();
    const outputPath = path.join(jobDir(this.rootDir, id), 'processed.wav');
    const job: RecordingMediaJob = {
      id,
      archiveId: input.archiveId,
      status: 'queued',
      attempt: 0,
      createdAt,
      updatedAt: createdAt,
      sourcePath: input.sourcePath,
      outputPath,
      rawPreserved: true,
      logs: [],
    };
    await fs.mkdir(jobDir(this.rootDir, id), { recursive: true });
    await writeJsonAtomic(jobStatePath(this.rootDir, id), job);
    return job;
  }

  async get(id: string): Promise<RecordingMediaJob> {
    try {
      return JSON.parse(await fs.readFile(jobStatePath(this.rootDir, id), 'utf8')) as RecordingMediaJob;
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error('Media job not found');
      throw error;
    }
  }

  private async save(job: RecordingMediaJob): Promise<void> {
    job.updatedAt = this.now().toISOString();
    await writeJsonAtomic(jobStatePath(this.rootDir, job.id), job);
  }

  private async appendLog(job: RecordingMediaJob, message: string): Promise<void> {
    job.logs.push({ at: this.now().toISOString(), message });
    await fs.appendFile(path.join(jobDir(this.rootDir, job.id), 'processing.log'), `${job.logs.at(-1)?.at} ${message}\n`);
    await this.save(job);
  }

  async run(id: string): Promise<RecordingMediaJob> {
    const job = await this.get(id);
    if (job.status === 'succeeded') return job;
    job.status = 'running';
    job.attempt += 1;
    job.startedAt = this.now().toISOString();
    job.error = undefined;
    await this.save(job);
    await this.appendLog(job, `job:start attempt=${job.attempt}`);

    try {
      const result = await this.mediaProcessor({
        inputPath: job.sourcePath,
        outputPath: job.outputPath,
        appendLog: (message) => this.appendLog(job, message),
      });
      job.status = 'succeeded';
      job.completedAt = this.now().toISOString();
      job.toolVersions = result.toolVersions;
      job.probe = result.probe;
      job.outputProbe = result.outputProbe;
      await this.appendLog(job, 'job:succeeded');
      await this.save(job);
      return job;
    } catch (error: any) {
      job.status = 'failed';
      job.completedAt = this.now().toISOString();
      job.error = error?.message || String(error);
      if (error instanceof MediaProcessingError) job.toolVersions = error.toolVersions;
      await this.appendLog(job, `job:failed error=${job.error}`);
      await this.save(job);
      return job;
    }
  }

  async recoverStaleJobs(): Promise<RecordingMediaJob[]> {
    const jobsRoot = path.join(this.rootDir, 'jobs');
    const entries = await fs.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
    const recovered: RecordingMediaJob[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.get(entry.name).catch(() => null);
      if (!job || job.status !== 'running') continue;
      job.status = 'queued';
      job.error = 'Recovered after server restart';
      await this.appendLog(job, 'job:recovered status=queued');
      await this.save(job);
      recovered.push(job);
    }
    return recovered;
  }
}

