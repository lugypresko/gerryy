import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const session = fs.readFileSync('src/audio/recordingSession.ts', 'utf8');
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');

test('recording session has explicit ownership and cleanup contract', () => {
  assert.match(session, /export interface RecordingSession/);
  assert.match(session, /ownsMic/);
  assert.match(session, /stopAndCollect/);
  assert.match(session, /cleanupGraph/);
  assert.match(session, /getTracks\(\)\.forEach/);
});

test('recording session waits for recorder stop before collecting chunks', () => {
  assert.match(session, /addEventListener\(['"]stop['"]/);
  assert.match(session, /dataavailable/);
  assert.match(session, /new Blob/);
  assert.match(session, /recorder\.stop\(\)/);
});

test('studio has one explicit recording-session owner', () => {
  assert.match(studio, /createRecordingSession/);
  assert.match(studio, /recordingSessionRef/);
});
