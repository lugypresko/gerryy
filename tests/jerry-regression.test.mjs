import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync('server.ts', 'utf8');
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
const animation = fs.readFileSync('src/jerryAnimation.ts', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('src/index.css', 'utf8');

test('fallback TTS is explicitly Hebrew and strips stage tags', () => {
  assert.match(server, /languageCode:\s*'he-IL'/);
  assert.match(server, /const ttsText = replyText\.replace\(\/<\[\^>\]\+>\/g, ''\)\.trim\(\);/);
  assert.doesNotMatch(server, /replyText\s*=\s*'<sigh>/);
});

test('recordings persist raw and processed artifacts before the browser can lose the Blob', () => {
  assert.match(server, /app\.post\('\/api\/recordings\/artifact'/);
  assert.match(server, /RECORDINGS_DIR/);
  assert.match(studio, /persistRecordingArtifact\(recordingId, 'raw'/);
  assert.match(studio, /persistRecordingArtifact\(recordingId, 'processed'/);
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

test('authoritative guest transcript is finalized from the complete turn audio', () => {
  assert.match(server, /guestPcmChunks/);
  assert.match(server, /Buffer\.from\(msg\.data,\s*'base64'\)/);
  assert.match(server, /gemini-3\.5-transcribe/);
  assert.match(server, /generateContent\(/);
  assert.match(server, /audioTranscriptionConfig/);
  assert.match(server, /mimeType:\s*'audio\/wav'/);
  assert.match(server, /transcribeGuestTurn/);
});

test('live STT is interim-only and authoritative text is what reaches Jerry', () => {
  assert.match(server, /input-transcript-interim/);
  assert.match(server, /transcribeGuestTurn\(aiClient,\s*completedTurnChunks\)/);
  assert.match(server, /finalTranscript[\s\S]{0,500}sendClientContent\(/);
  assert.doesNotMatch(
    server,
    /const transcript = finalText\.trim\(\);[\s\S]{0,260}sendClientContent\(/,
  );
});

test('transcription service failure keeps a live candidate fallback', () => {
  assert.match(server, /lastLiveFinalCandidate/);
  assert.match(server, /authoritativeTranscript \|\| lastLiveFinalCandidate/);
});

test('authoritative transcription keeps the Gemini client in WebSocket handler scope', () => {
  assert.match(server, /let aiClient:\s*GoogleGenAI \| null = null/);
  assert.match(server, /aiClient = new GoogleGenAI\(\{ apiKey: key \}\)/);
  assert.match(server, /transcribeGuestTurn\(aiClient,\s*completedTurnChunks\)/);
});

test('Jerry debug monitor records the complete live turn chain', () => {
  assert.match(server, /\/api\/jerry-debug/);
  assert.match(server, /JERRY_DEBUG_MAX_EVENTS/);
  assert.match(server, /connectionId/);
  assert.match(server, /turnId/);
  assert.match(server, /authoritative-start/);
  assert.match(server, /guest-transcript-forwarded/);
  assert.match(server, /jerry-audio/);
  assert.match(server, /jerry-turn-complete/);
});

test('authoritative STT cannot hang silently and reports an explicit timeout', () => {
  assert.match(server, /transcription-timeout/);
  assert.match(server, /authoritative-timeout/);
  assert.match(server, /turn-aborted-no-transcript/);
  assert.match(server, /stt-error/);
});

test('debug monitor accepts client-side voice, noise, animation, and recording telemetry', () => {
  assert.match(server, /msg\.type === 'debug-event'/);
  assert.match(server, /client-debug/);
  assert.match(studio, /sendDebugEvent/);
  assert.match(studio, /'mic'/);
  assert.match(studio, /'pcm'/);
  assert.match(studio, /'recording'/);
  assert.match(studio, /'animation'/);
  assert.match(studio, /'video'/);
  assert.match(studio, /'noise'/);
  assert.match(studio, /'stt'/);
});

test('recording-levels telemetry is documented as bounded metadata', () => {
  assert.match(studio, /RECORDING_LEVELS_INTERVAL_MS/);
  assert.match(studio, /recording-levels/);
  assert.match(fs.readFileSync('docs/JERRY_DEBUG_MONITOR.md', 'utf8'), /recording-levels/);
  assert.match(fs.readFileSync('docs/JERRY_DEBUG_MONITOR.md', 'utf8'), /bounded|truncated/i);
});

test('invalid debug/socket payloads are observable instead of uncaught JSON noise', () => {
  assert.match(server, /socket-invalid-message/);
  assert.match(server, /rawText === 'undefined'/);
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

test('Jerry studio renders the locked full-frame pose manifest with crossfade and anchors', () => {
  assert.match(studio, /JERRY_POSES/);
  assert.match(studio, /Object\.keys\(JERRY_POSES\)/);
  assert.match(studio, /JERRY_MOUTH_ANCHORS/);
  assert.match(studio, /JERRY_POSE_CROSSFADE_MS/);
  assert.match(studio, /poseForState\(animationState\)/);
  assert.match(animation, /idle: '\/jerry-pose-idle\.jpg'/);
  assert.match(animation, /speaking: '\/jerry-pose-speaking\.jpg'/);
  assert.match(animation, /skeptical: '\/jerry-pose-skeptical\.jpg'/);
  assert.match(animation, /amused: '\/jerry-pose-amused\.jpg'/);
  assert.match(studio, /opacity:\s*activePose\s*===\s*pose\s*\?\s*1\s*:\s*0/);
  assert.match(studio, /transition:\s*`opacity \$\{JERRY_POSE_CROSSFADE_MS\}ms/);
  assert.match(studio, /JERRY_MOUTH_ANCHORS\[activePose\]/);
  assert.doesNotMatch(studio, /jerry-pose-[abcd]\.jpg/);
  assert.doesNotMatch(studio, /jerry-head\.png/);
  assert.match(studio, /preload|new Image\(\)/);
  assert.match(studio, /onError=[\s\S]{0,180}JERRY_POSES\.idle/);
});

test('Jerry animation state follows live interaction events instead of a fixed script', () => {
  assert.match(studio, /transitionAnimation\('mic-start'\)/);
  assert.match(studio, /setAnimationState\('thinking'\)/);
  assert.match(studio, /transitionAnimation\('output-audio'\)/);
  assert.match(studio, /transitionAnimation\('turn-complete'\)/);
  assert.match(studio, /audio-energy/);
  assert.match(studio, /response-amused/);
  assert.match(studio, /lastEnergyTransitionRef/);
});

test('Live and recording lifecycle cleanup is explicit and mute silences current playback', () => {
  assert.match(studio, /getUserMediaRequestRef/);
  assert.match(studio, /requestId !== getUserMediaRequestRef\.current/);
  assert.match(studio, /mediaRecorderRef\.current\?\.stop\(\)/);
  assert.match(studio, /liveMicProcessorRef\.current\?\.disconnect\(\)/);
  assert.match(studio, /URL\.revokeObjectURL\(pcmDebugAudioUrl\)/);
  assert.match(studio, /liveQueuedSamplesRef\.current = 0/);
  assert.match(studio, /jerryPlaybackGainRef\.current\.gain\.value = isMuted/);
  assert.doesNotMatch(studio, /liveSocketRef\.current\?\.(close|send).*isMuted/);
});

test('Jerry studio integrates independent recording chains and a centered monitor mix', () => {
  assert.match(studio, /createRecordingGraph\(/);
  assert.match(studio, /recordingGraphRef/);
  assert.match(studio, /jerry:\s*jerryRecordingInputRef\.current/);
  assert.match(studio, /guest:\s*guestSource/);
  assert.match(studio, /(?:recordingGraphRef\.current|graph)\.destination\.stream/);
  assert.match(studio, /recordingMonitorMixRef/);
  assert.match(studio, /recordingGraphRef\.current\?\.update\(/);
  assert.match(studio, /liveMicStreamRef\.current/);
});

test('episode recording finalizes before exposing a download', () => {
  assert.match(studio, /import \{ finalizeEpisode/);
  assert.match(studio, /setRecordingNotice\('.*מעבד|Finalizing/);
  assert.match(studio, /finalizedEpisode\?\.publicationStatus !== 'failed'/);
  assert.match(studio, /recording-finalized/);
});

test('HTTP fallback retains full history instead of slicing to eight turns', () => {
  assert.doesNotMatch(studio, /history:\s*serverHistory\.slice\(-8\)/);
  assert.match(studio, /history:\s*serverHistory/);
});

test('known Hebrew UI debt remains visible so it cannot be mistaken for fixed', () => {
  assert.match(index, /<html lang="en">/);
  assert.match(css, /font-family:\s*'Assistant',\s*'Inter'/);
});
