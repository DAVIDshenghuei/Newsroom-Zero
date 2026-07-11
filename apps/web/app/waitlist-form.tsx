'use client';

import { type FormEvent, useState } from 'react';

interface FormState {
  status: 'idle' | 'loading' | 'success' | 'error';
  message: string;
}

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [form, setForm] = useState<FormState>({ status: 'idle', message: '' });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setForm({ status: 'loading', message: '' });

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (res.ok) {
        setForm({ status: 'success', message: "You're on the list. We'll be in touch." });
        setEmail('');
      } else {
        setForm({ status: 'error', message: data.error ?? 'Something went wrong.' });
      }
    } catch {
      setForm({ status: 'error', message: 'Network error. Please try again.' });
    }
  }

  return (
    <div className="waitlist-card">
      <h2>Join the waitlist</h2>
      <p>Be the first to know when Newsroom Zero goes live.</p>

      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={form.status === 'loading'}
          />
          <button type="submit" disabled={form.status === 'loading'}>
            {form.status === 'loading' ? 'Sending…' : 'Sign up'}
          </button>
        </div>
      </form>

      {form.status === 'success' && (
        <div className="form-feedback success">{form.message}</div>
      )}
      {form.status === 'error' && (
        <div className="form-feedback error">{form.message}</div>
      )}
    </div>
  );
}
