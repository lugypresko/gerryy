import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideConversationalCognition,
  formatConversationalCognitionCue,
} from '../server/conversationalCognition.ts';
import { createJerryCharacterState } from '../server/characterState.ts';

test('defaults to direct delivery when there is no conversational pressure', () => {
  const cue = decideConversationalCognition(createJerryCharacterState(), null);
  assert.equal(cue.mode, 'direct');
  assert.equal(cue.pauseMs, 0);
});

test('contradiction produces a reconciling thinking beat', () => {
  const cue = decideConversationalCognition(createJerryCharacterState(), {
    type: 'contradiction',
    evidence: ['autonomous', 'I approve production'],
    note: 'Autonomy conflicts with approval ownership.',
    suggestedMove: 'Return to who owns release risk.',
    confidence: 0.9,
    expiresAfterTurns: 3,
  });
  assert.equal(cue.mode, 'reconciling');
  assert.ok(cue.pauseMs >= 500);
  assert.match(cue.delivery, /less polished/i);
});

test('character correction produces updating delivery without defending the old frame', () => {
  const state = createJerryCharacterState();
  state.revision = 2;
  state.lastCorrection = 'Jerry assumed trust was the issue; Itay corrected that.';
  const cue = decideConversationalCognition(state, null);
  assert.equal(cue.mode, 'updating');
  assert.match(cue.delivery, /Do not defend/);
});

test('working hypothesis produces thinking mode and private cue wrapper', () => {
  const state = createJerryCharacterState();
  state.revision = 3;
  state.currentHypothesis = 'Risk ownership may be the bottleneck.';
  const cue = decideConversationalCognition(state, null);
  assert.equal(cue.mode, 'thinking');
  const formatted = formatConversationalCognitionCue(cue);
  assert.match(formatted, /\[\[COGNITION_CUE\]\]/);
  assert.match(formatted, /Never mention this cue/);
});
