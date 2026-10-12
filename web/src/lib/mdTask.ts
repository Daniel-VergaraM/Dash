// Pure helpers for Markdown task lists (`- [ ] a`, `[x] b`) in the notes editor. No React, no
// DOM: positions are string offsets and lines are 1-based, so everything runs from Node.
// lib.js carries a mirror of the recognition rule (countTasks) for the server's note index:
// keep the two in step.
// ponytail: an indented code block (4+ spaces after a blank line) is not told apart from a
// nested list; tables are skipped because a row starts with `|`, never with a marker; HTML
// blocks are recognised by their first line only (known block-level tags, no nesting of the
// same tag, no comments) and end at the closing tag or a blank line.
import type { Edit } from './mdTable';

export type Task = { indent: string; bullet: string; done: boolean; text: string };

// Bulleted / numbered: `- [ ] x`, `* [x]`, `1. [ ]`, `1) [X]`; the text may be empty.
const BULLETED = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+([\s\S]*)$/;
// Bare: `[ ] x` needs text, so a lone `[x]` stays prose. `[ ]x`, `[x](url)`, `[[x]]` never match.
const BARE = /^([ \t]*)\[([ xX])\][ \t]+(\S[\s\S]*)$/;
// Fences: <= 3 spaces of indent (4+ is an indented code block, not a fence).
const FENCE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const MATH = /^[ \t]*\$\$[ \t]*$/;
const HTML_OPEN = /^ {0,3}<(div|details|summary|table|p|section|article|aside|nav|header|footer|main|figure|form|fieldset|ul|ol|dl|pre|blockquote|center|h[1-6])(\s[^>]*)?>([\s\S]*)$/i;
// "Task" button skips: table rows, fence markers, headings.
const NO_TASK = /^(?:[ \t]*\||[ \t]*(?:`{3,}|~{3,})| {0,3}#{1,6}(?:[ \t]|$))/;
const nocr = (s: string) => s.replace(/\r$/, '');

export function parseTaskLine(line: string): Task | null {
  const s = nocr(line);
  const b = BULLETED.exec(s);
  if (b) return { indent: b[1], bullet: b[2], done: b[3] !== ' ', text: b[4] };
  const m = BARE.exec(s);
  return m ? { indent: m[1], bullet: '', done: m[2] !== ' ', text: m[3] } : null;
}

// true for lines inside a ``` / ~~~ fence, a `$$` math block or a block-level HTML element
// (delimiter lines included). A fence / `$$` that never closes runs to the end; an HTML block
// ends at its closing tag or at a blank line, as in CommonMark. Mirror in lib.js
// (countTasks): keep in step.
function codeMask(lines: string[]): boolean[] {
  let mode = ''; // fence marker | '$$' | '</tag'
  return lines.map((raw) => {
    const l = nocr(raw);
    if (mode === '$$') { if (MATH.test(l)) mode = ''; return true; }
    if (mode[0] === '<') {
      if (!l.trim()) { mode = ''; return false; }
      if (l.toLowerCase().includes(mode)) mode = '';
      return true;
    }
    const m = FENCE.exec(l);
    if (mode) {
      if (m && m[1][0] === mode[0] && m[1].length >= mode.length && !m[2].trim()) mode = '';
      return true;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) { mode = m[1]; return true; }
    if (MATH.test(l)) { mode = '$$'; return true; }
    const h = HTML_OPEN.exec(l);
    if (h && !(h[2] || '').endsWith('/') && !h[3].toLowerCase().includes('</' + h[1].toLowerCase())) {
      mode = '</' + h[1].toLowerCase();
      return true;
    }
    return false;
  });
}

const taskLines = (text: string) => {
  const lines = text.split('\n');
  const code = codeMask(lines);
  return { lines, tasks: lines.map((l, i) => (code[i] ? null : parseTaskLine(l))) };
};

export function countTasks(text: string): { open: number; done: number } {
  const out = { open: 0, done: 0 };
  for (const t of taskLines(text).tasks) if (t) t.done ? out.done++ : out.open++;
  return out;
}

// Bare `[ ] x` -> `- [ ] x` so GFM renders a checkbox. Same number of lines, text untouched
// everywhere else; running it twice changes nothing.
export function normalizeBareTasks(text: string): string {
  const { lines, tasks } = taskLines(text);
  return lines.map((l, i) => {
    const t = tasks[i];
    return t && !t.bullet ? t.indent + '- ' + l.slice(t.indent.length) : l;
  }).join('\n');
}

// Flips `[ ]` <-> `[x]` on 1-based `line`. Unchanged when that line is not a task (or sits in code).
export function toggleTaskAtLine(text: string, line: number): string {
  const { lines, tasks } = taskLines(text);
  const t = tasks[line - 1];
  if (!t) return text;
  const l = lines[line - 1];
  const at = l.indexOf('[', t.indent.length + (t.bullet ? t.bullet.length : 0)) + 1;
  lines[line - 1] = l.slice(0, at) + (t.done ? ' ' : 'x') + l.slice(at + 1);
  return lines.join('\n');
}

// Ctrl+Enter: toggle the task under the caret, keeping the selection.
export function toggleTaskAtCaret(text: string, a: number, b = a): Edit | null {
  const line = text.slice(0, a).split('\n').length;
  const next = toggleTaskAtLine(text, line);
  return next === text ? null : { text: next, sel: [a, b] };
}

// Enter at the end of a task line: a fresh `- [ ] ` below (numbers count up, indent and
// bullet are kept); on an empty task, drop the marker and leave a plain line. null = let the
// browser handle Enter.
export function continueTask(text: string, selStart: number, selEnd: number): Edit | null {
  if (selStart !== selEnd) return null;
  const start = text.lastIndexOf('\n', selStart - 1) + 1;
  let end = text.indexOf('\n', selStart);
  if (end < 0) end = text.length;
  const raw = text.slice(start, end);
  const eol = raw.endsWith('\r') ? '\r\n' : '\n';
  const lineEnd = end - (raw.endsWith('\r') ? 1 : 0);
  if (selStart !== lineEnd) return null;
  const { lines, tasks } = taskLines(text.slice(0, end));
  const t = tasks[lines.length - 1];
  if (!t) return null;
  if (!t.text.trim()) {
    return { text: text.slice(0, start) + text.slice(lineEnd), sel: [start, start] };
  }
  const n = /^(\d+)([.)])$/.exec(t.bullet);
  const bullet = n ? `${+n[1] + 1}${n[2]}` : t.bullet;
  const ins = eol + t.indent + (bullet ? bullet + ' ' : '') + '[ ] ';
  return { text: text.slice(0, lineEnd) + ins + text.slice(lineEnd), sel: [lineEnd + ins.length, lineEnd + ins.length] };
}

// "Task" button: every selected line becomes a task (a bullet item keeps its bullet); if they
// all already are tasks, the `[ ]` marker is removed instead. Table rows, fence markers and
// headings are left alone. Not a round trip: plain text -> task -> marker removed leaves
// `- text` (a bullet), because "was plain" is not stored anywhere.
export function convertToTask(text: string, selStart: number, selEnd: number): Edit {
  const from = selStart > 0 ? text.lastIndexOf('\n', selStart - 1) + 1 : 0;
  // A selection that ends just after a newline does not take the next line with it.
  const last = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
  let to = text.indexOf('\n', last);
  if (to < 0) to = text.length;
  const lines = text.slice(from, to).split('\n');
  const multi = lines.length > 1;
  const ok = lines.map((l) => !NO_TASK.test(nocr(l)));
  // Indexes of the lines to convert; a Set keeps this linear for thousands of lines.
  const ids = new Set<number>();
  lines.forEach((l, i) => { if (ok[i] && nocr(l).trim()) ids.add(i); });
  if (!ids.size && !multi && ok[0]) ids.add(0);
  if (!ids.size) return { text, sel: [selStart, selEnd] };
  const allTasks = [...ids].every((i) => parseTaskLine(lines[i]));
  let delta = 0;
  let first = true;
  const out = lines.map((l, i) => {
    if (!ids.has(i)) return l;
    const s = nocr(l);
    const cr = l.slice(s.length);
    let r: string;
    const t = parseTaskLine(s);
    if (allTasks) {
      r = t!.indent + (t!.bullet ? t!.bullet + ' ' : '') + t!.text;
    } else if (t) r = s;
    else {
      const m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)([\s\S]*)$/.exec(s);
      r = m ? m[1] + m[2] + m[3] + '[ ] ' + m[4] : s.replace(/^([ \t]*)/, '$1- [ ] ');
    }
    if (first) { delta = r.length - s.length; first = false; }
    return r + cr;
  });
  const joined = out.join('\n');
  const next = text.slice(0, from) + joined + text.slice(to);
  const sel: [number, number] = multi ? [from, from + joined.length]
    : [Math.max(from, selStart + delta), Math.max(from, selEnd + delta)];
  return { text: next, sel };
}
