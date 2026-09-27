import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync('server.ts', 'utf8');
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
const turnLog = fs.readFileSync('src/audio/turnLog.ts', 'utf8');
const animation = fs.readFileSync('src/jerryAnimation.ts', 'utf8');
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

test('guest speech interruption has explicit start/end telemetry and cancels Jerry generation', () => {
  assert.match(studio, /guest-interruption-start/);
  assert.match(studio, /guest-interruption-end/);
  assert.match(studio, /jerry-generation-cancelled/);
  assert.match(studio, /guestVadStateRef/);
  assert.match(studio, /guestSpeechRmsDbfs|rmsDbfs/);
  assert.match(studio, /send\(JSON\.stringify\(\{\s*type:\s*'debug-event'/);
  assert.match(studio, /livePlaybackQueueRef\.current\s*=\s*\[\]/);
  assert.match(studio, /liveSocketRef\.current\.send\(JSON\.stringify\(\{\s*type:\s*'activity-start'/);
});

test('guest interruption records overlap duration without stopping recording paths', () => {
  assert.match(turnLog, /export (?:function|const) startGuestInterruption/);
  assert.match(turnLog, /export (?:function|const) endGuestInterruption/);
  assert.match(turnLog, /overlapDurationMs/);
  assert.match(studio, /appendGuestInterruption|startGuestInterruption/);
  assert.match(studio, /endGuestInterruption/);
  assert.doesNotMatch(studio, /jerry-generation-cancelled[\s\S]{0,500}cleanupRecordingGraph\(\)/);
  assert.doesNotMatch(studio, /guest-interruption-start[\s\S]{0,500}stopMicTracks\(\)/);
});

test('interruption entries are additive and preserve existing conversation turns', () => {
  assert.match(turnLog, /export interface ConversationTurn/);
  assert.match(turnLog, /export type TurnLogEntry = ConversationTurn \| GuestInterruptionTurn/);
  assert.match(turnLog, /export function appendGuestInterruption\(\s*entries: TurnLogEntry\[\]/);
  assert.match(turnLog, /return \[\.\.\.entries, interruption\]/);
  assert.match(studio, /turnLogRef = useRef<TurnLogEntry\[\]>\(\[\]\)/);
  assert.match(studio, /appendGuestInterruption\(/);
});

test('guest speech state is tracked independently from interruption state', () => {
  assert.match(studio, /updateGuestVad\(guestVadStateRef\.current/);
  assert.match(studio, /guestInterruptionTurnRef\.current && vadTransition\.ended/);
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
  assert.match(studio, /recordingGraphRef\.current\.destination\.stream/);
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
