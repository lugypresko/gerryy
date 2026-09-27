import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Radio,
  Volume2,
  VolumeX,
  RotateCcw,
  Download,
  Send,
  Loader2,
  AlertCircle,
  Square,
  Activity,
  PhoneCall,
} from 'lucide-react';
import { createRecordingGraph, type RecordingGraph } from './audio/recordingGraph';
import { finalizeEpisode, type FinalizedEpisode } from './audio/episodeFinalizer';
import {
  endGuestInterruption,
  appendGuestInterruption,
  createGuestVadState,
  updateGuestVad,
  type TurnLogEntry,
  type GuestInterruptionTurn,
  type GuestVadState,
} from './audio/turnLog';
import {
  JERRY_MOUTH_ANCHORS,
  JERRY_POSES,
  JERRY_POSE_CROSSFADE_MS,
  type JerryAnimationEvent,
  type JerryAnimationState,
  type JerryPose,
  nextAnimationState,
  poseForState,
} from './jerryAnimation';

export interface PodcastMessage {
  id: string;
  sender: 'jerry' | 'user';
  text: string;
  timestamp: string;
  audioUrl?: string;
  pose?: 'speaking' | 'listening' | 'phone' | 'skeptical';
}

const JERRY_INITIAL_OPENING =
  'שמע, ערב טוב. ג\'רי, תוכנית הלילה. איתי אמר לי... לא משנה מה איתי אמר, איתי והשטויות שלו. מה הדבר הכי מוזר שקרה לך השבוע?';

export function JerryPodcastStudio() {
  const [messages, setMessages] = useState<PodcastMessage[]>([
    {
      id: 'm-0',
      sender: 'jerry',
      text: JERRY_INITIAL_OPENING,
      timestamp: '00:01',
      audioUrl: '/jerry-opening.wav',
      pose: 'speaking',
    },
  ]);

  const [inputText, setInputText] = useState('');
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [isJerryThinking, setIsJerryThinking] = useState(false);
  const [isJerrySpeaking, setIsJerrySpeaking] = useState(false);
  const [jerryPose, setJerryPose] = useState<'speaking' | 'listening' | 'phone' | 'skeptical'>('speaking');
  const [animationState, setAnimationState] = useState<JerryAnimationState>('idle');
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [micTranscript, setMicTranscript] = useState('');
  const [isMuted, setIsMuted] = useState(false);

  // Audio Analyser & Lip-Sync state (0: closed, 1: slightly open, 2: wide open)
  const [mouthStage, setMouthStage] = useState<0 | 1 | 2>(0);
  const [mouthOpenAmount, setMouthOpenAmount] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [jawBounce, setJawBounce] = useState(0);

  // Full Podcast Recording (Master Mix)
  const [isEpisodeRecording, setIsEpisodeRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [episodeAudioUrl, setEpisodeAudioUrl] = useState<string | null>(null);
  const [episodeFileExtension, setEpisodeFileExtension] = useState('webm');
  const [finalizedEpisode, setFinalizedEpisode] = useState<FinalizedEpisode | null>(null);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  const [isLiveReady, setIsLiveReady] = useState(false);
  const [isPcmDebugRecording, setIsPcmDebugRecording] = useState(false);
  const [pcmDebugAudioUrl, setPcmDebugAudioUrl] = useState<string | null>(null);
  const messagesRef = useRef<PodcastMessage[]>(messages);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Audio & WebRTC references
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Mixer refs for recording both Mic + Jerry
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingGraphRef = useRef<RecordingGraph | null>(null);
  const jerryRecordingInputRef = useRef<GainNode | null>(null);
  const jerryPlaybackGainRef = useRef<GainNode | null>(null);
  const recordingMonitorMixRef = useRef<GainNode | null>(null);
  const recordingMonitorJerryGainRef = useRef<GainNode | null>(null);
  const recordingMonitorGuestGainRef = useRef<GainNode | null>(null);
  const micMediaStreamRef = useRef<MediaStream | null>(null);
  const episodeOwnsMicRef = useRef(false);
  const recordingModeRef = useRef<'dual-channel' | 'jerry-only' | null>(null);
  const timerIntervalRef = useRef<any>(null);

  // Gemini Live low-latency streaming refs
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveTranscriptRef = useRef('');
  const livePcmChunksRef = useRef<Uint8Array[]>([]);
  const liveAudioEndTimeRef = useRef(0);
  const liveTurnTimerRef = useRef<number | null>(null);
  const livePlaybackProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const livePlaybackQueueRef = useRef<Float32Array[]>([]);
  const livePlaybackReadOffsetRef = useRef(0);
  const liveQueuedSamplesRef = useRef(0);
  const liveMicStreamRef = useRef<MediaStream | null>(null);
  const liveMicSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const liveMicProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const liveMicContextRef = useRef<AudioContext | null>(null);
  const liveMicSilentGainRef = useRef<GainNode | null>(null);
  const liveMicActiveRef = useRef(false);
  const liveInputTranscriptRef = useRef('');
  const liveUserTurnCommittedRef = useRef(false);
  const smoothedLipLevelRef = useRef(0);
  const quietLipFramesRef = useRef(0);
  const pcmDebugChunksRef = useRef<Uint8Array[]>([]);
  const pcmDebugStopTimerRef = useRef<number | null>(null);
  const pcmDebugRecordingRef = useRef(false);
  const getUserMediaRequestRef = useRef(0);
  const lastEnergyTransitionRef = useRef(0);
  const isJerrySpeakingRef = useRef(false);
  const guestVadStateRef = useRef<GuestVadState>(createGuestVadState());
  const guestInterruptionTurnRef = useRef<GuestInterruptionTurn | null>(null);
  const turnLogRef = useRef<TurnLogEntry[]>([]);

  useEffect(() => {
    isJerrySpeakingRef.current = isJerrySpeaking;
  }, [isJerrySpeaking]);

  const emitLiveDebugEvent = (event: string, details: Record<string, unknown> = {}) => {
    const payload = { type: 'debug-event', event, category: 'overlap', ...details };
    console.info('[Jerry Overlap]', payload);
    if (liveSocketRef.current?.readyState === WebSocket.OPEN) {
      liveSocketRef.current.send(JSON.stringify({ type: 'debug-event', event, category: 'overlap', ...details }));
    }
  };

  const emitRecordingDebugEvent = (event: string, details: Record<string, unknown> = {}) => {
    const payload = { type: 'debug-event', event, category: 'recording', ...details };
    console.info('[Jerry Recording]', payload);
    if (liveSocketRef.current?.readyState === WebSocket.OPEN) {
      liveSocketRef.current.send(JSON.stringify(payload));
    }
  };

  const finishGuestInterruption = (endedAt = Date.now()) => {
    const activeTurn = guestInterruptionTurnRef.current;
    if (!activeTurn) return;

    const completedTurn = endGuestInterruption(activeTurn, endedAt);
    turnLogRef.current = turnLogRef.current.map((turn) =>
      turn.id === completedTurn.id ? completedTurn : turn,
    );
    guestInterruptionTurnRef.current = null;
    guestVadStateRef.current = createGuestVadState();
    emitLiveDebugEvent('guest-interruption-end', {
      turnId: completedTurn.id,
      overlapDurationMs: completedTurn.overlapDurationMs,
    });
  };

  const cancelJerryGeneration = (overlapDurationMs: number) => {
    if (liveTurnTimerRef.current) {
      window.clearTimeout(liveTurnTimerRef.current);
      liveTurnTimerRef.current = null;
    }
    livePlaybackQueueRef.current = [];
    livePlaybackReadOffsetRef.current = 0;
    liveQueuedSamplesRef.current = 0;
    livePcmChunksRef.current = [];
    liveTranscriptRef.current = '';
    setIsJerrySpeaking(false);
    isJerrySpeakingRef.current = false;
    setIsJerryThinking(false);
    setMouthStage(0);
    setMouthOpenAmount(0);
    transitionAnimation('turn-complete');
    setJerryPose('listening');
    emitLiveDebugEvent('jerry-generation-cancelled', {
      reason: 'guest-overlap',
      overlapDurationMs,
      recordingPathsPreserved: true,
    });
  };

  const transitionAnimation = useCallback((event: JerryAnimationEvent) => {
    setAnimationState((current) => nextAnimationState(current, event));
  }, []);

  // Auto-scroll chat messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isJerryThinking]);

  const base64ToBytes = (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const resampleTo16kPcm = (input: Float32Array, inputRate: number) => {
    const targetRate = 16000;
    if (!input.length) return new Uint8Array();

    const ratio = inputRate / targetRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += input[j];
        count++;
      }
      const sample = Math.max(-1, Math.min(1, count ? sum / count : input[start] || 0));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return new Uint8Array(output.buffer);
  };

  const pcm16ChunksToWavBlob = (chunks: Uint8Array[], sampleRate = 16000) => {
    const dataLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeAscii = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (const chunk of chunks) {
      new Uint8Array(buffer, offset, chunk.byteLength).set(chunk);
      offset += chunk.byteLength;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  };

  const finishPcmDebugCapture = useCallback(() => {
    if (!pcmDebugChunksRef.current.length) {
      pcmDebugRecordingRef.current = false;
      setIsPcmDebugRecording(false);
      setErrorNotice('לא נאסף אודיו בבדיקת PCM.');
      return;
    }

    const blob = pcm16ChunksToWavBlob(pcmDebugChunksRef.current, 16000);
    const url = URL.createObjectURL(blob);

    setPcmDebugAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setIsPcmDebugRecording(false);
    pcmDebugRecordingRef.current = false;
    pcmDebugChunksRef.current = [];
    pcmDebugStopTimerRef.current = null;

    console.info('[PCM Debug] capture ready', {
      bytes: blob.size,
      type: blob.type,
      sampleRate: 16000,
    });
  }, []);

  async function startPcmDebugCapture() {
    setErrorNotice(null);

    if (!isLiveReady) {
      setErrorNotice('Gemini Live עדיין לא מחובר. המתן עד שיופיע GEMINI LIVE ואז נסה שוב.');
      return;
    }

    pcmDebugChunksRef.current = [];
    pcmDebugRecordingRef.current = true;
    setIsPcmDebugRecording(true);

    if (!liveMicActiveRef.current) {
      await startLiveMic();
    }

    if (pcmDebugStopTimerRef.current) {
      window.clearTimeout(pcmDebugStopTimerRef.current);
    }

    pcmDebugStopTimerRef.current = window.setTimeout(() => {
      finishPcmDebugCapture();
    }, 5000);
  }

  const commitLiveUserTurn = useCallback(() => {
    if (liveUserTurnCommittedRef.current) return;
    const text = liveInputTranscriptRef.current.trim();
    if (!text) return;

    liveUserTurnCommittedRef.current = true;
    setMessages((prev) => [
      ...prev,
      {
        id: `m-${Date.now()}-guest`,
        sender: 'user',
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  }, []);

  const stopLiveMic = useCallback(() => {
    finishGuestInterruption();
    getUserMediaRequestRef.current += 1;
    liveMicActiveRef.current = false;

    try {
      liveMicProcessorRef.current?.disconnect();
    } catch {}
    try {
      liveMicSourceRef.current?.disconnect();
    } catch {}
    try {
      liveMicSilentGainRef.current?.disconnect();
    } catch {}

    liveMicProcessorRef.current = null;
    liveMicSourceRef.current = null;
    liveMicSilentGainRef.current = null;

    if (liveMicStreamRef.current) {
      liveMicStreamRef.current.getTracks().forEach((track) => track.stop());
      liveMicStreamRef.current = null;
    }

    if (liveMicContextRef.current) {
      try {
        void liveMicContextRef.current.close();
      } catch {}
      liveMicContextRef.current = null;
    }

    if (liveSocketRef.current?.readyState === WebSocket.OPEN) {
      liveSocketRef.current.send(JSON.stringify({ type: 'activity-end' }));
    }

    setIsRecordingMic(false);
  }, []);

  const startLiveMic = useCallback(async () => {
    if (!isLiveReady || liveSocketRef.current?.readyState !== WebSocket.OPEN) return;

    // A new guest turn owns the floor. Stop any previous Jerry replay/opening.
    if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    // Mark Live mic ownership before any async permission prompt. This prevents
    // a stale Web Speech "onend" event from immediately turning the mic UI off.
    liveMicActiveRef.current = true;
    guestVadStateRef.current = createGuestVadState();
    setIsRecordingMic(true);
    setErrorNotice(null);
    liveInputTranscriptRef.current = '';
    liveUserTurnCommittedRef.current = false;
    setMicTranscript('');
    setInputText('');

    const requestId = ++getUserMediaRequestRef.current;
    try {
      // Make sure the fallback recognizer is not holding the browser microphone.
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort?.();
        } catch {}
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (requestId !== getUserMediaRequestRef.current || !liveMicActiveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      liveMicStreamRef.current = stream;

      // Push-to-talk gives us exact speech boundaries; tell the STT model
      // explicitly so background tones/silence are not mistaken for speech.
      if (liveSocketRef.current?.readyState === WebSocket.OPEN) {
        liveSocketRef.current.send(JSON.stringify({ type: 'activity-start' }));
      }

      const [track] = stream.getAudioTracks();
      if (!track || track.readyState !== 'live') {
        throw new Error('Microphone track is not live');
      }

      track.onended = () => {
        if (!liveMicActiveRef.current) return;
        liveMicActiveRef.current = false;
        setIsRecordingMic(false);
        setErrorNotice('המיקרופון נסגר על ידי הדפדפן או מערכת ההפעלה. בדוק הרשאת מיקרופון ונסה שוב.');
      };

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const micCtx = new AudioCtx();
      liveMicContextRef.current = micCtx;

      if (micCtx.state === 'suspended') {
        await micCtx.resume();
      }

      const source = micCtx.createMediaStreamSource(stream);
      const processor = micCtx.createScriptProcessor(2048, 1, 1);
      liveMicSourceRef.current = source;
      liveMicProcessorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (!liveMicActiveRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i];
        const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
        const guestSpeechRmsDbfs = 20 * Math.log10(Math.max(rms, 0.00001));

        const vadTransition = updateGuestVad(guestVadStateRef.current, guestSpeechRmsDbfs);
        guestVadStateRef.current = vadTransition.state;

        if (
          vadTransition.started &&
          isJerrySpeakingRef.current &&
          !guestInterruptionTurnRef.current
        ) {
          const startedAt = Date.now();
          turnLogRef.current = appendGuestInterruption(turnLogRef.current, startedAt);
          const interruption = turnLogRef.current[turnLogRef.current.length - 1] as GuestInterruptionTurn;
          guestInterruptionTurnRef.current = interruption;
          emitLiveDebugEvent('guest-interruption-start', {
            turnId: interruption.id,
            guestSpeechRmsDbfs,
          });
          cancelJerryGeneration(Math.max(0, Date.now() - startedAt));
        }

        if (guestInterruptionTurnRef.current && vadTransition.ended) {
          finishGuestInterruption();
        }

        const socket = liveSocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const pcm = resampleTo16kPcm(input, micCtx.sampleRate);
        if (!pcm.byteLength) return;

        // Capture exactly the same 16kHz PCM bytes that are sent to Gemini Live.
        if (pcmDebugRecordingRef.current) {
          pcmDebugChunksRef.current.push(new Uint8Array(pcm));
        }

        socket.send(
          JSON.stringify({
            type: 'audio',
            data: bytesToBase64(pcm),
            mimeType: 'audio/pcm;rate=16000',
          }),
        );
      };

      source.connect(processor);
      const silentGain = micCtx.createGain();
      silentGain.gain.value = 0;
      liveMicSilentGainRef.current = silentGain;
      processor.connect(silentGain);
      silentGain.connect(micCtx.destination);

      transitionAnimation('mic-start');
      setJerryPose('listening');
      console.info('[Jerry Live] microphone active', {
        label: track.label,
        state: track.readyState,
        sampleRate: micCtx.sampleRate,
      });
    } catch (err: any) {
      console.error('[Jerry Live] microphone start failed:', err);
      liveMicActiveRef.current = false;

      if (liveMicStreamRef.current) {
        liveMicStreamRef.current.getTracks().forEach((track) => track.stop());
        liveMicStreamRef.current = null;
      }
      if (liveMicContextRef.current) {
        try {
          void liveMicContextRef.current.close();
        } catch {}
        liveMicContextRef.current = null;
      }

      const reason =
        err?.name === 'NotAllowedError'
          ? 'הרשאת המיקרופון חסומה בדפדפן. אפשר הרשאה לאתר ונסה שוב.'
          : err?.name === 'NotFoundError'
          ? 'לא נמצא מיקרופון זמין במחשב.'
          : 'לא ניתן לפתוח את המיקרופון לשיחה החיה: ' + (err?.message || 'שגיאה לא ידועה');

      setErrorNotice(reason);
      setIsRecordingMic(false);
    }
  }, [isLiveReady, isPcmDebugRecording]);

  const pcm16ChunksToWavUrl = (chunks: Uint8Array[], sampleRate = 24000) => {
    const dataLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (!dataLength) return undefined;

    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const writeAscii = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (const chunk of chunks) {
      new Uint8Array(buffer, offset, chunk.byteLength).set(chunk);
      offset += chunk.byteLength;
    }

    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  };

  const ensureLivePlaybackProcessor = useCallback(() => {
    const ctx = getAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') void ctx.resume();

    if (livePlaybackProcessorRef.current) {
      return livePlaybackProcessorRef.current;
    }

    // One continuous output node drains a PCM queue. This avoids creating a
    // separate AudioBufferSourceNode for every network chunk, which can produce
    // periodic clicks/tones at chunk boundaries.
    const processor = ctx.createScriptProcessor(2048, 0, 1);
    processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);

      let writeOffset = 0;
      while (writeOffset < output.length && livePlaybackQueueRef.current.length > 0) {
        const head = livePlaybackQueueRef.current[0];
        const readOffset = livePlaybackReadOffsetRef.current;
        const available = head.length - readOffset;
        const needed = output.length - writeOffset;
        const count = Math.min(available, needed);

        output.set(head.subarray(readOffset, readOffset + count), writeOffset);
        writeOffset += count;
        livePlaybackReadOffsetRef.current += count;
        liveQueuedSamplesRef.current = Math.max(0, liveQueuedSamplesRef.current - count);

        if (livePlaybackReadOffsetRef.current >= head.length) {
          livePlaybackQueueRef.current.shift();
          livePlaybackReadOffsetRef.current = 0;
        }
      }
    };

    if (analyserRef.current) {
      processor.connect(analyserRef.current);
    } else {
      processor.connect(ctx.destination);
    }
    if (jerryRecordingInputRef.current) {
      processor.connect(jerryRecordingInputRef.current);
    }

    livePlaybackProcessorRef.current = processor;
    return processor;
  }, []);

  const playLivePcmChunk = useCallback(
    (base64: string, mimeType = 'audio/pcm;rate=24000') => {
      if (isMuted) return;
      // Chunks already in flight after an interruption must not restart Jerry
      // while the guest owns the floor. Recording paths remain untouched.
      if (guestInterruptionTurnRef.current) return;

      // Audio-source invariant: Jerry may have only ONE audible voice at a time.
      // Stop any opening/replay/fallback <audio> before streamed Live PCM starts.
      if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.currentTime = 0;
      }

      const bytes = base64ToBytes(base64);
      livePcmChunksRef.current.push(bytes);

      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (!sampleCount) return;

      const sourceSamples = new Float32Array(sampleCount);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < sampleCount; i++) {
        sourceSamples[i] = view.getInt16(i * 2, true) / 32768;
      }

      // Gemini Live returns PCM at ~24 kHz, while Chrome's AudioContext is
      // commonly 48 kHz. Writing 24 kHz samples directly into a 48 kHz output
      // plays Jerry at 2x speed/pitch and makes him nearly unintelligible.
      const sourceRateMatch = /rate=(\d+)/i.exec(mimeType || '');
      const sourceRate = sourceRateMatch ? Number(sourceRateMatch[1]) : 24000;
      const ctx = getAudioContext();
      const targetRate = ctx?.sampleRate || sourceRate;

      let playbackSamples = sourceSamples;
      if (sourceRate > 0 && targetRate > 0 && sourceRate !== targetRate) {
        const ratio = targetRate / sourceRate;
        const outputLength = Math.max(1, Math.round(sourceSamples.length * ratio));
        const resampled = new Float32Array(outputLength);

        for (let i = 0; i < outputLength; i++) {
          const sourcePos = i / ratio;
          const left = Math.floor(sourcePos);
          const right = Math.min(sourceSamples.length - 1, left + 1);
          const frac = sourcePos - left;
          const a = sourceSamples[left] ?? 0;
          const b = sourceSamples[right] ?? a;
          resampled[i] = a + (b - a) * frac;
        }
        playbackSamples = resampled;
      }

      livePlaybackQueueRef.current.push(playbackSamples);
      liveQueuedSamplesRef.current += playbackSamples.length;
      ensureLivePlaybackProcessor();

      setIsJerryThinking(false);
      setIsJerrySpeaking(true);
      isJerrySpeakingRef.current = true;
      transitionAnimation('output-audio');
      setJerryPose('speaking');
    },
    [isMuted, ensureLivePlaybackProcessor, transitionAnimation],
  );

  // Open one persistent Gemini Live session for the podcast instead of doing
  // LLM -> full TTS -> playback on every turn.
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/jerry-live-socket`);
      liveSocketRef.current = socket;

      socket.onopen = () => {
        console.info('[Jerry Live] browser socket connected');
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'ready') {
            setIsLiveReady(true);

            // A reconnect creates a fresh Gemini Live session. Restore only completed
            // conversation turns, ending at the most recent Jerry/model turn, so the
            // new session has context without accidentally replaying an unfinished user turn.
            const history = messagesRef.current;
            let lastModelIndex = -1;
            for (let i = history.length - 1; i >= 0; i--) {
              if (history[i].sender === 'jerry') {
                lastModelIndex = i;
                break;
              }
            }

            const firstUserIndex = history.findIndex((m) => m.sender === 'user');
            if (
              firstUserIndex >= 0 &&
              lastModelIndex >= firstUserIndex &&
              socket.readyState === WebSocket.OPEN
            ) {
              socket.send(
                JSON.stringify({
                  type: 'restore-history',
                  turns: history.slice(firstUserIndex, lastModelIndex + 1).map((m) => ({
                    role: m.sender === 'user' ? 'user' : 'model',
                    text: m.text,
                  })),
                }),
              );
            }
            return;
          }

          if (msg.type === 'audio' && msg.data) {
            playLivePcmChunk(msg.data, msg.mimeType || 'audio/pcm;rate=24000');
            return;
          }

          if (msg.type === 'input-transcript-interim' && msg.text) {
            setMicTranscript(msg.text);
            return;
          }

          if (msg.type === 'input-transcript' && msg.text) {
            liveInputTranscriptRef.current = msg.text;
            setMicTranscript(msg.text);
            commitLiveUserTurn();
            return;
          }

          if (msg.type === 'stt-error') {
            console.error('[Jerry STT] server error:', msg.message);
            setErrorNotice('תמלול העברית נכשל: ' + (msg.message || 'שגיאת STT'));
            return;
          }

          if (msg.type === 'stt-retry') {
            console.warn('[Jerry STT] rejected transcript:', msg.text);
            liveInputTranscriptRef.current = '';
            setMicTranscript('');
            setIsJerryThinking(false);
            setErrorNotice(msg.message || 'לא הצלחתי לזהות את העברית. נסה שוב.');
            return;
          }

          if (msg.type === 'transcript' && msg.text) {
            liveTranscriptRef.current += msg.text;
            return;
          }

          if (msg.type === 'interrupted') {
            finishGuestInterruption();
            liveAudioEndTimeRef.current = audioContextRef.current?.currentTime || 0;
            livePcmChunksRef.current = [];
            livePlaybackQueueRef.current = [];
            livePlaybackReadOffsetRef.current = 0;
            liveQueuedSamplesRef.current = 0;
            liveTranscriptRef.current = '';
            setIsJerrySpeaking(false);
            setIsJerryThinking(false);
            transitionAnimation('turn-complete');
            setJerryPose('listening');
            return;
          }

          if (msg.type === 'turn-complete') {
            finishGuestInterruption();
            const replyText = liveTranscriptRef.current.trim() || '...';
            const audioUrl = pcm16ChunksToWavUrl(livePcmChunksRef.current);

            setMessages((prev) => [
              ...prev,
              {
                id: `m-${Date.now()}`,
                sender: 'jerry',
                text: replyText,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                audioUrl,
                pose: 'speaking',
              },
            ]);
            if (/[חח😂🤣]|מצחיק|משעשע|笑/.test(replyText)) {
              transitionAnimation('response-amused');
            }

            liveTranscriptRef.current = '';
            livePcmChunksRef.current = [];

            const playbackRate = audioContextRef.current?.sampleRate || 48000;
            const remainingMs = Math.max(
              0,
              (liveQueuedSamplesRef.current / playbackRate) * 1000,
            );

            if (liveTurnTimerRef.current) window.clearTimeout(liveTurnTimerRef.current);
            liveTurnTimerRef.current = window.setTimeout(() => {
              setIsJerrySpeaking(false);
              setIsJerryThinking(false);
              transitionAnimation('turn-complete');
              setJerryPose('listening');
              setMouthStage(0);
              setMouthOpenAmount(0);
            }, remainingMs + 60);
            return;
          }

          if (msg.type === 'error') {
            console.error('[Jerry Live] server error:', msg.message);
            setIsLiveReady(false);
            setIsJerryThinking(false);
            setErrorNotice('Gemini Live לא זמין כרגע; עובר אוטומטית למסלול הרגיל.');
          }
        } catch (err) {
          console.warn('[Jerry Live] bad socket message:', err);
        }
      };

      socket.onerror = (event) => {
        console.warn('[Jerry Live] browser socket error:', event);
        setIsLiveReady(false);
      };

      socket.onclose = () => {
        setIsLiveReady(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 1200);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (liveTurnTimerRef.current) window.clearTimeout(liveTurnTimerRef.current);
      try {
        livePlaybackProcessorRef.current?.disconnect();
      } catch {}
      livePlaybackProcessorRef.current = null;
      livePlaybackQueueRef.current = [];
      livePlaybackReadOffsetRef.current = 0;
      liveQueuedSamplesRef.current = 0;
      try {
        liveSocketRef.current?.close();
      } catch {}
      liveSocketRef.current = null;
    };
  }, [playLivePcmChunk, commitLiveUserTurn, transitionAnimation]);

  // Episode Recording Timer
  useEffect(() => {
    if (isEpisodeRecording) {
      setRecordingSeconds(0);
      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [isEpisodeRecording]);

  // Initialize Web Audio Context and Analyser for LipSync & Recording
  const getAudioContext = () => {
    if (!audioContextRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.2; // fast response to syllables

      const jerryRecordingInput = ctx.createGain();
      jerryRecordingInput.gain.value = 1;
      const jerryPlaybackGain = ctx.createGain();
      jerryPlaybackGain.gain.value = 1;

      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      jerryRecordingInputRef.current = jerryRecordingInput;
      jerryPlaybackGainRef.current = jerryPlaybackGain;

      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new Audio();
        audioPlayerRef.current.crossOrigin = 'anonymous';
      }

      try {
        const source = ctx.createMediaElementSource(audioPlayerRef.current);
        source.connect(analyser);
        source.connect(jerryRecordingInput);
      } catch (e) {
        // already connected
      }
      analyser.connect(jerryPlaybackGain);
      jerryPlaybackGain.connect(ctx.destination);
    }
    return audioContextRef.current;
  };

  const cleanupRecordingGraph = useCallback(() => {
    try {
      recordingMonitorJerryGainRef.current?.disconnect();
      recordingMonitorGuestGainRef.current?.disconnect();
      recordingMonitorMixRef.current?.disconnect();
    } catch {}
    recordingMonitorJerryGainRef.current = null;
    recordingMonitorGuestGainRef.current = null;
    recordingMonitorMixRef.current = null;

    try {
      recordingGraphRef.current?.cleanup();
    } catch (err) {
      console.warn('[Podcast Recorder] graph cleanup failed:', err);
    }
    recordingGraphRef.current = null;
    recordingModeRef.current = null;
    if (jerryPlaybackGainRef.current) {
      jerryPlaybackGainRef.current.gain.value = 1;
    }
  }, []);

  const cleanupRecordingResources = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {}
    }
    // Keep the direct teardown path explicit for browsers with a partially initialized recorder.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'inactive') {
      mediaRecorderRef.current?.stop();
    }
    mediaRecorderRef.current = null;
    if (episodeOwnsMicRef.current && micMediaStreamRef.current) {
      micMediaStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    micMediaStreamRef.current = null;
    episodeOwnsMicRef.current = false;
    cleanupRecordingGraph();
  }, [cleanupRecordingGraph]);

  useEffect(() => () => {
    stopLiveMic();
    cleanupRecordingResources();
    if (pcmDebugStopTimerRef.current) window.clearTimeout(pcmDebugStopTimerRef.current);
    pcmDebugRecordingRef.current = false;
    if (episodeAudioUrl) URL.revokeObjectURL(episodeAudioUrl);
    if (pcmDebugAudioUrl) URL.revokeObjectURL(pcmDebugAudioUrl);
  }, [stopLiveMic, cleanupRecordingResources, episodeAudioUrl, pcmDebugAudioUrl]);

  useEffect(() => {
    const preloaders = Object.values(JERRY_POSES).map((src) => {
      const image = new Image();
      image.src = src;
      return image;
    });
    return () => preloaders.forEach((image) => { image.onload = null; image.onerror = null; });
  }, []);

  useEffect(() => {
    if (isMuted) {
      audioPlayerRef.current?.pause();
      livePlaybackQueueRef.current = [];
      livePlaybackReadOffsetRef.current = 0;
      liveQueuedSamplesRef.current = 0;
    }
    if (jerryPlaybackGainRef.current) {
      jerryPlaybackGainRef.current.gain.value = isMuted ? 0 : recordingGraphRef.current ? 0 : 1;
    }
  }, [isMuted]);

  useEffect(() => {
    if (!isEpisodeRecording) return;

    let frame: number | null = null;
    let previousTime = performance.now();
    const updateRecordingGraph = (now: number) => {
      recordingGraphRef.current?.update(Math.max(0, now - previousTime));
      previousTime = now;
      if (recordingGraphRef.current) {
        frame = requestAnimationFrame(updateRecordingGraph);
      }
    };

    frame = requestAnimationFrame(updateRecordingGraph);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isEpisodeRecording]);

  // Puppet-style mouth gating. Jerry is felt, so syllable energy matters more
  // than human phoneme-perfect lip shapes. We smooth attack/release and hold
  // quiet frames briefly to avoid frantic mouth flicker.
  const runLipSyncLoop = useCallback(() => {
    if (!analyserRef.current) return;
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    let sum = 0;
    const bins = Math.min(30, dataArray.length);
    for (let i = 2; i < bins; i++) {
      sum += dataArray[i];
    }

    const avg = sum / Math.max(1, bins - 2);
    const raw = Math.min(100, Math.max(0, (avg / 118) * 100));

    // Faster attack, slower release: the mouth catches syllables without chattering.
    const previous = smoothedLipLevelRef.current;
    const smoothing = raw > previous ? 0.46 : 0.78;
    const smoothed = previous * smoothing + raw * (1 - smoothing);
    smoothedLipLevelRef.current = smoothed;

    // Continuous organic Muppet dynamics:
    // 1. Dynamic jaw movement & bounce based on real-time syllable energy
    const bounce = (smoothed / 100) * 5.5; // 0 to 5.5px downward jaw/head pop
    setJawBounce(bounce);

    if (smoothed > 42) {
      quietLipFramesRef.current = 0;
      setMouthStage(2);
    } else if (smoothed > 12) {
      quietLipFramesRef.current = 0;
      setMouthStage(1);
    } else {
      quietLipFramesRef.current += 1;
      if (quietLipFramesRef.current >= 2) {
        setMouthStage(0);
      }
    }

    const now = performance.now();
    if (smoothed > 72 && now - lastEnergyTransitionRef.current > 1400) {
      lastEnergyTransitionRef.current = now;
      transitionAnimation('audio-energy');
    }

    if (isJerrySpeaking) {
      animFrameRef.current = requestAnimationFrame(runLipSyncLoop);
    } else {
      smoothedLipLevelRef.current = 0;
      quietLipFramesRef.current = 0;
      setMouthStage(0);
      setMouthOpenAmount(0);
      setAudioLevel(0);
      setJawBounce(0);
    }
  }, [isJerrySpeaking, transitionAnimation]);

  useEffect(() => {
    if (isJerrySpeaking) {
      animFrameRef.current = requestAnimationFrame(runLipSyncLoop);
    } else {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      setMouthStage(0);
      setMouthOpenAmount(0);
      setAudioLevel(0);
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isJerrySpeaking, runLipSyncLoop]);

  // Initialize Web Speech Recognition
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'he-IL';

      recognition.onresult = (event: any) => {
        let currentTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          currentTranscript += event.results[i][0].transcript;
        }
        setMicTranscript(currentTranscript);
        setInputText(currentTranscript);
      };

      recognition.onerror = (e: any) => {
        console.warn('Speech recognition warning:', e.error);
        // The Web Speech recognizer is only the fallback path. Its lifecycle
        // must never own the Live mic indicator.
        if (!liveMicActiveRef.current && e.error !== 'no-speech') {
          setIsRecordingMic(false);
        }
      };

      recognition.onend = () => {
        if (!liveMicActiveRef.current) {
          setIsRecordingMic(false);
        }
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
    };
  }, []);

  const playJerryAudio = (audioSrc: string, pose: 'speaking' | 'phone' = 'speaking') => {
    if (isMuted) return;

    // Audio-source invariant: replay/opening/fallback audio must never overlap
    // with the streamed Gemini Live voice.
    livePlaybackQueueRef.current = [];
    livePlaybackReadOffsetRef.current = 0;
    liveQueuedSamplesRef.current = 0;

    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume();
    }

    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Audio();
      audioPlayerRef.current.crossOrigin = 'anonymous';
    }

    const audio = audioPlayerRef.current;
    audio.src = audioSrc;
    setIsJerrySpeaking(true);
    isJerrySpeakingRef.current = true;
    transitionAnimation('output-audio');
    setJerryPose(pose);

    audio.onended = () => {
      setIsJerrySpeaking(false);
      transitionAnimation('turn-complete');
      setJerryPose('listening');
      setMouthStage(0);
      setMouthOpenAmount(0);
    };
    audio.onerror = () => {
      setIsJerrySpeaking(false);
      transitionAnimation('turn-complete');
      setJerryPose('listening');
      setMouthStage(0);
      setMouthOpenAmount(0);
    };

    audio.play().catch((err) => {
      console.warn('Audio play prevented:', err);
      setIsJerrySpeaking(false);
      transitionAnimation('turn-complete');
      setJerryPose('listening');
    });
  };

  const handlePlayOpening = () => {
    playJerryAudio('/jerry-opening.wav');
  };

  // Toggle Guest microphone. When Gemini Live is connected we stream raw PCM
  // directly to the model for natural turn-taking; Web Speech remains as fallback.
  const handleToggleMic = async () => {
    if (isLiveReady) {
      if (isRecordingMic) {
        stopLiveMic();
      } else {
        await startLiveMic();
      }
      return;
    }

    if (isRecordingMic) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
      setIsRecordingMic(false);
      if (inputText.trim()) {
        handleSubmitTurn(inputText.trim());
      }
    } else {
      setErrorNotice(null);
      if (!recognitionRef.current) {
        setErrorNotice('הדפדפן אינו תומך בזיהוי קולי (Web Speech). ניתן להקליד ישירות בתיבת הטקסט.');
        return;
      }
      try {
        setMicTranscript('');
        setInputText('');
        recognitionRef.current.start();
        setIsRecordingMic(true);
        transitionAnimation('mic-start');
        setJerryPose('listening');
      } catch (err: any) {
        console.error('Mic start error:', err);
        setErrorNotice('לא ניתן לגשת למיקרופון. אנא אשר הרשאת מיקרופון בדפדפן.');
        setIsRecordingMic(false);
      }
    }
  };

  // Start or Stop Master Podcast Recording
  const handleToggleEpisodeRecord = async () => {
    const stopMicTracks = () => {
      // If podcast recording borrowed the already-live conversation microphone,
      // do not kill it when recording stops.
      if (episodeOwnsMicRef.current && micMediaStreamRef.current) {
        micMediaStreamRef.current.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
      }

      micMediaStreamRef.current = null;
      episodeOwnsMicRef.current = false;
    };

    if (isEpisodeRecording) {
      // STOP recording. Important: do not stop the mic tracks here.
      // MediaRecorder still needs its source alive while it flushes/finalizes the last chunk.
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          console.info('[Podcast Recorder] stopping', { state: recorder.state, mimeType: recorder.mimeType });
          recorder.stop();
          setRecordingNotice('מסיים ושומר את ההקלטה...');
        } catch (e) {
          console.error('[Podcast Recorder] error stopping MediaRecorder:', e);
          cleanupRecordingGraph();
          stopMicTracks();
          setErrorNotice('לא ניתן היה לסיים את ההקלטה כראוי.');
        }
      } else {
        cleanupRecordingGraph();
        stopMicTracks();
      }
      setIsEpisodeRecording(false);
      return;
    }

    // START recording
    setErrorNotice(null);
    if (episodeAudioUrl) {
      URL.revokeObjectURL(episodeAudioUrl);
    }
    setEpisodeAudioUrl(null);
    setFinalizedEpisode(null);
    setRecordingNotice(null);

    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        await ctx.resume();
      }

      if (!ctx || !jerryRecordingInputRef.current) {
        throw new Error('Jerry audio source is unavailable for recording.');
      }

      // Prefer the exact same microphone stream used by the live conversation.
      // A Jerry-only recording remains available when mic permission is denied.
      let streamToRecord: MediaStream;
      let micStream: MediaStream | null = null;
      try {
        // Prefer the exact same microphone stream used by the live conversation.
        // Opening a second getUserMedia stream for the master recording can trigger
        // browser DSP/echo-cancellation twice and make the guest very quiet.
        if (
          liveMicStreamRef.current &&
          liveMicStreamRef.current.getAudioTracks().some((track) => track.readyState === 'live')
        ) {
          micStream = liveMicStreamRef.current;
          episodeOwnsMicRef.current = false;
          console.info('[Podcast Recorder] reusing live conversation microphone');
        } else {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          episodeOwnsMicRef.current = true;
        }

        micMediaStreamRef.current = micStream;

        const guestSource = ctx ? ctx.createMediaStreamSource(micStream) : null;
        const graph = ctx && jerryRecordingInputRef.current
          ? createRecordingGraph(ctx, { jerry: jerryRecordingInputRef.current, guest: guestSource })
          : null;
        if (!graph) throw new Error('Recording graph is unavailable.');
        recordingGraphRef.current = graph;

        const monitorMix = ctx.createGain();
        const monitorJerryGain = ctx.createGain();
        const monitorGuestGain = guestSource ? ctx.createGain() : null;
        monitorJerryGain.gain.value = guestSource ? 0.5 : 1;
        graph.jerryChain.output.connect(monitorJerryGain);
        monitorJerryGain.connect(monitorMix);
        if (graph.guestChain && monitorGuestGain) {
          monitorGuestGain.gain.value = 0.5;
          graph.guestChain.output.connect(monitorGuestGain);
          monitorGuestGain.connect(monitorMix);
        }
        monitorMix.connect(ctx.destination);
        recordingMonitorMixRef.current = monitorMix;
        recordingMonitorJerryGainRef.current = monitorJerryGain;
        recordingMonitorGuestGainRef.current = monitorGuestGain;
        recordingModeRef.current = guestSource ? 'dual-channel' : 'jerry-only';
        if (jerryPlaybackGainRef.current) jerryPlaybackGainRef.current.gain.value = 0;
        // recordingGraphRef.current.destination.stream is the master recording stream.
        streamToRecord = graph.destination.stream;
        setRecordingNotice(
          guestSource
            ? 'Stereo recording active: Jerry left, guest right.'
            : 'Jerry-only recording active: microphone unavailable.',
        );
      } catch (micErr: any) {
        console.warn('[Podcast Recorder] microphone unavailable; trying Jerry-only recording:', micErr);
        stopMicTracks();
        cleanupRecordingGraph();
        const fallbackGraph = createRecordingGraph(ctx, { jerry: jerryRecordingInputRef.current, guest: null });
        recordingGraphRef.current = fallbackGraph;
        const monitorMix = ctx.createGain();
        const monitorJerryGain = ctx.createGain();
        fallbackGraph.jerryChain.output.connect(monitorJerryGain);
        monitorJerryGain.connect(monitorMix);
        monitorMix.connect(ctx.destination);
        recordingMonitorMixRef.current = monitorMix;
        recordingMonitorJerryGainRef.current = monitorJerryGain;
        recordingModeRef.current = 'jerry-only';
        if (jerryPlaybackGainRef.current) jerryPlaybackGainRef.current.gain.value = 0;
        streamToRecord = fallbackGraph.destination.stream;
        setRecordingNotice('ההקלטה פעילה (רק ערוץ הקול של ג\'רי - לא אושרה הרשאת מיקרופון).');
      }

      const tracks = streamToRecord.getAudioTracks();
      console.info(
        '[Podcast Recorder] source tracks',
        tracks.map((track) => ({
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
      );

      if (tracks.length === 0 || !tracks.some((track) => track.readyState === 'live' && track.enabled)) {
        stopMicTracks();
        throw new Error('לא נמצא ערוץ שמע פעיל להקלטה.');
      }

      // Determine best supported MIME type
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        '',
      ];
      let chosenMime = '';
      for (const mime of candidates) {
        if (!mime || MediaRecorder.isTypeSupported(mime)) {
          chosenMime = mime;
          break;
        }
      }

      const options: MediaRecorderOptions = chosenMime ? { mimeType: chosenMime } : {};
      const mediaRecorder = new MediaRecorder(streamToRecord, options);
      const actualMime = mediaRecorder.mimeType || chosenMime || 'audio/webm';
      const extension = actualMime.includes('mp4')
        ? 'm4a'
        : actualMime.includes('ogg')
        ? 'ogg'
        : 'webm';

      setEpisodeFileExtension(extension);
      recordedChunksRef.current = [];

      mediaRecorder.onstart = () => {
        console.info('[Podcast Recorder] started', { mimeType: actualMime, tracks: tracks.length });
      };

      mediaRecorder.ondataavailable = (e) => {
        console.info('[Podcast Recorder] dataavailable', { size: e.data?.size || 0, type: e.data?.type });
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onerror = (event: any) => {
        console.error('[Podcast Recorder] MediaRecorder error:', event?.error || event);
        setErrorNotice(
          'שגיאת הקלטה: ' + (event?.error?.message || event?.error?.name || 'MediaRecorder נכשל'),
        );
      };

      mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(recordedChunksRef.current, { type: actualMime });
          console.info('[Podcast Recorder] finalized', {
            chunks: recordedChunksRef.current.length,
            blobSize: blob.size,
            mimeType: actualMime,
          });

          if (blob.size > 0) {
            setRecordingNotice('Finalizing recording...');
            emitRecordingDebugEvent('recording-finalization-start', { rawMasterBytes: blob.size, mimeType: actualMime });
            const finalized = await finalizeEpisode({ master: blob, mimeType: actualMime });
            setFinalizedEpisode(finalized);
            emitRecordingDebugEvent('recording-finalized', {
              publicationStatus: finalized.publicationStatus,
              processingMs: finalized.processingMs,
              balanceDeltaDb: finalized.metrics.balanceDeltaDb,
              rawMasterBytes: finalized.rawStems.master.size,
            });
            if (finalized.publicationStatus === 'failed') {
              setEpisodeAudioUrl(null);
              setErrorNotice(finalized.warnings.join(' '));
              setRecordingNotice('Recording saved but blocked from download until audio quality is fixed.');
            } else {
              const finalUrl = URL.createObjectURL(finalized.finalMaster);
              setEpisodeAudioUrl(finalUrl);
              setEpisodeFileExtension('wav');
            }
          } else {
            setErrorNotice('ההקלטה נעצרה אך לא נלכדו נתוני שמע.');
            setRecordingNotice(null);
          }
        } finally {
          // Only now is it safe to release the microphone source.
          cleanupRecordingGraph();
          stopMicTracks();
          mediaRecorderRef.current = null;
          recordedChunksRef.current = [];
        }
      };

      // Let the browser own final chunking. This is more reliable for short podcast recordings.
      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setIsEpisodeRecording(true);
    } catch (err: any) {
      console.error('[Podcast Recorder] setup error:', err);
      stopMicTracks();
      mediaRecorderRef.current = null;
      setErrorNotice(err.message || 'שגיאה בהפעלת ההקלטה. ודא הרשאת מיקרופון בדפדפן.');
      setIsEpisodeRecording(false);
    }
  };

  // Submit User Turn to Jerry
  const handleSubmitTurn = async (userTextToSubmit?: string) => {
    const text = (userTextToSubmit || inputText).trim();
    if (!text || isJerryThinking) return;

    if (isRecordingMic && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      setIsRecordingMic(false);
    }

    const userMsg: PodcastMessage = {
      id: `m-${Date.now()}`,
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInputText('');
    setMicTranscript('');
    setIsJerryThinking(true);
    setAnimationState('thinking');
    setJerryPose('skeptical');

    // Preferred conversational path: persistent Gemini 3.8 Live session.
    // Audio starts streaming as soon as the model speaks; no separate TTS wait.
    if (
      isLiveReady &&
      liveSocketRef.current &&
      liveSocketRef.current.readyState === WebSocket.OPEN
    ) {
      liveTranscriptRef.current = '';
      livePcmChunksRef.current = [];
      liveAudioEndTimeRef.current = audioContextRef.current?.currentTime || 0;
      liveSocketRef.current.send(JSON.stringify({ type: 'text', text }));
      return;
    }

    // Fallback path if Live is temporarily unavailable.
    try {
      const serverHistory = messages.map((m) => ({
        role: m.sender === 'user' ? 'user' : 'model',
        text: m.text,
      }));

      const res = await fetch('/api/jerry-live-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: text,
          history: serverHistory,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Server error ${res.status}`);
      }

      const data = await res.json();
      const replyText = data.replyText || 'מה אמרת עכשיו? שוב לא שמעתי.';
      let audioUrl: string | undefined = undefined;

      if (data.audioBase64) {
        audioUrl = `data:audio/wav;base64,${data.audioBase64}`;
      } else if (data.audioError) {
        console.error('[Jerry TTS] fallback returned text without audio:', data.audioError);
        setErrorNotice('ג\'רי יצר תשובה, אבל יצירת הקול נכשלה: ' + data.audioError);
      }

      const isPhonePose =
        replyText.includes('טלפון') ||
        replyText.includes('על הקו') ||
        replyText.includes('איתי מתקשר');

      const jerryMsg: PodcastMessage = {
        id: `m-${Date.now() + 1}`,
        sender: 'jerry',
        text: replyText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        audioUrl,
        pose: isPhonePose ? 'phone' : 'speaking',
      };

      setMessages((prev) => [...prev, jerryMsg]);
      setIsJerryThinking(false);

      if (audioUrl) {
        playJerryAudio(audioUrl, isPhonePose ? 'phone' : 'speaking');
      } else {
        transitionAnimation('turn-complete');
        setJerryPose('listening');
      }
    } catch (err: any) {
      console.error('[Jerry Live] Error:', err);
      setIsJerryThinking(false);
      transitionAnimation('turn-complete');
      setJerryPose('listening');
      setErrorNotice('חלה שגיאה במענה של ג\'רי: ' + (err.message || 'תקלה בתקשורת'));
    }
  };

  const handleResetSession = () => {
    stopLiveMic();
    cleanupRecordingResources();
    livePlaybackQueueRef.current = [];
    livePlaybackReadOffsetRef.current = 0;
    liveQueuedSamplesRef.current = 0;
    if (episodeAudioUrl) URL.revokeObjectURL(episodeAudioUrl);
    if (pcmDebugAudioUrl) URL.revokeObjectURL(pcmDebugAudioUrl);
    setEpisodeAudioUrl(null);
    setPcmDebugAudioUrl(null);
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }
    setIsJerrySpeaking(false);
    setIsJerryThinking(false);
    setIsRecordingMic(false);
    setAnimationState('idle');
    setJerryPose('speaking');
    setMouthStage(0);
    setMouthOpenAmount(0);
    setMessages([
      {
        id: 'm-0',
        sender: 'jerry',
        text: JERRY_INITIAL_OPENING,
        timestamp: '00:01',
        audioUrl: '/jerry-opening.wav',
        pose: 'speaking',
      },
    ]);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const activePose = poseForState(animationState);
  const activeMouthAnchor = JERRY_MOUTH_ANCHORS[activePose];

  return (
    <div className="w-full flex flex-col lg:flex-row gap-6 items-stretch">
      {/* =====================================================================
          LEFT: JERRY'S PODCAST BROADCAST BOOTH (VISUAL, AVATAR & LIP-SYNC)
         ===================================================================== */}
      <div className="w-full lg:w-[48%] flex flex-col justify-between bg-[#191918] rounded-[18px] border border-[#2E2E2B] p-4 sm:p-6 text-white shadow-xl relative overflow-hidden">
        {/* Top Studio Indicator Bar */}
        <div className="flex items-center justify-between border-b border-[#2E2E2B] pb-3 mb-4">
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                isJerrySpeaking
                  ? 'bg-red-500 animate-pulse ring-4 ring-red-500/20'
                  : isRecordingMic
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-emerald-500'
              }`}
            />
            <span className="text-[12px] font-mono uppercase tracking-[0.12em] text-[#D8D6CE] font-semibold">
              {isJerrySpeaking
                ? 'ON AIR - JERRY LIP-SYNC'
                : isRecordingMic
                ? 'GUEST SPEAKING (MIC LIVE)'
                : 'STUDIO LIVE • PODCAST READY'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Lip-sync indicator */}
            <span className="text-[10px] font-mono bg-red-950/80 border border-red-700/60 text-red-300 px-2 py-0.5 rounded-[4px] flex items-center gap-1">
              <Activity className="w-3 h-3 text-red-400" />
              <span>LIP-SYNC: {isJerrySpeaking ? (mouthStage === 2 ? 'WIDE' : mouthStage === 1 ? 'OPEN' : 'REST') : 'IDLE'}</span>
            </span>

            <button
              onClick={() => setIsMuted(!isMuted)}
              className="p-1.5 rounded-[6px] hover:bg-[#2A2A28] text-[#A8A7A1] hover:text-white transition-colors cursor-pointer"
              title={isMuted ? 'Unmute Jerry' : 'Mute Jerry'}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <button
              onClick={handleResetSession}
              className="p-1.5 rounded-[6px] hover:bg-[#2A2A28] text-[#A8A7A1] hover:text-white transition-colors cursor-pointer"
              title="Reset Podcast Episode"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Jerry's locked full-frame pose canvas with precision lip-sync layers */}
        <div className="relative rounded-[12px] overflow-hidden aspect-[16/10] sm:aspect-[16/9] bg-[#0E0E0D] border border-[#333330] flex items-center justify-center group shadow-inner select-none">
          {(Object.keys(JERRY_POSES) as JerryPose[]).map((pose) => (
            <img
              key={pose}
              src={JERRY_POSES[pose]}
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = JERRY_POSES.idle;
              }}
              alt={`Jerry ${pose} pose`}
              className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
              style={{
                opacity: activePose === pose ? 1 : 0,
                transition: `opacity ${JERRY_POSE_CROSSFADE_MS}ms ease-in-out`,
              }}
            />
          ))}

          {/* The analyser-driven mouth stays on top of whichever full-frame pose is active. */}
          {isJerrySpeaking && (
            <div
              aria-hidden="true"
              className="absolute pointer-events-none will-change-transform"
              style={{
                left: `${activeMouthAnchor.x}%`,
                top: `calc(${activeMouthAnchor.y}% + ${jawBounce * 0.55}px)`,
                width: `${activeMouthAnchor.width + (mouthOpenAmount / 100) * 3.8}%`,
                height: `${2.8 + (mouthOpenAmount / 100) * 11.5}%`,
                opacity: mouthStage === 0 ? 0 : 0.98,
                transform: 'translate(-50%, -50%)',
                borderRadius: '46% 46% 54% 54% / 30% 30% 70% 70%',
                background:
                  'radial-gradient(ellipse at 50% 75%, #8d3340 0 25%, #541921 26% 50%, #150709 55% 100%)',
                boxShadow:
                  mouthStage === 2
                    ? 'inset 0 2px 5px rgba(0,0,0,.9), 0 1px 2px rgba(0,0,0,.4)'
                    : 'inset 0 1px 4px rgba(0,0,0,.9)',
                transition:
                  'height 40ms ease-out, width 40ms ease-out, top 40ms ease-out, opacity 35ms linear',
              }}
            >
              <div
                className="absolute left-[20%] right-[20%] bottom-[6%] rounded-full"
                style={{
                  height: mouthStage === 2 ? '30%' : '22%',
                  background: 'rgba(185, 68, 80, 0.85)',
                  filter: 'blur(0.2px)',
                }}
              />
            </div>
          )}

          {/* Glowing "ON AIR" Retro Studio Sign */}
          <div className="absolute top-3 left-3 bg-red-600/90 backdrop-blur-xs text-white text-[10px] font-black uppercase tracking-[0.18em] px-2.5 py-0.5 rounded-[4px] border border-red-400/30 flex items-center gap-1.5 shadow-lg">
            <Radio className="w-3 h-3 animate-pulse" />
            <span>ON AIR</span>
          </div>

          {/* Phone Call Indicator if Jerry is on phone with Itai */}
          {jerryPose === 'phone' && (
            <div className="absolute top-3 right-3 bg-amber-600/90 backdrop-blur-xs text-white text-[10px] font-bold px-2.5 py-0.5 rounded-[4px] border border-amber-400/30 flex items-center gap-1.5 shadow-lg animate-pulse">
              <PhoneCall className="w-3 h-3" />
              <span>איתי על הקו...</span>
            </div>
          )}

          {/* VU Meter Bars Active when speaking */}
          {isJerrySpeaking && (
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between bg-black/75 backdrop-blur-md py-1.5 px-3 rounded-full border border-white/10 shadow-lg">
              <span className="text-[10px] font-mono text-[#DCDAD4] mr-2 flex items-center gap-1">
                <Activity className="w-3 h-3 text-red-400 animate-pulse" />
                <span>VOICE LIP-SYNC:</span>
              </span>
              <div className="flex items-center gap-1 flex-1 max-w-[200px] justify-center mx-2">
                {[50, 85, 95, 60, 100, 75, 45, 90, 65, 80, 40, 70].map((h, i) => {
                  const barH = Math.max(4, ((mouthOpenAmount * h) / 100) * 0.22);
                  return (
                    <div
                      key={i}
                      className="w-1 bg-red-400 rounded-full transition-all duration-75"
                      style={{ height: `${barH}px` }}
                    />
                  );
                })}
              </div>
              <span className="text-[10px] font-mono text-red-300">{Math.round(mouthOpenAmount)}% audio</span>
            </div>
          )}

          {/* Thinking overlay */}
          {isJerryThinking && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-xs flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-7 h-7 text-amber-400 animate-spin" />
              <span className="text-[13px] font-medium text-amber-200">ג'רי מגבש תגובה סרקסטית...</span>
            </div>
          )}
        </div>

        {/* Master Podcast Recording Bar */}
        <div className="mt-4 pt-3 border-t border-[#2E2E2B] flex flex-col gap-3">
          {recordingNotice && (
            <div className="text-[11.5px] bg-emerald-950/70 text-emerald-300 border border-emerald-800/60 rounded-[6px] px-3 py-1.5 flex items-center justify-between">
              <span>{recordingNotice}</span>
              <button
                onClick={() => setRecordingNotice(null)}
                className="text-emerald-400 hover:text-white cursor-pointer ml-2 text-xs"
              >
                ✕
              </button>
            </div>
          )}

          <div className="flex items-center justify-between bg-[#232321] p-2.5 rounded-[10px] border border-[#383835] flex-wrap gap-2">
            <div className="flex items-center gap-2.5">
              <button
                onClick={handleToggleEpisodeRecord}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-[12px] font-bold transition-all cursor-pointer shadow-xs ${
                  isEpisodeRecording
                    ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse ring-4 ring-red-500/20'
                    : 'bg-[#31312E] hover:bg-[#40403C] text-white border border-[#484844]'
                }`}
              >
                {isEpisodeRecording ? (
                  <Square className="w-3.5 h-3.5 fill-current" />
                ) : (
                  <Mic className="w-3.5 h-3.5 text-red-500" />
                )}
                <span>{isEpisodeRecording ? 'עצור הקלטת פרק' : 'הקלט את הפודקאסט'}</span>
              </button>

              {isEpisodeRecording && (
                <div className="flex items-center gap-1.5 text-red-400 font-mono text-[12px] font-bold">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                  <span>REC {formatTime(recordingSeconds)}</span>
                </div>
              )}
            </div>

            {episodeAudioUrl && finalizedEpisode?.publicationStatus !== 'failed' && (
              <a
                href={episodeAudioUrl}
                download={`jerry-podcast-episode-${Date.now()}.${episodeFileExtension}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] bg-emerald-600 hover:bg-emerald-500 text-white text-[11.5px] font-semibold transition-colors shadow-xs"
                title="הורד קובץ הקלטה מלא"
              >
                <Download className="w-3.5 h-3.5" />
                <span>הורד פרק מלא (Audio)</span>
              </a>
            )}
          </div>

          <div className="flex items-center justify-between text-[11px] text-[#A8A7A1] flex-wrap gap-2">
            <div>
              <span className="font-semibold text-white">ג'רי (Jerry)</span> • ותיק הייטק, מומחה מאז 1992
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handlePlayOpening}
                className="text-[11px] text-[#D8D6CE] hover:text-white underline cursor-pointer"
              >
                השמע פתיח אולפן
              </button>
              <button
                onClick={() => playJerryAudio('/jerry-opening.wav', 'phone')}
                className="text-[11px] text-amber-400 hover:text-amber-300 underline cursor-pointer flex items-center gap-1"
              >
                <PhoneCall className="w-3 h-3" />
                <span>פוזת טלפון</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          RIGHT: TWO-WAY LIVE PODCAST CONVERSATION & MIC CONTROLS
         ===================================================================== */}
      <div className="w-full lg:w-[52%] flex flex-col justify-between bg-white rounded-[18px] border border-[#E6E4DF] shadow-xs p-4 sm:p-6 min-h-[460px]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#F0EFEB] pb-3 mb-3">
          <div>
            <h2 className="text-[16px] sm:text-[18px] font-semibold text-[#141413] tracking-[-0.015em] flex items-center gap-2">
              <span>שיחה חיה עם ג'רי</span>
              <span className="text-[10px] font-mono bg-red-100 text-red-800 px-2 py-0.5 rounded font-bold">
                {isLiveReady ? 'GEMINI LIVE • LOW LATENCY' : 'FALLBACK VOICE ENGINE'}
              </span>
            </h2>
            <p className="text-[12px] text-[#8E8D8A]">
              {isLiveReady
                ? 'Gemini Live מחובר — ג\'רי מתחיל לדבר בזמן שהאודיו עדיין זורם'
                : 'מתחבר ל-Gemini Live; בינתיים אפשר להמשיך במסלול הרגיל'}
            </p>
          </div>

          <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-[5px] bg-[#F4F3EF] text-[#6E6D69] border border-[#E5E3DC]">
            {messages.length} תורות
          </span>
        </div>

        {/* Notice alert if any */}
        {errorNotice && (
          <div className="mb-3 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-[8px] p-2.5 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <div className="flex-1 text-[11.5px] leading-tight">{errorNotice}</div>
            <button
              onClick={() => setErrorNotice(null)}
              className="text-amber-800 text-[11px] font-bold p-0.5 cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        {/* Dialogue Scroll List */}
        <div className="flex-1 overflow-y-auto max-h-[360px] pr-1 space-y-3.5 my-2">
          {messages.map((m) => {
            const isJerry = m.sender === 'jerry';
            return (
              <div
                key={m.id}
                className={`flex flex-col ${isJerry ? 'items-start' : 'items-end'} group`}
              >
                {/* Sender Tag & Timestamp */}
                <div className="flex items-center gap-2 mb-1 px-1">
                  <span
                    className={`text-[10.5px] font-bold tracking-wider uppercase ${
                      isJerry ? 'text-red-700' : 'text-blue-700'
                    }`}
                  >
                    {isJerry ? "ג'רי (מנחה הפודקאסט)" : 'איתי (אורח באולפן)'}
                  </span>
                  <span className="text-[9.5px] text-[#A8A7A1]">{m.timestamp}</span>
                </div>

                {/* Message Bubble */}
                <div
                  className={`max-w-[90%] sm:max-w-[85%] rounded-[12px] px-3.5 py-2.5 text-[13px] sm:text-[14px] leading-relaxed shadow-2xs ${
                    isJerry
                      ? 'bg-[#F9F8F5] text-[#1E1E1C] border border-[#E5E3DC] rounded-tl-xs'
                      : 'bg-[#141413] text-white rounded-tr-xs'
                  }`}
                  dir="rtl"
                >
                  <p className="whitespace-pre-wrap leading-relaxed"><bdi>{m.text}</bdi></p>

                  {/* Audio replay button */}
                  {isJerry && m.audioUrl && (
                    <button
                      onClick={() =>
                        playJerryAudio(m.audioUrl!, m.pose === 'phone' ? 'phone' : 'speaking')
                      }
                      className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#65635E] hover:text-[#141413] transition-colors cursor-pointer bg-white px-2 py-0.5 rounded-[5px] border border-[#DCDAD4]"
                      title="Play Voice + Lip-Sync"
                    >
                      <Volume2 className="w-3.5 h-3.5 text-red-600" />
                      <span>השמע שוב עם Lip-Sync</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {isJerryThinking && (
            <div className="flex items-center gap-2 text-[12px] text-[#787672] p-2 bg-[#F9F8F5] rounded-[8px] border border-[#EBEAE5] w-fit">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-red-600" />
              <span>ג'רי חושב ומקליט תשובה... (מהיר)</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar & Live Mic Push-to-Talk Controls */}
        <div className="border-t border-[#F0EFEB] pt-3 mt-2">
          {/* Live Mic Transcript preview */}
          {isRecordingMic && (
            <div className="mb-2 bg-red-50 border border-red-200 text-red-800 text-[12px] rounded-[8px] px-3 py-1.5 flex items-center justify-between animate-pulse">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-600 animate-ping" />
                <span className="font-semibold">{isLiveReady ? 'ג\'רי מקשיב בזמן אמת:' : 'מקליט אותך עכשיו:'}</span>
                <span className="italic text-[#333]">{micTranscript || 'דבר חופשי אל ג\'רי...'}</span>
              </div>
              <span className="text-[11px] text-red-700">
                {isLiveReady ? 'אפשר לדבר טבעי; לחץ שוב כשתסיים' : 'לחץ שוב על המיקרופון לסיום ושליחה'}
              </span>
            </div>
          )}

          <div className="mb-2 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={startPcmDebugCapture}
              disabled={isPcmDebugRecording || !isLiveReady}
              className="px-2.5 py-1.5 rounded-[7px] text-[11px] font-semibold border border-[#DCDAD4] bg-[#F4F3EF] hover:bg-[#EBE9E3] disabled:opacity-50 disabled:cursor-not-allowed"
              title="Record the exact 16kHz PCM sent to Gemini for 5 seconds"
            >
              {isPcmDebugRecording ? 'מקליט PCM... 5 שניות' : 'בדיקת PCM ל-5 שניות'}
            </button>

            {pcmDebugAudioUrl && (
              <>
                <audio src={pcmDebugAudioUrl} controls className="h-8 max-w-[260px]" />
                <a
                  href={pcmDebugAudioUrl}
                  download={`jerry-mic-debug-${Date.now()}.wav`}
                  className="text-[11px] underline text-[#454440] hover:text-black"
                >
                  הורד WAV
                </a>
              </>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmitTurn();
            }}
            className="flex items-center gap-2"
          >
            {/* Microphone Button (Speech to Text) */}
            <button
              type="button"
              onClick={handleToggleMic}
              disabled={isJerryThinking}
              className={`p-3 rounded-[9px] transition-all cursor-pointer flex items-center justify-center shrink-0 shadow-xs ${
                isRecordingMic
                  ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse ring-4 ring-red-500/20'
                  : 'bg-[#F4F3EF] hover:bg-[#EBE9E3] text-[#141413] border border-[#DCDAD4]'
              }`}
              title={isRecordingMic ? 'עצור והעבר לג\'רי' : 'דבר במיקרופון לשיחה חיה'}
            >
              {isRecordingMic ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5 text-red-600" />}
            </button>

            {/* Text Input fallback */}
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={isRecordingMic ? 'מדבר במיקרופון...' : 'ענה לג\'רי, או לחץ על המיקרופון כדי לדבר...'}
              disabled={isJerryThinking}
              dir="auto"
              className="flex-1 bg-[#F9F8F5] border border-[#DCDAD4] focus:border-[#141413] rounded-[9px] px-3.5 py-2.5 text-[13px] sm:text-[14px] text-[#141413] outline-none transition-colors"
            />

            {/* Send Button */}
            <button
              type="submit"
              disabled={!inputText.trim() || isJerryThinking}
              className="p-3 rounded-[9px] bg-[#141413] hover:bg-[#2A2A28] disabled:bg-[#DCDAD4] disabled:text-[#8E8D8A] text-white transition-colors cursor-pointer shrink-0"
              title="שלח תשובה"
            >
              {isJerryThinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </form>

          {/* Quick suggestions pills */}
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5 text-[11px] text-[#787672]">
            <span className="font-medium text-[#141413]">רעיונות לתשובה:</span>
            {[
              'העברנו הכל לקוברנטיס בלי טסטים וזה עובד מדהים.',
              'פיטרנו את כל אנשי ה-QA וסומכים רק על ה-AI.',
              'איתי, יש לך שיחה דחופה בטלפון.',
            ].map((suggestion, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setInputText(suggestion);
                  handleSubmitTurn(suggestion);
                }}
                disabled={isJerryThinking}
                className="bg-[#F4F3EF] hover:bg-[#EBE9E3] border border-[#E5E3DC] px-2 py-0.5 rounded-[5px] text-[#454440] hover:text-[#141413] transition-colors cursor-pointer text-[10.5px] truncate max-w-[240px]"
              >
                « {suggestion} »
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
