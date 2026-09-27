export type PublishStatus = 'publishable' | 'needs-review' | 'failed';

export interface EpisodeStemInput {
  master: Blob;
  jerry?: Blob;
  guest?: Blob;
  mimeType?: string;
}

export interface StemMetrics {
  rmsDbfs: number;
  peakDbfs: number;
  clippingCount: number;
  durationMs: number;
}

export interface EpisodeMetrics {
  jerryRmsDbfs: number;
  guestRmsDbfs: number;
  jerryPeakDbfs: number;
  guestPeakDbfs: number;
  balanceDeltaDb: number;
  masterPeakDbfs: number;
  clippingCount: number;
  durationMs: number;
}

export interface FinalizedEpisode {
  finalMaster: Blob;
  rawStems: {
    master: Blob;
    jerry?: Blob;
    guest?: Blob;
  };
  metrics: EpisodeMetrics;
  publicationStatus: PublishStatus;
  warnings: string[];
  processingMs: number;
}

export interface FinalizerOptions {
  targetDbfs?: number;
  reviewDeltaDb?: number;
  failDeltaDb?: number;
  ceilingDbfs?: number;
}

const DEFAULT_OPTIONS: Required<FinalizerOptions> = {
  targetDbfs: -18,
  reviewDeltaDb: 3,
  failDeltaDb: 6,
  ceilingDbfs: -1,
};

const dbToLinear = (db: number) => 10 ** (db / 20);
const linearToDb = (value: number) => (value > 0 ? 20 * Math.log10(value) : -Infinity);

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const AudioContextCtor = globalThis.AudioContext;
  if (!AudioContextCtor) throw new Error('AudioContext is unavailable');
  const context = new AudioContextCtor();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function measureAudioBuffer(buffer: AudioBuffer, channel = 0): StemMetrics {
  const data = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
  let sumSquares = 0;
  let peak = 0;
  let clippingCount = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = Math.abs(data[i]);
    sumSquares += sample * sample;
    peak = Math.max(peak, sample);
    if (sample >= 0.999) clippingCount++;
  }
  return {
    rmsDbfs: linearToDb(Math.sqrt(sumSquares / Math.max(1, data.length))),
    peakDbfs: linearToDb(peak),
    clippingCount,
    durationMs: (buffer.length / buffer.sampleRate) * 1000,
  };
}

function balanceGainDb(sourceDbfs: number, targetDbfs: number): number {
  // Prefer attenuation of a loud source; only boost a quiet source within +12 dB.
  return Math.max(-6, Math.min(12, targetDbfs - sourceDbfs));
}

export function evaluatePublishGate(
  metrics: EpisodeMetrics,
  options: FinalizerOptions = {},
): { status: PublishStatus; warnings: string[] } {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];
  if (!Number.isFinite(metrics.durationMs) || metrics.durationMs < 500) {
    return { status: 'failed', warnings: ['Recording is too short to publish.'] };
  }
  if (!Number.isFinite(metrics.guestRmsDbfs)) {
    return { status: 'failed', warnings: ['Guest channel is missing or silent.'] };
  }
  if (metrics.clippingCount > 0 || metrics.masterPeakDbfs > config.ceilingDbfs + 0.1) {
    return { status: 'failed', warnings: ['Clipping or master peak above the safety ceiling.'] };
  }
  if (metrics.balanceDeltaDb > config.failDeltaDb) {
    return { status: 'failed', warnings: ['Speaker balance remains too far apart after processing.'] };
  }
  if (metrics.balanceDeltaDb > config.reviewDeltaDb) {
    warnings.push('Speaker balance needs review before publication.');
    return { status: 'needs-review', warnings };
  }
  return { status: 'publishable', warnings };
}

function encodeWav(buffer: AudioBuffer, ceilingDbfs: number): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const samples = buffer.length * channels;
  const output = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(output);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples * 2, true);
  const ceiling = dbToLinear(ceilingDbfs);
  let offset = 44;
  for (let frame = 0; frame < buffer.length; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-ceiling, Math.min(ceiling, buffer.getChannelData(channel)[frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

export async function renderFinalMaster(
  buffer: AudioBuffer,
  jerryGainDb: number,
  guestGainDb: number,
  ceilingDbfs: number,
): Promise<Blob> {
  const OfflineCtor = globalThis.OfflineAudioContext;
  if (!OfflineCtor) return new Blob([], { type: 'audio/wav' });
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const offline = new OfflineCtor(channels, buffer.length, buffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const compressor = offline.createDynamicsCompressor();
  compressor.threshold.value = ceilingDbfs;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.001;
  compressor.release.value = 0.1;
  if (channels === 2) {
    const splitter = offline.createChannelSplitter(2);
    const merger = offline.createChannelMerger(2);
    const jerryGain = offline.createGain();
    const guestGain = offline.createGain();
    jerryGain.gain.value = dbToLinear(jerryGainDb);
    guestGain.gain.value = dbToLinear(guestGainDb);
    source.connect(splitter);
    splitter.connect(jerryGain, 0);
    splitter.connect(guestGain, 1);
    jerryGain.connect(merger, 0, 0);
    guestGain.connect(merger, 0, 1);
    merger.connect(compressor);
  } else {
    const gain = offline.createGain();
    gain.gain.value = dbToLinear(jerryGainDb);
    source.connect(gain);
    gain.connect(compressor);
  }
  compressor.connect(offline.destination);
  source.start(0);
  return encodeWav(await offline.startRendering(), ceilingDbfs);
}

export async function finalizeEpisode(
  input: EpisodeStemInput,
  options: FinalizerOptions = {},
): Promise<FinalizedEpisode> {
  const startedAt = performance.now();
  const config = { ...DEFAULT_OPTIONS, ...options };
  const rawStems = { master: input.master, jerry: input.jerry, guest: input.guest };
  const warnings: string[] = [];
  try {
    const masterBuffer = await decodeAudioBlob(input.master);
    const jerry = measureAudioBuffer(masterBuffer, 0);
    const guest = masterBuffer.numberOfChannels > 1
      ? measureAudioBuffer(masterBuffer, 1)
      : input.guest
        ? await decodeAudioBlob(input.guest).then((buffer) => measureAudioBuffer(buffer))
        : { rmsDbfs: -Infinity, peakDbfs: -Infinity, clippingCount: 0, durationMs: jerry.durationMs };
    const balanceDeltaDb = Math.abs(jerry.rmsDbfs - guest.rmsDbfs);
    const jerryGainDb = balanceGainDb(jerry.rmsDbfs, config.targetDbfs);
    const guestGainDb = balanceGainDb(guest.rmsDbfs, config.targetDbfs);
    const finalMaster = await renderFinalMaster(masterBuffer, jerryGainDb, guestGainDb, config.ceilingDbfs);
    const finalBuffer = await decodeAudioBlob(finalMaster);
    const finalJerry = measureAudioBuffer(finalBuffer, 0);
    const finalGuest = finalBuffer.numberOfChannels > 1
      ? measureAudioBuffer(finalBuffer, 1)
      : guest;
    const metrics: EpisodeMetrics = {
      jerryRmsDbfs: finalJerry.rmsDbfs,
      guestRmsDbfs: finalGuest.rmsDbfs,
      jerryPeakDbfs: finalJerry.peakDbfs,
      guestPeakDbfs: finalGuest.peakDbfs,
      balanceDeltaDb: Math.abs(finalJerry.rmsDbfs - finalGuest.rmsDbfs),
      masterPeakDbfs: Math.max(finalJerry.peakDbfs, finalGuest.peakDbfs),
      clippingCount: finalJerry.clippingCount + finalGuest.clippingCount,
      durationMs: finalJerry.durationMs,
    };
    if (balanceDeltaDb > config.reviewDeltaDb) warnings.push(`Applied Jerry ${jerryGainDb.toFixed(1)} dB / Guest ${guestGainDb.toFixed(1)} dB balance correction.`);
    const gate = evaluatePublishGate(metrics, config);
    return {
      finalMaster,
      rawStems,
      metrics,
      publicationStatus: gate.status,
      warnings: [...warnings, ...gate.warnings],
      processingMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      finalMaster: input.master,
      rawStems,
      metrics: {
        jerryRmsDbfs: -Infinity,
        guestRmsDbfs: -Infinity,
        jerryPeakDbfs: -Infinity,
        guestPeakDbfs: -Infinity,
        balanceDeltaDb: Infinity,
        masterPeakDbfs: Infinity,
        clippingCount: 0,
        durationMs: 0,
      },
      publicationStatus: 'failed',
      warnings: [`Finalization failed: ${error instanceof Error ? error.message : 'unknown error'}`],
      processingMs: Math.round(performance.now() - startedAt),
    };
  }
}
