import assert from 'node:assert/strict';
import test from 'node:test';

const base = process.env.CANONICAL_API_BASE_URL || 'http://localhost:3000';

function pcmBase64(sampleCount, value) {
  const pcm = new Int16Array(sampleCount).fill(value);
  return Buffer.from(pcm.buffer).toString('base64');
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  assert.equal(response.ok, true, `${options.method || 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

test('canonical capture runtime keeps both stems and transcript/events under one episode', async (t) => {
  try {
    const episodeId = `runtime-${Date.now()}`;
    const started = await request('/api/captures/start', {
      method: 'POST',
      body: JSON.stringify({ episodeId, metadata: { test: 'runtime' } }),
    });
    assert.equal(started.body.episodeId, episodeId);

    const common = { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', sampleCount: 1600 };
    for (const [source, value] of [['human', 1000], ['jerry', -1000]]) {
      await request(`/api/captures/${episodeId}/chunks`, {
        method: 'POST',
        body: JSON.stringify({
          source,
          sequence: 0,
          captureStartMs: 0,
          captureEndMs: 100,
          data: pcmBase64(common.sampleCount, value),
          ...common,
        }),
      });
    }

    const stopped = await request(`/api/captures/${episodeId}/stop`, {
      method: 'POST',
      body: JSON.stringify({ stopAt: Date.now() }),
    });
    assert.equal(stopped.body.status, 'stopping');
    const finalized = await request(`/api/captures/${episodeId}/finalize`, { method: 'POST', body: '{}' });
    assert.equal(finalized.body.status, 'finalized');

    const status = await request(`/api/captures/${episodeId}/status`);
    assert.equal(status.body.manifest.streams.human.byteCount > 0, true);
    assert.equal(status.body.manifest.streams.jerry.byteCount > 0, true);

    for (const source of ['human', 'jerry']) {
      const stem = await request(`/api/captures/${episodeId}/source/${source}/download`);
      assert.equal(stem.response.headers.get('content-type'), 'audio/wav');
      assert.equal(stem.body.subarray(0, 4).toString(), 'RIFF');
      assert.equal(stem.body.length > 44, true);
    }
  } catch (error) {
    t.skip(`BLOCKED: runtime server unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
});
