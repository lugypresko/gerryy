export interface ConversationTurn {
  id: string;
  speaker: 'guest' | 'jerry';
  kind: 'conversation';
  startedAt: number;
  endedAt?: number;
  text?: string;
  overlapDurationMs?: number;
}

export interface GuestInterruptionTurn {
  id: string;
  speaker: 'guest';
  kind: 'interruption';
  startedAt: number;
  endedAt?: number;
  overlapDurationMs: number;
}

export type TurnLogEntry = ConversationTurn | GuestInterruptionTurn;

export interface GuestVadState {
  speechActive: boolean;
  aboveThresholdFrames: number;
  belowThresholdFrames: number;
}

export interface GuestVadTransition {
  state: GuestVadState;
  speechDetected: boolean;
  started: boolean;
  ended: boolean;
}

export interface GuestVadOptions {
  thresholdDbfs?: number;
  startFrames?: number;
  endFrames?: number;
}

export const DEFAULT_GUEST_VAD_OPTIONS = {
  thresholdDbfs: -38,
  startFrames: 2,
  endFrames: 3,
} as const;

export function createGuestVadState(): GuestVadState {
  return {
    speechActive: false,
    aboveThresholdFrames: 0,
    belowThresholdFrames: 0,
  };
}

export function updateGuestVad(
  previous: GuestVadState,
  rmsDbfs: number,
  options: GuestVadOptions = DEFAULT_GUEST_VAD_OPTIONS,
): GuestVadTransition {
  const thresholdDbfs = options.thresholdDbfs ?? DEFAULT_GUEST_VAD_OPTIONS.thresholdDbfs;
  const startFrames = Math.max(1, options.startFrames ?? DEFAULT_GUEST_VAD_OPTIONS.startFrames);
  const endFrames = Math.max(1, options.endFrames ?? DEFAULT_GUEST_VAD_OPTIONS.endFrames);
  const speechDetected = rmsDbfs >= thresholdDbfs;
  const next: GuestVadState = { ...previous };

  if (speechDetected) {
    next.aboveThresholdFrames += 1;
    next.belowThresholdFrames = 0;
  } else {
    next.aboveThresholdFrames = 0;
    next.belowThresholdFrames += 1;
  }

  const started = !previous.speechActive && next.aboveThresholdFrames >= startFrames;
  const ended = previous.speechActive && next.belowThresholdFrames >= endFrames;
  next.speechActive = ended ? false : previous.speechActive || started;

  return { state: next, speechDetected, started, ended };
}

export function startGuestInterruption(startedAt: number): GuestInterruptionTurn {
  return {
    id: `guest-interruption-${startedAt}`,
    speaker: 'guest',
    kind: 'interruption',
    startedAt,
    overlapDurationMs: 0,
  };
}

export function appendGuestInterruption(
  entries: TurnLogEntry[],
  startedAt: number,
): TurnLogEntry[] {
  const interruption = startGuestInterruption(startedAt);
  return [...entries, interruption];
}

export function endGuestInterruption(
  turn: GuestInterruptionTurn,
  endedAt: number,
): GuestInterruptionTurn {
  return {
    ...turn,
    endedAt,
    overlapDurationMs: Math.max(0, endedAt - turn.startedAt),
  };
}
export type ConversationSpeaker = 'jerry' | 'guest';

export interface ConversationTurnLogEntry {
  turn: number;
  speaker: ConversationSpeaker;
  text: string;
  startedAt: number;
  endedAt: number;
}

export function createConversationTurnLog(): ConversationTurnLogEntry[] {
  return [];
}

export function appendConversationTurn(
  log: ConversationTurnLogEntry[],
  speaker: ConversationSpeaker,
  text: string,
  startedAt: number,
  endedAt: number,
): ConversationTurnLogEntry[] {
  return [...log, {
    turn: log.length + 1,
    speaker,
    text,
    startedAt: Number(startedAt.toFixed(3)),
    endedAt: Number(Math.max(startedAt, endedAt).toFixed(3)),
  }];
}

