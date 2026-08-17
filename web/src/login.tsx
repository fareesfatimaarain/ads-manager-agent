import { useState } from 'react';
import { motion } from 'framer-motion';
import { login, type AuthUser } from './api';
import { EASE } from './components';

export function LoginView({ onSignedIn }: { onSignedIn: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!email || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      onSignedIn(await login(email.trim(), password));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: EASE }}
        style={{ width: '100%', maxWidth: 380 }}
      >
        <div className="brand-eyebrow" style={{ textAlign: 'center' }}>Autonomous Ad Management</div>
        <h1 className="brand-title" style={{ textAlign: 'center', marginBottom: 24 }}>Sign in</h1>
        <div className="card">
          <div className="field-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <label htmlFor="loginEmail" style={{ fontSize: 13, fontWeight: 600 }}>Email</label>
            <input
              id="loginEmail"
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </div>
          <div className="field-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 12 }}>
            <label htmlFor="loginPassword" style={{ fontSize: 13, fontWeight: 600 }}>Password</label>
            <input
              id="loginPassword"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </div>

          {error ? <div className="notice notice--bad" style={{ marginTop: 12 }}>{error}</div> : null}

          <div className="actions" style={{ marginTop: 16 }}>
            <button className="btn btn--primary" style={{ width: '100%' }} disabled={busy} onClick={() => void submit()}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </div>
        <p style={{ textAlign: 'center', color: 'var(--ink-3)', fontSize: 12.5, marginTop: 16 }}>
          No account? An admin account is created from the deployment with{' '}
          <code>npm run admin:create</code>, not from this screen.
        </p>
      </motion.div>
    </div>
  );
}
