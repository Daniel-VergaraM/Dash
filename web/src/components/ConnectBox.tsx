import { useAuth } from '../context/AuthContext';
import type { ApiError } from '../types';

// A 428 means "provider not connected" — offer the fix only to whoever is allowed to apply it.
export default function ConnectBox({ provider, err }: { provider: 'google' | 'spotify' | 'linear'; err: ApiError }) {
  const { can } = useAuth();
  if (err.status === 428) {
    return can('connections:manage') ? (
      <div className="connect">
        <p className="muted">{err.message}</p>
        <a href={`/auth/${provider}`}><button className="primary">Connect {provider}</button></a>
      </div>
    ) : (
      <div className="connect"><p className="muted">{err.message} — ask an admin to connect it.</p></div>
    );
  }
  return <p className="err">{err.message}</p>;
}
