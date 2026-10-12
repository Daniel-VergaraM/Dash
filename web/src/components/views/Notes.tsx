import { Children, Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Image as ImageIcon, ImageOff, ListChecks, Table as TableIcon } from 'lucide-react';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useAuth } from '../../context/AuthContext';
import { jf, encodePath } from '../../lib/api';
import { useListNav } from '../../lib/useListNav';
import { insertTable, tabInTable } from '../../lib/mdTable';
import { insertImage, insertUploaded, isSafeImageUrl, IMG_TYPES, IMG_MAX } from '../../lib/mdImage';
import { continueTask, convertToTask, normalizeBareTasks, parseTaskLine, toggleTaskAtCaret, toggleTaskAtLine } from '../../lib/mdTask';
import type { NoteMeta, NoteDoc } from '../../types';

const stem = (name: string) => name.replace(/\.md$/, '');

// [[x]] / [[x|alias]] / [[x#sec]] -> an internal link the `a` renderer below intercepts. The
// replacement has no `|`, so it is safe inside a table cell; `[[x\|alias]]` (the escaped form
// GFM needs when typed in a cell) is accepted too.
const WIKI = /\[\[([^\]|#\\\n]+)(?:#[^\]|\n]*)?(?:\\?\|([^\]\n]+))?\]\]/g;
// Fenced blocks and inline code are split out (odd indexes) and left untouched.
const wikiToLinks = (md: string) => md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part
  : part.replace(WIKI, (_, t: string, alias?: string) =>
    `[${(alias || t).trim()}](#note:${encodeURIComponent(t.trim()).replace(/[()]/g, escape)})`)).join('');

// Only `src` goes through the image allow-list; links keep react-markdown's default filter.
const urlTransform = (url: string, key: string) =>
  key === 'src' ? (isSafeImageUrl(url) ? url : '') : defaultUrlTransform(url);

// The task a preview checkbox belongs to: its 1-based source line and text, set by the `li`
// renderer and read by the checkbox inside it.
const TaskCtx = createContext<{ line: number; text: string } | null>(null);

// Accessible name: the task text without trivial markdown (emphasis, code, links), <= 80 chars.
const taskLabel = (text?: string) => {
  const s = (text ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)|\[\[|\]\]/g, '$1')
    .replace(/[*`~]+/g, '').replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ').trim();
  return s ? 'Task: ' + (s.length > 80 ? s.slice(0, 79) + '…' : s) : 'Task';
};

function TaskBox({ type, checked, canWrite, onToggle }: { type?: string; checked?: boolean; canWrite: boolean; onToggle: (line: number, text: string) => void }) {
  const t = useContext(TaskCtx);
  if (type !== 'checkbox') return <input type={type} checked={checked} disabled readOnly />;
  return (
    <input
      type="checkbox" checked={!!checked} disabled={!canWrite || !t} data-line={t?.line}
      aria-label={taskLabel(t?.text)}
      onChange={() => { if (t) onToggle(t.line, t.text); }}
    />
  );
}

// Image with an accessible fallback: a blocked or broken `src` shows the alt text (and URL)
// in place, so the layout does not collapse. An empty alt marks the image as decorative.
function NoteImg({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <span className="imgfail" role="img" aria-label={alt ? `Image unavailable: ${alt}` : 'Image unavailable'} title={title}>
        {alt || 'Image'}{src && !src.startsWith('data:') ? <small> {src}</small> : null}
      </span>
    );
  }
  return <img src={src} alt={alt ?? ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

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
  // Source line of the checkbox just toggled in the preview: focus returns to it once the
  // preview has re-rendered, so keyboard use is not thrown into the editor.
  const refocus = useRef<number | null>(null);
  const refocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Selection to restore once a table edit has re-rendered the controlled textarea.
  const pendingSel = useRef<[number, number] | null>(null);
  // Escape arms a one-shot "let the next Tab leave the editor" so tables never trap the keyboard.
  const tabFree = useRef(false);
  useLayoutEffect(() => {
    const sel = pendingSel.current;
    if (!sel) return;
    pendingSel.current = null;
    editorRef.current?.setSelectionRange(sel[0], sel[1]);
  }, [body]);
  // Replaces only the changed range through execCommand so the native Ctrl+Z stack survives;
  // falls back to a plain controlled update when the browser refuses.
  const applyEdit = (r: { text: string; sel: [number, number] }) => {
    const el = editorRef.current;
    if (el && r.text === body) { el.setSelectionRange(r.sel[0], r.sel[1]); return; }
    pendingSel.current = r.sel;
    if (el && el.value === body) {
      let p = 0;
      const max = Math.min(body.length, r.text.length);
      while (p < max && body[p] === r.text[p]) p++;
      let q = 0;
      while (q < max - p && body[body.length - 1 - q] === r.text[r.text.length - 1 - q]) q++;
      el.focus();
      el.setSelectionRange(p, body.length - q);
      let ok = false;
      try { ok = document.execCommand('insertText', false, r.text.slice(p, r.text.length - q)); } catch { /* fall back */ }
      if (ok && el.value === r.text) { el.setSelectionRange(r.sel[0], r.sel[1]); return; }
    }
    setBody(r.text);
  };
  // Preview checkbox -> flips `[ ]`/`[x]` on that line of the real text through the same path
  // as typing (undo stack, autosave). Skipped when the line no longer holds that task, which
  // happens only if the text changed within the preview's debounce.
  const toggleTask = (line: number, text: string) => {
    if (!canWrite || !current) return;
    if (parseTaskLine(body.split('\n')[line - 1] ?? '')?.text !== text) return;
    const next = toggleTaskAtLine(body, line);
    if (next === body) return;
    const el = editorRef.current;
    refocus.current = line;
    // Give up if the preview never catches up with the text (it would steal focus later).
    clearTimeout(refocusTimer.current);
    refocusTimer.current = setTimeout(() => { refocus.current = null; }, 1000);
    applyEdit({ text: next, sel: [el?.selectionStart ?? 0, el?.selectionEnd ?? 0] });
  };
  // Declared before the focus effect so a note change clears the pending refocus first.
  useEffect(() => { refocus.current = null; }, [current]);
  useEffect(() => {
    if (refocus.current === null || previewBody !== body) return;
    document.querySelector<HTMLInputElement>(`#preview input[data-line="${refocus.current}"]`)?.focus();
    refocus.current = null;
    clearTimeout(refocusTimer.current);
  }, [body, previewBody]);
  const taskText = useMemo(() => previewBody.split('\n').map((l) => parseTaskLine(l)), [previewBody]);
  // Pasted / dropped images: uploaded raw, then the markdown for the stored copy is inserted.
  // The upload outlives the render that started it, so the latest body, note and applyEdit are
  // read through refs, and the insert is skipped if the person has moved to another note.
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState('');
  const latest = useRef({ body, current, applyEdit });
  latest.current = { body, current, applyEdit };
  const [cleaned, setCleaned] = useState('');
  useEffect(() => { setUpErr(''); setCleaned(''); }, [current]);

  // Frees quota: removes images no note links to (and older than 10 min, enforced by the server).
  async function cleanImages() {
    if (!confirm('Delete every uploaded image that no note links to? Images pasted in the last 10 minutes are kept. This cannot be undone.')) return;
    setCleaned(''); setUpErr('');
    try {
      const r = await jf<{ removed: number; freedBytes: number }>('/api/notes/assets/prune', { method: 'POST' });
      const mb = r.freedBytes / 1048576;
      setCleaned(r.removed ? `Removed ${r.removed} unused image${r.removed === 1 ? '' : 's'}, freed ${mb >= 0.1 ? mb.toFixed(1) + ' MB' : Math.ceil(r.freedBytes / 1024) + ' KB'}.` : 'No unused images to remove.');
    } catch (e) { setUpErr((e as Error).message || 'Clean up failed'); }
  }

  async function uploadImage(file: File) {
    const el = editorRef.current;
    const at = { note: current, body, from: el?.selectionStart ?? body.length, to: el?.selectionEnd ?? body.length };
    if (!IMG_TYPES.includes(file.type)) { setUpErr('Only png, jpeg, gif and webp images can be uploaded.'); return; }
    if (file.size > IMG_MAX) { setUpErr('Image is larger than 5 MB.'); return; }
    setUploading(true); setUpErr('');
    try {
      const res = await fetch('/api/notes/assets', { method: 'POST', headers: { 'content-type': file.type }, body: file });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.statusText);
      const url = location.origin + j.url;
      const now = latest.current;
      if (now.current !== at.note) { setUpErr('Image uploaded, but the note changed before it could be inserted: ' + url); return; }
      // Typing while it uploaded moved things: fall back to wherever the caret is now.
      const same = now.body === at.body;
      const e2 = editorRef.current;
      const from = same ? at.from : e2?.selectionStart ?? now.body.length;
      const to = same ? at.to : e2?.selectionEnd ?? now.body.length;
      now.applyEdit(insertUploaded(now.body, from, to, url));
      e2?.focus();
    } catch (e) { setUpErr((e as Error).message || 'Upload failed'); }
    finally { setUploading(false); }
  }
  const imageIn = (dt: DataTransfer | null) => Array.from(dt?.files ?? []).find((f) => f.type.startsWith('image/'));

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
                  {n.tasks && (
                    <span className="taskbadge" role="img" aria-label={`${n.tasks.done} of ${n.tasks.open + n.tasks.done} tasks done`}>
                      {n.tasks.done}/{n.tasks.open + n.tasks.done}
                    </span>
                  )}
                  {n.snippet && <span className="snippet">{n.snippet}</span>}
                </button>
              </Fragment>
            )) : notesErr ? <p className="err small" role="alert">{notesErr}</p>
              : <p className="muted small">{notesLoaded ? (q || tag || folder ? 'No matches.' : 'No notes yet.') : 'Loading…'}</p>}
          </div>
        </div>
        <textarea
          id="editor" ref={editorRef} value={body} aria-label="Note editor" readOnly={!current || !canWrite} onChange={(e) => setBody(e.target.value)}
          onPaste={(e) => {
            // Pasted text wins: copying from Word or a web page brings text AND an image.
            if (!canWrite || !current || e.clipboardData.getData('text/plain')) return;
            const f = imageIn(e.clipboardData);
            if (f) { e.preventDefault(); uploadImage(f); }
          }}
          onDragOver={(e) => { if (canWrite && current && imageIn(e.dataTransfer)) e.preventDefault(); }}
          onDrop={(e) => {
            const f = canWrite && current ? imageIn(e.dataTransfer) : undefined;
            if (f) { e.preventDefault(); uploadImage(f); }
          }}
          onFocus={() => { tabFree.current = false; }} onBlur={() => { tabFree.current = false; }}
          onKeyDown={(e) => {
            // Enter continues / ends a task list; Ctrl/Cmd+Enter flips the task under the caret.
            // Anything else (tables, plain text, a selection, IME composition) keeps default Enter.
            if (e.key === 'Enter' && canWrite && current && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && !e.shiftKey && !e.altKey) {
              tabFree.current = false;
              const { selectionStart: a, selectionEnd: b } = e.currentTarget;
              const r = e.ctrlKey || e.metaKey ? toggleTaskAtCaret(body, a, b) : continueTask(body, a, b);
              if (r) { e.preventDefault(); applyEdit(r); }
              return;
            }
            if (e.key === 'Escape') tabFree.current = true;
            else if (e.key === 'Tab' && canWrite && current && !e.ctrlKey && !e.altKey && !e.metaKey) {
              if (tabFree.current) tabFree.current = false;
              else {
                const r = tabInTable(body, e.currentTarget.selectionStart, e.shiftKey);
                if (r) { e.preventDefault(); applyEdit(r); }
              }
              return;
            } else if (e.key !== 'Shift') tabFree.current = false;
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
              remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} urlTransform={urlTransform}
              components={{
                a: ({ href, children }) => href?.startsWith('#note:')
                  ? <a href={href} onClick={(e) => { e.preventDefault(); let t = href.slice(6); try { t = decodeURIComponent(t); } catch { /* keep raw */ } openLink(t); }}>{children}</a>
                  : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
                img: ({ src, alt, title }) => <NoteImg src={src} alt={alt} title={title} />,
                li: ({ node, className, children }) => {
                  if (!className?.includes('task-list-item')) return <li className={className}>{children}</li>;
                  const line = node?.position?.start.line ?? 0;
                  const t = taskText[line - 1];
                  // Done: dim and strike only the item's own text, not the sub-list under it.
                  const kids = Children.toArray(children);
                  const at = kids.findIndex((c) => isValidElement(c) && (c.type === 'ul' || c.type === 'ol'));
                  const own = at < 0 ? kids : kids.slice(0, at);
                  return (
                    <li className={className}>
                      <TaskCtx.Provider value={t ? { line, text: t.text } : null}>
                        {t?.done ? <><span className="taskdone">{own}</span>{at < 0 ? null : kids.slice(at)}</> : children}
                      </TaskCtx.Provider>
                    </li>
                  );
                },
                input: ({ type, checked }) => <TaskBox type={type} checked={checked} canWrite={canWrite} onToggle={toggleTask} />,
                table: ({ children }) => <div className="tablewrap"><table>{children}</table></div>,
              }}
            >
              {normalizeBareTasks(wikiToLinks(previewBody))}
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
        {uploading && <span role="status">Uploading image…</span>}
        {cleaned && <span role="status">{cleaned}</span>}
        {upErr && <span className="err" role="alert">{upErr}</span>}
        <button
          style={{ marginLeft: 'auto' }} disabled={!current || !canWrite}
          title={canWrite ? 'Insert a table. In a table, Tab / Shift+Tab move between cells; Esc then Tab leaves the editor.' : 'Requires notes:write'}
          onClick={() => {
            const el = editorRef.current;
            if (!el) return;
            applyEdit(insertTable(body, el.selectionStart, el.selectionEnd));
            el.focus();
          }}
        ><TableIcon size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Table</button>
        <button
          disabled={!current || !canWrite}
          title={canWrite ? 'Insert an image: ![alt](url). Selected text becomes the alt; a selected http(s) URL becomes the source. Only http(s), relative paths and small data:image URLs render.' : 'Requires notes:write'}
          onClick={() => {
            const el = editorRef.current;
            if (!el) return;
            applyEdit(insertImage(body, el.selectionStart, el.selectionEnd));
            el.focus();
          }}
        ><ImageIcon size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Image</button>
        <button
          disabled={!current || !canWrite}
          title={canWrite ? 'Turn the current line (or every selected line) into a task: - [ ] text. On tasks it removes the checkbox. Enter continues a task list; Ctrl/Cmd+Enter ticks the task under the caret.' : 'Requires notes:write'}
          onClick={() => {
            const el = editorRef.current;
            if (!el) return;
            applyEdit(convertToTask(body, el.selectionStart, el.selectionEnd));
            el.focus();
          }}
        ><ListChecks size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Task</button>
        <button
          onClick={cleanImages} disabled={!canWrite}
          title={canWrite ? 'Delete uploaded images that no note links to, to free image storage' : 'Requires notes:write'}
        ><ImageOff size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Clean unused images</button>
        <button onClick={renameNote} disabled={!current || !canWrite} title={canWrite ? undefined : 'Requires notes:write'}>Rename / move</button>
        <button onClick={delNote} disabled={!current || !canWrite} title={canWrite ? undefined : 'Requires notes:write'}>Delete note</button>
      </div>
    </>
  );
}
