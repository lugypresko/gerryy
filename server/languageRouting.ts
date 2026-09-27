export const CODE_SWITCH_LANGUAGE_CODES = ['he-IL', 'en-US'] as const;

export const CODE_SWITCH_TRANSCRIPTION_CONFIG = {
  languageCodes: CODE_SWITCH_LANGUAGE_CODES,
  mode: 'VERBATIM' as const,
  preserveCodeSwitching: true,
};

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
