'use client';

import { type FormEvent, useState } from 'react';

interface FormState {
  status: 'idle' | 'loading' | 'success' | 'error';
  message: string;
}

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [form, setForm] = useState<FormState>({ status: 'idle', message: '' });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setForm({ status: 'loading', message: '' });
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (response.ok) {
        setForm({ status: 'success', message: "You're on the pilot list. We'll be in touch." });
        setEmail('');
      } else setForm({ status: 'error', message: data.error ?? 'Something went wrong.' });
    } catch {
      setForm({ status: 'error', message: 'Network error. Please try again.' });
    }
  }

  return (
    <section id="pilot" className="waitlist" aria-labelledby="pilot-title">
      <div className="waitlist-copy">
        <p className="eyebrow">Invited pilot</p>
        <h2 id="pilot-title">Make your reading queue listenable.</h2>
        <p>Join the pilot for private document listening and focused AI news briefings. We are learning from real listening routines before widening the product.</p>
      </div>
      <form onSubmit={handleSubmit} className="waitlist-form">
        <label htmlFor="pilot-email">Email address</label>
        <div className="form-row">
          <input id="pilot-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={form.status === 'loading'} />
          <button type="submit" disabled={form.status === 'loading'}>{form.status === 'loading' ? 'Joining…' : 'Join the pilot'}</button>
        </div>
        <p className="form-note">Product updates only. No document content is collected here.</p>
        <div className={`form-feedback ${form.status}`} aria-live="polite">{form.message}</div>
      </form>
    </section>
  );
}
