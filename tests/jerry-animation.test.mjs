import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(path.join(root, 'src', 'jerryAnimation.ts')).href;

function loadAnimationModule() {
  const script = `
    import * as animation from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify({
      poses: animation.JERRY_POSES,
      anchors: animation.JERRY_MOUTH_ANCHORS,
      crossfadeMs: animation.JERRY_POSE_CROSSFADE_MS,
      mapped: Object.fromEntries(['idle', 'listening', 'thinking', 'speaking', 'emphasis', 'amused', 'skeptical'].map((state) => [state, animation.poseForState(state)])),
      transitions: [
        ['mic-start', 'listening'],
        ['output-audio', 'speaking'],
        ['turn-complete', 'idle'],
        ['live-disconnect', 'idle'],
      ].map(([event, state]) => animation.nextAnimationState(state, event)),
      disconnectedSpeaking: animation.nextAnimationState('speaking', 'live-disconnect'),
      unknownFromIdle: animation.nextAnimationState('idle', 'unknown-event'),
    }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('locks the four full-frame Jerry pose assets and mouth anchors', () => {
  const animation = loadAnimationModule();

  assert.deepEqual(animation.poses, {
    idle: '/jerry-pose-idle.jpg',
    speaking: '/jerry-pose-speaking.jpg',
    skeptical: '/jerry-pose-skeptical.jpg',
    amused: '/jerry-pose-amused.jpg',
  });
  assert.deepEqual(Object.keys(animation.anchors).sort(), ['amused', 'idle', 'skeptical', 'speaking']);
  for (const anchor of Object.values(animation.anchors)) {
    assert.deepEqual(anchor, { x: 55.2, y: 75.5, width: 17.5 });
  }
});

test('maps conversation and reaction states to the locked poses', () => {
  const { mapped } = loadAnimationModule();

  assert.deepEqual(mapped, {
    idle: 'idle',
    listening: 'idle',
    thinking: 'skeptical',
    speaking: 'speaking',
    emphasis: 'speaking',
    amused: 'amused',
    skeptical: 'skeptical',
  });
});

test('uses a short crossfade and safe state transitions', () => {
  const animation = loadAnimationModule();

  assert.ok(animation.crossfadeMs >= 120 && animation.crossfadeMs <= 160);
  assert.deepEqual(animation.transitions, ['listening', 'speaking', 'idle', 'idle']);
  assert.equal(animation.disconnectedSpeaking, 'idle');
  assert.equal(animation.unknownFromIdle, 'idle');
});
