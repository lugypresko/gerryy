import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  analyzeRecordingQuality,
  type RecordingQualityMetrics,
} from './quality';
import type { MediaProcessingResult } from './media';

export const PUBLICATION_PIPELINE_VERSION = 'jerry-publication-stereo-v1';
export const STEREO_POLICY = {
  channelMap: { left: 'jerry', right: 'guest' },
  panPolicy: 'hard-separated-archive-master',
  sourceTracksPreserved: true,
} as const;

export interface EpisodeProcessingThresholds {
  targetLufs?: number;
  loudnessToleranceLu?: number;
  reviewBalanceDeltaLu?: number;
  failBalanceDeltaLu?: number;
  truePeakCeilingDbtp?: number;
  minActiveSpeechMs?: number;
  maxJerryBoostDb?: number;
  maxGuestBoostDb?: number;
  maxAttenuationDb?: number;
}

export interface EpisodeProcessingRequest {
  episodeId: string;
  outputDir: string;
  rawStems: { jerry: string; guest: string; master?: string };
  mediaJob: MediaProcessingResult & { outputPath?: string };
  thresholds?: EpisodeProcessingThresholds;
  ffmpegCommand?: string;
  ffprobeCommand?: string;
}

export interface SpeakerQualityReport {
  jerry: RecordingQualityMetrics;
  guest: RecordingQualityMetrics;
  activeSpeechDeltaMs: number;
  loudnessDeltaLu: number;
  integratedLufs: number;
}

export interface EpisodeProcessingReport {
  schemaVersion: 1;
  pipelineVersion: typeof PUBLICATION_PIPELINE_VERSION;
  episodeId: string;
  createdAt: string;
  rawStems: EpisodeProcessingRequest['rawStems'];
  outputPath: string;
  stereoPolicy: typeof STEREO_POLICY;
  thresholds: Required<EpisodeProcessingThresholds>;
  gainsDb: { jerry: number; guest: number };
  mediaJob: {
    status: MediaProcessingResult['status'];
    outputPath?: string;
    outputProbe: MediaProcessingResult['outputProbe'];
    toolVersions: MediaProcessingResult['toolVersions'];
  };
  qualityBefore: SpeakerQualityReport;
  qualityAfter: RecordingQualityMetrics;
  publicationStatus: 'publishable' | 'needs-review' | 'failed';
  reasons: string[];
  warnings: string[];
}

export interface EpisodeProcessingResult {
  outputPath: string;
  reportPath: string;
  publicationStatus: EpisodeProcessingReport['publicationStatus'];
  report: EpisodeProcessingReport;
}

interface CommandResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

const DEFAULT_THRESHOLDS: Required<EpisodeProcessingThresholds> = {
  targetLufs: -16,
  loudnessToleranceLu: 1,
  reviewBalanceDeltaLu: 3,
  failBalanceDeltaLu: 6,
  truePeakCeilingDbtp: -1,
  minActiveSpeechMs: 1000,
  maxJerryBoostDb: 6,
  maxGuestBoostDb: 9,
  maxAttenuationDb: 6,
};

const linearFromDb = (db: number): number => 10 ** (db / 20);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ status: code ?? 1, stdout: Buffer.concat(stdout), stderr }));
  });
}

async function decodeToWav(
  inputPath: string,
  ffmpegCommand: string,
): Promise<Buffer> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-process-decode-'));
  const outputPath = path.join(tempDir, 'decoded.wav');
  const result = await runCommand(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:a:0',
    '-vn',
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    '-y',
    outputPath,
  ]);
  try {
    const decoded = await fs.readFile(outputPath).catch(() => Buffer.alloc(0));
    if (result.status !== 0 || decoded.length === 0) {
      throw new Error(`Unable to decode stem ${inputPath}: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
    return decoded;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function probeOutput(outputPath: string, ffprobeCommand: string): Promise<MediaProcessingResult['outputProbe']> {
  const result = await runCommand(ffprobeCommand, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    outputPath,
  ]);
  if (result.status !== 0) throw new Error(`Output probe failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  const parsed = JSON.parse(result.stdout.toString('utf8')) as MediaProcessingResult['outputProbe'];
  return { ...parsed, duration: Number(parsed.duration || parsed.format?.duration || 0) };
}

function speakerQuality(
  jerry: RecordingQualityMetrics,
  guest: RecordingQualityMetrics,
): SpeakerQualityReport {
  const jerryLufs = jerry.channels[0]?.lufs ?? -Infinity;
  const guestLufs = guest.channels[0]?.lufs ?? -Infinity;
  const finiteLufs = [jerryLufs, guestLufs].filter(Number.isFinite);
  return {
    jerry,
    guest,
    activeSpeechDeltaMs: Math.abs(jerry.activeSpeechMs - guest.activeSpeechMs),
    loudnessDeltaLu: finiteLufs.length === 2 ? Math.abs(jerryLufs - guestLufs) : Infinity,
    integratedLufs: finiteLufs.length === 2 ? (jerryLufs + guestLufs) / 2 : -Infinity,
  };
}

function preflightReasons(
  quality: SpeakerQualityReport,
  thresholds: Required<EpisodeProcessingThresholds>,
): string[] {
  const reasons: string[] = [];
  for (const [speaker, metrics] of [['jerry', quality.jerry], ['guest', quality.guest] as const]) {
    if (!metrics.decoded) reasons.push(`${speaker}-decode-failed`);
    if (metrics.insufficientSpeech || metrics.activeSpeechMs < thresholds.minActiveSpeechMs) {
      reasons.push(`${speaker}-insufficient-speech`);
    }
    if (metrics.clippingCount > 0) reasons.push(`${speaker}-clipping`);
  }
  return reasons;
}

function finalPublicationStatus(
  quality: RecordingQualityMetrics,
  thresholds: Required<EpisodeProcessingThresholds>,
): { status: EpisodeProcessingReport['publicationStatus']; reasons: string[] } {
  const reasons: string[] = [...quality.reasons];
  const outputLufs = quality.channels.map((channel) => channel.lufs).filter(Number.isFinite);
  const integratedLufs = outputLufs.length ? outputLufs.reduce((sum, value) => sum + value, 0) / outputLufs.length : -Infinity;
  if (!quality.decoded) reasons.push('output-decode-failed');
  if (quality.channelCount !== 2) reasons.push('expected-two-channels');
  if (quality.insufficientSpeech) reasons.push('insufficient-speech');
  if (quality.clippingCount > 0) reasons.push('clipping');
  if (quality.truePeakDbfs > thresholds.truePeakCeilingDbtp) reasons.push('true-peak-over-ceiling');
  if (!Number.isFinite(integratedLufs) || Math.abs(integratedLufs - thresholds.targetLufs) > thresholds.loudnessToleranceLu) {
    reasons.push('integrated-loudness-out-of-range');
  }
  if (quality.balanceDeltaDb > thresholds.failBalanceDeltaLu) return { status: 'failed', reasons: [...new Set(reasons.concat('speaker-balance'))] };
  if (reasons.some((reason) => /decode|insufficient|clipping|true-peak|expected-two|integrated/.test(reason))) {
    return { status: 'failed', reasons: [...new Set(reasons)] };
  }
  if (quality.balanceDeltaDb > thresholds.reviewBalanceDeltaLu) {
    return { status: 'needs-review', reasons: [...new Set(reasons.concat('speaker-balance'))] };
  }
  return { status: 'publishable', reasons: [...new Set(reasons)] };
}

async function renderStereoMaster(
  request: EpisodeProcessingRequest,
  gainsDb: { jerry: number; guest: number },
  outputPath: string,
  thresholds: Required<EpisodeProcessingThresholds>,
): Promise<void> {
  const ffmpegCommand = request.ffmpegCommand || 'ffmpeg';
  const limiter = linearFromDb(thresholds.truePeakCeilingDbtp);
  const filter = [
    `[0:a]aformat=channel_layouts=mono,volume=${linearFromDb(gainsDb.jerry)}[jerry]`,
    `[1:a]aformat=channel_layouts=mono,volume=${linearFromDb(gainsDb.guest)}[guest]`,
    `[jerry][guest]amerge=inputs=2,pan=stereo|c0=c0|c1=c1,alimiter=limit=${limiter}:attack=5:release=50:latency=1[out]`,
  ].join(';');
  const result = await runCommand(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', request.rawStems.jerry,
    '-i', request.rawStems.guest,
    '-filter_complex', filter,
    '-map', '[out]',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    '-y',
    outputPath,
  ]);
  if (result.status !== 0) throw new Error(`Stereo render failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

export async function processEpisode(request: EpisodeProcessingRequest): Promise<EpisodeProcessingResult> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...request.thresholds };
  const outputPath = path.join(request.outputDir, 'master-stereo.wav');
  const reportPath = path.join(request.outputDir, 'publication-report.json');
  await fs.mkdir(request.outputDir, { recursive: true });

  if (request.mediaJob.status !== 'succeeded') throw new Error('Cannot publish without a succeeded media job');
  const [jerryWav, guestWav] = await Promise.all([
    decodeToWav(request.rawStems.jerry, request.ffmpegCommand || 'ffmpeg'),
    decodeToWav(request.rawStems.guest, request.ffmpegCommand || 'ffmpeg'),
  ]);
  const qualityBefore = speakerQuality(
    analyzeRecordingQuality(jerryWav, { minActiveSpeechMs: thresholds.minActiveSpeechMs }),
    analyzeRecordingQuality(guestWav, { minActiveSpeechMs: thresholds.minActiveSpeechMs }),
  );
  const preflight = preflightReasons(qualityBefore, thresholds);
  if (preflight.length > 0) {
    const report: EpisodeProcessingReport = {
      schemaVersion: 1,
      pipelineVersion: PUBLICATION_PIPELINE_VERSION,
      episodeId: request.episodeId,
      createdAt: new Date().toISOString(),
      rawStems: request.rawStems,
      outputPath,
      stereoPolicy: STEREO_POLICY,
      thresholds,
      gainsDb: { jerry: 0, guest: 0 },
      mediaJob: {
        status: request.mediaJob.status,
        outputPath: request.mediaJob.outputPath,
        outputProbe: request.mediaJob.outputProbe,
        toolVersions: request.mediaJob.toolVersions,
      },
      qualityBefore,
      qualityAfter: qualityBefore.jerry,
      publicationStatus: 'failed',
      reasons: preflight,
      warnings: ['Raw stems were preserved; no publication master was written.'],
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    return { outputPath, reportPath, publicationStatus: 'failed', report };
  }

  const jerryLufs = qualityBefore.jerry.channels[0]?.lufs ?? thresholds.targetLufs;
  const guestLufs = qualityBefore.guest.channels[0]?.lufs ?? thresholds.targetLufs;
  const gainsDb = {
    jerry: clamp(thresholds.targetLufs - jerryLufs, -thresholds.maxAttenuationDb, thresholds.maxJerryBoostDb),
    guest: clamp(thresholds.targetLufs - guestLufs, -thresholds.maxAttenuationDb, thresholds.maxGuestBoostDb),
  };
  await renderStereoMaster(request, gainsDb, outputPath, thresholds);
  const outputBytes = await fs.readFile(outputPath);
  const qualityAfter = analyzeRecordingQuality(outputBytes, {
    minActiveSpeechMs: thresholds.minActiveSpeechMs,
    reviewBalanceDeltaDb: thresholds.reviewBalanceDeltaLu,
    failBalanceDeltaDb: thresholds.failBalanceDeltaLu,
    truePeakCeilingDbfs: thresholds.truePeakCeilingDbtp,
  });
  const gate = finalPublicationStatus(qualityAfter, thresholds);
  const report: EpisodeProcessingReport = {
    schemaVersion: 1,
    pipelineVersion: PUBLICATION_PIPELINE_VERSION,
    episodeId: request.episodeId,
    createdAt: new Date().toISOString(),
    rawStems: request.rawStems,
    outputPath,
    stereoPolicy: STEREO_POLICY,
    thresholds,
    gainsDb,
    mediaJob: {
      status: request.mediaJob.status,
      outputPath: request.mediaJob.outputPath,
      outputProbe: request.mediaJob.outputProbe,
      toolVersions: request.mediaJob.toolVersions,
    },
    qualityBefore,
    qualityAfter,
    publicationStatus: gate.status,
    reasons: gate.reasons,
    warnings: gate.status === 'publishable' ? [] : ['Output exists for diagnosis; publication download must honor the report status.'],
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  return { outputPath, reportPath, publicationStatus: gate.status, report };
}
