export type LocalTtsProvider = 'pocket-tts' | 'kokoro';

export const OUTPUT_LANGUAGES = [
  { value: 'english', label: 'English', analysisLanguage: 'English', ttsLanguage: 'english', ttsVoice: 'alba', ttsProvider: 'pocket-tts' },
  { value: 'french', label: 'French', analysisLanguage: 'French', ttsLanguage: 'french_24l', ttsVoice: 'estelle', ttsProvider: 'pocket-tts' },
  { value: 'german', label: 'German', analysisLanguage: 'German', ttsLanguage: 'german_24l', ttsVoice: 'juergen', ttsProvider: 'pocket-tts' },
  { value: 'spanish', label: 'Spanish', analysisLanguage: 'Spanish', ttsLanguage: 'spanish_24l', ttsVoice: 'lola', ttsProvider: 'pocket-tts' },
  { value: 'italian', label: 'Italian', analysisLanguage: 'Italian', ttsLanguage: 'italian', ttsVoice: 'giovanni', ttsProvider: 'pocket-tts' },
  { value: 'portuguese', label: 'Portuguese', analysisLanguage: 'Portuguese', ttsLanguage: 'portuguese', ttsVoice: 'rafael', ttsProvider: 'pocket-tts' },
  { value: 'traditional_chinese', label: 'Traditional Chinese', analysisLanguage: 'Traditional Chinese', ttsLanguage: 'chinese_traditional', ttsVoice: 'zf_xiaoxiao', ttsProvider: 'kokoro' },
] as const satisfies readonly {
  value: string;
  label: string;
  analysisLanguage: string;
  ttsLanguage: string;
  ttsVoice: string;
  ttsProvider: LocalTtsProvider;
}[];

export type OutputLanguage = typeof OUTPUT_LANGUAGES[number]['value'];
export type OutputLanguageConfig = typeof OUTPUT_LANGUAGES[number];
export const OUTPUT_LANGUAGE_VALUES = OUTPUT_LANGUAGES.map(({ value }) => value) as unknown as readonly [
  OutputLanguage,
  ...OutputLanguage[],
];

export function getOutputLanguage(value: OutputLanguage): OutputLanguageConfig {
  const language = OUTPUT_LANGUAGES.find((item) => item.value === value);
  if (!language) throw new Error(`Unsupported output language: ${value}`);
  return language;
}
