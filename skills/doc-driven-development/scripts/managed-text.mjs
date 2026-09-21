// Lossless UTF-8 block edits. Never reformat or regenerate surrounding prose.
import { TextDecoder } from 'node:util';

export function decodeText(buf, label = 'file') {
  if (buf.length > 2 * 1024 * 1024) throw new Error(`${label}: exceeds 2 MiB; split or integrate manually.`);
  if (buf.includes(0)) throw new Error(`${label}: binary/UTF-16 content is not edited.`);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); }
  catch { throw new Error(`${label}: invalid UTF-8; refusing lossy conversion.`); }
}
export const newline = text => text.includes('\r\n') ? '\r\n' : '\n';

// Conservative Markdown boundary check; not a complete Markdown parser.
export function inspectBlock(text, start, end) {
  const positions = token => [...text.matchAll(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(m => m.index);
  const a = positions(start), b = positions(end);
  if (a.length !== b.length || a.length > 1 || (a.length && a[0] >= b[0]))
    throw new Error('Managed markers are malformed or duplicated; resolve them manually first.');
  if (a.length) for (const [pos, token] of [[a[0], start], [b[0], end]]) {
    if ((pos && text[pos - 1] !== '\n') || !/^(?:\r?\n|$)/.test(text.slice(pos + token.length)))
      throw new Error('Managed markers must occupy separate, unindented lines.');
  }
  let fence = null, comment = false, offset = 0, yaml = false, first = true;
  for (const line of text.split(/(?<=\n)/)) {
    const clean = line.replace(/\r?\n$/, ''), bare = first ? clean.replace(/^\uFEFF/, '') : clean;
    if (first && bare === '---') { yaml = true; first = false; offset += line.length; continue; }
    first = false;
    const isMarker = a[0] === offset || b[0] === offset;
    if (isMarker && (fence || comment || yaml)) throw new Error('Managed markers are hidden inside a fence, comment, or frontmatter.');
    if (yaml) { if (/^(?:---|\.\.\.)\s*$/.test(bare)) yaml = false; offset += line.length; continue; }
    const f = !comment && clean.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (f) {
      if (!fence) fence = { char: f[1][0], length: f[1].length };
      else if (f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = null;
    } else if (!fence) {
      for (const m of clean.matchAll(/<!--|-->/g)) {
        if (m[0] === '<!--') { if (comment) throw new Error('Nested/unclosed HTML comment; refusing ambiguous insertion.'); comment = true; }
        else { if (!comment) throw new Error('Unmatched HTML comment ending; refusing ambiguous insertion.'); comment = false; }
      }
    }
    offset += line.length;
  }
  if (fence || comment || yaml) throw new Error('Unclosed Markdown fence, HTML comment, or frontmatter; refusing hidden insertion.');
  if (!a.length) return null;
  return { before: text.slice(0, a[0]), block: text.slice(a[0], b[0] + end.length), after: text.slice(b[0] + end.length) };
}
export function mergeBlock(text, body, start, end) {
  const parts = inspectBlock(text, start, end), eol = newline(text), block = body.replace(/\r?\n/g, eol);
  if (parts) return { text: parts.before + block + parts.after, block, appended: false, prefix: '', suffix: '' };
  const prefix = !text || text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
  return { text: text + prefix + block + eol, block, appended: true, prefix, suffix: eol };
}
