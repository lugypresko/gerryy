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

export interface EpisodeClock {
  offsetAt: (timestampMs: number) => number;
  lastOffset: () => number;
}

export interface EpisodeTimelineEvent {
  id: string;
  type: string;
  offsetMs: number;
  endOffsetMs?: number;
  speaker?: 'guest' | 'jerry';
  late?: boolean;
}

export interface EpisodeTimelineAppendInput {
  id: string;
  type: string;
  atMs: number;
  endAtMs?: number;
  speaker?: 'guest' | 'jerry';
}

export interface TimelineAppendResult {
  accepted: boolean;
  duplicate: boolean;
  late: boolean;
}

export interface TimelineBoundsResult {
  valid: boolean;
  violations: Array<{ id: string; reason: 'negative-offset' | 'reversed-interval' | 'out-of-bounds' | 'duplicate-id' }>;
}

export interface SpeakerOverlapResult {
  durationMs: number;
  intervals: Array<{ startOffsetMs: number; endOffsetMs: number }>;
}

export interface EpisodeTimeline {
  readonly episodeId: string;
  append: (event: EpisodeTimelineAppendInput) => TimelineAppendResult;
  events: () => EpisodeTimelineEvent[];
  finalize: (durationMs: number) => {
    episodeId: string;
    durationMs: number;
    events: EpisodeTimelineEvent[];
    overlap: SpeakerOverlapResult;
    bounds: TimelineBoundsResult;
  };
}

function finiteTimestamp(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

export function createEpisodeClock(options: { originMs?: number } = {}): EpisodeClock {
  const originMs = finiteTimestamp(options.originMs ?? 0, 'originMs');
  let last = 0;

  return {
    offsetAt(timestampMs: number) {
      const raw = Math.max(0, finiteTimestamp(timestampMs, 'timestampMs') - originMs);
      last = Math.max(last, raw);
      return last;
    },
    lastOffset() {
      return last;
    },
  };
}

function mergeIntervals(intervals: Array<{ startOffsetMs: number; endOffsetMs: number }>) {
  const sorted = [...intervals].sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.endOffsetMs - b.endOffsetMs);
  const merged: Array<{ startOffsetMs: number; endOffsetMs: number }> = [];
  for (const interval of sorted) {
    const current = merged[merged.length - 1];
    if (!current || interval.startOffsetMs > current.endOffsetMs) {
      merged.push({ ...interval });
    } else {
      current.endOffsetMs = Math.max(current.endOffsetMs, interval.endOffsetMs);
    }
  }
  return merged;
}

export function calculateSpeakerOverlap(
  events: Array<{ speaker?: 'guest' | 'jerry'; startOffsetMs?: number; endOffsetMs?: number }>,
): SpeakerOverlapResult {
  const guest = events.filter((event) => event.speaker === 'guest' && event.endOffsetMs !== undefined);
  const jerry = events.filter((event) => event.speaker === 'jerry' && event.endOffsetMs !== undefined);
  const intersections: Array<{ startOffsetMs: number; endOffsetMs: number }> = [];

  for (const guestEvent of guest) {
    for (const jerryEvent of jerry) {
      const startOffsetMs = Math.max(guestEvent.startOffsetMs || 0, jerryEvent.startOffsetMs || 0);
      const endOffsetMs = Math.min(guestEvent.endOffsetMs!, jerryEvent.endOffsetMs!);
      if (endOffsetMs > startOffsetMs) intersections.push({ startOffsetMs, endOffsetMs });
    }
  }

  const intervals = mergeIntervals(intersections);
  return {
    intervals,
    durationMs: intervals.reduce((total, interval) => total + interval.endOffsetMs - interval.startOffsetMs, 0),
  };
}

export function validateTimelineBounds(events: EpisodeTimelineEvent[], durationMs: number): TimelineBoundsResult {
  finiteTimestamp(durationMs, 'durationMs');
  const seen = new Set<string>();
  const violations: TimelineBoundsResult['violations'] = [];
  for (const event of events) {
    if (seen.has(event.id)) violations.push({ id: event.id, reason: 'duplicate-id' });
    seen.add(event.id);
    if (event.offsetMs < 0) violations.push({ id: event.id, reason: 'negative-offset' });
    if (event.endOffsetMs !== undefined && event.endOffsetMs < event.offsetMs) {
      violations.push({ id: event.id, reason: 'reversed-interval' });
    }
    if (event.offsetMs > durationMs || (event.endOffsetMs !== undefined && event.endOffsetMs > durationMs)) {
      violations.push({ id: event.id, reason: 'out-of-bounds' });
    }
  }
  return { valid: violations.length === 0, violations };
}

export function createEpisodeTimeline(options: { episodeId: string; originMs?: number }): EpisodeTimeline {
  const clock = createEpisodeClock({ originMs: options.originMs });
  const entries: EpisodeTimelineEvent[] = [];
  const ids = new Set<string>();

  return {
    episodeId: options.episodeId,
    append(input) {
      if (ids.has(input.id)) return { accepted: false, duplicate: true, late: false };
      const rawAtMs = finiteTimestamp(input.atMs, 'atMs');
      const wasLate = Math.max(0, rawAtMs - (options.originMs ?? 0)) < clock.lastOffset();
      const offsetMs = clock.offsetAt(rawAtMs);
      const event: EpisodeTimelineEvent = {
        id: input.id,
        type: input.type,
        offsetMs,
        ...(input.speaker ? { speaker: input.speaker } : {}),
        ...(wasLate ? { late: true } : {}),
      };
      if (input.endAtMs !== undefined) {
        const rawEnd = Math.max(0, finiteTimestamp(input.endAtMs, 'endAtMs') - (options.originMs ?? 0));
        event.endOffsetMs = Math.max(offsetMs, rawEnd);
      }
      ids.add(input.id);
      entries.push(event);
      return { accepted: true, duplicate: false, late: wasLate };
    },
    events() {
      return entries.map((event) => ({ ...event }));
    },
    finalize(durationMs) {
      const snapshot = entries.map((event) => ({ ...event }));
      return {
        episodeId: options.episodeId,
        durationMs,
        events: snapshot,
        overlap: calculateSpeakerOverlap(snapshot.map((event) => ({
          speaker: event.speaker,
          startOffsetMs: event.offsetMs,
          endOffsetMs: event.endOffsetMs,
        }))),
        bounds: validateTimelineBounds(snapshot, durationMs),
      };
    },
  };
}

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

