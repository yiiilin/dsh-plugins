// Human headings and machine identities are separate. Legacy numbered headings remain valid.
// Only an immediately attached, standalone marker outside code/comments can define an item.
import { scanDesign } from './design-check.mjs';
const ITEM = /^[RCDE]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+$/;
const PREFIX = /^([RCDE]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)\b\s*(.*)$/;
export function itemHeadings(text) {
  const scan = scanDesign(text), errors = [], headings = scan.headings.map(h => {
    const m = h.title.match(PREFIX);
    return { ...h, id: m?.[1] ?? null, label: m ? m[2] : h.title, markerLine: null };
  });
  for (const m of scan.markers.filter(m => m.type === 'item')) {
    const h = headings.filter(h => h.line < m.line).at(-1);
    if (!ITEM.test(m.value) || !h || h.level < 2 || !h.label.trim()
        || scan.lines.slice(h.line + 1, m.line).some(l => l.trim())) {
      errors.push(`Invalid/unattached ddd:item at line ${m.line + 1}`); continue;
    }
    if (h.id || h.markerLine !== null) { errors.push(`Duplicate identity representation at line ${m.line + 1}`); continue; }
    h.id = m.value; h.markerLine = m.line;
  }
  return { scan, headings, errors };
}
export function canonicalItemLines(text) {
  const { scan, headings } = itemHeadings(text), lines = [...scan.lines];
  for (const h of headings.filter(h => h.id && h.markerLine !== null)) {
    // Exactly the old heading representation, so moving an ID out of the human title
    // does not by itself invalidate a previously bound contract. Actual prose still does.
    lines[h.line] = `${'#'.repeat(h.level)} ${h.id} ${h.label}`;
    lines[h.markerLine] = '';
  }
  return lines;
}
export function humanTitle(text, fallback = '') {
  const h = scanDesign(text).headings.find(h => h.level === 1);
  return h?.title ?? fallback;
}
