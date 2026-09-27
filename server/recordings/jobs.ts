import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaProcessingError, processMedia, type MediaProcessingResult } from './media';

export type RecordingMediaJobStatus = 'queued' | 'running' | 'retryable' | 'succeeded' | 'failed';
export type RecordingProcessingMode = 'processed' | 'fallback';
export type RecordingEventStage = 'capture' | 'upload' | 'processing' | 'verification' | 'download';
export type RecordingEventName = 'queued' | 'started' | 'heartbeat' | 'succeeded' | 'retryable' | 'failed' | 'recovered' | 'requested';

export interface RecordingObservabilityEvent {
  id: string;
  at: string;
  episodeId: string;
  jobId?: string;
  stage: RecordingEventStage;
  event: RecordingEventName;
  elapsedMs: number;
  heartbeat?: boolean;
  reasonCode: string;
  processingMode: RecordingProcessingMode;
  metadata?: Record<string, unknown>;
}

export interface RecordObservabilityEventInput {
  episodeId: string;
  jobId?: string;
  stage: RecordingEventStage;
  event: RecordingEventName;
  elapsedMs?: number;
  heartbeat?: boolean;
  reasonCode: string;
  processingMode?: RecordingProcessingMode;
  metadata?: Record<string, unknown>;
}

export class RecordingObservabilityStore {
  constructor(private readonly rootDir: string) {}

  async record(input: RecordObservabilityEventInput): Promise<RecordingObservabilityEvent> {
    const event: RecordingObservabilityEvent = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      elapsedMs: Math.max(0, input.elapsedMs || 0),
      processingMode: input.processingMode || 'processed',
      ...input,
    };
    const observabilityDir = path.join(this.rootDir, 'observability');
    await fs.mkdir(observabilityDir, { recursive: true });
    await fs.appendFile(path.join(observabilityDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    if (event.jobId) {
      const perJobDir = path.join(this.rootDir, 'jobs', event.jobId);
      await fs.mkdir(perJobDir, { recursive: true });
      await fs.appendFile(path.join(perJobDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    }
    return event;
  }

  async list(filters: { episodeId?: string; jobId?: string } = {}): Promise<RecordingObservabilityEvent[]> {
    const filePath = path.join(this.rootDir, 'observability', 'events.jsonl');
    const text = await fs.readFile(filePath, 'utf8').catch(() => '');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordingObservabilityEvent)
      .filter((event) => (!filters.episodeId || event.episodeId === filters.episodeId) && (!filters.jobId || event.jobId === filters.jobId));
  }
}

export interface RecordingMediaJobLogEntry {
  at: string;
  message: string;
}

export interface RecordingMediaJob {
  id: string;
  archiveId: string;
  episodeId: string;
  status: RecordingMediaJobStatus;
  attempt: number;
  maxAttempts: number;
  processingMode: RecordingProcessingMode;
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
  failureReasonCode?: string;
  nextRetryAt?: string;
  lastHeartbeatAt?: string;
  logs: RecordingMediaJobLogEntry[];
}

export interface RecordingMediaJobQueueOptions {
  mediaProcessor?: typeof processMedia;
  now?: () => Date;
  maxAttempts?: number;
  heartbeatIntervalMs?: number;
  observability?: RecordingObservabilityStore;
}

export interface EnqueueRecordingMediaJobInput {
  archiveId: string;
  episodeId?: string;
  sourcePath: string;
  processingMode?: RecordingProcessingMode;
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
  private readonly maxAttempts: number;
  private readonly heartbeatIntervalMs: number;
  private readonly observability: RecordingObservabilityStore;

  constructor(private readonly rootDir: string, options: RecordingMediaJobQueueOptions = {}) {
    this.mediaProcessor = options.mediaProcessor || processMedia;
    this.now = options.now || (() => new Date());
    this.maxAttempts = Math.max(1, options.maxAttempts || 3);
    this.heartbeatIntervalMs = Math.max(0, options.heartbeatIntervalMs ?? 5000);
    this.observability = options.observability || new RecordingObservabilityStore(rootDir);
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
      episodeId: input.episodeId || input.archiveId,
      status: 'queued',
      attempt: 0,
      maxAttempts: this.maxAttempts,
      processingMode: input.processingMode || 'processed',
      createdAt,
      updatedAt: createdAt,
      sourcePath: input.sourcePath,
      outputPath,
      rawPreserved: true,
      logs: [],
    };
    await fs.mkdir(jobDir(this.rootDir, id), { recursive: true });
    await writeJsonAtomic(jobStatePath(this.rootDir, id), job);
    await this.recordEvent(job, 'processing', 'queued', 'job_queued');
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

  private elapsed(job: RecordingMediaJob): number {
    return Math.max(0, Date.now() - Date.parse(job.startedAt || job.createdAt));
  }

  private async recordEvent(
    job: RecordingMediaJob,
    stage: RecordingEventStage,
    event: RecordingEventName,
    reasonCode: string,
    options: { heartbeat?: boolean; elapsedMs?: number; metadata?: Record<string, unknown> } = {},
  ): Promise<RecordingObservabilityEvent> {
    const recorded = await this.observability.record({
      episodeId: job.episodeId,
      jobId: job.id,
      stage,
      event,
      elapsedMs: options.elapsedMs ?? this.elapsed(job),
      heartbeat: options.heartbeat,
      reasonCode,
      processingMode: job.processingMode,
      metadata: options.metadata,
    });
    if (options.heartbeat) job.lastHeartbeatAt = recorded.at;
    await this.save(job);
    return recorded;
  }

  async getEvents(jobId: string): Promise<RecordingObservabilityEvent[]> {
    return this.observability.list({ jobId });
  }

  async run(id: string): Promise<RecordingMediaJob> {
    const job = await this.get(id);
    if (job.status === 'succeeded') return job;
    job.status = 'running';
    job.attempt += 1;
    job.startedAt = this.now().toISOString();
    job.error = undefined;
    job.failureReasonCode = undefined;
    job.nextRetryAt = undefined;
    await this.save(job);
    await this.appendLog(job, `job:start attempt=${job.attempt}`);
    await this.recordEvent(job, 'processing', 'started', 'worker_started');
    await this.recordEvent(job, 'processing', 'heartbeat', 'worker_heartbeat', { heartbeat: true });
    const heartbeat = this.heartbeatIntervalMs > 0
      ? setInterval(() => {
          void this.recordEvent(job, 'processing', 'heartbeat', 'worker_heartbeat', { heartbeat: true });
        }, this.heartbeatIntervalMs)
      : null;

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
      await this.recordEvent(job, 'verification', 'succeeded', 'verification_passed', {
        metadata: { durationSec: result.outputProbe?.duration },
      });
      await this.recordEvent(job, 'processing', 'succeeded', 'processing_complete');
      await this.appendLog(job, 'job:succeeded');
      await this.save(job);
      return job;
    } catch (error: any) {
      job.status = job.attempt < job.maxAttempts ? 'retryable' : 'failed';
      job.completedAt = this.now().toISOString();
      job.error = error?.message || String(error);
      job.failureReasonCode = job.status === 'retryable' ? 'processor_failed' : 'max_attempts_exceeded';
      if (job.status === 'retryable') job.nextRetryAt = this.now().toISOString();
      if (error instanceof MediaProcessingError) job.toolVersions = error.toolVersions;
      await this.recordEvent(job, 'processing', job.status === 'retryable' ? 'retryable' : 'failed', job.failureReasonCode);
      await this.appendLog(job, `job:${job.status} error=${job.error}`);
      await this.save(job);
      return job;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async retry(id: string): Promise<RecordingMediaJob> {
    const job = await this.get(id);
    if (job.status !== 'retryable') throw new Error('Media job is not retryable');
    job.status = 'queued';
    job.error = undefined;
    job.nextRetryAt = undefined;
    await this.save(job);
    await this.appendLog(job, 'job:retry requested');
    await this.recordEvent(job, 'processing', 'requested', 'manual_retry');
    return job;
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
      job.failureReasonCode = 'server_restart_recovery';
      await this.appendLog(job, 'job:recovered status=queued');
      await this.recordEvent(job, 'processing', 'recovered', 'server_restart_recovery');
      await this.save(job);
      recovered.push(job);
    }
    return recovered;
  }
}

