import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JerryCharacterState,
  createJerryCharacterState,
  formatJerryCharacterState,
} from '../server/characterState.ts';

test('character state starts empty and increments revision on meaningful updates', () => {
  const initial = createJerryCharacterState();
  assert.equal(initial.revision, 0);
  assert.equal(initial.currentHypothesis, null);

  const state = new JerryCharacterState();
  assert.equal(state.hasContent(), false);
  const next = state.apply({
    currentHypothesis: 'Risk ownership may be the bottleneck.',
    unresolvedCuriosity: 'Who owns the consequences of a bad release?',
    callbackCandidate: 'autonomy vs approval',
  });

  assert.equal(next.revision, 1);
  assert.equal(state.hasContent(), true);
  assert.equal(next.currentHypothesis, 'Risk ownership may be the bottleneck.');
  assert.deepEqual(next.unresolvedCuriosities, ['Who owns the consequences of a bad release?']);
});

test('character state remains bounded and deduplicates repeated continuity', () => {
  const state = new JerryCharacterState();
  state.apply({ belief: 'A', callbackCandidate: 'same detail' });
  state.apply({ belief: 'A', callbackCandidate: 'same detail' });
  for (let i = 0; i < 10; i++) state.apply({ belief: `belief-${i}`, callbackCandidate: `callback-${i}` });

  const snapshot = state.snapshot();
  assert.equal(snapshot.beliefs.length, 6);
  assert.equal(snapshot.callbackCandidates.length, 5);
  assert.equal(snapshot.callbackCandidates.at(-1), 'callback-9');
});

test('state supports resolving curiosities and clearing callbacks', () => {
  const state = new JerryCharacterState();
  state.apply({ unresolvedCuriosity: 'Who approves production?', callbackCandidate: 'release approval' });
  state.apply({ resolvedCuriosity: 'Who approves production?', clearCallback: 'release approval' });

  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.unresolvedCuriosities, []);
  assert.deepEqual(snapshot.callbackCandidates, []);
});

test('formatted state is private continuity rather than a script', () => {
  const state = new JerryCharacterState();
  const snapshot = state.apply({
    lastCorrection: 'Jerry assumed trust was the issue; Itay corrected that.',
    emotionalStance: 'curious and less certain',
  });
  const formatted = formatJerryCharacterState(snapshot);

  assert.match(formatted, /\[\[JERRY_STATE\]\]/);
  assert.match(formatted, /Last correction:/);
  assert.match(formatted, /Current stance:/);
  assert.match(formatted, /Do not mention this state/);
});
