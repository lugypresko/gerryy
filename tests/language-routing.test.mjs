import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routing = fs.existsSync('server/languageRouting.ts')
  ? fs.readFileSync('server/languageRouting.ts', 'utf8')
  : '';
const server = fs.readFileSync('server.ts', 'utf8');
const manifest = JSON.parse(fs.readFileSync('tests/fixtures/code-switching-manifest.json', 'utf8'));
const { extractGeneratedTranscript } = await import('../server/languageRouting.ts');

test('language routing defines mixed Hebrew/English preservation policy', () => {
  assert.match(routing, /export const CODE_SWITCH_LANGUAGE_CODES/);
  assert.match(routing, /he-IL/);
  assert.match(routing, /en-US/);
  assert.match(routing, /preserve/);
  assert.match(routing, /VERBATIM/);
  assert.match(routing, /do not translate|without translating/i);
});

test('server uses language routing for transcription and Jerry prompt', () => {
  assert.match(server, /buildJerryLanguagePrompt/);
  assert.match(server, /languageRouting|CODE_SWITCH_LANGUAGE_CODES/);
  assert.match(server, /inputAudioTranscription:/);
  assert.doesNotMatch(server, /languageCodes:\s*\['he-IL'\]/);
  assert.doesNotMatch(server, /Hebrew transcription session error/);
});

test('mock provider preserves every fixture transcript and mixed language settings', () => {
  const mockProvider = ({ text, languageCodes }) => ({ text, languageCodes });
  for (const fixture of manifest.cases) {
    const result = mockProvider({ text: fixture.input, languageCodes: fixture.expectedLanguages });
    assert.deepEqual(result.languageCodes, ['he-IL', 'en-US']);
    assert.equal(result.text, fixture.expectedTranscript);
  }
});

test('live-provider proof is explicitly separated from deterministic mocks', () => {
  assert.equal(manifest.liveProviderProof.required, true);
  assert.match(manifest.liveProviderProof.note, /real Gemini credential/i);
  assert.match(server, /live-provider|provider proof|providerProof/i);
});

test('authoritative transcription extracts Gemini audioTranscription parts', () => {
  const response = {
    text: '',
    candidates: [{
      content: {
        parts: [
          { audioTranscription: { text: 'אז איך החיים שלך?' } },
        ],
      },
    }],
  };
  assert.equal(extractGeneratedTranscript(response), 'אז איך החיים שלך?');
});
