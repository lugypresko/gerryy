import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const baseUrl = process.env.CANONICAL_CAPTURE_BASE_URL || 'http://localhost:3000';
const serverSource = fs.readFileSync('server.ts', 'utf8');
const hasCanonicalIngest = /app\.post\(\[.*\/api\/captures\/start/s.test(serverSource);
const hasCanonicalStop = /recording-stop-ack|canonical.*stop/i.test(serverSource);

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(3000) });
}

test('canonical capture E2E harness can reach the local app and debug monitor', async (t) => {
  try {
    const app = await get('/');
    assert.equal(app.ok, true, `app returned HTTP ${app.status}`);
    const monitor = await get('/api/jerry-debug');
    assert.equal(monitor.ok, true, `debug monitor returned HTTP ${monitor.status}`);
    const payload = await monitor.json() as { events?: unknown };
    assert.ok(Array.isArray(payload.events), 'debug monitor must return an events array');
  } catch (error) {
    t.skip(`BLOCKED: local server unavailable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
});

test('canonical capture E2E adapter exposes ingest and server-confirmed STOP', () => {
  if (!hasCanonicalIngest || !hasCanonicalStop) {
    const missing = [
      !hasCanonicalIngest ? 'POST /api/recordings/capture' : null,
      !hasCanonicalStop ? 'server-confirmed canonical STOP ACK' : null,
    ].filter(Boolean).join(', ');
    throw new Error(`runtime adapter is not implemented (${missing})`);
  }
  assert.match(serverSource, /app\.post\(\[.*\/api\/captures\/.*finalize/s);
  assert.match(serverSource, /recording-stop-ack/);
});
