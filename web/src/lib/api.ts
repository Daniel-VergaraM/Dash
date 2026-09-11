import type { ApiError } from '../types';

export async function jf<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = Object.assign(new Error(j.error || res.statusText), { status: res.status });
    throw err;
  }
  return j as T;
}

export const fmtTime = (iso: string, allDay?: boolean) =>
  allDay ? 'all day' : new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

export const ago = (iso: string | number) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
};

export const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
