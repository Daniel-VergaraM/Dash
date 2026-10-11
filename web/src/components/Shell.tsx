import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Home, Inbox as InboxIcon, ListChecks, CalendarDays, FileText, FolderOpen, Music, Github, User, ShieldCheck, LogOut, X, Bell,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { Capability, ViewName } from '../types';
import { jf } from '../lib/api';
import { getKbdMode, setKbdMode as persistKbdMode, getVimNav, setVimNav as persistVimNav } from '../lib/kbdMode';
import { isTypingTarget } from '../lib/kbd';
import { useNotifications } from '../lib/useNotifications';
import CommandPalette from './CommandPalette';
import NotificationsPanel from './NotificationsPanel';
import Today from './views/Today';
import Inbox from './views/Inbox';
import Tasks from './views/Tasks';
import CalendarView from './views/CalendarView';
import Notes from './views/Notes';
import Drive from './views/Drive';
import MusicView from './views/Music';
import GitHubView from './views/GitHubView';
import Account from './views/Account';
import Access from './views/Access';

export const NAV: { view: ViewName; label: string; cap?: Capability; icon: typeof Home; key: string }[] = [
  { view: 'today', label: 'Today', icon: Home, key: 't' },
  { view: 'inbox', label: 'Inbox', cap: 'tasks:read', icon: InboxIcon, key: 'i' },
  { view: 'tasks', label: 'Tasks', cap: 'tasks:read', icon: ListChecks, key: 'k' },
  { view: 'calendar', label: 'Calendar', cap: 'calendar:read', icon: CalendarDays, key: 'c' },
  { view: 'notes', label: 'Notes', cap: 'notes:read', icon: FileText, key: 'n' },
  { view: 'drive', label: 'Drive', cap: 'drive:read', icon: FolderOpen, key: 'd' },
  { view: 'music', label: 'Music', cap: 'music:read', icon: Music, key: 'm' },
  { view: 'github', label: 'GitHub', cap: 'github:read', icon: Github, key: 'h' },
  { view: 'account', label: 'Account', icon: User, key: 'a' },
  { view: 'access', label: 'Access', cap: 'users:manage', icon: ShieldCheck, key: 'x' },
];

export default function Shell() {
  const { me, can, logout, refresh } = useAuth();
  const items = useMemo(() => NAV.filter((n) => !n.cap || can(n.cap)), [can]);
  const [view, setView] = useState<ViewName>(items[0]?.view ?? 'today');
  const [connBusy, setConnBusy] = useState<string | null>(null);
  const [kbdMode, setKbdModeState] = useState(() => getKbdMode());
  const [vimNav, setVimNavState] = useState(() => getVimNav());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [taskReq, setTaskReq] = useState<{ id: string } | null>(null);
  const [noteReq, setNoteReq] = useState<{ name: string } | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const canNotify = can('calendar:read') || can('tasks:read') || can('tasks:write');
  const notifs = useNotifications(!!me && canNotify);
  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [navFocusIdx, setNavFocusIdx] = useState(0);

  useEffect(() => {
    const i = items.findIndex((n) => n.view === view);
    if (i >= 0) setNavFocusIdx(i);
  }, [view, items]);

  function updateKbdMode(on: boolean) {
    setKbdModeState(on);
    persistKbdMode(on);
  }

  function updateVimNav(on: boolean) {
    setVimNavState(on);
    persistVimNav(on);
  }

  useEffect(() => {
    let chordActive = false;
    let chordTimer: number | undefined;

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (chordActive) {
        chordActive = false;
        window.clearTimeout(chordTimer);
        const target = items.find((n) => n.key === e.key.toLowerCase());
        if (target) { e.preventDefault(); setView(target.view); }
        return;
      }
      if (e.key === 'g') {
        chordActive = true;
        chordTimer = window.setTimeout(() => { chordActive = false; }, 800);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(chordTimer);
    };
  }, [items]);

  // Ctrl/Cmd+K is the one shortcut that fires while typing: it does not collide with the
  // g-chord or useListNav, which both ignore any keypress with a modifier held.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function onNavKeyDown(e: React.KeyboardEvent, i: number) {
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const backward = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (forward || backward) {
      e.preventDefault();
      const next = forward ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      setNavFocusIdx(next);
      navRefs.current[next]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault(); setNavFocusIdx(0); navRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      const last = items.length - 1;
      e.preventDefault(); setNavFocusIdx(last); navRefs.current[last]?.focus();
    }
  }

  const closeBell = useCallback(() => { setBellOpen(false); bellRef.current?.focus(); }, []);

  if (!me) return null;

  async function disconnect(k: string) {
    if (!confirm(`Disconnect ${k}? Its panel stops working until you reconnect.`)) return;
    setConnBusy(k);
    try {
      await jf('/api/disconnect/' + k, { method: 'POST' });
      await refresh();
    } finally {
      setConnBusy(null);
    }
  }

  return (
    <div id="app" data-kbd-mode={kbdMode ? 'true' : undefined}>
      <a href="#main" className="skip-link">Skip to content</a>
      <nav>
        <div className="brand" title="Press g then a letter to jump to a view (e.g. g t for Today)">
          <span className="mark" />DASH
        </div>
        {canNotify && (
          <div className="bellwrap">
            <button
              ref={bellRef} className="navbtn bell" aria-haspopup="dialog" aria-expanded={bellOpen}
              aria-label={`Notifications${notifs.data?.unread ? `, ${notifs.data.unread} unread` : ''}`}
              onClick={() => setBellOpen((o) => !o)}
            >
              <Bell size={16} /> Alerts
              {!!notifs.data?.unread && <span className="badge" aria-hidden="true">{notifs.data.unread > 99 ? '99+' : notifs.data.unread}</span>}
            </button>
            {bellOpen && (
              <NotificationsPanel
                items={notifs.data?.items ?? []} unread={notifs.data?.unread ?? 0}
                onMarkRead={(id) => notifs.markRead([id])} onMarkAll={() => notifs.markRead()}
                onClose={closeBell}
              />
            )}
          </div>
        )}
        {items.map(({ view: v, label, icon: Icon }, i) => (
          <button
            key={v} ref={(el) => { navRefs.current[i] = el; }}
            className={'navbtn' + (v === view ? ' on' : '')}
            tabIndex={i === navFocusIdx ? 0 : -1}
            onClick={() => { setView(v); setNavFocusIdx(i); }}
            onKeyDown={(e) => onNavKeyDown(e, i)}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
        <div className="spacer" />
        <div className="who">
          <b>{me.user.name}</b>
          <span className={'tag' + (me.user.role === 'admin' ? ' admin' : '')}>{me.user.role}</span>
          <span className="muted"> · via {me.via || 'code'}</span>
        </div>
        <div className="conn">
          {Object.entries(me.connected).map(([k, v]) => (
            <div key={k}>
              {v ? <b>●</b> : '○'}{' '}
              <a href={`/auth/${k}`} title={v ? `Reconnect ${k} (re-runs consent)` : undefined}>{k}</a>
              {v && (
                <button
                  className="x" title={`Disconnect ${k}`} disabled={connBusy === k}
                  onClick={() => disconnect(k)}
                ><X size={11} /></button>
              )}
            </div>
          ))}
        </div>
        <button id="logout" onClick={logout}><LogOut size={14} /> Sign out</button>
      </nav>

      <main id="main" tabIndex={-1}>
        <Section active={view === 'today'}><Today active={view === 'today'} vimNav={vimNav} /></Section>
        <Section active={view === 'inbox'}>
          <Inbox active={view === 'inbox'} vimNav={vimNav} onOpenTasks={() => setView('tasks')} />
        </Section>
        <Section active={view === 'tasks'}><Tasks active={view === 'tasks'} vimNav={vimNav} focusReq={taskReq} /></Section>
        <Section active={view === 'calendar'}><CalendarView active={view === 'calendar'} /></Section>
        <Section active={view === 'notes'}><Notes active={view === 'notes'} vimNav={vimNav} openName={noteReq} /></Section>
        <Section active={view === 'drive'}><Drive active={view === 'drive'} vimNav={vimNav} /></Section>
        <Section active={view === 'music'}><MusicView active={view === 'music'} vimNav={vimNav} /></Section>
        <Section active={view === 'github'}><GitHubView active={view === 'github'} /></Section>
        <Section active={view === 'account'}>
          <Account
            active={view === 'account'} kbdMode={kbdMode} onKbdModeChange={updateKbdMode}
            vimNav={vimNav} onVimNavChange={updateVimNav} shortcuts={items}
          />
        </Section>
        <Section active={view === 'access'}><Access active={view === 'access'} vimNav={vimNav} /></Section>
      </main>

      {paletteOpen && (
        <CommandPalette
          views={items}
          canAddTask={can('tasks:write')}
          onClose={() => setPaletteOpen(false)}
          onGo={setView}
          onNewTask={() => {
            setView('tasks');
            setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label="Task"]')?.focus(), 0);
          }}
          onOpenTask={(id) => { setTaskReq({ id }); setView('tasks'); }}
          onOpenNote={(name) => { setNoteReq({ name }); setView('notes'); }}
        />
      )}
    </div>
  );
}

function Section({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <section className="view" hidden={!active}>{children}</section>;
}
