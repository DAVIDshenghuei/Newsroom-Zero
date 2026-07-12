export const WELCOME_MESSAGE = 'Welcome to Newsroom Zero.\n\n' +
  'I search the latest AI news, analyze trends, and turn them into actionable insights.\n\n' +
  'Choose an AI topic below.';

export const BOT_COPY = Object.freeze({
  welcome: WELCOME_MESSAGE,
  askTopics: 'Choose an AI topic:',
  askAngles: 'Choose an analysis angle:',
  askRange: 'Choose a news range:',
  askDelivery: 'How would you like to receive your briefing?',
  textOnly: 'Text Only',
  textAndAudio: 'Text + Audio',
  invalidTopics: 'Please choose an AI topic from the menu.',
  invalidAngles: 'Please choose an analysis angle from the menu.',
  invalidRange: 'Please choose Past 24 Hours, Past 3 Days, or Past 7 Days.',
  invalidDelivery: 'Please choose Text Only or Text + Audio.',
  confirmation: 'Your research brief is ready.',
  generateNow: 'Generate Now',
  generating: 'Researching the latest news and preparing your briefing now.',
  alreadyGenerating: 'A briefing is already being generated for this chat. Please wait for it to finish.',
  generationFailed: 'I could not generate the briefing right now. Please try Generate Now again later.',
  noRecentStories: 'I could not find any reliably dated stories in that publication window. Please choose a broader news range and try again.',
  generationComplete: 'Your Newsroom Zero AI briefing is ready.',
  audioUnavailable: 'Audio generation is unavailable right now. Your text briefing is below.',
  expired: 'This research brief is incomplete. Send /start to begin again.',
});
