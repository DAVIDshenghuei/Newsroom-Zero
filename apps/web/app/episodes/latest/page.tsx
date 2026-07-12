import Link from 'next/link';
import { loadLatestEpisode } from '@/lib/episode';

export const dynamic = 'force-dynamic';

export default async function LatestEpisodePage() {
  const episode = await loadLatestEpisode();

  return (
    <main className="container episode-page">
      <Link className="back-link" href="/">← Newsroom Zero</Link>
      <h1>Latest episode</h1>
      {!episode ? (
        <section className="episode-empty">
          <h2>No bulletin yet</h2>
          <p>The latest verified audio bulletin will appear here after it is voiced.</p>
        </section>
      ) : (
        <article>
          <div className="episode-heading">
            <div>
              <h2>{episode.title}</h2>
              <time dateTime={episode.generatedAt}>
                {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
                  .format(new Date(episode.generatedAt))}
              </time>
            </div>
            <span className={`fact-badge ${episode.factGate.approved ? 'approved' : 'blocked'}`}>
              Fact Gate: {episode.factGate.approved ? 'Approved' : 'Blocked'}
            </span>
          </div>
          {episode.audioUrl ? (
            <audio controls preload="metadata" src={episode.audioUrl}>
              Your browser does not support HTML audio.
            </audio>
          ) : (
            <p className="episode-empty">This briefing is available as text only.</p>
          )}
          <section className="citations">
            <h2>Stories and sources</h2>
            <ol>
              {episode.stories.map((story) => (
                <li key={story.url}>
                  <a href={story.url} target="_blank" rel="noreferrer">{story.headline}</a>
                  <span>{story.source}</span>
                </li>
              ))}
            </ol>
          </section>
        </article>
      )}
    </main>
  );
}
