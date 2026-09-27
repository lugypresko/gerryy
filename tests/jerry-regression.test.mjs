import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync('server.ts', 'utf8');
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('src/index.css', 'utf8');

test('fallback TTS is explicitly Hebrew and strips stage tags', () => {
  assert.match(server, /languageCode:\s*'he-IL'/);
  assert.match(server, /const ttsText = replyText\.replace\(\/<\[\^>\]\+>\/g, ''\)\.trim\(\);/);
  assert.doesNotMatch(server, /replyText\s*=\s*'<sigh>/);
});

test('final STT transcript commits the guest turn; 180ms race is gone', () => {
  assert.match(
    studio,
    /if \(msg\.type === 'input-transcript' && msg\.text\)[\s\S]{0,300}commitLiveUserTurn\(\);/,
  );
  assert.doesNotMatch(studio, /setTimeout\(commitLiveUserTurn,\s*180\)/);
});

test('fallback history does not duplicate the current user message', () => {
  assert.match(studio, /const serverHistory = messages\.map\(/);
  assert.doesNotMatch(studio, /const serverHistory = newHistory\.map\(/);
  assert.match(server, /contents\.push\(\{\s*role: 'user',[\s\S]*userMessage\.trim\(\)/);
});

test('Live reconnect restores completed conversation from first guest turn', () => {
  assert.match(studio, /const firstUserIndex = history\.findIndex\(\(m\) => m\.sender === 'user'\)/);
  assert.match(studio, /type: 'restore-history'/);
  assert.match(server, /msg\.type === 'restore-history'/);
  assert.match(server, /turnComplete:\s*false/);
});

test('dedicated Hebrew transcription path is present', () => {
  assert.match(server, /model:\s*'gemini-3\.5-transcribe-live'/);
  assert.match(server, /languageCodes:\s*\['he-IL'\]/);
  assert.match(server, /mode:\s*'VERBATIM'/);
  assert.match(server, /customVocabulary:/);
  assert.match(server, /type:\s*'stt-error'/);
});

test('Gemini Live output PCM is resampled to the browser AudioContext rate', () => {
  assert.match(studio, /sourceRateMatch = \/rate=\(\\d\+\)\/i\.exec/);
  assert.match(studio, /const targetRate = ctx\?\.sampleRate \|\| sourceRate/);
  assert.match(studio, /const ratio = targetRate \/ sourceRate/);
  assert.match(studio, /playLivePcmChunk\(msg\.data, msg\.mimeType/);
});

test('Jerry audio sources are mutually exclusive', () => {
  assert.match(
    studio,
    /if \(audioPlayerRef\.current && !audioPlayerRef\.current\.paused\)[\s\S]{0,180}audioPlayerRef\.current\.pause\(\)/,
  );
  assert.match(studio, /livePlaybackQueueRef\.current = \[\]/);
});

test('HTTP fallback retains full history instead of slicing to eight turns', () => {
  assert.doesNotMatch(studio, /history:\s*serverHistory\.slice\(-8\)/);
  assert.match(studio, /history:\s*serverHistory/);
});

test('known Hebrew UI debt remains visible so it cannot be mistaken for fixed', () => {
  assert.match(index, /<html lang="en">/);
  assert.match(css, /font-family:\s*'Inter',\s*'Assistant'/);
});


test('M1 performance runtime teaches vocal backchannels and timing', () => {
  assert.match(server, /ביצוע קולי — זה חלק מהשיחה, לא קישוט/);
  assert.match(server, /backchannels קוליים/);
  assert.match(server, /300–800ms של שקט/);
  assert.match(server, /אל תבצע יותר ממחווה קולית אחת/);
  assert.match(server, /jerry-conversation-v4-performance-m1/);
});
