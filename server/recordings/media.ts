import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface MediaToolVersion {
  command: string;
  available: boolean;
  version?: string;
  error?: string;
}

export interface MediaProbeResult {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
  };
  streams?: Array<Record<string, unknown>>;
  duration: number;
}

export interface MediaProcessingRequest {
  inputPath: string;
  outputPath: string;
  appendLog?: (message: string) => Promise<void>;
  ffmpegCommand?: string;
  ffprobeCommand?: string;
}

export interface MediaProcessingResult {
  status: 'succeeded';
  toolVersions: Record<'ffmpeg' | 'ffprobe', MediaToolVersion>;
  probe: MediaProbeResult;
  outputProbe: MediaProbeResult;
  logs: string[];
}

export class MediaProcessingError extends Error {
  readonly toolVersions?: Record<'ffmpeg' | 'ffprobe', MediaToolVersion>;
  readonly logs: string[];

  constructor(message: string, options: {
    toolVersions?: Record<'ffmpeg' | 'ffprobe', MediaToolVersion>;
    logs?: string[];
  } = {}) {
    super(message);
    this.name = 'MediaProcessingError';
    this.toolVersions = options.toolVersions;
    this.logs = options.logs || [];
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function inspectTool(command: string): Promise<MediaToolVersion> {
  try {
    const result = await runCommand(command, ['-version']);
    const version = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim();
    if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code}`);
    return { command, available: true, version };
  } catch (error: any) {
    return { command, available: false, error: error?.message || String(error) };
  }
}

export async function getMediaToolVersions(
  ffmpegCommand = 'ffmpeg',
  ffprobeCommand = 'ffprobe',
): Promise<Record<'ffmpeg' | 'ffprobe', MediaToolVersion>> {
  const [ffmpeg, ffprobe] = await Promise.all([
    inspectTool(ffmpegCommand),
    inspectTool(ffprobeCommand),
  ]);
  return { ffmpeg, ffprobe };
}

export async function probeMedia(
  inputPath: string,
  ffprobeCommand = 'ffprobe',
): Promise<MediaProbeResult> {
  const result = await runCommand(ffprobeCommand, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);
  if (result.code !== 0) {
    throw new MediaProcessingError(`ffprobe failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new MediaProcessingError('ffprobe returned invalid JSON');
  }
  const duration = Number(parsed?.format?.duration || 0);
  return { ...parsed, duration: Number.isFinite(duration) ? duration : 0 };
}

export async function processMedia(request: MediaProcessingRequest): Promise<MediaProcessingResult> {
  const logs: string[] = [];
  const appendLog = async (message: string) => {
    logs.push(message);
    await request.appendLog?.(message);
  };
  const ffmpegCommand = request.ffmpegCommand || 'ffmpeg';
  const ffprobeCommand = request.ffprobeCommand || 'ffprobe';
  const toolVersions = await getMediaToolVersions(ffmpegCommand, ffprobeCommand);

  if (!toolVersions.ffmpeg.available || !toolVersions.ffprobe.available) {
    throw new MediaProcessingError('ffmpeg and ffprobe are required for media processing', {
      toolVersions,
      logs,
    });
  }

  const inputStat = await fs.stat(request.inputPath).catch(() => null);
  if (!inputStat?.isFile() || inputStat.size === 0) {
    throw new MediaProcessingError('Raw media input is missing or empty', { toolVersions, logs });
  }

  await fs.mkdir(path.dirname(request.outputPath), { recursive: true });
  await appendLog(`probe:start input=${request.inputPath}`);
  const probe = await probeMedia(request.inputPath, ffprobeCommand).catch((error) => {
    throw new MediaProcessingError(error?.message || String(error), { toolVersions, logs });
  });
  if (!probe.streams?.some((stream) => stream.codec_type === 'audio')) {
    throw new MediaProcessingError('Raw media contains no audio stream', { toolVersions, logs });
  }

  await appendLog(`ffmpeg:start output=${request.outputPath}`);
  const ffmpeg = await runCommand(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', request.inputPath,
    '-map', '0:a:0',
    '-vn',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    '-y',
    request.outputPath,
  ]);
  if (ffmpeg.stderr.trim()) await appendLog(`ffmpeg:stderr ${ffmpeg.stderr.trim()}`);
  if (ffmpeg.code !== 0) {
    throw new MediaProcessingError(`ffmpeg failed: ${ffmpeg.stderr.trim() || `exit ${ffmpeg.code}`}`, {
      toolVersions,
      logs,
    });
  }

  const outputProbe = await probeMedia(request.outputPath, ffprobeCommand).catch((error) => {
    throw new MediaProcessingError(error?.message || String(error), { toolVersions, logs });
  });
  await appendLog(`ffmpeg:complete duration=${outputProbe.duration}`);
  return { status: 'succeeded', toolVersions, probe, outputProbe, logs };
}

