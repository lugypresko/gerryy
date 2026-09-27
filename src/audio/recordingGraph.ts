import {
  createAutoLeveler,
  DEFAULT_AUTO_LEVELER_CONFIG,
  type AutoLevelerConfig,
} from './autoLeveler';

export const RECORDING_CHANNELS = {
  jerry: 0,
  guest: 1,
} as const;

export const RECORDING_LEVEL_CONFIG = {
  targetDbfs: -18,
  minGainDb: -6,
  maxGainDb: 12,
  gateDbfs: -55,
  attackMs: 20,
  releaseMs: 300,
} as const satisfies AutoLevelerConfig;

export const RECORDING_DYNAMICS_CONFIG = {
  threshold: -3,
  knee: 6,
  ratio: 20,
  attack: 0.003,
  release: 0.15,
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
): RecordingChannelChain {
  const analyser = context.createAnalyser();
  const levelGain = context.createGain();
  const compressor = context.createDynamicsCompressor();

  analyser.fftSize = 1024;
  levelGain.gain.value = 1;
  setAudioParam(context, compressor.threshold, RECORDING_DYNAMICS_CONFIG.threshold);
  setAudioParam(context, compressor.knee, RECORDING_DYNAMICS_CONFIG.knee);
  setAudioParam(context, compressor.ratio, RECORDING_DYNAMICS_CONFIG.ratio);
  setAudioParam(context, compressor.attack, RECORDING_DYNAMICS_CONFIG.attack);
  setAudioParam(context, compressor.release, RECORDING_DYNAMICS_CONFIG.release);

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
  levelConfig: AutoLevelerConfig = RECORDING_LEVEL_CONFIG,
): RecordingGraph {
  const jerryChain = createChannelChain(context, sources.jerry, levelConfig);
  const guestChain = sources.guest
    ? createChannelChain(context, sources.guest, levelConfig)
    : null;
  const merger = context.createChannelMerger(2);
  const destination = context.createMediaStreamDestination();
  destination.channelCount = guestChain ? 2 : 1;

  jerryChain.output.connect(merger, 0, RECORDING_CHANNELS.jerry);
  if (guestChain) guestChain.output.connect(merger, 0, RECORDING_CHANNELS.guest);
  merger.connect(destination);

  return {
    jerryChain,
    guestChain,
    merger,
    destination,
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
      destination.disconnect();
    },
  };
}

export { DEFAULT_AUTO_LEVELER_CONFIG };
