import { describe, expect, it } from 'vitest';
import { OUTPUT_LANGUAGES, OUTPUT_LANGUAGE_VALUES, getOutputLanguage } from '../languages.js';
import { EpisodeMetadataSchema } from '../voice.js';

describe('output language catalog', () => {
  it('contains the exact stable menu values and routes each language to its local TTS provider', () => {
    expect(OUTPUT_LANGUAGES).toEqual([
      { value: 'english', label: 'English', analysisLanguage: 'English', ttsLanguage: 'english', ttsVoice: 'alba', ttsProvider: 'pocket-tts' },
      { value: 'french', label: 'French', analysisLanguage: 'French', ttsLanguage: 'french_24l', ttsVoice: 'estelle', ttsProvider: 'pocket-tts' },
      { value: 'german', label: 'German', analysisLanguage: 'German', ttsLanguage: 'german_24l', ttsVoice: 'juergen', ttsProvider: 'pocket-tts' },
      { value: 'spanish', label: 'Spanish', analysisLanguage: 'Spanish', ttsLanguage: 'spanish_24l', ttsVoice: 'lola', ttsProvider: 'pocket-tts' },
      { value: 'italian', label: 'Italian', analysisLanguage: 'Italian', ttsLanguage: 'italian', ttsVoice: 'giovanni', ttsProvider: 'pocket-tts' },
      { value: 'portuguese', label: 'Portuguese', analysisLanguage: 'Portuguese', ttsLanguage: 'portuguese', ttsVoice: 'rafael', ttsProvider: 'pocket-tts' },
      { value: 'traditional_chinese', label: 'Traditional Chinese', analysisLanguage: 'Traditional Chinese', ttsLanguage: 'chinese_traditional', ttsVoice: 'zf_xiaoxiao', ttsProvider: 'kokoro' },
    ]);
    expect(getOutputLanguage('traditional_chinese')).toEqual(OUTPUT_LANGUAGES[6]);
  });

  it('derives the runtime schema tuple from the canonical catalog', () => {
    expect(OUTPUT_LANGUAGE_VALUES).toEqual(OUTPUT_LANGUAGES.map(({ value }) => value));
    for (const outputLanguage of OUTPUT_LANGUAGE_VALUES) {
      expect(EpisodeMetadataSchema.shape.outputLanguage.unwrap().parse(outputLanguage)).toBe(outputLanguage);
    }
  });
});
