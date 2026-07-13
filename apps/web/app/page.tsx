import { WaitlistForm } from './waitlist-form';

export default function HomePage() {
  return (
    <div className="container">
      <header>
        <h1>AI Newsroom Studio</h1>
        <p className="subtitle">Policy-constrained AI news research — from original sources to fact-gated Telegram briefings.</p>
      </header>

      <section className="telegram-card">
        <div className="telegram-main">
          <span className="telegram-icon" aria-hidden="true">✈️</span>
          <div className="telegram-copy">
            <h2>Try AI Newsroom Studio on Telegram</h2>
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
        </div>
        <a
          className="telegram-qr"
          href="https://t.me/Newsroomhermesbot"
          target="_blank"
          rel="noreferrer"
          aria-label="Open the AI Newsroom Studio Telegram bot"
        >
          <span className="telegram-qr-frame">
            <img
              src="/newsroomhermesbot-qr.png"
              width="370"
              height="370"
              alt="QR code to open the AI Newsroom Studio Telegram bot"
            />
          </span>
          <span className="telegram-qr-label">Scan to open in Telegram</span>
        </a>
      </section>

      <section className="how-it-works" aria-labelledby="how-it-works-title">
        <div className="section-heading">
          <p className="section-kicker">Your personalized briefing in minutes</p>
          <h2 id="how-it-works-title">How It Works</h2>
        </div>
        <ol className="how-it-works-list">
          <li>Open the Telegram bot and press <strong>Start</strong>.</li>
          <li>Choose one AI topic to follow.</li>
          <li>Choose one analysis angle.</li>
          <li>Select a news range from the available options.</li>
          <li>Choose text-only or text-and-audio delivery.</li>
          <li>Review your preferences and press <strong>Generate Now</strong>.</li>
          <li>Receive your fact-gated briefing in Telegram.</li>
        </ol>
      </section>

      <p><a className="episode-link" href="/episodes/latest">Listen to the latest verified episode →</a></p>

      <WaitlistForm />

      <footer>
        <p>
          Built for the Hermes Buildathon &middot; <strong>@ai-newsroom-studio</strong>
        </p>
      </footer>
    </div>
  );
}
