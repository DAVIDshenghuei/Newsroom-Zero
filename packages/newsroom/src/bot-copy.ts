export const WELCOME_MESSAGE = 'Welcome to Newsroom Zero.\n\n' +
  'I search the latest AI news, analyze trends, and turn them into actionable insights.\n\n' +
  'What AI topics should I research? Send comma-separated topics or free text.\n' +
  'Examples: AI Agents, AI Glasses, Claude Code, OpenAI API, AI x Blockchain, AI Travel';

export const BOT_COPY = Object.freeze({
  welcome: WELCOME_MESSAGE,
  askAngles: 'Which analysis angles should I use? Send comma-separated angles or free text.\nExamples: Startup Opportunities, Product Strategy, Technical Trends, Investment Signals',
  askRange: 'Choose a news range:',
  askDelivery: 'How would you like to receive your briefing?',
  textOnly: 'Text Only',
  textAndAudio: 'Text + Audio',
  invalidTopics: 'Please send at least one AI topic as text.',
  invalidAngles: 'Please send at least one analysis angle as text.',
  invalidRange: 'Please choose Past 24 Hours, Past 3 Days, or Past 7 Days.',
  invalidDelivery: 'Please choose Text Only or Text + Audio.',
  confirmation: 'Your research brief is ready.',
  generateNow: 'Generate Now',
  generating: 'Researching the latest news and preparing your briefing now.',
  alreadyGenerating: 'A briefing is already being generated for this chat. Please wait for it to finish.',
  generationFailed: 'I could not generate the briefing right now. Please try Generate Now again later.',
  generationComplete: 'Your Newsroom Zero AI briefing is ready.',
  audioUnavailable: 'Audio generation is unavailable right now. Your text briefing is below.',
  expired: 'This research brief is incomplete. Send /start to begin again.',
});
