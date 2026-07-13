export const OUTPUT_LANGUAGES = [
  { value: 'english', label: 'English', analysisLanguage: 'English', pocketLanguage: 'english', pocketVoice: 'alba' },
  { value: 'french', label: 'French', analysisLanguage: 'French', pocketLanguage: 'french_24l', pocketVoice: 'estelle' },
  { value: 'german', label: 'German', analysisLanguage: 'German', pocketLanguage: 'german_24l', pocketVoice: 'juergen' },
  { value: 'spanish', label: 'Spanish', analysisLanguage: 'Spanish', pocketLanguage: 'spanish_24l', pocketVoice: 'lola' },
  { value: 'italian', label: 'Italian', analysisLanguage: 'Italian', pocketLanguage: 'italian', pocketVoice: 'giovanni' },
  { value: 'portuguese', label: 'Portuguese', analysisLanguage: 'Portuguese', pocketLanguage: 'portuguese', pocketVoice: 'rafael' },
] as const;

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
