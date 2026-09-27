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
  return [
    ...log,
    {
      turn: log.length + 1,
      speaker,
      text,
      startedAt: Number(startedAt.toFixed(3)),
      endedAt: Number(Math.max(startedAt, endedAt).toFixed(3)),
    },
  ];
}
