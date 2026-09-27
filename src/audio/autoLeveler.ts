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

  return {
    get gainDb() {
      return gainDb;
    },
    update(samples: Float32Array, elapsedMs: number): number {
      const desiredGainDb = targetGainDb(rmsDbfs(samples), config);
      gainDb = smoothGainDb(gainDb, desiredGainDb, elapsedMs, config);
      return gainDb;
    },
  };
}
