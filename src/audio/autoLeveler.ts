export interface AutoLevelerConfig {
  targetDbfs: number;
  gateDbfs: number;
  minGainDb: number;
  maxGainDb: number;
  attackMs: number;
  releaseMs: number;
}

export const DEFAULT_AUTO_LEVELER_CONFIG: AutoLevelerConfig = {
  targetDbfs: -18,
  gateDbfs: -55,
  minGainDb: -6,
  maxGainDb: 12,
  attackMs: 20,
  releaseMs: 300,
};

export interface AudioWindowMeasurement {
  rmsDbfs: number;
  peakDbfs: number;
  isSpeech: boolean;
  clippingCount: number;
}

export interface SpeechWindowMetrics extends AudioWindowMeasurement {
  silenceDurationMs: number;
  activeSpeechDurationMs: number;
  smoothedRmsDbfs: number;
}

const CLIP_SAMPLE_THRESHOLD = 0.999;
const MAX_TRACKED_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_CLIPPING_COUNT = 1_000_000;

export function peakDbfs(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

export function measureAudioWindow(
  samples: Float32Array,
  gateDbfs = DEFAULT_AUTO_LEVELER_CONFIG.gateDbfs,
): AudioWindowMeasurement {
  let clippingCount = 0;
  for (const sample of samples) {
    if (Math.abs(sample) >= CLIP_SAMPLE_THRESHOLD) clippingCount += 1;
  }
  const rms = rmsDbfs(samples);
  return {
    rmsDbfs: rms,
    peakDbfs: peakDbfs(samples),
    isSpeech: Number.isFinite(rms) && rms > gateDbfs,
    clippingCount,
  };
}

export function createSpeechWindowMeter(
  gateDbfs = DEFAULT_AUTO_LEVELER_CONFIG.gateDbfs,
  smoothingMs = 150,
) {
  let silenceDurationMs = 0;
  let activeSpeechDurationMs = 0;
  let clippingCount = 0;
  let smoothedRmsDbfs = gateDbfs;

  return {
    measure(samples: Float32Array, elapsedMs: number): SpeechWindowMetrics {
      const window = measureAudioWindow(samples, gateDbfs);
      const durationMs = Math.max(0, elapsedMs);
      const targetDbfs = Number.isFinite(window.rmsDbfs) ? window.rmsDbfs : gateDbfs;
      const alpha = 1 - Math.exp(-durationMs / Math.max(1, smoothingMs));
      smoothedRmsDbfs += (targetDbfs - smoothedRmsDbfs) * alpha;
      clippingCount = Math.min(MAX_CLIPPING_COUNT, clippingCount + window.clippingCount);
      if (window.isSpeech) {
        activeSpeechDurationMs = Math.min(MAX_TRACKED_DURATION_MS, activeSpeechDurationMs + durationMs);
      } else {
        silenceDurationMs = Math.min(MAX_TRACKED_DURATION_MS, silenceDurationMs + durationMs);
      }
      return {
        ...window,
        silenceDurationMs,
        activeSpeechDurationMs,
        clippingCount,
        smoothedRmsDbfs,
      };
    },
  };
}

export function rmsDbfs(samples: Float32Array): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;

  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

export function targetGainDb(
  rmsDbfsValue: number,
  config: AutoLevelerConfig = DEFAULT_AUTO_LEVELER_CONFIG,
): number {
  if (rmsDbfsValue <= config.gateDbfs) return 0;
  return Math.min(
    config.maxGainDb,
    Math.max(config.minGainDb, config.targetDbfs - rmsDbfsValue),
  );
}

export function smoothGainDb(
  currentGainDb: number,
  desiredGainDb: number,
  elapsedMs: number,
  config: AutoLevelerConfig = DEFAULT_AUTO_LEVELER_CONFIG,
): number {
  const timeConstant = desiredGainDb > currentGainDb ? config.attackMs : config.releaseMs;
  const alpha = 1 - Math.exp(-Math.max(0, elapsedMs) / Math.max(1, timeConstant));
  return currentGainDb + (desiredGainDb - currentGainDb) * alpha;
}

export function createAutoLeveler(config: AutoLevelerConfig = DEFAULT_AUTO_LEVELER_CONFIG) {
  let gainDb = 0;

  function updateRmsDbfs(rmsDbfsValue: number, elapsedMs: number): number {
    const desiredGainDb = targetGainDb(rmsDbfsValue, config);
    gainDb = smoothGainDb(gainDb, desiredGainDb, elapsedMs, config);
    return gainDb;
  }

  return {
    get gainDb() {
      return gainDb;
    },
    updateRmsDbfs,
    update(samples: Float32Array, elapsedMs: number): number {
      return updateRmsDbfs(rmsDbfs(samples), elapsedMs);
    },
  };
}
