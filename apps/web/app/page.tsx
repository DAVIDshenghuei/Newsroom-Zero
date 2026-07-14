import { WaitlistForm } from './waitlist-form';

const telegramUrl = 'https://t.me/Newsroomhermesbot';

export default function HomePage() {
  return (
    <main>
      <nav className="site-nav" aria-label="Primary navigation">
        <a className="wordmark" href="#top" aria-label="AI Newsroom Studio home">
          <span className="wordmark-mark" aria-hidden="true">AN</span>
          <span>AI Newsroom Studio</span>
        </a>
        <div className="nav-links">
          <a href="#modes">Two modes</a>
          <a href="#pilot">Join the pilot</a>
        </div>
      </nav>

      <div id="top" className="landing-shell">
        <header className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Private listening for important material</p>
            <h1>Important reading, ready to listen.</h1>
            <p className="hero-descriptor">Trusted news and your own documents, turned into portable audio.</p>
            <p className="hero-detail">
              Choose a cited AI news briefing or send your own text through Telegram. One studio,
              two clearly separated paths, and the source stays visible.
            </p>
            <div className="hero-actions" aria-label="Start listening">
              <a className="button button-primary" href={telegramUrl} target="_blank" rel="noreferrer">
                Open Telegram Bot
              </a>
              <a className="button button-secondary" href="/episodes/latest">
                Listen to the latest episode
              </a>
            </div>
            <p className="transport-note">Telegram is the transport. Document voice generation runs on the configured local service. Expired jobs are cleaned while the bot is online, with an overdue scan at startup.</p>
          </div>

          <aside className="listening-receipt" aria-labelledby="receipt-title">
            <div className="receipt-heading">
              <div>
                <p className="receipt-overline">Telegram conversion receipt</p>
                <h2 id="receipt-title">Field notes.md</h2>
              </div>
              <span className="receipt-status">Ready</span>
            </div>
            <dl className="receipt-details">
              <div><dt>Source</dt><dd>TXT / Markdown</dd></div>
              <div><dt>Text</dt><dd>Verbatim</dd></div>
              <div><dt>Voice</dt><dd>English</dd></div>
            </dl>
            <div className="audio-proof" aria-label="Example audio result">
              <span className="play-mark" aria-hidden="true">Play</span>
              <div className="audio-track" aria-hidden="true"><span /></div>
              <span className="audio-time">MP3</span>
            </div>
            <div className="processing-contract" aria-label="Document processing contract">
              <p>Transport: Telegram</p>
              <p>Processing: Local</p>
              <p>External fallback: Off</p>
              <p>Translation: Off</p>
              <p>Retention target: 24 hours · Cleanup: startup and every 60 seconds while the local bot is online.</p>
            </div>
            <a className="qr-link" href={telegramUrl} target="_blank" rel="noreferrer">
              <img src="/newsroomhermesbot-qr.png" width="370" height="370" alt="QR code for the AI Newsroom Studio Telegram bot" />
              <span>Scan to open the bot</span>
            </a>
          </aside>
        </header>

        <section id="modes" className="modes-intro" aria-labelledby="modes-title">
          <p className="eyebrow">Decide what you need</p>
          <h2 id="modes-title">Research the news, or listen to your own words.</h2>
          <p>The workflows share audio delivery, but they do not share source handling or generation rules.</p>
        </section>

        <section className="mode mode-news" aria-labelledby="news-title">
          <div className="mode-number" aria-hidden="true">01</div>
          <div className="mode-summary">
            <p className="mode-label">Trusted news to audio</p>
            <h2 id="news-title">Create a News Briefing</h2>
            <p>Choose an AI beat, analysis angle, time range, and output. The newsroom researches original articles, checks publication windows, and fact-gates claims before delivery.</p>
            <a className="text-link" href={telegramUrl} target="_blank" rel="noreferrer">Create in Telegram</a>
          </div>
          <div className="mode-method">
            <h3>How it works</h3>
            <ol>
              <li><span><strong>Choose</strong> a topic, angle, range, and language.</span></li>
              <li><span><strong>Research</strong> constrained original sources.</span></li>
              <li><span><strong>Receive</strong> cited text or fact-gated audio.</span></li>
            </ol>
          </div>
        </section>

        <section className="mode mode-document" aria-labelledby="document-title">
          <div className="mode-number" aria-hidden="true">02</div>
          <div className="mode-summary">
            <p className="mode-label">Your documents to audio</p>
            <h2 id="document-title">Turn a Document into Audio</h2>
            <p>Send a TXT or Markdown file through Telegram. Choose English or Traditional Chinese voice delivery and receive an MP3 made from the text in order, with no rewrite and no translation.</p>
            <p className="release-note">Release A: Telegram upload only · Pocket for English · Kokoro for Traditional Chinese</p>
            <a className="text-link" href={telegramUrl} target="_blank" rel="noreferrer">Send a document</a>
          </div>
          <div className="mode-method">
            <h3>How it works</h3>
            <ol>
              <li><span><strong>Upload</strong> TXT or Markdown in Telegram.</span></li>
              <li><span><strong>Confirm</strong> language and processing terms.</span></li>
              <li><span><strong>Listen</strong> to the delivered MP3 within the stated retention window.</span></li>
            </ol>
          </div>
        </section>

        <section className="principle" aria-labelledby="principle-title">
          <p className="eyebrow">Learn what the system does</p>
          <div>
            <h2 id="principle-title">Trust comes from visible boundaries.</h2>
            <p>News mode may research, analyze, and translate into the selected output language. Document mode does none of those things: it reads the uploaded text verbatim through the local Pocket or Kokoro service.</p>
          </div>
        </section>

        <WaitlistForm />

        <footer>
          <a className="wordmark footer-wordmark" href="#top"><span className="wordmark-mark" aria-hidden="true">AN</span><span>AI Newsroom Studio</span></a>
          <p>Private listening for trusted news and your documents.</p>
        </footer>
      </div>
    </main>
  );
}
