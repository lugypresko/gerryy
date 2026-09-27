export type RecordingSource = 'master' | 'jerry' | 'guest';
export type OutboxRetention = 'until-ack' | 'retain';

export interface RecordingChunk {
  episodeId: string;
  source: RecordingSource;
  sequence: number;
  blob: Blob;
  sha256: string;
  byteLength: number;
  createdAt: string;
}

export interface RecordingSnapshot {
  master?: Blob;
  jerry?: Blob;
  guest?: Blob;
  timeline: unknown[];
}

export interface RecordingUploadAck {
  acknowledged: boolean;
  sha256?: string;
}

export interface RecordingOutboxStore {
  getEpisode: (episodeId: string) => Promise<StoredEpisode | undefined>;
  putEpisode: (episode: StoredEpisode) => Promise<void>;
  listChunks: (episodeId: string) => Promise<StoredChunk[]>;
  putChunk: (chunk: StoredChunk) => Promise<void>;
  deleteChunk: (key: string) => Promise<void>;
}

interface StoredEpisode {
  episodeId: string;
  createdAt: string;
  snapshot?: RecordingSnapshot;
}

interface StoredChunk extends RecordingChunk {
  key: string;
  acknowledged?: boolean;
}

export interface RecordingOutbox {
  readonly episodeId: string;
  appendChunk: (input: { source: RecordingSource; sequence: number; blob: Blob }) => Promise<RecordingChunk>;
  listChunks: (source?: RecordingSource) => Promise<RecordingChunk[]>;
  saveSnapshot: (snapshot: RecordingSnapshot) => Promise<void>;
  getSnapshot: () => Promise<RecordingSnapshot>;
  resumeUploads: (
    uploadChunk: (chunk: RecordingChunk) => Promise<RecordingUploadAck>,
  ) => Promise<number>;
}

export interface CreateRecordingOutboxOptions {
  dbName?: string;
  episodeId?: string;
  retention?: OutboxRetention;
  store?: RecordingOutboxStore;
}

const DB_VERSION = 1;
const EPISODES_STORE = 'episodes';
const CHUNKS_STORE = 'chunks';

function makeEpisodeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `episode-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function chunkKey(episodeId: string, source: RecordingSource, sequence: number): string {
  return `${episodeId}:${source}:${sequence}`;
}

async function digestBlob(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${blob.size}:${blob.type}`;
}

function sortChunks(chunks: StoredChunk[]): StoredChunk[] {
  return chunks.sort((a, b) => a.source.localeCompare(b.source) || a.sequence - b.sequence);
}

function toPublicChunk(chunk: StoredChunk): RecordingChunk {
  const { key: _key, acknowledged: _acknowledged, ...publicChunk } = chunk;
  return publicChunk;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function createIndexedDbStore(dbName: string): RecordingOutboxStore {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is unavailable in this browser'));
      return;
    }
    const request = globalThis.indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EPISODES_STORE)) db.createObjectStore(EPISODES_STORE, { keyPath: 'episodeId' });
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) db.createObjectStore(CHUNKS_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB outbox'));
  });

  return {
    async getEpisode(episodeId) {
      const db = await open();
      const transaction = db.transaction(EPISODES_STORE, 'readonly');
      return requestResult(transaction.objectStore(EPISODES_STORE).get(episodeId));
    },
    async putEpisode(episode) {
      const db = await open();
      const transaction = db.transaction(EPISODES_STORE, 'readwrite');
      transaction.objectStore(EPISODES_STORE).put(episode);
      await transactionDone(transaction);
    },
    async listChunks(episodeId) {
      const db = await open();
      const transaction = db.transaction(CHUNKS_STORE, 'readonly');
      const chunks = await requestResult(transaction.objectStore(CHUNKS_STORE).getAll());
      return chunks.filter((chunk) => chunk.episodeId === episodeId);
    },
    async putChunk(chunk) {
      const db = await open();
      const transaction = db.transaction(CHUNKS_STORE, 'readwrite');
      transaction.objectStore(CHUNKS_STORE).put(chunk);
      await transactionDone(transaction);
    },
    async deleteChunk(key) {
      const db = await open();
      const transaction = db.transaction(CHUNKS_STORE, 'readwrite');
      transaction.objectStore(CHUNKS_STORE).delete(key);
      await transactionDone(transaction);
    },
  };
}

export function createMemoryOutboxStore(): RecordingOutboxStore {
  const episodes = new Map<string, StoredEpisode>();
  const chunks = new Map<string, StoredChunk>();
  return {
    async getEpisode(episodeId) { return episodes.get(episodeId); },
    async putEpisode(episode) { episodes.set(episode.episodeId, episode); },
    async listChunks(episodeId) { return [...chunks.values()].filter((chunk) => chunk.episodeId === episodeId); },
    async putChunk(chunk) { if (!chunks.has(chunk.key)) chunks.set(chunk.key, chunk); },
    async deleteChunk(key) { chunks.delete(key); },
  };
}

export async function createRecordingOutbox(options: CreateRecordingOutboxOptions = {}): Promise<RecordingOutbox> {
  const episodeId = options.episodeId || makeEpisodeId();
  const retention = options.retention || 'until-ack';
  const store = options.store || createIndexedDbStore(options.dbName || 'jerry-recording-outbox-v1');
  const existing = await store.getEpisode(episodeId);
  if (!existing) await store.putEpisode({ episodeId, createdAt: new Date().toISOString() });

  return {
    episodeId,
    async appendChunk({ source, sequence, blob }) {
      if (!Number.isInteger(sequence) || sequence < 0) throw new Error('Chunk sequence must be a non-negative integer');
      if (!(blob instanceof Blob) || blob.size === 0) throw new Error('Recording chunk must be a non-empty Blob');
      const key = chunkKey(episodeId, source, sequence);
      const current = (await store.listChunks(episodeId)).find((chunk) => chunk.key === key);
      if (current) return toPublicChunk(current);
      const chunk: StoredChunk = {
        key,
        episodeId,
        source,
        sequence,
        blob,
        sha256: await digestBlob(blob),
        byteLength: blob.size,
        createdAt: new Date().toISOString(),
      };
      await store.putChunk(chunk);
      return toPublicChunk(chunk);
    },
    async listChunks(source) {
      const chunks = sortChunks(await store.listChunks(episodeId));
      return chunks.filter((chunk) => !source || chunk.source === source).map(toPublicChunk);
    },
    async saveSnapshot(snapshot) {
      const current = (await store.getEpisode(episodeId)) || { episodeId, createdAt: new Date().toISOString() };
      await store.putEpisode({ ...current, snapshot: { ...snapshot, timeline: [...snapshot.timeline] } });
    },
    async getSnapshot() {
      const current = await store.getEpisode(episodeId);
      if (!current?.snapshot) throw new Error('Recording snapshot is not available');
      return current.snapshot;
    },
    async resumeUploads(uploadChunk) {
      const pending = sortChunks(await store.listChunks(episodeId)).filter((chunk) => !chunk.acknowledged);
      let uploaded = 0;
      for (const chunk of pending) {
        const ack = await uploadChunk(toPublicChunk(chunk));
        if (!ack?.acknowledged) throw new Error(`Chunk ${chunk.source}:${chunk.sequence} was not acknowledged`);
        if (ack.sha256 && ack.sha256 !== chunk.sha256) throw new Error(`Chunk ${chunk.source}:${chunk.sequence} checksum mismatch`);
        uploaded += 1;
        if (retention === 'retain') {
          await store.putChunk({ ...chunk, acknowledged: true });
        } else {
          await store.deleteChunk(chunk.key);
        }
      }
      return uploaded;
    },
  };
}
