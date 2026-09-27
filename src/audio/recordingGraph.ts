import {
  createAutoLeveler,
  DEFAULT_AUTO_LEVELER_CONFIG,
  type AutoLevelerConfig,
} from './autoLeveler';

export const RECORDING_CHANNELS = {
  jerry: 0,
  guest: 1,
} as const;

export const GUEST_LEVEL_CONFIG = {
  targetDbfs: -18,
  minGainDb: -6,
  maxGainDb: 12,
  gateDbfs: -55,
  attackMs: 20,
  releaseMs: 300,
} as const satisfies AutoLevelerConfig;

export const JERRY_LEVEL_CONFIG = {
  targetDbfs: -18,
  minGainDb: -6,
  maxGainDb: 6,
  gateDbfs: -55,
  attackMs: 80,
  releaseMs: 500,
} as const satisfies AutoLevelerConfig;

interface DynamicsConfig {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

export const GUEST_DYNAMICS_CONFIG: DynamicsConfig = {
  threshold: -3,
  knee: 6,
  ratio: 12,
  attack: 0.003,
  release: 0.15,
};

export const JERRY_DYNAMICS_CONFIG: DynamicsConfig = {
  threshold: -3,
  knee: 6,
  ratio: 3,
  attack: 0.01,
  release: 0.25,
};

const MASTER_LIMITER_CONFIG = {
  threshold: -1,
  knee: 0,
  ratio: 20,
  attack: 0.001,
  release: 0.1,
} as const;

type AudioContextLike = AudioContext;
type AudioNodeLike = AudioNode;

export interface RecordingChannelChain {
  source: AudioNodeLike;
  analyser: AnalyserNode;
  levelGain: GainNode;
  compressor: DynamicsCompressorNode;
  output: AudioNodeLike;
  leveler: ReturnType<typeof createAutoLeveler>;
}

export interface RecordingGraph {
  jerryChain: RecordingChannelChain;
  guestChain: RecordingChannelChain | null;
  merger: ChannelMergerNode;
  destination: MediaStreamAudioDestinationNode;
  jerryDestination: MediaStreamAudioDestinationNode;
  guestDestination: MediaStreamAudioDestinationNode | null;
  masterGain: GainNode;
  masterLimiter: DynamicsCompressorNode;
  /** The centered monitor mix remains an integration responsibility. */
  monitorMix: null;
  update: (elapsedMs: number) => void;
  cleanup: () => void;
}

function setAudioParam(context: AudioContextLike, param: AudioParam, value: number): void {
  param.setValueAtTime(value, context.currentTime);
}

function createChannelChain(
  context: AudioContextLike,
  source: AudioNodeLike,
  levelConfig: AutoLevelerConfig,
  dynamicsConfig: DynamicsConfig,
): RecordingChannelChain {
  const analyser = context.createAnalyser();
  const levelGain = context.createGain();
  const compressor = context.createDynamicsCompressor();

  analyser.fftSize = 1024;
  levelGain.gain.value = 1;
  setAudioParam(context, compressor.threshold, dynamicsConfig.threshold);
  setAudioParam(context, compressor.knee, dynamicsConfig.knee);
  setAudioParam(context, compressor.ratio, dynamicsConfig.ratio);
  setAudioParam(context, compressor.attack, dynamicsConfig.attack);
  setAudioParam(context, compressor.release, dynamicsConfig.release);

  source.connect(analyser);
  analyser.connect(levelGain);
  levelGain.connect(compressor);

  return {
    source,
    analyser,
    levelGain,
    compressor,
    output: compressor,
    leveler: createAutoLeveler(levelConfig),
  };
}

function readRmsSamples(analyser: AnalyserNode): Float32Array {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return samples;
}

export function createRecordingGraph(
  context: AudioContextLike,
  sources: { jerry: AudioNodeLike; guest?: AudioNodeLike | null },
): RecordingGraph {
  const jerryChain = createChannelChain(
    context,
    sources.jerry,
    JERRY_LEVEL_CONFIG,
    JERRY_DYNAMICS_CONFIG,
  );
  const guestChain = sources.guest
    ? createChannelChain(
      context,
      sources.guest,
      GUEST_LEVEL_CONFIG,
      GUEST_DYNAMICS_CONFIG,
    )
    : null;
  const merger = context.createChannelMerger(2);
  const destination = context.createMediaStreamDestination();
  const jerryDestination = context.createMediaStreamDestination();
  const guestDestination = guestChain ? context.createMediaStreamDestination() : null;
  const masterGain = context.createGain();
  const masterLimiter = context.createDynamicsCompressor();
  destination.channelCount = guestChain ? 2 : 1;
  jerryDestination.channelCount = 1;
  if (guestDestination) guestDestination.channelCount = 1;
  masterGain.gain.value = 1;
  setAudioParam(context, masterLimiter.threshold, MASTER_LIMITER_CONFIG.threshold);
  setAudioParam(context, masterLimiter.knee, MASTER_LIMITER_CONFIG.knee);
  setAudioParam(context, masterLimiter.ratio, MASTER_LIMITER_CONFIG.ratio);
  setAudioParam(context, masterLimiter.attack, MASTER_LIMITER_CONFIG.attack);
  setAudioParam(context, masterLimiter.release, MASTER_LIMITER_CONFIG.release);

  jerryChain.output.connect(merger, 0, RECORDING_CHANNELS.jerry);
  if (guestChain) guestChain.output.connect(merger, 0, RECORDING_CHANNELS.guest);
  merger.connect(masterGain);
  masterGain.connect(masterLimiter);
  masterLimiter.connect(destination);
  jerryChain.output.connect(jerryDestination);
  if (guestChain && guestDestination) guestChain.output.connect(guestDestination);

  return {
    jerryChain,
    guestChain,
    merger,
    destination,
    jerryDestination,
    guestDestination,
    masterGain,
    masterLimiter,
    monitorMix: null,
    update(elapsedMs: number) {
      const jerryGainDb = jerryChain.leveler.update(
        readRmsSamples(jerryChain.analyser),
        elapsedMs,
      );
      jerryChain.levelGain.gain.value = 10 ** (jerryGainDb / 20);

      if (guestChain) {
        const guestGainDb = guestChain.leveler.update(
          readRmsSamples(guestChain.analyser),
          elapsedMs,
        );
        guestChain.levelGain.gain.value = 10 ** (guestGainDb / 20);
      }
    },
    cleanup() {
      jerryChain.source.disconnect();
      jerryChain.analyser.disconnect();
      jerryChain.levelGain.disconnect();
      jerryChain.compressor.disconnect();
      if (guestChain) {
        guestChain.source.disconnect();
        guestChain.analyser.disconnect();
        guestChain.levelGain.disconnect();
        guestChain.compressor.disconnect();
      }
      merger.disconnect();
      masterGain.disconnect();
      masterLimiter.disconnect();
      destination.disconnect();
      jerryDestination.disconnect();
      guestDestination?.disconnect();
    },
  };
}

export { DEFAULT_AUTO_LEVELER_CONFIG };
