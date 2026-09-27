import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const baseUrl = process.env.RELEASE_GATE_BASE_URL || 'http://localhost:3000';
const allowSkip = process.env.RELEASE_GATE_ALLOW_SKIP === '1';

function hasCredentials(): boolean {
  if (process.env.GEMINI_API_KEY?.trim()) return true;
  if (!fs.existsSync('.api-key.json')) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync('.api-key.json', 'utf8')) as Record<string, unknown>;
    return Object.values(parsed).some((value) => typeof value === 'string' && value.trim().length > 0);
  } catch {
    return false;
  }
}

async function probeServer(): Promise<string | null> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return `server responded with HTTP ${response.status}`;
    return null;
  } catch (error) {
    return `server unavailable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

test('podcast release gate: app, browser, and credentials are available', async (t) => {
  const diagnostics: string[] = [];
  const serverError = await probeServer();
  if (serverError) diagnostics.push(serverError);
  if (!hasCredentials()) diagnostics.push('Gemini credentials unavailable: set GEMINI_API_KEY or provide a valid .api-key.json');

  let playwright: typeof import('@playwright/test');
  try {
    playwright = await import('@playwright/test');
  } catch {
    diagnostics.push('Playwright unavailable: install @playwright/test and its browser binaries');
  }

  if (diagnostics.length > 0) {
    const message = `RELEASE GATE PREREQUISITES NOT MET\n- ${diagnostics.join('\n- ')}`;
    if (allowSkip) {
      console.warn(message + '\nExplicit skip enabled via RELEASE_GATE_ALLOW_SKIP=1');
      t.skip(message);
      return;
    }
    throw new Error(message);
  }

  const browser = await playwright!.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const body = await page.locator('body').innerText();
    assert.match(body, /הקלט|פודקאסט|podcast/i, 'podcast recording UI is missing');
    const debugResponse = await page.request.get(`${baseUrl}/api/jerry-debug`);
    assert.equal(debugResponse.ok(), true, 'debug monitor endpoint is unavailable');
  } finally {
    await browser.close();
  }
});
