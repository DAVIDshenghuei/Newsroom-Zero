import { describe, expect, it } from 'vitest';
import { OUTPUT_LANGUAGES, OUTPUT_LANGUAGE_VALUES, getOutputLanguage } from '../languages.js';
import { EpisodeMetadataSchema } from '../voice.js';

describe('output language catalog', () => {
  it('contains the exact stable menu values and official Pocket defaults', () => {
    expect(OUTPUT_LANGUAGES).toEqual([
      { value: 'english', label: 'English', analysisLanguage: 'English', pocketLanguage: 'english', pocketVoice: 'alba' },
      { value: 'french', label: 'French', analysisLanguage: 'French', pocketLanguage: 'french_24l', pocketVoice: 'estelle' },
      { value: 'german', label: 'German', analysisLanguage: 'German', pocketLanguage: 'german_24l', pocketVoice: 'juergen' },
      { value: 'spanish', label: 'Spanish', analysisLanguage: 'Spanish', pocketLanguage: 'spanish_24l', pocketVoice: 'lola' },
      { value: 'italian', label: 'Italian', analysisLanguage: 'Italian', pocketLanguage: 'italian', pocketVoice: 'giovanni' },
      { value: 'portuguese', label: 'Portuguese', analysisLanguage: 'Portuguese', pocketLanguage: 'portuguese', pocketVoice: 'rafael' },
    ]);
    expect(getOutputLanguage('french')).toEqual(OUTPUT_LANGUAGES[1]);
  });

  it('derives the runtime schema tuple from the canonical catalog', () => {
    expect(OUTPUT_LANGUAGE_VALUES).toEqual(OUTPUT_LANGUAGES.map(({ value }) => value));
    for (const outputLanguage of OUTPUT_LANGUAGE_VALUES) {
      expect(EpisodeMetadataSchema.shape.outputLanguage.unwrap().parse(outputLanguage)).toBe(outputLanguage);
    }
  });
});
