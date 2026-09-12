import { useEffect, useState } from 'react';
import { jf, ago } from '../../lib/api';
import type { ApiError } from '../../types';
import ConnectBox from '../ConnectBox';

interface GhData {
  repos: { name: string; url: string; desc: string; private: boolean; pushed: string }[];
  prs: { title: string; url: string; repo: string; at: string }[];
  events: { type: string; repo: string; detail: string; at: string }[];
}

export default function GitHubView({ active }: { active: boolean }) {
  const [data, setData] = useState<GhData | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!active) return;
    setData(null);
    setErr(null);
    jf<GhData>('/api/github').then(setData).catch((e) => setErr(e as ApiError));
  }, [active]);

  return (
    <>
      <h2>GitHub</h2>
      <div className="grid">
        {err ? <ConnectBox provider="github" err={err} /> : !data ? <p className="muted">Loading…</p> : (
          <>
            <div className="card">
              <h3>Repositories</h3>
              <ul className="list">
                {data.repos.map((r) => (
                  <li key={r.name}>
                    <span className="grow">
                      <a href={r.url} target="_blank" rel="noreferrer">{r.name}</a>
                      {r.private && <span className="muted small"> · private</span>}
                      <div className="muted small ellip">{r.desc || ''}</div>
                    </span>
                    <span className="muted small">{ago(r.pushed)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h3>Open pull requests</h3>
              <ul className="list">
                {data.prs.length ? data.prs.map((p, i) => (
                  <li key={i}>
                    <span className="grow">
                      <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
                      <div className="muted small">{p.repo}</div>
                    </span>
                    <span className="muted small">{ago(p.at)}</span>
                  </li>
                )) : <p className="muted">None open.</p>}
              </ul>
            </div>
            <div className="card">
              <h3>Recent activity</h3>
              <ul className="list">
                {data.events.map((e, i) => (
                  <li key={i}>
                    <span className="grow">
                      <b className="small">{e.type}</b> {e.repo}
                      <div className="muted small ellip">{e.detail}</div>
                    </span>
                    <span className="muted small">{ago(e.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </>
  );
}
