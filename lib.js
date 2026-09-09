// Pure helpers, kept out of server.js so test.mjs can import them without booting the server.

const NOTE_RE = /^[\w][\w .()'-]{0,80}\.md$/;

export function noteName(raw) {
  // Trust boundary: this string becomes a filesystem path.
  const base = String(raw ?? '').split(/[\\/]/).pop();
  if (!NOTE_RE.test(base)) {
    throw Object.assign(new Error('bad note name'), { status: 400 });
  }
  return base;
}

// `arp -a` output differs per OS; find the line for this IP and pull the MAC off it.
export function macFromArp(stdout, ip) {
  const line = stdout
    .split(/\r?\n/)
    .find((l) => l.split(/[\s()]+/).includes(ip));
  const mac = line?.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i)?.[0];
  return mac ? mac.toLowerCase().replace(/-/g, ':') : null;
}

// A task is a calendar event; this is the only date maths in the app.
export function taskWindow(start, minutes) {
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) throw Object.assign(new Error('bad start time'), { status: 400 });
  const mins = Math.min(Math.max(Number(minutes) || 30, 5), 60 * 24);
  return { start: s.toISOString(), end: new Date(s.getTime() + mins * 60000).toISOString() };
}
