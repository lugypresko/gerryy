export const JERRY_POSES = {
  idle: '/jerry-pose-idle.jpg',
  speaking: '/jerry-pose-speaking.jpg',
  skeptical: '/jerry-pose-skeptical.jpg',
  amused: '/jerry-pose-amused.jpg',
} as const;

export type JerryPose = keyof typeof JERRY_POSES;

export type JerryAnimationState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'emphasis'
  | 'amused'
  | 'skeptical';

export const JERRY_MOUTH_ANCHORS = {
  idle: { x: 55.2, y: 75.5, width: 17.5 },
  speaking: { x: 55.2, y: 75.5, width: 17.5 },
  skeptical: { x: 55.2, y: 75.5, width: 17.5 },
  amused: { x: 55.2, y: 75.5, width: 17.5 },
} as const;

export const JERRY_POSE_CROSSFADE_MS = 140;

const STATE_TO_POSE: Record<JerryAnimationState, JerryPose> = {
  idle: 'idle',
  listening: 'idle',
  thinking: 'skeptical',
  speaking: 'speaking',
  emphasis: 'speaking',
  amused: 'amused',
  skeptical: 'skeptical',
};

export function poseForState(state: JerryAnimationState): JerryPose {
  return STATE_TO_POSE[state] ?? 'idle';
}

export type JerryAnimationEvent =
  | 'mic-start'
  | 'output-audio'
  | 'turn-complete'
  | 'live-disconnect';

export function nextAnimationState(
  current: JerryAnimationState,
  event: JerryAnimationEvent | string,
): JerryAnimationState {
  switch (event) {
    case 'mic-start':
      return 'listening';
    case 'output-audio':
      return 'speaking';
    case 'turn-complete':
      return current === 'listening' ? 'listening' : 'idle';
    case 'live-disconnect':
      return 'idle';
    default:
      return current;
  }
}
