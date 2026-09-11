import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { jf, ago, mmss } from '../../lib/api';
import type { ApiError, SpotifyPlaylist, SpotifyTrack } from '../../types';
import ConnectBox from '../ConnectBox';

type NowData = { now?: { item?: any; is_playing?: boolean }; recent: { track: any; played_at: string }[] };

export default function MusicView({ active }: { active: boolean }) {
  const { can } = useAuth();
  const [data, setData] = useState<NowData | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [spErr, setSpErr] = useState('');
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[] | null>(null);
  const [plErr, setPlErr] = useState<ApiError | null>(null);
  const [openPlaylist, setOpenPlaylist] = useState<string | null>(null);
  const [tracks, setTracks] = useState<SpotifyTrack[] | null>(null);
  const [tracksErr, setTracksErr] = useState('');
  const [readable, setReadable] = useState(true);
  const [plTitle, setPlTitle] = useState('Recently played');

  const loadNow = useCallback(async () => {
    try { setData(await jf<NowData>('/api/spotify')); setErr(null); }
    catch (e) { setErr(e as ApiError); }
  }, []);

  const loadPlaylists = useCallback(async () => {
    try { setPlaylists(await jf<SpotifyPlaylist[]>('/api/spotify/playlists')); setPlErr(null); }
    catch (e) { setPlErr(e as ApiError); }
  }, []);

  useEffect(() => {
    if (!active) return;
    loadNow();
    loadPlaylists();
  }, [active, loadNow, loadPlaylists]);

  async function cmd(name: string) {
    setSpErr('');
    try { await jf('/api/spotify/' + name, { method: 'POST' }); setTimeout(loadNow, 400); }
    catch (e) { setSpErr((e as Error).message + ' (playback control needs Premium + an active device)'); }
  }

  async function openList(pl: SpotifyPlaylist) {
    setOpenPlaylist(pl.id);
    setPlTitle(pl.name || 'Playlist');
    setTracks(null);
    setTracksErr('');
    try {
      const full = await jf<{ tracks: SpotifyTrack[]; readable?: boolean; uri?: string }>(
        '/api/spotify/playlists/' + encodeURIComponent(pl.id));
      setTracks(full.tracks);
      setReadable(full.readable !== false);
    } catch (e) { setTracksErr((e as Error).message); }
  }

  async function playTrack(t: SpotifyTrack) {
    const pl = playlists?.find((p) => p.id === openPlaylist);
    setSpErr('');
    try {
      await jf('/api/spotify/play', { method: 'PUT', body: JSON.stringify({ uri: t.uri, context: pl?.uri }) });
      setTimeout(loadNow, 500);
    } catch (e) { setSpErr((e as Error).message + ' (needs Premium + an active device)'); }
  }

  const playable = can('music:control');
  const t = data?.now?.item;

  return (
    <>
      <h2>Music</h2>
      <div className="card">
        <div id="np">
          {data === null
            ? (err ? <ConnectBox provider="spotify" err={err} /> : <p className="muted">Loading…</p>)
            : t ? (
              <>
                <img src={t.album.images.at(-1)?.url || ''} alt="" />
                <div className="grow">
                  <b>{t.name}</b>
                  <div className="muted">{t.artists.map((a: any) => a.name).join(', ')}</div>
                  <div className="muted small">{t.album.name} · {data.now?.is_playing ? 'playing' : 'paused'}</div>
                </div>
              </>
            ) : <p className="muted">Nothing playing.</p>}
        </div>
        {playable && (
          <div className="row" style={{ marginTop: 14 }}>
            <button aria-label="Previous track" onClick={() => cmd('previous')}>⏮</button>
            <button aria-label="Play" onClick={() => cmd('play')}>▶</button>
            <button aria-label="Pause" onClick={() => cmd('pause')}>⏸</button>
            <button aria-label="Next track" onClick={() => cmd('next')}>⏭</button>
            <span className="err small">{spErr}</span>
          </div>
        )}
      </div>

      <div id="musicWrap">
        <div className="card" style={{ overflow: 'auto' }}>
          <h3>Playlists</h3>
          <div id="plList">
            {playlists === null
              ? (plErr ? (
                  plErr.status === 403
                    ? <p className="muted small">Reading playlists needs a scope the stored token does not have — reconnect Spotify from the sidebar.</p>
                    : <p className="err small">{plErr.message}</p>
                ) : <p className="muted small">Loading…</p>)
              : playlists.length ? playlists.map((p) => {
                const locked = p.mine === false && !p.collaborative;
                return (
                  <button key={p.id} className={p.id === openPlaylist ? 'on' : ''}
                    title={locked ? 'Spotify only serves playlists you own or collaborate on' : ''}
                    onClick={() => openList(p)}>
                    <img src={p.image} alt="" />
                    <span className="grow ellip">
                      {locked ? '🔒 ' : ''}{p.name}
                      <div className="muted small">{p.tracks} tracks{p.owner ? ' · ' + p.owner : ''}</div>
                    </span>
                  </button>
                );
              }) : <p className="muted small">No playlists.</p>}
          </div>
        </div>
        <div className="card" style={{ overflow: 'auto' }}>
          <h3>{openPlaylist ? plTitle : 'Recently played'}</h3>
          <ul className="list" id="trackList">
            {tracksErr ? <p className="err">{tracksErr}</p>
              : openPlaylist ? (
                tracks === null ? <p className="muted">Loading…</p>
                : tracks.length ? tracks.map((tr, i) => (
                  <li key={tr.uri + i} className={playable ? 'play' : ''} title={playable ? 'Play' : ''}
                    onClick={() => playable && playTrack(tr)}>
                    <span className="muted small" style={{ width: 24, flex: 'none', textAlign: 'right' }}>{i + 1}</span>
                    <img src={tr.image} alt="" />
                    <span className="grow ellip">{tr.name}<div className="muted small ellip">{tr.artists}</div></span>
                    <span className="muted small">{mmss(tr.ms)}</span>
                  </li>
                )) : (
                  !readable
                    ? <p className="muted">Spotify only lets this app read playlists you own or collaborate on. This one belongs to someone else, so its tracks are not available.</p>
                    : <p className="muted">This playlist is empty.</p>
                )
              ) : data?.recent.length ? data.recent.map((r, i) => (
                <li key={i}>
                  <span className="grow ellip">{r.track.name} <span className="muted">— {r.track.artists[0]?.name || ''}</span></span>
                  <span className="muted small">{ago(r.played_at)}</span>
                </li>
              )) : <p className="muted">Nothing recent.</p>}
          </ul>
        </div>
      </div>
    </>
  );
}
