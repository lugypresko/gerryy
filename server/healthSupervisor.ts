export type JerryHealthComponent =
  | 'socket'
  | 'stt'
  | 'live'
  | 'slow_brain'
  | 'human_capture'
  | 'jerry_capture'
  | 'recording'
  | 'finalization'
  | 'processing';

export type JerryHealthState =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'recovering'
  | 'failed_safe';

export interface JerryHealthEvent {
  id: number;
  atMs: number;
  component: JerryHealthComponent;
  event: string;
  state: JerryHealthState;
  latencyMs?: number;
  errorCode?: string;
  recoveryAction?: string;
  details?: Record<string, unknown>;
}

export interface JerryComponentHealth {
  state: JerryHealthState;
  lastEvent: string;
  updatedAtMs: number;
  failures: number;
  recoveries: number;
}

export interface JerryHealthSnapshot {
  sessionId: string;
  episodeId?: string;
  overall: JerryHealthState;
  components: Record<JerryHealthComponent, JerryComponentHealth>;
  recentEvents: JerryHealthEvent[];
}

const COMPONENTS: JerryHealthComponent[] = [
  'socket',
  'stt',
  'live',
  'slow_brain',
  'human_capture',
  'jerry_capture',
  'recording',
  'finalization',
  'processing',
];

function initialComponent(): JerryComponentHealth {
  return {
    state: 'unknown',
    lastEvent: 'not_started',
    updatedAtMs: 0,
    failures: 0,
    recoveries: 0,
  };
}

function severity(state: JerryHealthState): number {
  switch (state) {
    case 'failed_safe': return 4;
    case 'degraded': return 3;
    case 'recovering': return 2;
    case 'healthy': return 1;
    default: return 0;
  }
}

export class JerryHealthSupervisor {
  readonly sessionId: string;
  private episodeId?: string;
  private nextId = 1;
  private readonly maxEvents: number;
  private readonly events: JerryHealthEvent[] = [];
  private readonly components: Record<JerryHealthComponent, JerryComponentHealth>;

  constructor(sessionId: string, options: { maxEvents?: number } = {}) {
    this.sessionId = sessionId;
    this.maxEvents = options.maxEvents ?? 250;
    this.components = Object.fromEntries(
      COMPONENTS.map((component) => [component, initialComponent()]),
    ) as Record<JerryHealthComponent, JerryComponentHealth>;
  }

  setEpisode(episodeId?: string) {
    this.episodeId = episodeId || undefined;
  }

  record(input: Omit<JerryHealthEvent, 'id' | 'atMs'> & { atMs?: number }): JerryHealthEvent {
    const atMs = input.atMs ?? Date.now();
    const previous = this.components[input.component];
    const next: JerryComponentHealth = {
      ...previous,
      state: input.state,
      lastEvent: input.event,
      updatedAtMs: atMs,
      failures: previous.failures + (input.state === 'degraded' || input.state === 'failed_safe' ? 1 : 0),
      recoveries: previous.recoveries + (input.state === 'recovering' ? 1 : 0),
    };
    this.components[input.component] = next;

    const event: JerryHealthEvent = {
      id: this.nextId++,
      atMs,
      component: input.component,
      event: input.event,
      state: input.state,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.recoveryAction ? { recoveryAction: input.recoveryAction } : {}),
      ...(input.details ? { details: input.details } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return event;
  }

  overall(): JerryHealthState {
    let worst: JerryHealthState = 'unknown';
    for (const component of Object.values(this.components)) {
      if (severity(component.state) > severity(worst)) worst = component.state;
    }
    return worst;
  }

  snapshot(): JerryHealthSnapshot {
    return {
      sessionId: this.sessionId,
      ...(this.episodeId ? { episodeId: this.episodeId } : {}),
      overall: this.overall(),
      components: Object.fromEntries(
        Object.entries(this.components).map(([key, value]) => [key, { ...value }]),
      ) as Record<JerryHealthComponent, JerryComponentHealth>,
      recentEvents: this.events.map((event) => ({ ...event })),
    };
  }
}

export class JerryHealthRegistry {
  private readonly sessions = new Map<string, JerryHealthSupervisor>();
  private readonly maxSessions: number;

  constructor(maxSessions = 20) {
    this.maxSessions = maxSessions;
  }

  create(sessionId: string): JerryHealthSupervisor {
    const supervisor = new JerryHealthSupervisor(sessionId);
    this.sessions.set(sessionId, supervisor);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    return supervisor;
  }

  get(sessionId: string): JerryHealthSupervisor | undefined {
    return this.sessions.get(sessionId);
  }

  list(): JerryHealthSnapshot[] {
    return [...this.sessions.values()].map((supervisor) => supervisor.snapshot());
  }
}
