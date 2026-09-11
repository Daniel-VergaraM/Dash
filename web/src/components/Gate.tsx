import { useState } from 'react';
import { jf } from '../lib/api';
import { b64uToBuf, credToJSON, hasWebAuthn } from '../lib/webauthn';
import { useAuth } from '../context/AuthContext';

export default function Gate() {
  const { refresh } = useAuth();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await jf('/api/login', { method: 'POST', body: JSON.stringify({ name, password }) });
      setPassword('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onPasskey() {
    setErr('');
    try {
      const options = await jf<any>('/api/login/passkey/options', { method: 'POST', body: '{}' });
      const credential = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: b64uToBuf(options.challenge),
          allowCredentials: (options.allowCredentials || []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
        },
      }) as PublicKeyCredential | null;
      if (!credential) return;
      await jf('/api/login/passkey', {
        method: 'POST',
        body: JSON.stringify({ response: credToJSON(credential) }),
      });
      await refresh();
    } catch (e) {
      const err = e as Error;
      // A cancelled prompt is not an error worth shouting about.
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') return;
      setErr(err.message);
    }
  }

  const webauthn = hasWebAuthn();

  return (
    <div id="gate">
      <form id="loginForm" onSubmit={onSubmit}>
        <div className="mark">D</div>
        <h1>Dash</h1>
        <p>Sign in to continue</p>
        <input
          id="loginName" placeholder="Name" autoComplete="username" autoFocus
          value={name} onChange={(e) => setName(e.target.value)}
        />
        <input
          id="loginPass" type="password" placeholder="Password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
        <button className="primary" type="submit">Sign in</button>
        {webauthn && (
          <>
            <div className="or"><span>or</span></div>
            <button type="button" onClick={onPasskey}>Use a passkey</button>
          </>
        )}
        <div id="gateErr">{err}</div>
      </form>
    </div>
  );
}
