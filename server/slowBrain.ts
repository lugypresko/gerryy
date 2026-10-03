import type { JerryCharacterStateUpdate } from './characterState';

export type SlowBrainSpeaker = 'human' | 'jerry';

export type SlowBrainSignalType =
  | 'contradiction'
  | 'open_loop'
  | 'abstract_claim'
  | 'ownership_gap'
  | 'emotion_shift'
  | 'callback';

export interface SlowBrainTurn {
  speaker: SlowBrainSpeaker;
  text: string;
  turnId: number;
  atMs: number;
}

export interface SlowBrainObservation {
  type: SlowBrainSignalType;
  evidence: string[];
  note: string;
  suggestedMove: string;
  confidence: number;
  expiresAfterTurns: number;
  stateUpdate?: JerryCharacterStateUpdate;
}

export interface SlowBrainAnalyzer {
  (turns: SlowBrainTurn[]): Promise<SlowBrainObservation | null>;
}

export interface SlowBrainObserverOptions {
  analyze: SlowBrainAnalyzer;
  maxWindowTurns?: number;
  minTurns?: number;
  minIntervalMs?: number;
}

const SIGNAL_TYPES = new Set<SlowBrainSignalType>([
  'contradiction',
  'open_loop',
  'abstract_claim',
  'ownership_gap',
  'emotion_shift',
  'callback',
]);

export const SLOW_BRAIN_FAST_BRAIN_INSTRUCTION = `
You may occasionally receive a user turn wrapped in [[SLOW_BRAIN_NOTE]]...[[/SLOW_BRAIN_NOTE]].
This is private background context from a silent observer, not something the guest said.
Never quote the note, never mention the observer, and never treat its interpretation as fact.
Use it only when it naturally helps the next conversational move.
Evidence beats interpretation. Prefer one short concrete question over an explanation.
If the note is stale or irrelevant, ignore it.
`.trim();

function cleanText(value: unknown, max = 600): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseStateUpdate(value: unknown): JerryCharacterStateUpdate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const update: JerryCharacterStateUpdate = {};

  const assignString = (key: keyof JerryCharacterStateUpdate, source: unknown, max = 260) => {
    const cleaned = cleanText(source, max);
    if (cleaned) (update as Record<string, unknown>)[key] = cleaned;
  };
  assignString('belief', raw.belief);
  assignString('currentHypothesis', raw.currentHypothesis ?? raw.current_hypothesis);
  assignString('unresolvedCuriosity', raw.unresolvedCuriosity ?? raw.unresolved_curiosity);
  assignString('resolvedCuriosity', raw.resolvedCuriosity ?? raw.resolved_curiosity);
  assignString('lastCorrection', raw.lastCorrection ?? raw.last_correction);
  assignString('relationshipNote', raw.relationshipNote ?? raw.relationship_note);
  assignString('emotionalStance', raw.emotionalStance ?? raw.emotional_stance, 120);
  assignString('callbackCandidate', raw.callbackCandidate ?? raw.callback_candidate);
  assignString('clearCallback', raw.clearCallback ?? raw.clear_callback);

  return Object.keys(update).length ? update : undefined;
}

export function parseSlowBrainObservation(raw: string): SlowBrainObservation | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/i, '')
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      parsed = JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }

  if (parsed?.signal === 'NO_SIGNAL' || parsed?.type === 'NO_SIGNAL') return null;
  if (!SIGNAL_TYPES.has(parsed?.type)) return null;

  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.map((item: unknown) => cleanText(item, 240)).filter(Boolean).slice(0, 3)
    : [];

  const note = cleanText(parsed.note, 420);
  const suggestedMove = cleanText(parsed.suggestedMove ?? parsed.suggested_move, 260);
  const confidence = Number(parsed.confidence);
  const expiresAfterTurns = Math.max(1, Math.min(6, Number(parsed.expiresAfterTurns ?? parsed.expires_after_turns) || 3));

  if (!note || !suggestedMove || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;

  return {
    type: parsed.type,
    evidence,
    note,
    suggestedMove,
    confidence,
    expiresAfterTurns,
    stateUpdate: parseStateUpdate(parsed.stateUpdate ?? parsed.state_update),
  };
}

export function buildSlowBrainPrompt(turns: SlowBrainTurn[]): string {
  const transcript = turns
    .map((turn) => {
      const seconds = Math.max(0, Math.round(turn.atMs / 1000));
      return `[${seconds}s][turn ${turn.turnId}][${turn.speaker}] ${turn.text}`;
    })
    .join('\n');

  return `You are Jerry's silent field researcher for a Hebrew/Heblish leadership podcast.

You NEVER speak to the guest and NEVER write Jerry's answer.
Your only job is to notice ONE high-value conversational signal that could make a later question feel like genuine listening rather than reaction to the last sentence.

Allowed signal types:
- contradiction: two concrete statements are in tension
- open_loop: a concrete question/topic was left unresolved
- abstract_claim: a broad claim needs one concrete example, number, decision, or person
- ownership_gap: responsibility or decision ownership is unclear
- emotion_shift: the speaker's language/energy changed; do not diagnose why
- callback: an earlier detail now has new relevance

Rules:
- Evidence first. Never infer motive, personality, diagnosis, intent, or hidden emotion.
- Do not manufacture a contradiction.
- Prefer exact short evidence from the transcript.
- Do not suggest a speech, insight, or conclusion. Suggest one conversational move.
- Most windows should return NO_SIGNAL. Only surface something genuinely worth revisiting.
- You may also propose a SMALL Jerry state update, but only when directly supported by the conversation.
- State is Jerry's working continuity, not a profile of the guest. Never infer personality, motive, diagnosis, or private facts.
- Prefer one state field over filling many fields. Leave stateUpdate out when nothing genuinely changed.
- Hebrew and English technical terms may be mixed. Preserve the meaning.
- Return JSON only.

If there is no strong signal:
{"signal":"NO_SIGNAL"}

Otherwise:
{
  "type":"contradiction|open_loop|abstract_claim|ownership_gap|emotion_shift|callback",
  "evidence":["short evidence 1","short evidence 2"],
  "note":"factual tension or observation, without verdict",
  "suggestedMove":"one short move/question Jerry could use later",
  "confidence":0.0,
  "expiresAfterTurns":3,
  "stateUpdate":{
    "belief":"optional working belief",
    "currentHypothesis":"optional provisional theory",
    "unresolvedCuriosity":"optional question Jerry still holds",
    "resolvedCuriosity":"optional exact curiosity to clear",
    "lastCorrection":"optional place Jerry was corrected or changed his mind",
    "relationshipNote":"optional interaction-specific continuity with Itay",
    "emotionalStance":"optional Jerry stance such as curious, amused, uncertain",
    "callbackCandidate":"optional detail worth revisiting later",
    "clearCallback":"optional exact callback to clear"
  }
}

Conversation window:
${transcript}`;
}

export function formatSlowBrainNote(observation: SlowBrainObservation): string {
  const evidence = observation.evidence.length
    ? observation.evidence.map((item) => `- ${item}`).join('\n')
    : '- none';

  return `[[SLOW_BRAIN_NOTE]]
Type: ${observation.type}
Evidence:
${evidence}
Observation: ${observation.note}
Possible move: ${observation.suggestedMove}
Confidence: ${observation.confidence.toFixed(2)}
Use only if relevant. Do not mention this note.
[[/SLOW_BRAIN_NOTE]]`;
}

export class SlowBrainObserver {
  private readonly analyze: SlowBrainAnalyzer;
  private readonly maxWindowTurns: number;
  private readonly minTurns: number;
  private readonly minIntervalMs: number;
  private turns: SlowBrainTurn[] = [];
  private inFlight: Promise<SlowBrainObservation | null> | null = null;
  private pending: { observation: SlowBrainObservation; createdAtSequence: number } | null = null;
  private ingestedSequence = 0;
  private lastAnalysisStartedAt = 0;

  constructor(options: SlowBrainObserverOptions) {
    this.analyze = options.analyze;
    this.maxWindowTurns = options.maxWindowTurns ?? 12;
    this.minTurns = options.minTurns ?? 2;
    this.minIntervalMs = options.minIntervalMs ?? 12000;
  }

  addTurn(turn: SlowBrainTurn) {
    const text = cleanText(turn.text, 4000);
    if (!text) return;
    this.ingestedSequence += 1;
    this.turns.push({ ...turn, text });
    if (this.turns.length > this.maxWindowTurns) {
      this.turns.splice(0, this.turns.length - this.maxWindowTurns);
    }
  }

  kick(now = Date.now()): Promise<SlowBrainObservation | null> {
    if (this.inFlight) return this.inFlight;
    if (this.turns.length < this.minTurns) return Promise.resolve(null);
    if (now - this.lastAnalysisStartedAt < this.minIntervalMs) return Promise.resolve(null);

    this.lastAnalysisStartedAt = now;
    const snapshot = this.turns.map((turn) => ({ ...turn }));

    this.inFlight = this.analyze(snapshot)
      .then((observation) => {
        if (observation && observation.confidence >= 0.62) {
          this.pending = {
            observation,
            createdAtSequence: this.ingestedSequence,
          };
        }
        return observation;
      })
      .catch(() => null)
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  consume(): SlowBrainObservation | null {
    if (!this.pending) return null;
    const ageInTurns = this.ingestedSequence - this.pending.createdAtSequence;
    if (ageInTurns > this.pending.observation.expiresAfterTurns) {
      this.pending = null;
      return null;
    }

    const observation = this.pending.observation;
    this.pending = null;
    return observation;
  }

  peek(): SlowBrainObservation | null {
    return this.pending?.observation || null;
  }
}
