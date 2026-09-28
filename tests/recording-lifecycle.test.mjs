import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const serverSource = fs.readFileSync('server.ts', 'utf8');
const studioSource = fs.readFileSync('src/JerryPodcastStudio.tsx', 'utf8');

function runTs(expression) {
  const script = `console.log(JSON.stringify(await (${expression})()));`;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }));
}

test('repeated STOP requests share one idempotent finalization', async () => {
  const result = runTs(`async () => {
    const { RecordingStopCoordinator } = await import('./server/recordingLifecycle.ts');
    const coordinator = new RecordingStopCoordinator();
    coordinator.start('episode-1');
    let finalizeCalls = 0;
    const firstStop = coordinator.requestStop('stop-1', 100);
    const repeatedStop = coordinator.requestStop('stop-1', 100);
    const firstAck = coordinator.finalize('stop-1', async () => { finalizeCalls += 1; });
    const repeatedFinalize = coordinator.finalize('stop-1', async () => { finalizeCalls += 1; });
    const ack = await firstAck;
    return { sameStop: JSON.stringify(firstStop) === JSON.stringify(repeatedStop), samePromise: firstAck === repeatedFinalize, ack, finalizeCalls };
  }`);
  assert.equal(result.sameStop, true);
  assert.equal(result.samePromise, true);
  assert.equal(result.ack.type, 'recording-stop-ack');
  assert.equal(result.ack.recordingId, 'episode-1');
  assert.equal(result.ack.requestId, 'stop-1');
  assert.equal(result.ack.status, 'finalized');
  assert.equal(result.finalizeCalls, 1);
});

test('finalization waits for all in-flight work before returning the server ACK', async () => {
  const result = runTs(`async () => {
    const { RecordingStopCoordinator } = await import('./server/recordingLifecycle.ts');
    const coordinator = new RecordingStopCoordinator();
    coordinator.start('episode-2');
    let resolvePending;
    const pending = new Promise((resolve) => { resolvePending = resolve; });
    coordinator.track(pending);
    coordinator.requestStop('stop-2', 200);
    let finalized = false;
    const ackPromise = coordinator.finalize('stop-2', async () => { finalized = true; });
    const settledBeforeDrain = await Promise.race([ackPromise.then(() => true), Promise.resolve(false)]);
    resolvePending();
    const ack = await ackPromise;
    return { settledBeforeDrain, finalized, inflight: ack.inflight };
  }`);
  assert.equal(result.settledBeforeDrain, false);
  assert.equal(result.finalized, true);
  assert.equal(result.inflight, 0);
});

test('a finalized session returns the same server ACK for a repeated STOP', async () => {
  const result = runTs(`async () => {
    const { RecordingStopCoordinator } = await import('./server/recordingLifecycle.ts');
    const coordinator = new RecordingStopCoordinator();
    coordinator.start('episode-3');
    coordinator.requestStop('stop-3', 300);
    const ack = await coordinator.finalize('stop-3', async () => {});
    const repeatedStop = coordinator.requestStop('stop-3', 300);
    const repeatedAck = await coordinator.finalize('stop-3', async () => {});
    return { repeatedStop, sameAck: repeatedAck === ack };
  }`);
  assert.deepEqual(result.repeatedStop, { status: 'finalized', recordingId: 'episode-3', requestId: 'stop-3', stopAt: 300 });
  assert.equal(result.sameAck, true);
});

test('server and client use the STOP request/finalize/ACK protocol', () => {
  assert.match(serverSource, /new RecordingStopCoordinator()/);
  assert.match(serverSource, /msg\.type === 'recording-stop-request'/);
  assert.match(serverSource, /msg\.type === 'recording-finalize'/);
  assert.match(serverSource, /JSON\.stringify\(ack\)/);
  assert.match(studioSource, /type: 'recording-stop-request'/);
  assert.match(studioSource, /type: 'recording-finalize'/);
  assert.match(studioSource, /msg\.type === 'recording-stop-ack'/);
  assert.match(studioSource, /recordingStopPromiseRef\.current/);
});

test('finalize waits behind an in-flight STOP control message', async () => {
  const result = runTs(`async () => {
    const { RecordingStopCoordinator, RecordingControlQueue } = await import('./server/recordingLifecycle.ts');
    const coordinator = new RecordingStopCoordinator();
    const queue = new RecordingControlQueue();
    coordinator.start('episode-race');
    let stopFinished = false;
    const stop = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      coordinator.requestStop('stop-race', 400);
      stopFinished = true;
    });
    const finalize = queue.run(() => coordinator.finalize('stop-race', async () => {}));
    await Promise.all([stop, finalize]);
    return { stopFinished, state: coordinator.getState() };
  }`);
  assert.deepEqual(result, { stopFinished: true, state: 'finalized' });
});
