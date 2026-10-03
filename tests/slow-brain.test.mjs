import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SlowBrainObserver,
  buildSlowBrainPrompt,
  formatSlowBrainNote,
  parseSlowBrainObservation,
} from '../server/slowBrain.ts';

test('parses a valid observation', () => {
  const parsed = parseSlowBrainObservation(JSON.stringify({
    type: 'contradiction',
    evidence: ['team is autonomous', 'I approve production'],
    note: 'Autonomy claim and approval ownership are in tension.',
    suggestedMove: 'Ask who can ship without approval.',
    confidence: 0.87,
    expiresAfterTurns: 3,
  }));

  assert.equal(parsed?.type, 'contradiction');
  assert.equal(parsed?.confidence, 0.87);
  assert.equal(parsed?.evidence.length, 2);
});

test('NO_SIGNAL and malformed output produce null', () => {
  assert.equal(parseSlowBrainObservation('{"signal":"NO_SIGNAL"}'), null);
  assert.equal(parseSlowBrainObservation('not json'), null);
});

test('prompt asks for evidence rather than motive', () => {
  const prompt = buildSlowBrainPrompt([
    { speaker: 'human', text: 'הצוות autonomous', turnId: 1, atMs: 1000 },
    { speaker: 'human', text: 'אני מאשר production', turnId: 2, atMs: 5000 },
  ]);
  assert.match(prompt, /Evidence first/);
  assert.match(prompt, /Never infer motive/);
  assert.match(prompt, /הצוות autonomous/);
});

test('observer is non-blocking and observation is consumed once', async () => {
  let resolveAnalysis;
  const observer = new SlowBrainObserver({
    minIntervalMs: 0,
    analyze: () => new Promise((resolve) => { resolveAnalysis = resolve; }),
  });

  observer.addTurn({ speaker: 'human', text: 'a', turnId: 1, atMs: 1000 });
  observer.addTurn({ speaker: 'jerry', text: 'b', turnId: 1, atMs: 2000 });

  const pending = observer.kick(3000);
  assert.equal(observer.consume(), null);

  resolveAnalysis({
    type: 'callback',
    evidence: ['a'],
    note: 'Earlier detail is relevant again.',
    suggestedMove: 'Return to it briefly.',
    confidence: 0.9,
    expiresAfterTurns: 3,
  });
  await pending;

  assert.equal(observer.consume()?.type, 'callback');
  assert.equal(observer.consume(), null);
});

test('formatted note is explicitly private context', () => {
  const note = formatSlowBrainNote({
    type: 'ownership_gap',
    evidence: ['"הצוות החליט"'],
    note: 'No individual owner was named.',
    suggestedMove: 'Ask who said yes.',
    confidence: 0.8,
    expiresAfterTurns: 2,
  });
  assert.match(note, /\[\[SLOW_BRAIN_NOTE\]\]/);
  assert.match(note, /Do not mention this note/);
});


test('parses a bounded character state update when directly supported', () => {
  const parsed = parseSlowBrainObservation(JSON.stringify({
    type: 'contradiction',
    evidence: ['team is autonomous', 'I approve production'],
    note: 'Autonomy and approval ownership are in tension.',
    suggestedMove: 'Return to who owns release risk.',
    confidence: 0.91,
    expiresAfterTurns: 3,
    stateUpdate: {
      currentHypothesis: 'Risk ownership may not have moved with autonomy.',
      unresolvedCuriosity: 'Who owns the consequences of a bad release?',
      callbackCandidate: 'autonomy vs approval',
    },
  }));

  assert.equal(parsed?.stateUpdate?.currentHypothesis, 'Risk ownership may not have moved with autonomy.');
  assert.equal(parsed?.stateUpdate?.unresolvedCuriosity, 'Who owns the consequences of a bad release?');
  assert.equal(parsed?.stateUpdate?.callbackCandidate, 'autonomy vs approval');
});

test('slow brain prompt treats state as working continuity, not guest profiling', () => {
  const prompt = buildSlowBrainPrompt([
    { speaker: 'human', text: 'הצוות autonomous', turnId: 1, atMs: 1000 },
    { speaker: 'jerry', text: 'מי מאשר production?', turnId: 1, atMs: 2000 },
  ]);
  assert.match(prompt, /working continuity/);
  assert.match(prompt, /Never infer personality, motive, diagnosis, or private facts/);
  assert.match(prompt, /stateUpdate/);
});
