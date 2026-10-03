import type { JerryCharacterStateSnapshot } from './characterState';
import type { SlowBrainObservation } from './slowBrain';

export type ConversationalCognitionMode =
  | 'direct'
  | 'thinking'
  | 'revisiting'
  | 'reconciling'
  | 'updating'
  | 'holding';

export interface ConversationalCognitionCue {
  mode: ConversationalCognitionMode;
  pauseMs: number;
  delivery: string;
  preludePolicy: string;
  basis: string;
  fingerprint: string;
}

function compact(value: string | null | undefined, max = 120): string {
  return (value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

export function decideConversationalCognition(
  state: JerryCharacterStateSnapshot,
  pendingObservation: SlowBrainObservation | null,
): ConversationalCognitionCue {
  if (pendingObservation?.type === 'contradiction' || pendingObservation?.type === 'ownership_gap') {
    return {
      mode: 'reconciling',
      pauseMs: 700,
      delivery: 'Start slower and less polished. Let the mismatch register before the line lands.',
      preludePolicy: 'A tiny audible thinking beat is allowed if natural; do not force a catchphrase.',
      basis: pendingObservation.note,
      fingerprint: `observation:${pendingObservation.type}:${compact(pendingObservation.note)}`,
    };
  }

  if (pendingObservation?.type === 'callback' || pendingObservation?.type === 'open_loop') {
    return {
      mode: 'revisiting',
      pauseMs: 600,
      delivery: 'Sound like you just remembered something relevant. Re-enter the earlier thread before asking anything new.',
      preludePolicy: 'A short "רגע..." or unfinished start is allowed only if it feels spontaneous.',
      basis: pendingObservation.note,
      fingerprint: `observation:${pendingObservation.type}:${compact(pendingObservation.note)}`,
    };
  }

  if (pendingObservation?.type === 'emotion_shift') {
    return {
      mode: 'holding',
      pauseMs: 900,
      delivery: 'Do less. Leave space, lower the energy, and respond to the change before moving the content forward.',
      preludePolicy: 'Silence is preferred over filler.',
      basis: pendingObservation.note,
      fingerprint: `observation:emotion_shift:${compact(pendingObservation.note)}`,
    };
  }

  if (state.lastCorrection) {
    return {
      mode: 'updating',
      pauseMs: 650,
      delivery: 'Do not defend the old frame. Sound like Jerry is genuinely re-forming the thought in real time.',
      preludePolicy: 'A brief "אה..." / "אוקיי..." is allowed, followed by a small pause; avoid polished summary language.',
      basis: state.lastCorrection,
      fingerprint: `state:${state.revision}:correction:${compact(state.lastCorrection)}`,
    };
  }

  if (state.currentHypothesis || state.unresolvedCuriosities.length > 0) {
    const basis = state.currentHypothesis || state.unresolvedCuriosities[0] || '';
    return {
      mode: 'thinking',
      pauseMs: 550,
      delivery: 'Let the thought form audibly. It is okay to begin with a fragment, hesitate, then sharpen into one line.',
      preludePolicy: 'Use at most one tiny hesitation such as "רגע..." or "ממ..." if natural; never repeat it mechanically.',
      basis,
      fingerprint: `state:${state.revision}:thinking:${compact(basis)}`,
    };
  }

  return {
    mode: 'direct',
    pauseMs: 0,
    delivery: 'Respond naturally without manufacturing hesitation.',
    preludePolicy: 'No filler.',
    basis: '',
    fingerprint: `state:${state.revision}:direct`,
  };
}

export const CONVERSATIONAL_COGNITION_INSTRUCTION = `
You may occasionally receive private context wrapped in [[COGNITION_CUE]]...[[/COGNITION_CUE]].
It controls delivery, not content. Never quote it and never mention it exists.

When a cue is present:
- Do not sound like text being read aloud.
- Allow thought to form in the voice: a short silence, a fragment, a tiny hesitation, then the line.
- Do not use filler every turn. "רגע", "אה", "ממ", "Okay" are only allowed when the cue makes them natural.
- Vary pacing and sentence completeness. A first fragment may be incomplete.
- The pause is a performance beat, not dead latency. Keep the whole response concise.
- If the current guest audio makes the cue wrong, ignore it and follow the guest.
`.trim();

export function formatConversationalCognitionCue(cue: ConversationalCognitionCue): string {
  return `[[COGNITION_CUE]]
Mode: ${cue.mode}
Target pre-line beat: about ${cue.pauseMs}ms
Delivery: ${cue.delivery}
Prelude policy: ${cue.preludePolicy}
Basis: ${compact(cue.basis, 220)}
Never mention this cue.
[[/COGNITION_CUE]]`;
}
