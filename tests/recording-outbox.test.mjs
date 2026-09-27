import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingOutbox, createMemoryOutboxStore } from '../src/audio/recordingOutbox.ts';

function blob(text) {
  return new Blob([text], { type: 'audio/webm' });
}

test('outbox allocates an episode and preserves chunks in source/sequence order', async () => {
  const outbox = await createRecordingOutbox({ store: createMemoryOutboxStore() });
  const episodeId = outbox.episodeId;

  await outbox.appendChunk({ source: 'master', sequence: 1, blob: blob('second') });
  await outbox.appendChunk({ source: 'master', sequence: 0, blob: blob('first') });

  const chunks = await outbox.listChunks('master');
  assert.equal(episodeId.length > 0, true);
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), [0, 1]);
  assert.equal(await chunks[0].blob.text(), 'first');
  assert.equal(await chunks[1].blob.text(), 'second');
});

test('outbox is idempotent for a retried chunk and removes it only after acknowledged upload', async () => {
  const outbox = await createRecordingOutbox({
    store: createMemoryOutboxStore(),
    retention: 'until-ack',
  });
  const chunk = { source: 'guest', sequence: 0, blob: blob('guest-0') };
  await outbox.appendChunk(chunk);
  await outbox.appendChunk(chunk);

  let uploads = 0;
  const uploaded = await outbox.resumeUploads(async (queued) => {
    uploads += 1;
    assert.equal(queued.episodeId, outbox.episodeId);
    return { acknowledged: true, sha256: queued.sha256 };
  });

  assert.equal(uploaded, 1);
  assert.equal(uploads, 1);
  assert.deepEqual(await outbox.listChunks('guest'), []);
});

test('failed upload remains pending and a later resume retries it without duplication', async () => {
  const store = createMemoryOutboxStore();
  const first = await createRecordingOutbox({ store, retention: 'until-ack' });
  await first.appendChunk({ source: 'jerry', sequence: 0, blob: blob('jerry-0') });

  await assert.rejects(
    () => first.resumeUploads(async () => { throw new Error('offline'); }),
    /offline/,
  );
  assert.equal((await first.listChunks('jerry')).length, 1);

  const reloaded = await createRecordingOutbox({ episodeId: first.episodeId, store, retention: 'until-ack' });
  let attempts = 0;
  assert.equal(await reloaded.resumeUploads(async (queued) => {
    attempts += 1;
    return { acknowledged: true, sha256: queued.sha256 };
  }), 1);
  assert.equal(attempts, 1);
  assert.deepEqual(await reloaded.listChunks('jerry'), []);
});

test('episode snapshot persists sources and the full timeline, not only a turn count', async () => {
  const store = createMemoryOutboxStore();
  const outbox = await createRecordingOutbox({ store });
  const timeline = [{ id: 'turn-1', sender: 'guest', startedAt: 10, endedAt: 20 }];

  await outbox.saveSnapshot({
    master: blob('master'),
    jerry: blob('jerry'),
    guest: blob('guest'),
    timeline,
  });
  const reloaded = await createRecordingOutbox({ episodeId: outbox.episodeId, store });
  const snapshot = await reloaded.getSnapshot();

  assert.equal(await snapshot.master.text(), 'master');
  assert.equal(await snapshot.jerry.text(), 'jerry');
  assert.equal(await snapshot.guest.text(), 'guest');
  assert.deepEqual(snapshot.timeline, timeline);
});
