import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RecordingAssetManifest {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface RecordingArchiveManifest {
  id: string;
  createdAt: string;
  status: 'ready' | 'review' | 'failed';
  assets: Record<string, RecordingAssetManifest>;
  metadata: Record<string, unknown>;
}

export interface RecordingArchiveInput {
  master: Buffer;
  jerry?: Buffer;
  guest?: Buffer;
  conversation?: Buffer;
  metadata?: Record<string, unknown>;
  status?: 'ready' | 'review' | 'failed';
  mimeTypes?: Partial<Record<'master' | 'jerry' | 'guest' | 'conversation', string>>;
}

const ASSET_NAMES = ['master', 'jerry', 'guest', 'conversation'] as const;
type AssetName = (typeof ASSET_NAMES)[number];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertArchiveId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid archive id');
}

function assertAssetName(asset: string): asserts asset is AssetName {
  if (!ASSET_NAMES.includes(asset as AssetName)) throw new Error('Invalid archive asset');
}

async function writeExclusive(filePath: string, content: string | Buffer): Promise<void> {
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

export class RecordingArchiveStore {
  constructor(private readonly rootDir: string) {}

  async createArchive(input: RecordingArchiveInput): Promise<RecordingArchiveManifest> {
    if (!Buffer.isBuffer(input.master) || input.master.length === 0) {
      throw new Error('Master recording is required');
    }

    const buffers: Partial<Record<AssetName, Buffer>> = {
      master: input.master,
      ...(input.jerry ? { jerry: input.jerry } : {}),
      ...(input.guest ? { guest: input.guest } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
    };
    const metadata = input.metadata || {};
    const digests = Object.fromEntries(
      ASSET_NAMES.filter((name) => buffers[name]).map((name) => [name, sha256(buffers[name] as Buffer)]),
    );
    const id = sha256(Buffer.from(stableJson({ digests, metadata })));
    const archiveDir = path.join(this.rootDir, id);
    await fs.mkdir(this.rootDir, { recursive: true });

    try {
      await fs.mkdir(archiveDir);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      return this.getArchive(id);
    }

    const assets: Record<string, RecordingAssetManifest> = {};
    try {
      for (const name of ASSET_NAMES) {
        const buffer = buffers[name];
        if (!buffer) continue;
        const fileName = name === 'conversation' ? 'conversation.json' : `${name}.webm`;
        const mimeType = input.mimeTypes?.[name] || (name === 'conversation' ? 'application/json' : 'audio/webm');
        await writeExclusive(path.join(archiveDir, fileName), buffer);
        assets[name] = { fileName, mimeType, size: buffer.length, sha256: sha256(buffer) };
      }
      const manifest: RecordingArchiveManifest = {
        id,
        createdAt: new Date().toISOString(),
        status: input.status || 'ready',
        assets,
        metadata,
      };
      await writeExclusive(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      return manifest;
    } catch (error) {
      // A failed archive is never made visible as a valid archive: its manifest
      // is the commit marker and readers require it before serving assets.
      throw error;
    }
  }

  async listArchives(): Promise<RecordingArchiveManifest[]> {
    try {
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
      const archives = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
          .map(async (entry) => {
            try {
              return await this.getArchive(entry.name);
            } catch {
              return null;
            }
          }),
      );
      return archives
        .filter((archive): archive is RecordingArchiveManifest => archive !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async getArchive(id: string): Promise<RecordingArchiveManifest> {
    assertArchiveId(id);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(this.rootDir, id, 'manifest.json'), 'utf8'));
      if (manifest?.id !== id || !manifest.assets) throw new Error('Invalid archive manifest');
      const status = manifest.status === 'review' || manifest.status === 'failed' ? manifest.status : 'ready';
      return { ...manifest, status } as RecordingArchiveManifest;
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error('Archive not found');
      throw error;
    }
  }

  async getAsset(id: string, asset: string): Promise<{ data: Buffer; manifest: RecordingAssetManifest }> {
    assertAssetName(asset);
    const archive = await this.getArchive(id);
    const manifest = archive.assets[asset];
    if (!manifest) throw new Error('Archive asset not found');
    const data = await fs.readFile(path.join(this.rootDir, id, manifest.fileName));
    if (sha256(data) !== manifest.sha256) throw new Error('Archive integrity check failed');
    return { data, manifest };
  }
}
