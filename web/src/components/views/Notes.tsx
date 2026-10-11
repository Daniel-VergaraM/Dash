import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useAuth } from '../../context/AuthContext';
import { jf, encodePath } from '../../lib/api';
import { useListNav } from '../../lib/useListNav';
import type { NoteMeta, NoteDoc } from '../../types';

const stem = (name: string) => name.replace(/\.md$/, '');

// [[x]] / [[x|alias]] / [[x#sec]] -> an internal link the `a` renderer below intercepts.
const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
// Fenced blocks and inline code are split out (odd indexes) and left untouched.
const wikiToLinks = (md: string) => md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part
  : part.replace(WIKI, (_, t: string, alias?: string) =>
    `[${(alias || t).trim()}](#note:${encodeURIComponent(t.trim()).replace(/[()]/g, escape)})`)).join('');

// `openName` is a fresh object per request so asking for the same note twice still fires.
export default function Notes({ active, vimNav, openName }: { active: boolean; vimNav: boolean; openName?: { name: string } | null }) {
  const { can } = useAuth();
  const canWrite = can('notes:write');
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [notesErr, setNotesErr] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [previewBody, setPreviewBody] = useState('');
  const [status, setStatus] = useState('');
  const [backlinks, setBacklinks] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [folder, setFolder] = useState('');
  // The unfiltered listing: tag chips and folders come from here so they survive filtering.
  const [all, setAll] = useState<NoteMeta[]>([]);
  const filters = useRef({ q, tag, folder });
  filters.current = { q, tag, folder };
  const listCtl = useRef<AbortController | null>(null);
  // Set while a rename is in flight so a pending autosave cannot resurrect the old name.
  const renamingRef = useRef(false);
  const [retry, setRetry] = useState(0); // re-arms autosave when a rename ends with an edit pending

  const listNotes = useCallback(async () => {
    listCtl.current?.abort();
    const ctl = listCtl.current = new AbortController();
    const f = filters.current;
    const qs = new URLSearchParams();
    if (f.q.trim()) qs.set('q', f.q.trim());
    if (f.tag) qs.set('tag', f.tag);
    if (f.folder) qs.set('folder', f.folder);
    const str = qs.toString();
    try {
      const list = await jf<NoteMeta[]>('/api/notes' + (str ? '?' + str : ''), { signal: ctl.signal });
      setNotes(list); setNotesErr('');
      if (!str) setAll(list);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setNotesErr((e as Error).message);
    } finally { if (!ctl.signal.aborted) setNotesLoaded(true); }
  }, []);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(listNotes, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [active, q, tag, folder, listNotes]);

  // Debounced so fast typing doesn't re-parse markdown on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setPreviewBody(body), 200);
    return () => clearTimeout(t);
  }, [body]);

  // What the server last confirmed for `current`. Comparing against it is what stops the
  // autosave from firing on a freshly opened note, or re-writing an unchanged one.
  const savedRef = useRef('');

  const write = useCallback(async (name: string, text: string) => {
    try {
      await jf('/api/notes/' + encodePath(name), { method: 'PUT', body: JSON.stringify({ body: text }) });
    } catch (e) { setSaveErr((e as Error).message); throw e; }
    savedRef.current = text;
    setSaveErr('');
    setStatus(name + ' · saved ' + new Date().toLocaleTimeString());
    listNotes();
  }, [listNotes]);

  const openNote = useCallback(async (name: string) => {
    // Switching away cancels the pending autosave, so anything still unsaved has to go now
    // or it is lost silently.
    try {
      if (current && current !== name && body !== savedRef.current) await write(current, body);
      const n = await jf<NoteDoc>('/api/notes/' + encodePath(name));
      setCurrent(n.name);
      setBody(n.body);
      setBacklinks(n.backlinks || []);
      savedRef.current = n.body;
      setStatus(n.name);
      setSaveErr('');
    } catch (e) { setSaveErr((e as Error).message); }
  }, [current, body, write]);

  useEffect(() => { if (openName) openNote(openName.name); }, [openName]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveNote = useCallback(async () => {
    if (!current || !canWrite || renamingRef.current) return;
    try { await write(current, body); } catch { /* surfaced in the status line */ }
  }, [current, body, write, canWrite]);

  const dirty = !!current && canWrite && body !== savedRef.current;

  // Autosave: 5s after the last keystroke. Every edit re-runs this effect, and the cleanup
  // cancels the previous timer, so the clock restarts while you are still typing.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => { saveNote(); }, 5000);
    return () => clearTimeout(t);
  }, [body, dirty, saveNote, retry]);

  // Closing the tab inside the 5s window would drop the edit without this.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveNote(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [saveNote]);

  async function newNote() {
    const raw = prompt('Note name (use folder/name to file it in a folder)');
    if (!raw) return;
    const path = raw.trim().replace(/^\/+/, '');
    if (!path) return;
    const name = path.endsWith('.md') ? path : path + '.md';
    try {
      await jf('/api/notes/' + encodePath(name), {
        method: 'PUT', body: JSON.stringify({ body: '# ' + (stem(path).split('/').pop() || '') + '\n\n' }),
      });
      openNote(name);
      listNotes();
    } catch (e) { setSaveErr((e as Error).message); }
  }

  async function delNote() {
    if (!current || !confirm('Delete ' + current + '?')) return;
    try { await jf('/api/notes/' + encodePath(current), { method: 'DELETE' }); }
    catch (e) { setSaveErr((e as Error).message); return; }
    setCurrent(null); setBody(''); setStatus(''); setSaveErr(''); setBacklinks([]);
    listNotes();
  }

  async function renameNote() {
    if (!current) return;
    const raw = prompt('Rename / move to (folder/name)', stem(current));
    if (!raw) return;
    const path = raw.trim().replace(/^\/+/, '');
    const to = path.endsWith('.md') ? path : path + '.md';
    if (!path || to === current) return;
    renamingRef.current = true;
    try {
      if (body !== savedRef.current) await write(current, body);
      const r = await jf<{ name: string; rewritten: number }>('/api/notes/rename', {
        method: 'POST', body: JSON.stringify({ from: current, to }),
      });
      // Links inside this note may have been rewritten server-side, so reload it.
      const n = await jf<NoteDoc>('/api/notes/' + encodePath(r.name));
      savedRef.current = n.body;
      setCurrent(n.name); setBody(n.body); setBacklinks(n.backlinks || []);
      setStatus(`${n.name} · renamed, ${r.rewritten} link${r.rewritten === 1 ? '' : 's'} rewritten`);
      setSaveErr('');
      listNotes();
    } catch (e) { setSaveErr((e as Error).message); }
    finally { renamingRef.current = false; setRetry((n) => n + 1); }
  }

  // [[target]] may be a full path or just a note's name; fall back to <target>.md.
  function openLink(target: string) {
    const t = stem(target).toLowerCase();
    const pool = all.length ? all : notes;
    const hit = pool.find((n) => stem(n.name).toLowerCase() === t)
      || pool.find((n) => stem(n.name).toLowerCase().split('/').pop() === t);
    openNote(hit ? hit.name : stem(target) + '.md');
  }

  const tags = Array.from(new Set(all.flatMap((n) => n.tags))).sort();
  const folders = Array.from(new Set(all.map((n) => n.folder).filter(Boolean))).sort();
  // Group by folder only when browsing: a search is ordered by relevance.
  const searching = !!q.trim();
  const shown = searching ? notes : [...notes].sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const { rowRef, onKeyDown, focusAt } = useListNav(shown.length, vimNav, {
    onRight: async (i) => {
      const n = shown[i];
      if (n.name !== current) await openNote(n.name);
      editorRef.current?.focus();
    },
  });

  return (
    <>
      <h2>Notes <span className="muted small">markdown + $\LaTeX$ &mdash; {canWrite ? 'autosaves 5s after you stop typing, or Ctrl+S' : 'Read-only'}</span></h2>
      <div id="notesWrap">
        <div>
          <button className="primary" style={{ width: '100%', marginBottom: 8 }} onClick={newNote} disabled={!canWrite} title={canWrite ? undefined : 'Requires notes:write'}>+ New note</button>
          <input
            type="search" id="noteSearch" placeholder="Search notes" aria-label="Search notes"
            value={q} onChange={(e) => setQ(e.target.value)}
          />
          {folders.length > 0 && (
            <select aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>
              <option value="">All folders</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          )}
          {tags.length > 0 && (
            <div className="tagchips" role="group" aria-label="Filter by tag">
              {tags.map((t) => (
                <button
                  key={t} className={'tagchip' + (t === tag ? ' on' : '')} aria-pressed={t === tag}
                  onClick={() => setTag(t === tag ? '' : t)}
                >#{t}</button>
              ))}
            </div>
          )}
          <div id="noteList">
            {shown.length ? shown.map((n, i) => (
              <Fragment key={n.name}>
                {!searching && n.folder && n.folder !== shown[i - 1]?.folder && <div className="folder">{n.folder}</div>}
                <button
                  ref={rowRef(i)} onKeyDown={(e) => onKeyDown(e, i)} title={n.name}
                  className={n.name === current ? 'on' : ''} aria-current={n.name === current || undefined} onClick={() => openNote(n.name)}
                >
                  {stem(searching || !n.folder ? n.name : n.name.slice(n.folder.length + 1))}
                  {n.snippet && <span className="snippet">{n.snippet}</span>}
                </button>
              </Fragment>
            )) : notesErr ? <p className="err small" role="alert">{notesErr}</p>
              : <p className="muted small">{notesLoaded ? (q || tag || folder ? 'No matches.' : 'No notes yet.') : 'Loading…'}</p>}
          </div>
        </div>
        <textarea
          id="editor" ref={editorRef} value={body} aria-label="Note editor" readOnly={!current || !canWrite} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (!vimNav || e.key !== 'Escape') return;
            e.preventDefault();
            const idx = shown.findIndex((n) => n.name === current);
            if (idx >= 0) focusAt(idx);
          }}
          placeholder={!current ? (canWrite ? 'Select a note, or create one with + New note.' : 'Select a note to read it.') : '# Title\n\nInline math $e^{i\\pi}+1=0$, or display:\n\n$$\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt\\pi}{2}$$'}
        />
        <div className="previewCol">
          <div id="preview" role="region" aria-label="Preview">
            <ReactMarkdown
              remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}
              components={{
                a: ({ href, children }) => href?.startsWith('#note:')
                  ? <a href={href} onClick={(e) => { e.preventDefault(); let t = href.slice(6); try { t = decodeURIComponent(t); } catch { /* keep raw */ } openLink(t); }}>{children}</a>
                  : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
              }}
            >
              {wikiToLinks(previewBody)}
            </ReactMarkdown>
          </div>
          <div id="backlinks" role="region" aria-label="Backlinks">
            <b>Backlinks</b>
            {backlinks.length ? backlinks.map((b) => (
              <button key={b} onClick={() => openNote(b)} title={b}>{stem(b)}</button>
            )) : <span className="muted small">{current ? 'No notes link here.' : '—'}</span>}
          </div>
        </div>
      </div>
      <div className="row small muted" style={{ marginTop: 8 }}>
        {saveErr ? <span className="err" role="alert">{saveErr}</span> : <span>{dirty ? current + ' · unsaved…' : status}</span>}
        <button style={{ marginLeft: 'auto' }} onClick={renameNote} disabled={!current || !canWrite} title={canWrite ? undefined : 'Requires notes:write'}>Rename / move</button>
        <button onClick={delNote} disabled={!current || !canWrite} title={canWrite ? undefined : 'Requires notes:write'}>Delete note</button>
      </div>
    </>
  );
}
