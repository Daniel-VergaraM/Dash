const KEY = 'dash:kbd-nav';

export function getKbdMode(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setKbdMode(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
