import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const graph = fs.readFileSync('src/audio/recordingGraph.ts', 'utf8');
const studio = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');
const leveler = fs.readFileSync('src/audio/autoLeveler.ts', 'utf8');

function extractBalancedObject(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }

    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }

  throw new Error(`Unclosed object starting at ${openIndex}`);
}

function extractGetUserMediaAudioBlocks(source) {
  const blocks = [];
  const callPattern = /navigator\.mediaDevices\.getUserMedia\s*\(\s*\{\s*audio\s*:\s*\{/g;
  let match;

  while ((match = callPattern.exec(source))) {
    const audioStart = match.index + match[0].lastIndexOf('{');
    blocks.push(extractBalancedObject(source, audioStart));
  }

  return blocks;
}

function extractNamedObject(source, name) {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`);
  const match = declaration.exec(source);
  assert.ok(match, `Expected ${name} object declaration`);
  return extractBalancedObject(source, match.index + match[0].lastIndexOf('{'));
}

test('guest and Jerry use intentionally separate processing configurations', () => {
  assert.match(graph, /GUEST_LEVEL_CONFIG/);
  assert.match(graph, /JERRY_LEVEL_CONFIG/);
  assert.match(graph, /GUEST_DYNAMICS_CONFIG/);
  assert.match(graph, /JERRY_DYNAMICS_CONFIG/);
  assert.match(graph, /createChannelChain\(context, sources\.jerry, JERRY_LEVEL_CONFIG/);
  assert.match(graph, /createChannelChain\(context, sources\.guest, GUEST_LEVEL_CONFIG/);
  assert.match(graph, /jerryChain\.compressor[\s\S]{0,240}JERRY_DYNAMICS_CONFIG/);
  assert.match(graph, /guestChain\.compressor[\s\S]{0,240}GUEST_DYNAMICS_CONFIG/);
});

test('microphone capture enables cleanup but delegates leveling to Jerry', () => {
  const sharedConstraints = extractNamedObject(studio, 'MICROPHONE_CAPTURE_CONSTRAINTS');
  assert.match(sharedConstraints, /echoCancellation:\s*true/);
  assert.match(sharedConstraints, /noiseSuppression:\s*true/);
  assert.match(sharedConstraints, /autoGainControl:\s*false/);

  const captureBlocks = extractGetUserMediaAudioBlocks(studio);
  assert.equal(captureBlocks.length, 2, 'expected separate live and recording capture calls');

  for (const [index, block] of captureBlocks.entries()) {
    assert.match(
      block,
      /\.\.\.MICROPHONE_CAPTURE_CONSTRAINTS/,
      `capture block ${index + 1} must use shared microphone constraints`,
    );
  }
});

test('source gain policies are bounded and silence cannot create runaway gain', () => {
  const guestConfig = extractNamedObject(graph, 'GUEST_LEVEL_CONFIG');
  const jerryConfig = extractNamedObject(graph, 'JERRY_LEVEL_CONFIG');
  const guestMaxGain = guestConfig.match(/maxGainDb:\s*(-?\d+(?:\.\d+)?)/);
  const jerryMaxGain = jerryConfig.match(/maxGainDb:\s*(-?\d+(?:\.\d+)?)/);

  assert.ok(guestMaxGain, 'guest config must define a numeric maxGainDb');
  assert.ok(jerryMaxGain, 'Jerry config must define a numeric maxGainDb');
  assert.notEqual(
    Number(guestMaxGain[1]),
    Number(jerryMaxGain[1]),
    'guest and Jerry maxGainDb values must be intentionally distinct',
  );
  assert.match(guestConfig, /gateDbfs:\s*-55/);
  assert.match(jerryConfig, /gateDbfs:\s*-55/);
  assert.match(leveler, /if \(rmsDbfsValue <= config\.gateDbfs\) return 0/);
  assert.match(leveler, /Math\.min\(\s*config\.maxGainDb/);
  assert.match(leveler, /Math\.max\(config\.minGainDb/);
});

test('master output has an explicit conservative ceiling', () => {
  assert.match(graph, /RECORDING_MASTER_CONFIG[\s\S]{0,220}ceilingDb:\s*-1/);
  assert.match(graph, /masterGain\.connect\(masterLimiter\)/);
  assert.match(graph, /masterLimiter\.connect\(destination\)/);
});

test('recording exposes balance telemetry and a publication decision', () => {
  assert.match(graph, /getMetrics/);
  for (const metric of [
    'guestRmsDbfs',
    'jerryRmsDbfs',
    'guestPeakDbfs',
    'jerryPeakDbfs',
    'guestClippingCount',
    'jerryClippingCount',
    'balanceDeltaDb',
  ]) {
    assert.match(graph, new RegExp(`\\b${metric}\\b`), `missing concrete telemetry metric: ${metric}`);
  }
  assert.match(studio, /recording-levels/);
  assert.match(studio, /publicationStatus/);
  assert.match(studio, /publishable/);
  assert.match(studio, /needs-review/);
  assert.match(studio, /failed/);
});
