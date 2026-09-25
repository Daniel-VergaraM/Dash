import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { jf } from '../../lib/api';
import { useListNav } from '../../lib/useListNav';
import type { NoteMeta } from '../../types';

export default function Notes({ active, vimNav }: { active: boolean; vimNav: boolean }) {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [previewBody, setPreviewBody] = useState('');
  const [status, setStatus] = useState('');

  const listNotes = useCallback(async () => setNotes(await jf<NoteMeta[]>('/api/notes')), []);

  useEffect(() => { if (active) listNotes(); }, [active, listNotes]);

  // Debounced so fast typing doesn't re-parse markdown on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setPreviewBody(body), 200);
    return () => clearTimeout(t);
  }, [body]);

  // What the server last confirmed for `current`. Comparing against it is what stops the
  // autosave from firing on a freshly opened note, or re-writing an unchanged one.
  const savedRef = useRef('');

  const write = useCallback(async (name: string, text: string) => {
    await jf('/api/notes/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ body: text }) });
    savedRef.current = text;
    setStatus(name + ' · saved ' + new Date().toLocaleTimeString());
    listNotes();
  }, [listNotes]);

  const openNote = useCallback(async (name: string) => {
    // Switching away cancels the pending autosave, so anything still unsaved has to go now
    // or it is lost silently.
    if (current && current !== name && body !== savedRef.current) await write(current, body);
    const n = await jf<{ name: string; body: string }>('/api/notes/' + encodeURIComponent(name));
    setCurrent(n.name);
    setBody(n.body);
    savedRef.current = n.body;
    setStatus(n.name);
  }, [current, body, write]);

  const saveNote = useCallback(async () => {
    if (!current) return;
    await write(current, body);
  }, [current, body, write]);

  const dirty = !!current && body !== savedRef.current;

  // Autosave: 5s after the last keystroke. Every edit re-runs this effect, and the cleanup
  // cancels the previous timer, so the clock restarts while you are still typing.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => { saveNote(); }, 5000);
    return () => clearTimeout(t);
  }, [body, dirty, saveNote]);

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
    const raw = prompt('Note name');
    if (!raw) return;
    const name = raw.endsWith('.md') ? raw : raw + '.md';
    try {
      await jf('/api/notes/' + encodeURIComponent(name), {
        method: 'PUT', body: JSON.stringify({ body: '# ' + raw.replace(/\.md$/, '') + '\n\n' }),
      });
      openNote(name);
      listNotes();
    } catch (e) { alert((e as Error).message); }
  }

  async function delNote() {
    if (!current || !confirm('Delete ' + current + '?')) return;
    await jf('/api/notes/' + encodeURIComponent(current), { method: 'DELETE' });
    setCurrent(null); setBody('');
    listNotes();
  }

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const { rowRef, onKeyDown, focusAt } = useListNav(notes.length, vimNav, {
    onRight: async (i) => {
      const n = notes[i];
      if (n.name !== current) await openNote(n.name);
      editorRef.current?.focus();
    },
  });

  return (
    <>
      <h2>Notes <span className="muted small">markdown + $\LaTeX$ &mdash; autosaves 5s after you stop typing, or Ctrl+S</span></h2>
      <div id="notesWrap">
        <div>
          <button className="primary" style={{ width: '100%', marginBottom: 8 }} onClick={newNote}>+ New note</button>
          <div id="noteList">
            {notes.length ? notes.map((n, i) => (
              <button
                key={n.name} ref={rowRef(i)} onKeyDown={(e) => onKeyDown(e, i)}
                className={n.name === current ? 'on' : ''} onClick={() => openNote(n.name)}
              >
                {n.name.replace(/\.md$/, '')}
              </button>
            )) : <p className="muted small">No notes yet.</p>}
          </div>
        </div>
        <textarea
          id="editor" ref={editorRef} value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (!vimNav || e.key !== 'Escape') return;
            e.preventDefault();
            const idx = notes.findIndex((n) => n.name === current);
            if (idx >= 0) focusAt(idx);
          }}
          placeholder={'# Title\n\nInline math $e^{i\\pi}+1=0$, or display:\n\n$$\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt\\pi}{2}$$'}
        />
        <div id="preview">
          <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
            {previewBody}
          </ReactMarkdown>
        </div>
      </div>
      <div className="row small muted" style={{ marginTop: 8 }}>
        <span>{dirty ? current + ' · unsaved…' : status}</span>
        <button style={{ marginLeft: 'auto' }} onClick={delNote}>Delete note</button>
      </div>
    </>
  );
}
