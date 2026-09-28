type ArchiveSocket = {
  readonly readyState: number;
  send(data: string): void;
};

const OPEN = 1;

export interface HumanArchiveCaptureOptions {
  context: AudioContext;
  stream?: MediaStream;
  episodeId: string;
  getSocket: () => ArchiveSocket | null;
  onFrame?: (frame: { sequence: number; sampleRate: number; sampleCount: number; bytes: Uint8Array }) => void;
  captureFromStream?: boolean;
}

export function float32ToPcm16(input: Float32Array): Uint8Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(output.buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function createHumanArchiveCapture(options: HumanArchiveCaptureOptions) {
  const shouldCaptureFromStream = options.captureFromStream !== false;
  if (shouldCaptureFromStream && !options.stream) {
    throw new Error('Human archive capture requires a microphone stream.');
  }
  const source = shouldCaptureFromStream && options.stream
    ? options.context.createMediaStreamSource(options.stream)
    : null;
  const processor = shouldCaptureFromStream ? options.context.createScriptProcessor(2048, 1, 1) : null;
  const silentGain = shouldCaptureFromStream ? options.context.createGain() : null;
  if (silentGain) silentGain.gain.value = 0;
  let sequence = 0;
  let active = false;

  const sendFrame = (input: Float32Array, sampleRate: number) => {
    if (!active || !input.length) return;
    const bytes = float32ToPcm16(input);
    const frame = {
      sequence,
      sampleRate,
      sampleCount: input.length,
      bytes,
    };
    sequence += 1;
    options.onFrame?.(frame);

    const socket = options.getSocket();
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify({
      type: 'human-archive',
      episodeId: options.episodeId,
      sequence: frame.sequence,
      sampleRate: frame.sampleRate,
      channels: 1,
      sampleCount: frame.sampleCount,
      mimeType: `audio/pcm;rate=${frame.sampleRate}`,
      capturedAtMs: Date.now(),
      data: bytesToBase64(frame.bytes),
    }));
  };

  if (processor && source && silentGain) {
    processor.onaudioprocess = (event) => {
      if (!active) return;
      sendFrame(event.inputBuffer.getChannelData(0), options.context.sampleRate);
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(options.context.destination);
  }

  return {
    start() {
      active = true;
    },
    stop() {
      active = false;
      try { processor?.disconnect(); } catch {}
      try { source?.disconnect(); } catch {}
      try { silentGain?.disconnect(); } catch {}
      if (processor) processor.onaudioprocess = null;
    },
    sendFrame,
  };
}


