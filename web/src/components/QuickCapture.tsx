import { useEffect, useRef, useState } from 'react';
import { jf } from '../lib/api';
import type { ApiError, CalEvent, QuickParsed } from '../types';

const PRIO = { high: 'High', med: 'Medium', low: 'Low' } as const;

// "2026-10-12T15:00" / "2026-10-12" -> "Mon, Oct 12 · 15:00" in the viewer's locale.
function whenLabel(due: string) {
  const [y, m, d] = due.slice(0, 10).split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return due.length > 10 ? `${day} · ${due.slice(11, 16)}` : day;
}

export default function QuickCapture({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (task: CalEvent, parsed: QuickParsed) => void;
}) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<QuickParsed | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Read during render, before autoFocus moves focus into the dialog.
  const [prevFocus] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    // Capture on window so Escape closes only this modal, never what is under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;
      const f = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])');
      if (!f?.length) return;
      const first = f[0], last = f[f.length - 1];
      const at = document.activeElement;
      if (!dialogRef.current?.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); if (prevFocus?.isConnected) prevFocus.focus(); };
  }, [prevFocus]);

  // Debounced live preview; a newer keystroke aborts the request still in flight. The server
  // is the only parser, so the preview is exactly what Enter will create.
  useEffect(() => {
    const term = text.trim();
    if (!term) { setParsed(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      jf<QuickParsed>('/api/quick/parse?text=' + encodeURIComponent(term), { signal: ctl.signal })
        .then((p) => { setParsed(p); setErr(''); })
        .catch((e: ApiError) => { if (e.name !== 'AbortError') setErr(e.message); });
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [text]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await jf<{ task: CalEvent; parsed: QuickParsed }>('/api/tasks/quick', {
        method: 'POST', body: JSON.stringify({ text: text.trim() }),
      });
      onCreated(r.task, r.parsed);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const chips: string[] = [];
  if (parsed?.due) chips.push(whenLabel(parsed.due));
  if (parsed?.project) chips.push('Project: ' + parsed.project.name);
  if (parsed?.priority) chips.push('Priority: ' + PRIO[parsed.priority]);
  if (parsed?.duration) chips.push(parsed.duration + ' min');

  return (
    <div className="modal on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form id="quick" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="quickTitle" onSubmit={submit}>
        <h3 id="quickTitle">Quick add</h3>
        <input
          autoFocus aria-label="Task" aria-describedby="quickHelp" maxLength={300}
          placeholder="tomorrow 3pm review PR !dash p1" value={text} onChange={(e) => setText(e.target.value)}
        />
        <div className="row quick-prev" aria-live="polite">
          {parsed?.title && <b className="ellip">{parsed.title}</b>}
          {chips.map((c) => <span key={c} className="tag">{c}</span>)}
          {parsed && !parsed.title && <span className="muted small">Add a title to create the task.</span>}
        </div>
        {parsed?.warnings.filter((w) => w !== 'Title is empty').map((w) => <p key={w} className="muted small">{w}</p>)}
        {err && <p className="err small" role="alert">{err}</p>}
        <p id="quickHelp" className="muted small">
          Date: today, tomorrow, friday, in 3 days, 2026-12-31, 25/12 · Time: 3pm, 15:00, at 3pm · !project · p1 p2 p3 · 30m, 1.5h · "quoted" stays literal
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !text.trim() || parsed?.title === ''}>Create</button>
        </div>
      </form>
    </div>
  );
}
