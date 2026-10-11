import type { ApiError } from '../types';

// A 428 means "you haven't connected this yourself yet" — connecting is always self-service.
export default function ConnectBox({ provider, err }: { provider: 'google' | 'spotify' | 'linear' | 'github'; err: ApiError }) {
  if (err.status === 428) {
    return (
      <div className="connect">
        <p className="muted">{err.message}</p>
        <button className="primary" onClick={() => { window.location.href = `/auth/${provider}`; }}>Connect {provider}</button>
      </div>
    );
  }
  return <p className="err">{err.message}</p>;
}
