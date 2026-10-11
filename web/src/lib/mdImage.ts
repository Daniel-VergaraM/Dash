// Pure helpers for Markdown images (`![alt](url)`). No React, no DOM.
export type Edit = { text: string; sel: [number, number] };

const DATA_IMG = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;
const MAX_DATA = 200_000; // ponytail: inline images above ~150 KB are refused; use a URL instead.
const HTTP = /^https?:\/\/\S+$/i;

// Allowed `src`: http(s), relative / same-origin paths, and small base64 png/jpeg/gif/webp.
// Everything else (javascript:, data:text/html, blob:, file:, ...) is refused.
export function isSafeImageUrl(url: string): boolean {
  const u = url.trim();
  if (!u || /[\u0000-\u001f]/.test(u)) return false;
  if (/^data:/i.test(u)) return u.length <= MAX_DATA && DATA_IMG.test(u);
  if (/^https?:/i.test(u)) return HTTP.test(u);
  return !/^[a-z][a-z0-9+.-]*:/i.test(u); // no other scheme => relative or //host
}

// Raster types the server accepts for uploads, and its size ceiling (kept in step with lib.js).
export const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMG_MAX = 5 * 1024 * 1024;

// Inserts the markdown for an image that was just uploaded, replacing the selection; selected
// text becomes the alt. The caret ends after it.
export function insertUploaded(text: string, from: number, to: number, url: string): Edit {
  const alt = text.slice(from, to).replace(/\s+/g, ' ').trim().replace(/[[\]\\]/g, '\\$&') || 'image';
  const md = `![${alt}](${url})`;
  const end = from + md.length;
  return { text: text.slice(0, from) + md + text.slice(to), sel: [end, end] };
}

// Inserts `![alt](url)` at the caret. Selected text becomes the alt and `url` is left
// selected for pasting; a selected http(s) URL becomes the url with an empty alt (caret in it).
export function insertImage(text: string, from: number, to: number): Edit {
  const raw = text.slice(from, to).trim();
  const isUrl = HTTP.test(raw);
  const alt = isUrl ? '' : raw.replace(/\s+/g, ' ').replace(/[[\]]/g, '\$&');
  const url = isUrl ? raw.replace(/[ ()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()) : 'url';
  const md = `![${alt}](${url})`;
  const base = from;
  const at = base + 2; // after `![`
  const sel: [number, number] = isUrl ? [at, at] : [base + md.length - 4, base + md.length - 1];
  return { text: text.slice(0, from) + md + text.slice(to), sel };
}
