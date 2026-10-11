import { useEffect, useMemo, useRef, useState } from 'react';
import { jf } from '../lib/api';
import type { SearchResults, ViewName } from '../types';

interface Entry { key: string; group: string; label: string; hint?: string; run: () => void; }

export default function CommandPalette({ views, canAddTask, onClose, onGo, onNewTask, onOpenTask, onOpenNote }: {
  views: { view: ViewName; label: string }[];
  canAddTask: boolean;
  onClose: () => void;
  onGo: (v: ViewName) => void;
  onNewTask: () => void;
  onOpenTask: (id: string) => void;
  onOpenNote: (name: string) => void;
}) {
  const [q, setQ] = useState('');
  // Results carry the query they answer, so Enter never runs one that belongs to older text.
  const [found, setFound] = useState<{ term: string; data: SearchResults } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    // Capture on window runs before any document-level handler (e.g. ProjectsModal's own
    // Escape), so closing the palette never also closes what is under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;
      const f = dialogRef.current?.querySelectorAll<HTMLElement>('input, button, [tabindex="0"]');
      if (!f?.length) return;
      const first = f[0], last = f[f.length - 1];
      const at = document.activeElement;
      if (!dialogRef.current?.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); prevFocus?.focus(); };
  }, []);

  // Debounced, and a newer keystroke aborts the request still in flight.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      jf<SearchResults>('/api/search?q=' + encodeURIComponent(term), { signal: ctl.signal })
                .then((data) => setFound({ term, data })).catch(() => { /* aborted or failed: keep local actions only */ });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const entries = useMemo<Entry[]>(() => {
    const term = q.trim().toLowerCase();
    const open = (url: string) => () => { window.open(url, '_blank', 'noopener'); };
    const out: Entry[] = [];
    for (const v of views) out.push({ key: 'go:' + v.view, group: 'Go to', label: v.label, run: () => onGo(v.view) });
    if (canAddTask) out.push({ key: 'new-task', group: 'Actions', label: 'New task', run: onNewTask });
    const local = term ? out.filter((e) => e.label.toLowerCase().includes(term)) : out;
    const res = found && found.term === q.trim() ? found.data : null;
    if (!res) return local;
    return [
      ...local,
      ...res.tasks.map((t) => ({ key: 't:' + t.id, group: 'Tasks', label: t.title, hint: t.done ? 'done' : t.start?.slice(0, 10), run: () => onOpenTask(t.id) })),
      ...res.notes.map((n) => ({ key: 'n:' + n.name, group: 'Notes', label: n.name.replace(/\.md$/, ''), hint: n.snippet, run: () => onOpenNote(n.name) })),
      ...res.files.filter((f) => f.webViewLink).map((f) => ({ key: 'f:' + f.id, group: 'Drive', label: f.name, run: open(f.webViewLink!) })),
      ...res.repos.map((r) => ({ key: 'r:' + r.name, group: 'Repositories', label: r.name, run: open(r.url) })),
      ...res.prs.map((p) => ({ key: 'p:' + p.url, group: 'Pull requests', label: p.title, hint: p.repo, run: open(p.url) })),
    ];
  }, [q, found, views, canAddTask, onGo, onNewTask, onOpenTask, onOpenNote]);

  useEffect(() => { setIdx(0); }, [entries.length]);

  function choose(e: Entry) { onClose(); e.run(); }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, entries.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (entries[idx]) choose(entries[idx]); }
  }

  return (
    <div className="modal on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div id="palette" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus role="combobox" aria-expanded={entries.length > 0} aria-controls="paletteList" aria-autocomplete="list"
          aria-activedescendant={entries[idx] ? 'pal-' + idx : undefined}
          placeholder="Search tasks, notes, files, repos — or jump to a view" aria-label="Search"
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
        />
        <ul id="paletteList" role="listbox" className="list">
          {entries.map((en, i) => (
            <li
              key={en.key} id={'pal-' + i} role="option" aria-selected={i === idx}
              className={i === idx ? 'on' : ''}
              onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); choose(en); }}
            >
              <span className="muted small pal-group">{en.group}</span>
              <span className="grow ellip">{en.label}</span>
              {en.hint && <span className="muted small ellip pal-hint">{en.hint}</span>}
            </li>
          ))}
          {!entries.length && <li className="muted small">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
