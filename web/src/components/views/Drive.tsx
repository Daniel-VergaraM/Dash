import { useCallback, useEffect, useState } from 'react';
import { jf, ago } from '../../lib/api';
import type { ApiError, DriveFile } from '../../types';
import { useListNav } from '../../lib/useListNav';
import ConnectBox from '../ConnectBox';

interface Crumb { id: string; name: string; }

export default function Drive({ active, vimNav }: { active: boolean; vimNav: boolean }) {
  const [path, setPath] = useState<Crumb[]>([{ id: 'root', name: 'My Drive' }]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<DriveFile | null>(null);

  const load = useCallback(async (search: string, currentPath: Crumb[]) => {
    setFiles(null);
    setSearching(!!search);
    try {
      const url = search
        ? '/api/drive?q=' + encodeURIComponent(search)
        : '/api/drive?folder=' + encodeURIComponent(currentPath.at(-1)!.id);
      const { files } = await jf<{ files: DriveFile[] }>(url);
      setFiles(files);
      setErr(null);
    } catch (e) { setErr(e as ApiError); }
  }, []);

  useEffect(() => { if (active) load(searching ? query : '', path); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  function openFolder(f: DriveFile) {
    const next = [...path, { id: f.id, name: f.name }];
    setPath(next);
    setQuery('');
    setSelected(null);
    load('', next);
  }

  function goCrumb(depth: number) {
    const next = path.slice(0, depth + 1);
    setPath(next);
    setSelected(null);
    load('', next);
  }

  function goHome() {
    const next = [{ id: 'root', name: 'My Drive' }];
    setPath(next);
    setQuery('');
    setSelected(null);
    load('', next);
  }

  function activate(f: DriveFile) { f.folder ? openFolder(f) : setSelected(f); }
  const { rowRef, onKeyDown } = useListNav(files?.length ?? 0, vimNav, {
    onRight: (i) => files && activate(files[i]),
    onLeft: () => { if (!searching && path.length > 1) goCrumb(path.length - 2); },
  });

  return (
    <>
      <h2>Drive</h2>
      <div className="row">
        <input className="grow" placeholder="Search all files…" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(query, path)} />
        <button onClick={() => load(query, path)}>Search</button>
        <button onClick={goHome}>My Drive</button>
      </div>
      <div id="crumbs" className="row small muted" style={{ margin: '10px 0 4px' }}>
        {searching ? <span>Search results</span> : path.map((p, i) => (
          <span key={p.id}>
            {i > 0 && <span>/</span>}
            <button onClick={() => goCrumb(i)}>{p.name}</button>
          </span>
        ))}
      </div>
      <div id="driveWrap">
        <div className="card" style={{ overflow: 'auto' }}>
          <ul className="list" id="driveFiles">
            {files === null
              ? (err ? <ConnectBox provider="google" err={err} /> : <p className="muted">Loading…</p>)
              : files.length ? files.map((f, i) => (
                <li key={f.id} className={selected?.id === f.id ? 'on' : ''}>
                  <img src={f.iconLink || ''} alt="" />
                  <span className="grow ellip">
                    <a
                      ref={rowRef(i)} tabIndex={0} role="button"
                      onClick={() => activate(f)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(f); return; }
                        onKeyDown(e, i);
                      }}
                    >{f.name}</a>
                    <div className="muted small">
                      {f.folder ? 'folder' : f.mimeType.split('.').pop()} · {ago(f.modifiedTime)}
                    </div>
                  </span>
                </li>
              )) : <p className="muted">This folder is empty.</p>}
          </ul>
        </div>
        <div className="card" id="dvPane" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <b className="grow ellip">{selected?.name || 'Preview'}</b>
            {selected?.webViewLink && (
              <a className="small" href={selected.webViewLink} target="_blank" rel="noreferrer">open in Drive ↗</a>
            )}
          </div>
          {selected ? (
            <iframe id="dv" referrerPolicy="no-referrer" src={`/api/drive/${encodeURIComponent(selected.id)}/preview`} />
          ) : (
            <div className="muted" style={{ margin: 'auto', textAlign: 'center', padding: 40 }}>
              Pick a file to view it here.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
