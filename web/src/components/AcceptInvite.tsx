import { useEffect, useState } from 'react';
import { jf } from '../lib/api';
import { Mark } from './Mark';
import type { InvitePublic } from '../types';

type Status = 'loading' | 'invalid' | 'ready' | 'done';

export default function AcceptInvite({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>('loading');
  const [invite, setInvite] = useState<InvitePublic | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    jf<InvitePublic>(`/api/invites/${token}/info`)
      .then((info) => { setInvite(info); setStatus('ready'); })
      .catch(() => setStatus('invalid'));
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (!password || password !== confirm) { setErr('Passwords do not match'); return; }
    setBusy(true);
    try {
      await jf(`/api/invites/${token}/accept`, { method: 'POST', body: JSON.stringify({ name, password }) });
      setStatus('done');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="gate">
      <div id="loginForm">
        <Mark size={46} />
        <h1>Dash</h1>
        {status === 'loading' && <p>Loading invitation…</p>}
        {status === 'invalid' && <p role="alert">This invitation is not valid or has expired.</p>}
        {status === 'done' && (
          <>
            <p>Account created, you can now sign in.</p>
            <a className="primary" href="/" style={{ display: 'inline-block', textAlign: 'center' }}>Go to sign in</a>
          </>
        )}
        {status === 'ready' && invite && (
          <form onSubmit={onSubmit}>
            <p>
              Invited by <strong>{invite.invitedByName}</strong> as <strong>{invite.role}</strong>
            </p>
            <input
              aria-label="Name" placeholder="Name" autoComplete="username" autoFocus required
              value={name} onChange={(e) => setName(e.target.value)}
            />
            <input
              type="password" aria-label="Password" placeholder="Password" autoComplete="new-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
            <input
              type="password" aria-label="Confirm password" placeholder="Confirm password" autoComplete="new-password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
            />
            <button className="primary" type="submit" disabled={busy}>Create account</button>
            <div id="gateErr" role="alert">{err}</div>
          </form>
        )}
      </div>
    </div>
  );
}
