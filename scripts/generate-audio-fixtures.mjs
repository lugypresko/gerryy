import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const SAMPLE_RATE = 48_000;
const DURATION_SECONDS = 4;

function parseOutputDirectory(argv) {
  const index = argv.indexOf('--output');
  if (index < 0 || !argv[index + 1]) throw new Error('Usage: node scripts/generate-audio-fixtures.mjs --output <directory>');
  return path.resolve(argv[index + 1]);
}

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function makeChannel(length, frequency, gainDb, windows) {
  const data = new Float32Array(length);
  const gain = dbToLinear(gainDb);
  for (let i = 0; i < length; i++) {
    const timeMs = (i / SAMPLE_RATE) * 1000;
    if (windows.some(([start, end]) => timeMs >= start && timeMs < end)) {
      data[i] = Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) * gain;
    }
  }
  return data;
}

function writeWav(channels, outputPath) {
  const frames = channels[0].length;
  const channelCount = channels.length;
  const bytesPerSample = 2;
  const dataSize = frames * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      buffer.writeInt16LE(sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), offset);
      offset += bytesPerSample;
    }
  }
  return fs.writeFile(outputPath, buffer);
}

async function runTool(command, args) {
  try {
    const result = await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || String(error),
    };
  }
}

function findChrome() {
  return process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => candidate.includes('/') && candidate.includes(':')
    ? true
    : false);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopBrowserProcess(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await runTool('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
}

async function removeProfileWithRetry(profile) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await sleep(100);
    }
  }
}

async function waitForJson(url, attempts = 50, method = 'GET') {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { method });
      if (response.ok) return response.json();
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function browserCaptureExpression() {
  return `(${(async () => {
    const sampleRate = 48000;
    const frames = sampleRate * 2;
    const context = new AudioContext({ sampleRate });
    context.resume();
    const destination = context.createMediaStreamDestination();
    const buffer = context.createBuffer(2, frames, sampleRate);
    const jerry = buffer.getChannelData(0);
    const guest = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      const seconds = i / sampleRate;
      jerry[i] = seconds < 1.2 ? Math.sin(2 * Math.PI * 440 * seconds) * 0.16 : 0;
      guest[i] = seconds >= 0.4 && seconds < 2 ? Math.sin(2 * Math.PI * 660 * seconds) * 0.08 : 0;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.connect(context.destination);
    const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve({ stopped: true });
      recorder.onerror = (event) => reject(new Error(event.error?.message || 'MediaRecorder error'));
      setTimeout(() => resolve({ stopped: false, state: recorder.state, chunks: chunks.length }), 6000);
    });
    recorder.start(100);
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    recorder.stop();
    const stopResult = await stopped;
    if (!stopResult.stopped) throw new Error('MediaRecorder did not stop: ' + JSON.stringify(stopResult));
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await context.close();
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { base64: btoa(binary), mimeType: recorder.mimeType, byteLength: bytes.length };
  }).toString()})()`;
}

async function captureBrowserMediaRecorder() {
  const executable = findChrome();
  if (!executable) throw new Error('Chrome/Edge executable not found; set CHROME_PATH to capture MediaRecorder fixture');
  const port = await freePort();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jerry-fixture-browser-'));
  const child = (await import('node:child_process')).spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank');
    if (!page) throw new Error('Chrome did not expose an about:blank page target');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    let nextId = 1;
    const evaluate = (expression) => new Promise((resolve, reject) => {
      const id = nextId++;
      const onMessage = (payload) => {
        const message = JSON.parse(payload.toString());
        if (message.id !== id) return;
        socket.off('message', onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)));
        else resolve(message.result.result.value);
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }}));
    });
    const capture = await Promise.race([
      evaluate(browserCaptureExpression()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MediaRecorder capture timed out after 20000ms')), 20_000)),
    ]);
    socket.close();
    return { ...capture, stderr };
  } finally {
    await stopBrowserProcess(child);
    await removeProfileWithRetry(profile);
  }
}

async function probeAndDecode(file) {
  const probeResult = await runTool(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const decodeResult = await runTool(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return {
    probe: {
      status: probeResult.status,
      stderr: probeResult.stderr,
      metadata: probeResult.status === 0 ? JSON.parse(probeResult.stdout) : null,
    },
    decode: {
      status: decodeResult.status,
      stderr: decodeResult.stderr,
    },
  };
}

async function main() {
  const output = parseOutputDirectory(process.argv.slice(2));
  await fs.mkdir(output, { recursive: true });
  const frames = SAMPLE_RATE * DURATION_SECONDS;
  const jerryWindows = [[0, 1000], [2000, 3500]];
  const guestWindows = [[500, 1500], [2500, 3500]];
  await writeWav([
    makeChannel(frames, 440, -18, jerryWindows),
    makeChannel(frames, 660, -25, guestWindows),
  ], path.join(output, 'stereo-unbalanced.wav'));
  await writeWav([
    makeChannel(frames, 440, -18, jerryWindows),
    makeChannel(frames, 660, -18, guestWindows),
  ], path.join(output, 'stereo-unequal-duration.wav'));
  await writeWav([new Float32Array(SAMPLE_RATE * 2), new Float32Array(SAMPLE_RATE * 2)], path.join(output, 'stereo-silence.wav'));
  await writeWav([makeChannel(SAMPLE_RATE * 2, 440, -18, [[0, 1000]])], path.join(output, 'mono.wav'));

  const validWav = await fs.readFile(path.join(output, 'stereo-unbalanced.wav'));
  await fs.writeFile(path.join(output, 'damaged-container.wav'), validWav.subarray(0, 32));

  let browser = null;
  let browserError = null;
  try {
    browser = await captureBrowserMediaRecorder();
    await fs.writeFile(path.join(output, 'browser-mediarecorder.webm'), Buffer.from(browser.base64, 'base64'));
  } catch (error) {
    browserError = error?.stack || error?.message || String(error);
    await fs.writeFile(path.join(output, 'browser-mediarecorder.diagnostics.json'), JSON.stringify({
      captureMethod: 'MediaRecorder',
      status: 'unavailable',
      error: browserError,
    }, null, 2));
  }

  const names = [
    'stereo-unbalanced.wav',
    'stereo-unequal-duration.wav',
    'stereo-silence.wav',
    'mono.wav',
    'damaged-container.wav',
  ];
  if (browser) names.push('browser-mediarecorder.webm');
  const sourceHashes = {};
  const baselineResults = {};
  for (const name of names) {
    const file = path.join(output, name);
    const bytes = await fs.readFile(file);
    sourceHashes[name] = {
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
    baselineResults[name] = await probeAndDecode(file);
  }

  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    generatedBy: 'scripts/generate-audio-fixtures.mjs',
    sampleRate: SAMPLE_RATE,
    sourceHashes,
    expected: {
      stereoUnbalanced: { leftSpeaker: 'jerry', rightSpeaker: 'guest', guestGainDeltaDb: 7 },
      unequalSpeakingWindows: { jerryMs: 2500, guestMs: 2000 },
      silenceDurationMs: 2000,
      monoChannels: 1,
    },
    browserMediaRecorder: browser ? {
      captureMethod: 'MediaRecorder',
      mimeType: browser.mimeType,
      byteLength: browser.byteLength,
      browserStderr: browser.stderr,
      status: 'captured',
    } : {
      captureMethod: 'MediaRecorder',
      status: 'unavailable',
      error: browserError,
    },
    baselineResults,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
