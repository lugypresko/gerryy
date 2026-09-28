import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalCaptureRoot } from '../recordingStore';

export type CaptureSource = 'human' | 'jerry';
export type CaptureStatus = 'recording' | 'stopping' | 'finalized';
export type CaptureEncoding = 'pcm_s16le' | 'pcm_f32le';

export interface CaptureFormat {
  sampleRate: number;
  channels: 1 | 2;
  encoding: CaptureEncoding;
}

export interface CaptureChunk {
  source: CaptureSource;
  sequence: number;
  captureStartMs: number;
  captureEndMs: number;
  sampleCount: number;
  format: CaptureFormat;
  data: Buffer;
}

export interface CaptureStreamManifest {
  source: CaptureSource;
  format?: CaptureFormat;
  chunkCount: number;
  byteCount: number;
  sampleCount: number;
  firstSequence: number;
  lastSequence: number;
  firstCaptureStartMs?: number;
  lastCaptureEndMs?: number;
}

export interface CanonicalCaptureManifest {
  id: string;
  episodeId: string;
  status: CaptureStatus;
  startedAtMs: number;
  stopRequestedAtMs?: number;
  finalizedAtMs?: number;
  streams: Record<CaptureSource, CaptureStreamManifest>;
  metadata: Record<string, unknown>;
}

export interface StartCaptureInput {
  episodeId?: string;
  startedAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredCaptureChunk {
  source: CaptureSource;
  sequence: number;
  captureStartMs: number;
  captureEndMs: number;
  sampleCount: number;
  format: CaptureFormat;
  byteCount: number;
  sha256: string;
  fileName: string;
}

export interface CaptureChunkReceipt {
  status: 'appended' | 'duplicate';
  source: CaptureSource;
  sequence: number;
  byteCount: number;
  sha256: string;
}

export interface CaptureEvent {
  id: string;
  type: 'started' | 'chunk-appended' | 'stop-requested' | 'finalized' | 'transcript' | 'conversation-event';
  atMs: number;
  source?: CaptureSource;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

const SOURCES: CaptureSource[] = ['human', 'jerry'];
const ENCODING_BYTES: Record<CaptureEncoding, number> = { pcm_s16le: 2, pcm_f32le: 4 };

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertEpisodeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('Invalid capture episode id');
}

function assertSource(source: string): asserts source is CaptureSource {
  if (!SOURCES.includes(source as CaptureSource)) throw new Error('Invalid capture source');
}

function sameFormat(left: CaptureFormat, right: CaptureFormat): boolean {
  return left.sampleRate === right.sampleRate && left.channels === right.channels && left.encoding === right.encoding;
}

function emptyStream(source: CaptureSource): CaptureStreamManifest {
  return { source, chunkCount: 0, byteCount: 0, sampleCount: 0, firstSequence: -1, lastSequence: -1 };
}

function captureDir(rootDir: string, id: string): string {
  return path.join(canonicalCaptureRoot(rootDir), id);
}

function statePath(rootDir: string, id: string): string {
  return path.join(captureDir(rootDir, id), 'capture.json');
}

function eventsPath(rootDir: string, id: string): string {
  return path.join(captureDir(rootDir, id), 'events.jsonl');
}

function sourceDir(rootDir: string, id: string, source: CaptureSource): string {
  return path.join(captureDir(rootDir, id), 'sources', source);
}

function chunkIndexPath(rootDir: string, id: string, source: CaptureSource): string {
  return path.join(sourceDir(rootDir, id, source), 'chunks.jsonl');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, filePath);
}

function validateChunk(chunk: CaptureChunk): void {
  if (!chunk || typeof chunk !== 'object') throw new Error('Invalid capture chunk: object required');
  assertSource(chunk.source);
  if (!Number.isInteger(chunk.sequence) || chunk.sequence < 0) throw new Error('Invalid capture chunk: sequence');
  if (!isFiniteNonNegative(chunk.captureStartMs) || !isFiniteNonNegative(chunk.captureEndMs) || chunk.captureEndMs < chunk.captureStartMs) {
    throw new Error('Invalid capture chunk: capture timestamps');
  }
  if (!Number.isInteger(chunk.sampleCount) || chunk.sampleCount <= 0) throw new Error('Invalid capture chunk: sample count');
  const format = chunk.format;
  if (!format || !Number.isInteger(format.sampleRate) || format.sampleRate <= 0 || format.sampleRate > 384_000
    || (format.channels !== 1 && format.channels !== 2) || !(format.encoding in ENCODING_BYTES)) {
    throw new Error('Invalid capture chunk: format');
  }
  if (!Buffer.isBuffer(chunk.data) || chunk.data.length === 0) throw new Error('Invalid capture chunk: data');
  const frameBytes = ENCODING_BYTES[format.encoding] * format.channels;
  if (chunk.data.length % frameBytes !== 0 || chunk.data.length / frameBytes !== chunk.sampleCount) {
    throw new Error('Invalid capture chunk: data/sample count mismatch');
  }
}

export class CanonicalCaptureStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async start(input: StartCaptureInput = {}): Promise<CanonicalCaptureManifest> {
    const episodeId = input.episodeId || crypto.randomUUID();
    assertEpisodeId(episodeId);
    const existing = await this.get(episodeId).catch(() => null);
    if (existing) return existing;

    const manifest: CanonicalCaptureManifest = {
      id: episodeId,
      episodeId,
      status: 'recording',
      startedAtMs: input.startedAtMs ?? Date.now(),
      streams: { human: emptyStream('human'), jerry: emptyStream('jerry') },
      metadata: input.metadata || {},
    };
    await fs.mkdir(captureDir(this.rootDir, episodeId), { recursive: true });
    await fs.mkdir(sourceDir(this.rootDir, episodeId, 'human'), { recursive: true });
    await fs.mkdir(sourceDir(this.rootDir, episodeId, 'jerry'), { recursive: true });
    try {
      await fs.open(statePath(this.rootDir, episodeId), 'wx').then(async (handle) => {
        try { await handle.writeFile(JSON.stringify(manifest, null, 2)); } finally { await handle.close(); }
      });
    } catch (error: any) {
      if (error?.code === 'EEXIST') return this.get(episodeId);
      throw error;
    }
    await this.appendEvent(episodeId, { id: crypto.randomUUID(), type: 'started', atMs: manifest.startedAtMs });
    return manifest;
  }

  async get(id: string): Promise<CanonicalCaptureManifest> {
    assertEpisodeId(id);
    try {
      return JSON.parse(await fs.readFile(statePath(this.rootDir, id), 'utf8')) as CanonicalCaptureManifest;
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error('Capture not found');
      throw error;
    }
  }

  async appendChunk(id: string, chunk: CaptureChunk): Promise<CaptureChunkReceipt> {
    return this.withLock(id, async () => {
      validateChunk(chunk);
      const manifest = await this.get(id);
      if (manifest.status === 'finalized') throw new Error('Capture is finalized');
      if (manifest.stopRequestedAtMs !== undefined && chunk.captureEndMs > manifest.stopRequestedAtMs) {
        throw new Error('Capture chunk is after capture stop boundary');
      }
      const stream = manifest.streams[chunk.source];
      if (stream.format && !sameFormat(stream.format, chunk.format)) throw new Error('Capture format changed within source');
      const expectedSequence = stream.lastSequence + 1;
      const digest = crypto.createHash('sha256').update(chunk.data).digest('hex');
      if (chunk.sequence < expectedSequence) {
        const existing = (await this.listChunks(id, chunk.source)).find((item) => item.sequence === chunk.sequence);
        if (existing && existing.sha256 === digest && existing.byteCount === chunk.data.length) {
          return { status: 'duplicate', source: chunk.source, sequence: chunk.sequence, byteCount: existing.byteCount, sha256: existing.sha256 };
        }
        throw new Error('Capture chunk conflicts with an existing sequence');
      }
      if (chunk.sequence > expectedSequence) throw new Error('Capture chunk sequence gap');

      const fileName = `${String(chunk.sequence).padStart(12, '0')}.pcm`;
      const filePath = path.join(sourceDir(this.rootDir, id, chunk.source), fileName);
      const handle = await fs.open(filePath, 'wx');
      try { await handle.writeFile(chunk.data); } finally { await handle.close(); }
      const stored: StoredCaptureChunk = {
        source: chunk.source,
        sequence: chunk.sequence,
        captureStartMs: chunk.captureStartMs,
        captureEndMs: chunk.captureEndMs,
        sampleCount: chunk.sampleCount,
        format: chunk.format,
        byteCount: chunk.data.length,
        sha256: digest,
        fileName,
      };
      await fs.appendFile(chunkIndexPath(this.rootDir, id, chunk.source), `${JSON.stringify(stored)}\n`);
      stream.format = chunk.format;
      stream.chunkCount += 1;
      stream.byteCount += chunk.data.length;
      stream.sampleCount += chunk.sampleCount;
      stream.firstSequence = stream.firstSequence < 0 ? chunk.sequence : stream.firstSequence;
      stream.lastSequence = chunk.sequence;
      stream.firstCaptureStartMs = stream.firstCaptureStartMs ?? chunk.captureStartMs;
      stream.lastCaptureEndMs = chunk.captureEndMs;
      await writeJsonAtomic(statePath(this.rootDir, id), manifest);
      await this.appendEvent(id, { id: crypto.randomUUID(), type: 'chunk-appended', atMs: chunk.captureEndMs, source: chunk.source, sequence: chunk.sequence });
      return { status: 'appended', source: chunk.source, sequence: chunk.sequence, byteCount: stored.byteCount, sha256: stored.sha256 };
    });
  }

  async listChunks(id: string, source: CaptureSource): Promise<StoredCaptureChunk[]> {
    assertSource(source);
    const text = await fs.readFile(chunkIndexPath(this.rootDir, id, source), 'utf8').catch(() => '');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as StoredCaptureChunk)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async readSource(id: string, source: CaptureSource): Promise<Buffer> {
    const chunks = await this.listChunks(id, source);
    const buffers = await Promise.all(chunks.map((chunk) => fs.readFile(path.join(sourceDir(this.rootDir, id, source), chunk.fileName))));
    return Buffer.concat(buffers);
  }

  async requestStop(id: string, stopRequestedAtMs = Date.now()): Promise<CanonicalCaptureManifest> {
    return this.withLock(id, async () => {
      const manifest = await this.get(id);
      if (manifest.status === 'finalized' || manifest.status === 'stopping') return manifest;
      manifest.status = 'stopping';
      manifest.stopRequestedAtMs = stopRequestedAtMs;
      await writeJsonAtomic(statePath(this.rootDir, id), manifest);
      await this.appendEvent(id, { id: crypto.randomUUID(), type: 'stop-requested', atMs: stopRequestedAtMs });
      return manifest;
    });
  }

  async finalize(id: string, finalizedAtMs = Date.now()): Promise<CanonicalCaptureManifest> {
    return this.withLock(id, async () => {
      const manifest = await this.get(id);
      if (manifest.status === 'finalized') return manifest;
      if (manifest.status !== 'stopping') throw new Error('Capture must be stopping before finalization');
      manifest.status = 'finalized';
      manifest.finalizedAtMs = finalizedAtMs;
      await writeJsonAtomic(statePath(this.rootDir, id), manifest);
      await this.appendEvent(id, { id: crypto.randomUUID(), type: 'finalized', atMs: finalizedAtMs });
      return manifest;
    });
  }

  async listEvents(id: string): Promise<CaptureEvent[]> {
    const text = await fs.readFile(eventsPath(this.rootDir, id), 'utf8').catch(() => '');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CaptureEvent);
  }

  async appendEventRecord(id: string, event: Omit<CaptureEvent, 'id'> & { id?: string }): Promise<CaptureEvent> {
    return this.withLock(id, async () => {
      await this.get(id);
      const stored: CaptureEvent = { ...event, id: event.id || crypto.randomUUID() };
      await this.appendEvent(id, stored);
      return stored;
    });
  }

  private async appendEvent(id: string, event: CaptureEvent): Promise<void> {
    await fs.appendFile(eventsPath(this.rootDir, id), `${JSON.stringify(event)}\n`);
  }

  private async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
}

export { validateChunk as validateCaptureChunk };


