export interface JerryCharacterStateSnapshot {
  revision: number;
  beliefs: string[];
  currentHypothesis: string | null;
  unresolvedCuriosities: string[];
  lastCorrection: string | null;
  relationshipNotes: string[];
  emotionalStance: string | null;
  callbackCandidates: string[];
}

export interface JerryCharacterStateUpdate {
  belief?: string;
  currentHypothesis?: string | null;
  unresolvedCuriosity?: string;
  resolvedCuriosity?: string;
  lastCorrection?: string | null;
  relationshipNote?: string;
  emotionalStance?: string | null;
  callbackCandidate?: string;
  clearCallback?: string;
}

const MAX_BELIEFS = 6;
const MAX_CURIOSITIES = 5;
const MAX_RELATIONSHIP_NOTES = 4;
const MAX_CALLBACKS = 5;

function clean(value: unknown, max = 260): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function appendUnique(list: string[], value: string, max: number): string[] {
  const normalized = clean(value);
  if (!normalized) return list;
  const withoutDuplicate = list.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
  return [...withoutDuplicate, normalized].slice(-max);
}

function removeMatching(list: string[], value: string): string[] {
  const needle = clean(value).toLocaleLowerCase();
  if (!needle) return list;
  return list.filter((item) => item.toLocaleLowerCase() !== needle);
}

export function createJerryCharacterState(): JerryCharacterStateSnapshot {
  return {
    revision: 0,
    beliefs: [],
    currentHypothesis: null,
    unresolvedCuriosities: [],
    lastCorrection: null,
    relationshipNotes: [],
    emotionalStance: null,
    callbackCandidates: [],
  };
}

export class JerryCharacterState {
  private state: JerryCharacterStateSnapshot = createJerryCharacterState();

  apply(update: JerryCharacterStateUpdate | null | undefined): JerryCharacterStateSnapshot {
    if (!update) return this.snapshot();
    let changed = false;
    const next = this.snapshot();

    const belief = clean(update.belief);
    if (belief) {
      next.beliefs = appendUnique(next.beliefs, belief, MAX_BELIEFS);
      changed = true;
    }

    if (update.currentHypothesis !== undefined) {
      const value = update.currentHypothesis === null ? null : clean(update.currentHypothesis);
      if (value !== next.currentHypothesis) {
        next.currentHypothesis = value || null;
        changed = true;
      }
    }

    const curiosity = clean(update.unresolvedCuriosity);
    if (curiosity) {
      next.unresolvedCuriosities = appendUnique(next.unresolvedCuriosities, curiosity, MAX_CURIOSITIES);
      changed = true;
    }

    const resolvedCuriosity = clean(update.resolvedCuriosity);
    if (resolvedCuriosity) {
      const reduced = removeMatching(next.unresolvedCuriosities, resolvedCuriosity);
      if (reduced.length !== next.unresolvedCuriosities.length) {
        next.unresolvedCuriosities = reduced;
        changed = true;
      }
    }

    if (update.lastCorrection !== undefined) {
      const value = update.lastCorrection === null ? null : clean(update.lastCorrection);
      if (value !== next.lastCorrection) {
        next.lastCorrection = value || null;
        changed = true;
      }
    }

    const relationshipNote = clean(update.relationshipNote);
    if (relationshipNote) {
      next.relationshipNotes = appendUnique(next.relationshipNotes, relationshipNote, MAX_RELATIONSHIP_NOTES);
      changed = true;
    }

    if (update.emotionalStance !== undefined) {
      const value = update.emotionalStance === null ? null : clean(update.emotionalStance, 120);
      if (value !== next.emotionalStance) {
        next.emotionalStance = value || null;
        changed = true;
      }
    }

    const callback = clean(update.callbackCandidate);
    if (callback) {
      next.callbackCandidates = appendUnique(next.callbackCandidates, callback, MAX_CALLBACKS);
      changed = true;
    }

    const clearCallback = clean(update.clearCallback);
    if (clearCallback) {
      const reduced = removeMatching(next.callbackCandidates, clearCallback);
      if (reduced.length !== next.callbackCandidates.length) {
        next.callbackCandidates = reduced;
        changed = true;
      }
    }

    if (changed) next.revision += 1;
    this.state = next;
    return this.snapshot();
  }

  snapshot(): JerryCharacterStateSnapshot {
    return {
      ...this.state,
      beliefs: [...this.state.beliefs],
      unresolvedCuriosities: [...this.state.unresolvedCuriosities],
      relationshipNotes: [...this.state.relationshipNotes],
      callbackCandidates: [...this.state.callbackCandidates],
    };
  }

  hasContent(): boolean {
    const state = this.state;
    return Boolean(
      state.beliefs.length ||
      state.currentHypothesis ||
      state.unresolvedCuriosities.length ||
      state.lastCorrection ||
      state.relationshipNotes.length ||
      state.emotionalStance ||
      state.callbackCandidates.length
    );
  }
}

export const JERRY_CHARACTER_STATE_INSTRUCTION = `
You may occasionally receive private context wrapped in [[JERRY_STATE]]...[[/JERRY_STATE]].
It is Jerry's current working continuity, not a script and not a set of facts about the guest.
Never quote it, list it, or mention that a state exists.
Let it subtly shape what Jerry remembers, doubts, revisits, or updates.
A hypothesis is provisional. A curiosity is permission to return later, not an instruction to ask immediately.
If current conversation evidence contradicts the state, prefer the conversation and update naturally rather than defending the old state.
`.trim();

export function formatJerryCharacterState(state: JerryCharacterStateSnapshot): string {
  const lines: string[] = [
    '[[JERRY_STATE]]',
    `Revision: ${state.revision}`,
  ];
  if (state.beliefs.length) lines.push(`Working beliefs: ${state.beliefs.join(' | ')}`);
  if (state.currentHypothesis) lines.push(`Current hypothesis: ${state.currentHypothesis}`);
  if (state.unresolvedCuriosities.length) lines.push(`Unresolved curiosities: ${state.unresolvedCuriosities.join(' | ')}`);
  if (state.lastCorrection) lines.push(`Last correction: ${state.lastCorrection}`);
  if (state.relationshipNotes.length) lines.push(`Relationship continuity: ${state.relationshipNotes.join(' | ')}`);
  if (state.emotionalStance) lines.push(`Current stance: ${state.emotionalStance}`);
  if (state.callbackCandidates.length) lines.push(`Possible callbacks: ${state.callbackCandidates.join(' | ')}`);
  lines.push('Use only if naturally relevant. Do not mention this state.', '[[/JERRY_STATE]]');
  return lines.join('\n');
}
