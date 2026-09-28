export interface RecordingSessionOptions {
  recorder: MediaRecorder;
  micStream: MediaStream | null;
  ownsMic: boolean;
  mimeType: string;
  cleanupGraph: () => void;
  onChunk?: (chunk: Blob, sequence: number) => void | Promise<void>;
}

export interface RecordingSession {
  readonly recorder: MediaRecorder;
  readonly ownsMic: boolean;
  stopAndCollect: () => Promise<Blob>;
  cleanup: () => void;
  abort: () => void;
}

export function createRecordingSession(options: RecordingSessionOptions): RecordingSession {
  const { recorder, micStream, ownsMic, mimeType, cleanupGraph, onChunk } = options;
  const chunks: Blob[] = [];
  const pendingChunkWrites: Promise<void>[] = [];
  let sequence = 0;
  let cleaned = false;
  let stopRequested = false;
  let resolveStopped: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const onData = (event: BlobEvent) => {
    if (event.data?.size) {
      chunks.push(event.data);
      const write = onChunk?.(event.data, sequence++);
      if (write) pendingChunkWrites.push(Promise.resolve(write));
    }
  };
  const onStop = () => resolveStopped?.();
  recorder.addEventListener('dataavailable', onData);
  recorder.addEventListener('stop', onStop, { once: true });

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    recorder.removeEventListener('dataavailable', onData);
    recorder.removeEventListener('stop', onStop);
    cleanupGraph();
    if (ownsMic) micStream?.getTracks().forEach((track) => { try { track.stop(); } catch {} });
    chunks.length = 0;
  };

  const stopAndCollect = async () => {
    if (!stopRequested && recorder.state !== 'inactive') {
      stopRequested = true;
      recorder.stop();
    }
    if (recorder.state !== 'inactive') await stopped;
    else await Promise.resolve();
    await Promise.all(pendingChunkWrites);
    return new Blob(chunks, { type: mimeType });
  };

  const abort = () => {
    if (recorder.state === 'inactive') { cleanup(); return; }
    void stopAndCollect().catch(() => undefined).finally(cleanup);
  };

  return { recorder, ownsMic, stopAndCollect, cleanup, abort };
}
