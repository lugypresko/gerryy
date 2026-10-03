import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = fs.readFileSync('server/recordingStore.ts', 'utf8');
const server = fs.readFileSync('server.ts', 'utf8');
const envExample = fs.readFileSync('.env.example', 'utf8');
const gitignore = fs.readFileSync('.gitignore', 'utf8');

test('recording store exposes an append-only immutable archive contract', () => {
  assert.match(store, /export class RecordingArchiveStore/);
  assert.match(store, /export interface RecordingArchiveManifest/);
  assert.match(store, /sha256/);
  assert.match(store, /fs\.open\(filePath, 'wx'\)/);
  assert.match(store, /manifest\.json/);
  assert.match(store, /if \(manifest\?\.id !== id \|\| !manifest\.assets\)/);
  assert.doesNotMatch(store, /fs\.rm|fs\.unlink/);
});

test('recording store is idempotent for identical content and verifies asset integrity', () => {
  assert.match(store, /const id = sha256\(Buffer\.from\(stableJson\(\{ digests, metadata \}\)\)\)/);
  assert.match(store, /return this\.getArchive\(id\)/);
  assert.match(store, /if \(sha256\(data\) !== manifest\.sha256\) throw new Error\('Archive integrity check failed'\)/);
  assert.match(store, /assertArchiveId\(id\)/);
  assert.match(store, /assertAssetName\(asset\)/);
});

test('server exposes create and read-only recording archive routes', () => {
  assert.match(server, /RecordingArchiveStore/);
  assert.match(server, /app\.post\(['"]\/api\/recordings['"]/);
  assert.match(server, /masterBase64/);
  assert.match(server, /app\.get\(['"]\/api\/recordings\/:archiveId['"]/);
  assert.match(server, /app\.get\(['"]\/api\/recordings\/:archiveId\/:asset['"]/);
  assert.doesNotMatch(server, /app\.(?:put|patch|delete)\(['"]\/api\/recordings/);
});

test('recording archive storage is configured outside the repository', () => {
  assert.match(envExample, /JERRY_RECORDINGS_DIR=/);
  assert.match(gitignore, /data\/recordings\//);
  assert.match(server, /process\.env\.JERRY_RECORDINGS_DIR/);
});


test('studio publishes finalized recordings into the persistent archive library', () => {
  const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
  assert.match(studio, /persistRecordingArchive/);
  assert.match(studio, /fetch\(['"]\/api\/recordings['"]/);
  assert.match(studio, /publicationStatus === 'publishable'[\s\S]*?'ready'/);
  assert.match(studio, /publicationStatus === 'needs-review'[\s\S]*?'review'/);
  assert.match(studio, /recording-archive-persisted/);
});

test('recording outbox and canonical capture share the same episode id', () => {
  const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
  assert.match(studio, /const episodeId = `episode-/);
  assert.match(studio, /createRecordingOutbox\(\{ episodeId: episodeIdRef\.current \|\| undefined \}\)/);
  assert.match(studio, /type: 'recording-start',[\s\S]*?recordingId: episodeId/);
});
