export type RecordingLifecycleState = 'idle' | 'recording' | 'stopping' | 'finalized';

export interface RecordingStopAccepted {
  status: RecordingLifecycleState;
  recordingId: string;
  requestId: string;
  stopAt: number;
}

export interface RecordingStopAck {
  type: 'recording-stop-ack';
  status: 'finalized';
  recordingId: string;
  requestId: string;
  stopAt: number;
  inflight: number;
}

/** Serializes recording control messages that can arrive on the same socket concurrently. */
export class RecordingControlQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class RecordingStopCoordinator {
  private state: RecordingLifecycleState = 'idle';
  private recordingId = '';
  private stopRequestId = '';
  private stopAt = 0;
  private inflight = new Set<Promise<unknown>>();
  private finalizationPromise: Promise<RecordingStopAck> | null = null;
  private finalizationAck: RecordingStopAck | null = null;

  start(recordingId: string): void {
    if (!recordingId.trim()) throw new Error('Recording id is required');
    if (this.state === 'recording' || this.state === 'stopping') {
      if (this.recordingId === recordingId) return;
      throw new Error('Another recording is already active');
    }
    this.state = 'recording';
    this.recordingId = recordingId;
    this.stopRequestId = '';
    this.stopAt = 0;
    this.finalizationPromise = null;
    this.finalizationAck = null;
    this.inflight.clear();
  }

  track<T>(work: Promise<T>): Promise<T> {
    if (this.state !== 'recording') throw new Error('Recording is not accepting work');
    const tracked = Promise.resolve(work);
    this.inflight.add(tracked);
    tracked.then(
      () => this.inflight.delete(tracked),
      () => this.inflight.delete(tracked),
    );
    return tracked;
  }

  requestStop(requestId: string, stopAt: number): RecordingStopAccepted {
    if (!requestId.trim()) throw new Error('Stop request id is required');
    if (this.state === 'idle') throw new Error('No recording is active');
    if (this.stopRequestId && this.stopRequestId !== requestId) {
      throw new Error('A different stop request is already in progress');
    }
    if (this.state === 'finalized' && this.finalizationAck) {
      return {
        status: 'finalized',
        recordingId: this.recordingId,
        requestId: this.stopRequestId,
        stopAt: this.stopAt,
      };
    }
    this.stopRequestId = requestId;
    this.stopAt = stopAt;
    this.state = 'stopping';
    return {
      status: 'stopping',
      recordingId: this.recordingId,
      requestId,
      stopAt,
    };
  }

  finalize(requestId: string, finalize: () => Promise<void> | void): Promise<RecordingStopAck> {
    if (this.state === 'idle') return Promise.reject(new Error('No recording is active'));
    if (this.stopRequestId !== requestId) {
      return Promise.reject(new Error('Stop request id does not match the active recording'));
    }
    if (this.finalizationPromise) return this.finalizationPromise;

    this.finalizationPromise = (async () => {
      await Promise.all([...this.inflight]);
      await finalize();
      const ack: RecordingStopAck = {
        type: 'recording-stop-ack',
        status: 'finalized',
        recordingId: this.recordingId,
        requestId,
        stopAt: this.stopAt,
        inflight: this.inflight.size,
      };
      this.finalizationAck = ack;
      this.state = 'finalized';
      return ack;
    })();
    return this.finalizationPromise;
  }

  getState(): RecordingLifecycleState {
    return this.state;
  }
}
