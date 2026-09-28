export const CODE_SWITCH_LANGUAGE_CODES = ['he-IL', 'en-US'] as const;

export const CODE_SWITCH_TRANSCRIPTION_CONFIG = {
  languageCodes: CODE_SWITCH_LANGUAGE_CODES,
};

// Application policy; these fields are intentionally not spread into the
// provider request because Gemini rejects unknown inputAudioTranscription keys.
export const CODE_SWITCH_PRESERVATION_POLICY = {
  mode: 'VERBATIM' as const,
  preserveCodeSwitching: true,
};

export function extractGeneratedTranscript(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const candidateResponse = response as {
    text?: unknown;
    candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
  };

  if (typeof candidateResponse.text === 'string' && candidateResponse.text.trim()) {
    return candidateResponse.text.trim();
  }

  const parts = (candidateResponse.candidates || []).flatMap(
    (candidate) => candidate.content?.parts || [],
  );
  const text = parts
    .map((part) => {
      if (typeof part.text === 'string') return part.text;
      const transcription = part.audioTranscription || part.audio_transcription;
      return transcription && typeof transcription === 'object' && 'text' in transcription
        ? transcription.text
        : '';
    })
    .filter((value): value is string => typeof value === 'string')
    .join('')
    .trim();

  return text;
}

export function buildJerryLanguagePrompt(basePrompt: string): string {
  return `${basePrompt}

Language and code-switching policy:
- Detect Hebrew and English naturally in every turn; the guest may switch languages mid-sentence.
- Preserve the transcript verbatim, including English technical terms inside Hebrew and Hebrew phrases inside English.
- Do not translate, normalize, transliterate, or treat a language switch as a transcription error.
- Reply in the language mix and register the guest used, unless the guest explicitly asks for another language.
- Keep code, product names, acronyms, and technical vocabulary exactly as spoken when possible.`;
}

export function selectTtsLanguage(text: string): 'he-IL' | 'en-US' | undefined {
  const hasHebrew = /[\u0590-\u05ff]/u.test(text);
  const hasLatin = /[A-Za-z]/u.test(text);
  if (hasHebrew && hasLatin) return undefined;
  if (hasHebrew) return 'he-IL';
  if (hasLatin) return 'en-US';
  return undefined;
}
