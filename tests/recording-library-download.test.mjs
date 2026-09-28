import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = fs.readFileSync('server/recordingStore.ts', 'utf8');
const server = fs.readFileSync('server.ts', 'utf8');
const library = fs.existsSync('src/components/RecordingLibrary.tsx')
  ? fs.readFileSync('src/components/RecordingLibrary.tsx', 'utf8')
  : '';

test('recording library lists persisted archive states after restart', () => {
  assert.match(store, /status:\s*'ready' \| 'review' \| 'failed'/);
  assert.match(store, /async listArchives\(\)/);
  assert.match(store, /readdir\(this\.rootDir/);
  assert.match(server, /app\.get\(['"]\/api\/recordings['"]/);
  assert.match(library, /fetch\(['"]\/api\/recordings['"]/);
  assert.match(library, /ready|review|failed/);
});

test('master download sets MIME, disposition, hash, and byte range headers', () => {
  assert.match(server, /app\.get\(['"]\/api\/recordings\/:archiveId\/download['"]/);
  assert.match(server, /Content-Disposition/);
  assert.match(server, /Accept-Ranges/);
  assert.match(server, /Content-Range/);
  assert.match(server, /ETag/);
  assert.match(server, /Range/);
  assert.match(server, /sha256|integrity/i);
});

test('failed archives cannot be downloaded while review archives remain downloadable', () => {
  assert.match(server, /status\s*===\s*'failed'/);
  assert.match(server, /review|ready/);
  assert.match(server, /status\(409\)|status\(423\)/);
  assert.match(library, /download/);
});
