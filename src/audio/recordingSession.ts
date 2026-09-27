export interface RecordingSessionOptions {
  recorder: MediaRecorder;
  micStream: MediaStream | null;
  ownsMic: boolean;
  mimeType: string;
  cleanupGraph: () => void;
}

export interface RecordingSession {
  readonly recorder: MediaRecorder;
  readonly ownsMic: boolean;
  stopAndCollect: () => Promise<Blob>;
  cleanup: () => void;
  abort: () => void;
}

export function createRecordingSession(options: RecordingSessionOptions): RecordingSession {
  const { recorder, micStream, ownsMic, mimeType, cleanupGraph } = options;
  const chunks: Blob[] = [];
  let cleaned = false;
  let stopRequested = false;
  let resolveStopped: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const onData = (event: BlobEvent) => { if (event.data?.size) chunks.push(event.data); };
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
    return new Blob(chunks, { type: mimeType });
  };

  const abort = () => {
    if (recorder.state === 'inactive') { cleanup(); return; }
    void stopAndCollect().catch(() => undefined).finally(cleanup);
  };

  return { recorder, ownsMic, stopAndCollect, cleanup, abort };
}
