// Keyboard-accessibility preferences, persisted independently: boosted focus rings vs. vim/yazi list navigation.
const KBD_KEY = 'dash:kbd-nav';
const VIM_KEY = 'dash:vim-nav';

export function getKbdMode(): boolean {
  try { return localStorage.getItem(KBD_KEY) === '1'; } catch { return false; }
}

export function setKbdMode(on: boolean) {
  try { localStorage.setItem(KBD_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

export function getVimNav(): boolean {
  try { return localStorage.getItem(VIM_KEY) === '1'; } catch { return false; }
}

export function setVimNav(on: boolean) {
  try { localStorage.setItem(VIM_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
