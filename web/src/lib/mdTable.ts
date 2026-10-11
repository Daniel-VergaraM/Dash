// Pure helpers for editing GFM tables in a plain textarea. No React, no DOM: positions are
// string offsets, so every function can be exercised from Node.
// ponytail: only pipe-led tables (`| a | b |`) are recognised; code spans containing `|` are
// not special-cased. GFM tables without the leading pipe are left to the browser default.
// A block of `|` lines only counts as a table when it holds a separator row and is not inside
// a ``` / ~~~ fence.

export type Edit = { text: string; sel: [number, number] };

const isRow = (line: string) => /^\s*\|/.test(line);
const isSep = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

// Cells of one row, trimmed; `\|` stays inside its cell.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

// [start, end) of each cell's trimmed content in a row (an empty cell is a caret position).
function cellRanges(line: string): [number, number][] {
  const out: [number, number][] = [];
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === '|' && line[i - 1] !== '\\') pipes.push(i);
  const first = line.search(/\S/);
  if (first < 0 || pipes[0] !== first) return out;
  for (let k = 0; k < pipes.length; k++) {
    const a = pipes[k] + 1;
    const b = k + 1 < pipes.length ? pipes[k + 1] : line.length;
    if (k + 1 === pipes.length && !line.slice(a).trim()) break; // nothing after the closing pipe
    const raw = line.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim() ? a + lead : Math.min(a + 1, b);
    out.push([s, raw.trim() ? s + raw.trim().length : s]);
  }
  return out;
}

function pad(cell: string, w: number, align: 'l' | 'r' | 'c'): string {
  const gap = Math.max(0, w - cell.length);
  if (align === 'r') return ' '.repeat(gap) + cell;
  if (align === 'c') return ' '.repeat(gap >> 1) + cell + ' '.repeat(gap - (gap >> 1));
  return cell + ' '.repeat(gap);
}

// Aligns columns; short rows are padded with empty cells. Returns the new lines and which
// of them are separator rows.
function format(rows: string[][], ncols: number): string[] {
  const sep = rows.map(isSep);
  const full = rows.map((r) => Array.from({ length: ncols }, (_, i) => r[i] ?? ''));
  const aligns = Array.from({ length: ncols }, (_, c) => {
    const s = full.find((_, i) => sep[i])?.[c] ?? '';
    return s.startsWith(':') && s.endsWith(':') ? 'c' : s.endsWith(':') ? 'r' : 'l';
  }) as ('l' | 'r' | 'c')[];
  const w = Array.from({ length: ncols }, (_, c) => Math.max(3, ...full.filter((_, i) => !sep[i]).map((r) => r[c].length)));
  return full.map((r, i) => '| ' + r.map((cell, c) => {
    if (!sep[i]) return pad(cell, w[c], aligns[c]);
    const a = aligns[c];
    if (a === 'c') return ':' + '-'.repeat(w[c] - 2) + ':';
    if (a === 'r') return '-'.repeat(w[c] - 1) + ':';
    return (cell.startsWith(':') ? ':' : '-') + '-'.repeat(w[c] - 1);
  }).join(' | ') + ' |');
}

// 3 columns: header, separator, 3 empty rows. `sel` covers the first header cell.
export function tableTemplate(): { md: string; sel: [number, number] } {
  const head = ['Column 1', 'Column 2', 'Column 3'];
  const empty = ['', '', ''];
  const lines = format([head, ['---', '---', '---'], empty, empty, empty], 3);
  const [s, e] = cellRanges(lines[0])[0];
  return { md: lines.join('\n'), sel: [s, e] };
}

// Inserts the template at the caret, on its own paragraph, with the first cell selected.
export function insertTable(text: string, from: number, to: number): Edit {
  const before = text.slice(0, from), after = text.slice(to);
  const pre = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const post = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const t = tableTemplate();
  const base = before.length + pre.length;
  return { text: before + pre + t.md + post + after, sel: [base + t.sel[0], base + t.sel[1]] };
}

// Tab / Shift+Tab inside a table row: re-aligns the table and selects the next/previous
// cell; past the last cell of the last row a new row is appended. Returns null when the caret
// is not in a table (or Shift+Tab at the very first cell), so the browser default applies.
export function tabInTable(text: string, pos: number, back: boolean): Edit | null {
  const lines = text.split('\n');
  let li = 0, off = 0;
  while (li < lines.length - 1 && off + lines[li].length < pos) { off += lines[li].length + 1; li++; }
  let fence = '';
  const row = lines.map((l) => {
    const m = /^s*(```|~~~)/.exec(l);
    if (m) { fence = !fence ? m[1] : fence === m[1] ? '' : fence; return false; }
    return !fence && isRow(l);
  });
  if (!row[li]) return null;
  let a = li, b = li;
  while (a > 0 && row[a - 1]) a--;
  while (b < lines.length - 1 && row[b + 1]) b++;
  if (!lines.slice(a, b + 1).some((l) => isSep(splitRow(l)))) return null;

  const rows = lines.slice(a, b + 1).map(splitRow);
  const ncols = Math.max(...rows.map((r) => r.length));
  const sep = rows.map(isSep);
  const rowOf = li - a;
  const rng = cellRanges(lines[li]);
  const rel = pos - off;
  let col = 0;
  for (let i = 0; i < rng.length; i++) if (rel >= rng[i][0] - 1) col = i;
  col = Math.min(col, ncols - 1);

  let r = rowOf, c = col;
  const step = back ? -1 : 1;
  const stepRow = () => { do r += step; while (r >= 0 && r < rows.length && sep[r]); };
  c += step;
  if (c < 0 || c >= ncols) {
    stepRow();
    c = back ? ncols - 1 : 0;
    if (r < 0) return null;
    if (r >= rows.length) rows.push(Array(ncols).fill(''));
  }

  const out = format(rows, ncols);
  const head = lines.slice(0, a), tail = lines.slice(b + 1);
  const start = head.reduce((n, l) => n + l.length + 1, 0) + out.slice(0, r).reduce((n, l) => n + l.length + 1, 0);
  const [s, e] = cellRanges(out[r])[c];
  return { text: [...head, ...out, ...tail].join('\n'), sel: [start + s, start + e] };
}
