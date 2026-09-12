import { useRef } from 'react';
import { isTypingTarget } from './kbd';

export interface ListNavCallbacks {
  onLeft?: (i: number) => void;          // h
  onRight?: (i: number) => void;         // l
  onSelectToggle?: (i: number) => void;  // Space
}

export function useListNav(count: number, enabled: boolean, cb: ListNavCallbacks = {}) {
  const rows = useRef<(HTMLElement | null)[]>([]);
  const gPending = useRef(false);
  const gTimer = useRef<number | undefined>(undefined);

  function rowRef(i: number) {
    return (el: HTMLElement | null) => { rows.current[i] = el; };
  }

  function focusAt(i: number) {
    rows.current[Math.max(0, Math.min(count - 1, i))]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    if (!enabled || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (gPending.current) {
      gPending.current = false;
      window.clearTimeout(gTimer.current);
      if (e.key === 'g') { e.preventDefault(); focusAt(0); }
      return;
    }
    switch (e.key) {
      case 'j': e.preventDefault(); focusAt(i + 1); return;
      case 'k': e.preventDefault(); focusAt(i - 1); return;
      case 'g': gPending.current = true; gTimer.current = window.setTimeout(() => { gPending.current = false; }, 800); return;
      case 'G': e.preventDefault(); focusAt(count - 1); return;
      case ' ':
        if (e.target !== e.currentTarget) return; // a nested button/checkbox already owns Space
        e.preventDefault(); cb.onSelectToggle?.(i); return;
      case 'h': if (cb.onLeft) { e.preventDefault(); cb.onLeft(i); } return;
      case 'l': if (cb.onRight) { e.preventDefault(); cb.onRight(i); } return;
    }
  }

  return { rowRef, onKeyDown, focusAt };
}
