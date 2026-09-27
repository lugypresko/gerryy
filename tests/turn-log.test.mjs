import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();

function runTurnLogModule(expression) {
  const script = `import { appendGuestInterruption, createGuestVadState, endGuestInterruption, updateGuestVad } from './src/audio/turnLog.ts';\nconsole.log(JSON.stringify(${expression}));`;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  }));
}

test('VAD starts only after two loud frames and ends after three quiet frames', () => {
  const result = runTurnLogModule(`(() => {
    let state = createGuestVadState();
    const transitions = [];
    for (const rms of [-40, -37, -37, -40, -40, -40]) {
      const transition = updateGuestVad(state, rms);
      state = transition.state;
      transitions.push({ started: transition.started, ended: transition.ended, active: state.speechActive });
    }
    return transitions;
  })()`);

  assert.deepEqual(result, [
    { started: false, ended: false, active: false },
    { started: false, ended: false, active: false },
    { started: true, ended: false, active: true },
    { started: false, ended: false, active: true },
    { started: false, ended: false, active: true },
    { started: false, ended: true, active: false },
  ]);
});

test('interruption turn preserves conversation entries and records overlap duration', () => {
  const result = runTurnLogModule(`(() => {
    const conversation = [{ id: 'jerry-1', speaker: 'jerry', kind: 'conversation', startedAt: 100 }];
    const withInterruption = appendGuestInterruption(conversation, 120);
    const interruption = withInterruption[1];
    return {
      originalCount: conversation.length,
      entries: withInterruption.length,
      ended: endGuestInterruption(interruption, 370),
    };
  })()`);

  assert.equal(result.originalCount, 1);
  assert.equal(result.entries, 2);
  assert.equal(result.ended.overlapDurationMs, 250);
  assert.equal(result.ended.kind, 'interruption');
});
