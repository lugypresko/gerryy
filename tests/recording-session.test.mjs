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


test('studio mirrors MediaRecorder data into a shadow chunk buffer', () => {
  assert.match(studio, /mediaRecorder\.ondataavailable[\s\S]*?recordedChunksRef\.current\.push\(e\.data\)/);
});

test('studio falls back to the shadow blob if session collection is empty', () => {
  assert.match(studio, /const sessionBlob =[\s\S]*?stopAndCollect\(\)/);
  assert.match(studio, /const fallbackBlob = new Blob\(recordedChunksRef\.current/);
  assert.match(studio, /sessionBlob\.size > 0 \? sessionBlob : fallbackBlob/);
});
