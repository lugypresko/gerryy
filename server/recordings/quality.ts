import type { Buffer } from 'node:buffer';

export type RecordingQualityStatus =
  | 'publishable'
  | 'needs-review'
  | 'failed'
  | 'insufficient-speech';

export interface DecodedRecording {
  sampleRate: number;
  channels: Float32Array[];
  durationMs: number;
}

export interface RecordingQualityOptions {
  windowMs?: number;
  hopMs?: number;
  speechThresholdDbfs?: number;
  minActiveSpeechMs?: number;
  reviewBalanceDeltaDb?: number;
  failBalanceDeltaDb?: number;
  truePeakCeilingDbfs?: number;
}

export interface RecordingChannelQuality {
  lufs: number;
  truePeakDbfs: number;
  clippingCount: number;
  activeWindows: number;
  activeSpeechMs: number;
}

export interface RecordingQualityMetrics {
  decoded: boolean;
  decodeError?: string;
  sampleRate: number;
  channelCount: number;
  durationMs: number;
  activeWindows: number;
  activeSpeechMs: number;
  speechCoverage: number;
  insufficientSpeech: boolean;
  balanceDeltaDb: number;
  clippingCount: number;
  truePeakDbfs: number;
  channels: RecordingChannelQuality[];
  status: RecordingQualityStatus;
  reasons: string[];
}

const DEFAULTS: Required<RecordingQualityOptions> = {
  windowMs: 400,
  hopMs: 100,
  speechThresholdDbfs: -48,
  minActiveSpeechMs: 1000,
  reviewBalanceDeltaDb: 3,
  failBalanceDeltaDb: 6,
  truePeakCeilingDbfs: -1,
};

const dbfs = (power: number): number => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const linearDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

function readAscii(view: DataView, offset: number, length: number): string {
  let value = '';
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i));
  return value;
}

function decodePcm(view: DataView, offset: number, length: number, format: number, channels: number, bits: number): Float32Array[] {
  const bytesPerSample = bits / 8;
  const frameSize = bytesPerSample * channels;
  if (!Number.isInteger(bytesPerSample) || frameSize <= 0 || length % frameSize !== 0) {
    throw new Error('Unsupported WAV sample layout');
  }
  const frameCount = length / frameSize;
  const output = Array.from({ length: channels }, () => new Float32Array(frameCount));
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const position = offset + frame * frameSize + channel * bytesPerSample;
      let sample: number;
      if (format === 3 && bits === 32) {
        sample = view.getFloat32(position, true);
      } else if (format === 1 && bits === 16) {
        sample = view.getInt16(position, true) / 0x8000;
      } else if (format === 1 && bits === 24) {
        const raw = view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getUint8(position + 2) << 16);
        sample = (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x800000;
      } else if (format === 1 && bits === 32) {
        sample = view.getInt32(position, true) / 0x80000000;
      } else {
        throw new Error(`Unsupported WAV format ${format}/${bits}`);
      }
      output[channel][frame] = Math.max(-1, Math.min(1, sample));
    }
  }
  return output;
}

export function decodeWav(input: Uint8Array | Buffer): DecodedRecording {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Audio decode failed: expected RIFF/WAVE input');
  }
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const chunkId = readAscii(view, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const content = offset + 8;
    if (content + chunkLength > view.byteLength) throw new Error('Audio decode failed: truncated WAV chunk');
    if (chunkId === 'fmt ') {
      format = view.getUint16(content, true);
      channelCount = view.getUint16(content + 2, true);
      sampleRate = view.getUint32(content + 4, true);
      bits = view.getUint16(content + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = content;
      dataLength = chunkLength;
    }
    offset = content + chunkLength + (chunkLength % 2);
  }
  if (!format || !channelCount || !sampleRate || dataOffset < 0) throw new Error('Audio decode failed: missing WAV metadata');
  const decodedChannels = decodePcm(view, dataOffset, dataLength, format, channelCount, bits);
  return { sampleRate, channels: decodedChannels, durationMs: (decodedChannels[0].length / sampleRate) * 1000 };
}

function windowPower(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let index = start; index < end; index++) {
    // A small first-order high-pass is a cheap, deterministic K-weighting approximation.
    const previous = index > start ? samples[index - 1] : 0;
    const filtered = samples[index] - previous * 0.995;
    sum += filtered * filtered;
  }
  return sum / Math.max(1, end - start);
}

function oversampledTruePeak(samples: Float32Array, start: number, end: number): number {
  let peak = 0;
  for (let index = start; index < end; index++) {
    const current = samples[index];
    const previous = index > start ? samples[index - 1] : current;
    for (let step = 0; step < 4; step++) {
      const fraction = step / 4;
      peak = Math.max(peak, Math.abs(previous + (current - previous) * fraction));
    }
  }
  return peak;
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of windows) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function measureChannel(
  samples: Float32Array,
  activeWindows: Array<[number, number]>,
  sampleRate: number,
  activeWindowCount: number,
): RecordingChannelQuality {
  let powerSum = 0;
  let sampleCount = 0;
  let activePeak = 0;
  for (const [start, end] of activeWindows) {
    powerSum += windowPower(samples, start, end) * (end - start);
    sampleCount += end - start;
    activePeak = Math.max(activePeak, oversampledTruePeak(samples, start, end));
  }
  const filePeak = oversampledTruePeak(samples, 0, samples.length);
  const clippingCount = samples.reduce((total, sample) => total + (Math.abs(sample) >= 0.999 ? 1 : 0), 0);
  return {
    lufs: dbfs(powerSum / Math.max(1, sampleCount)),
    truePeakDbfs: linearDb(Math.max(activePeak, filePeak)),
    clippingCount,
    activeWindows: activeWindowCount,
    activeSpeechMs: (sampleCount / sampleRate) * 1000,
  };
}

export function analyzePcmRecording(input: DecodedRecording, options: RecordingQualityOptions = {}): RecordingQualityMetrics {
  const config = { ...DEFAULTS, ...options };
  const channels = input.channels.filter((channel) => channel.length > 0);
  const channelCount = channels.length;
  if (!channelCount || !input.sampleRate) {
    return failedMetrics('No decodable audio channels were provided.');
  }
  const windowLength = Math.max(1, Math.round(input.sampleRate * config.windowMs / 1000));
  const hopLength = Math.max(1, Math.round(input.sampleRate * config.hopMs / 1000));
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  const activeWindows: Array<[number, number]> = [];
  for (let start = 0; start + windowLength <= frameCount; start += hopLength) {
    const end = start + windowLength;
    const loudestWindowDb = Math.max(...channels.map((channel) => dbfs(windowPower(channel, start, end))));
    if (loudestWindowDb >= config.speechThresholdDbfs) activeWindows.push([start, end]);
  }
  const speechWindows = mergeWindows(activeWindows);
  const measuredChannels = channels.map((channel) => measureChannel(channel, speechWindows, input.sampleRate, activeWindows.length));
  const activeSpeechMs = speechWindows.reduce((total, [start, end]) => total + ((end - start) / input.sampleRate) * 1000, 0);
  const insufficientSpeech = activeSpeechMs < config.minActiveSpeechMs;
  const lufsValues = measuredChannels.map((channel) => channel.lufs).filter(Number.isFinite);
  const balanceDeltaDb = lufsValues.length > 1 ? Math.abs(lufsValues[0] - lufsValues[1]) : Infinity;
  const clippingCount = measuredChannels.reduce((total, channel) => total + channel.clippingCount, 0);
  const truePeakDbfs = Math.max(...measuredChannels.map((channel) => channel.truePeakDbfs));
  const reasons: string[] = [];
  if (insufficientSpeech) reasons.push('insufficient-speech');
  if (channelCount !== 2) reasons.push('expected-two-channels');
  if (clippingCount > 0) reasons.push('clipping');
  if (truePeakDbfs > config.truePeakCeilingDbfs) reasons.push('true-peak-over-ceiling');
  if (Number.isFinite(balanceDeltaDb) && balanceDeltaDb > config.reviewBalanceDeltaDb) reasons.push('speaker-balance');
  let status: RecordingQualityStatus = 'publishable';
  if (insufficientSpeech) status = 'insufficient-speech';
  else if (clippingCount > 0 || truePeakDbfs > 0 || (Number.isFinite(balanceDeltaDb) && balanceDeltaDb > config.failBalanceDeltaDb)) status = 'failed';
  else if (channelCount !== 2 || truePeakDbfs > config.truePeakCeilingDbfs || (Number.isFinite(balanceDeltaDb) && balanceDeltaDb > config.reviewBalanceDeltaDb)) status = 'needs-review';
  return {
    decoded: true,
    sampleRate: input.sampleRate,
    channelCount,
    durationMs: input.durationMs,
    activeWindows: activeWindows.length,
    activeSpeechMs,
    speechCoverage: activeSpeechMs / Math.max(1, input.durationMs),
    insufficientSpeech,
    balanceDeltaDb,
    clippingCount,
    truePeakDbfs,
    channels: measuredChannels,
    status,
    reasons,
  };
}

export function analyzeRecordingQuality(input: Uint8Array | Buffer, options: RecordingQualityOptions = {}): RecordingQualityMetrics {
  try {
    return analyzePcmRecording(decodeWav(input), options);
  } catch (error) {
    return failedMetrics(error instanceof Error ? error.message : 'Audio decode failed');
  }
}

function failedMetrics(decodeError: string): RecordingQualityMetrics {
  return {
    decoded: false,
    decodeError,
    sampleRate: 0,
    channelCount: 0,
    durationMs: 0,
    activeWindows: 0,
    activeSpeechMs: 0,
    speechCoverage: 0,
    insufficientSpeech: true,
    balanceDeltaDb: Infinity,
    clippingCount: 0,
    truePeakDbfs: -Infinity,
    channels: [],
    status: 'failed',
    reasons: ['decode-failed'],
  };
}
