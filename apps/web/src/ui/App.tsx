import { FormEvent, useEffect, useState } from 'react';
import { api } from './api';
import { Dashboard } from './Dashboard';
import type { User } from './types';

// ---------------------------------------------------------------------------
// App – root component that owns authentication state
// ---------------------------------------------------------------------------

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch the current session on mount.
  useEffect(() => {
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="auth-state">Loading Outbox…</div>;
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <Dashboard
      user={user}
      onLogout={async () => {
        await api.logout();
        setUser(null);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Login – password + Google OAuth sign-in form
// ---------------------------------------------------------------------------

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const values = new FormData(event.currentTarget);
    const email = String(values.get('email'));
    const password = String(values.get('password'));

    setBusy(true);
    setError('');

    try {
      const result = await api.passwordLogin(email, password);
      onLogin(result.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Login</h1>

        {/* ── Google OAuth ─────────────────────────────────────────── */}
        <button type="button" className="google-login" onClick={api.googleLogin}>
          <svg className="google-mark" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M21.8 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.5a4.7 4.7 0 0 1-2 3.1v2.5h3.2c1.9-1.7 3.1-4.3 3.1-7.4Z"
            />
            <path
              fill="#34A853"
              d="M12 22c2.7 0 5-.9 6.7-2.4l-3.2-2.5c-.9.6-2 .9-3.5.9-2.7 0-5-1.8-5.8-4.3H2.9v2.6A10 10 0 0 0 12 22Z"
            />
            <path
              fill="#FBBC05"
              d="M6.2 13.7A6 6 0 0 1 5.9 12c0-.6.1-1.2.3-1.7V7.7H2.9A10 10 0 0 0 2 12c0 1.6.4 3.1.9 4.3l3.3-2.6Z"
            />
            <path
              fill="#EA4335"
              d="M12 6c1.7 0 3.2.6 4.4 1.7l3.3-3.2C17.9 2.8 15.2 2 12 2a10 10 0 0 0-9.1 5.7l3.3 2.6C7 7.8 9.3 6 12 6Z"
            />
          </svg>
          Login with Google
        </button>

        <div className="divider">
          <span />
          or sign up through email
          <span />
        </div>

        {/* ── Email / password ─────────────────────────────────────── */}
        <input
          aria-label="Email ID"
          name="email"
          type="email"
          placeholder="Email ID"
          required
          autoComplete="email"
        />
        <input
          aria-label="Password"
          name="password"
          type="password"
          placeholder="Password"
          required
          minLength={8}
          autoComplete="current-password"
        />

        <button className="email-login" disabled={busy}>
          {busy ? 'Logging in…' : 'Login'}
        </button>

        {error && <p className="login-error">{error}</p>}

        <small>New email addresses create an account. Use at least 8 characters.</small>
      </form>
    </div>
  );
}
