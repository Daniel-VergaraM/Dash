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

  const openNote = useCallback(async (name: string) => {
    const n = await jf<{ name: string; body: string }>('/api/notes/' + encodeURIComponent(name));
    setCurrent(n.name);
    setBody(n.body);
    setStatus(n.name);
  }, []);

  const saveNote = useCallback(async () => {
    if (!current) return;
    await jf('/api/notes/' + encodeURIComponent(current), { method: 'PUT', body: JSON.stringify({ body }) });
    setStatus(current + ' · saved ' + new Date().toLocaleTimeString());
    listNotes();
  }, [current, body, listNotes]);

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
      <h2>Notes <span className="muted small">markdown + $\LaTeX$ &mdash; Ctrl+S saves</span></h2>
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
        <span>{status}</span>
        <button style={{ marginLeft: 'auto' }} onClick={delNote}>Delete note</button>
      </div>
    </>
  );
}
