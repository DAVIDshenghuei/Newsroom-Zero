import { WaitlistForm } from './waitlist-form';

export default function HomePage() {
  return (
    <div className="container">
      <header>
        <h1>Newsroom Zero</h1>
        <p className="subtitle">Autonomous multi-agent newsroom — from live feeds to Telegram, end-to-end.</p>
      </header>

      <section className="telegram-card">
        <span className="telegram-icon" aria-hidden="true">✈️</span>
        <div>
          <h2>Try Newsroom Zero on Telegram</h2>
          <p>Open the bot to receive the latest fact-gated audio bulletin.</p>
        </div>
        <a
          className="telegram-button"
          href="https://t.me/Newsroomhermesbot"
          target="_blank"
          rel="noreferrer"
        >
          Open Telegram Bot →
        </a>
      </section>

      <section className="how-it-works" aria-labelledby="how-it-works-title">
        <div className="section-heading">
          <p className="section-kicker">Your personalized briefing in minutes</p>
          <h2 id="how-it-works-title">How It Works</h2>
        </div>
        <ol className="how-it-works-list">
          <li>Open the Telegram bot and press <strong>Start</strong>.</li>
          <li>Enter the AI topics you want to follow.</li>
          <li>Choose the analysis angles that matter to you.</li>
          <li>Select a news range from the available options.</li>
          <li>Review your preferences and press <strong>Generate Now</strong>.</li>
          <li>Receive your fact-gated audio briefing in Telegram.</li>
        </ol>
      </section>

      <p><a className="episode-link" href="/episodes/latest">Listen to the latest verified episode →</a></p>

      <WaitlistForm />

      <footer>
        <p>
          Built for the Hermes Buildathon &middot; <strong>@newsroom-zero</strong>
        </p>
      </footer>
    </div>
  );
}
