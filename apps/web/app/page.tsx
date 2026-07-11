import { WaitlistForm } from './waitlist-form';

const pipeline = [
  { emoji: '📡', label: 'Live Feeds', desc: 'Ingest from RSS, Twitter, webhooks' },
  { emoji: '✏️', label: 'Editor', desc: 'Select and rank stories for each edition' },
  { emoji: '📝', label: 'Writer', desc: 'Draft concise news briefs' },
  { emoji: '⚖️', label: 'Fact Judge', desc: 'Verify claims, reject misinformation' },
  { emoji: '🎙️', label: 'Voice', desc: 'Generate natural audio narration' },
  { emoji: '📬', label: 'Telegram', desc: 'Dispatch to subscribers' },
] as const;

export default function HomePage() {
  return (
    <div className="container">
      <header>
        <h1>Newsroom Zero</h1>
        <p className="subtitle">Autonomous multi-agent newsroom — from live feeds to Telegram, end-to-end.</p>
      </header>

      <section>
        <h2>Pipeline</h2>
        <div className="pipeline">
          {pipeline.map((step) => (
            <div className="step" key={step.label}>
              <span className="emoji">{step.emoji}</span>
              <span className="label">{step.label}</span>
              <span className="desc">{step.desc}</span>
            </div>
          ))}
        </div>
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
