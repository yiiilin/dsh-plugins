// Contract identities and evidence bindings. No Markdown renderer or model needed.
// Conservative text identity, NOT semantic equivalence. Evidence subtrees are excluded
// to avoid a record invalidating itself; all other prose/diagrams stay in the identity.
import { sha, list } from './lib.mjs';
import { scanDesign } from './design-check.mjs';

export const EVIDENCE_FORMAT = 'bound-v1';
const ID = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*';
const REF = new RegExp(`^(${ID})@([1-9]\\d*)#([a-f0-9]{64})$`);
export const meaningful = s => Boolean(s?.trim() && !/^(?:none|unknown|—|-|TODO|TBD|待填写|待替换)$/i.test(s.trim()));

export function evidenceSections(text) {
  const scan = scanDesign(text), found = [];
  for (let i = 0; i < scan.headings.length; i++) {
    const h = scan.headings[i], id = h.title.match(/^(E-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)\b/)?.[1];
    if (!id) continue;
    const end = scan.headings.slice(i + 1).find(x => x.level <= h.level)?.line ?? scan.lines.length;
    found.push({ id, start: h.line, end, level: h.level });
  }
  return { scan, sections: found };
}
export function contractHash(doc) {
  const { scan, sections } = evidenceSections(doc.text);
  // Headers contain bookkeeping (approval, code baseline, verification). Include only
  // fields that affect responsibility and interface/dependency scope.
  const first = scan.headings.find(h => h.level >= 2)?.line ?? scan.lines.length;
  const bookkeepingHeadings = new Set(scan.headings.filter(h => h.level === 2 && /^(?:实现与验证|实现定位与验证记录|实现与验证记录|实现定位与验证|证据|设计评审|evidence|implementation(?: and verification)?|verification records|verification|design review)$/i.test(h.title.replace(/^\d+(?:\.\d+)*[.、)）\s]*/, '').trim())).map(h => h.line));
  const lines = scan.lines.slice(first).filter((_, i) => !bookkeepingHeadings.has(i + first) && !sections.some(s => i + first >= s.start && i + first < s.end));
  // Ignore blank-line-only formatting and CRLF; retain all nonblank text incl fences.
  const body = lines.filter(l => l.trim()).map(l => l.trimEnd()).join('\n');
  const fields = Object.fromEntries(['Doc-ID', 'Type', 'Owns', 'Owns names', 'Targets', 'Affects', 'Depends on']
    .map(k => [k, doc.fields[k] ?? '']));
  return sha(JSON.stringify({ algorithm: 'ddd-contract-v1', fields, body }));
}
export function specRef(doc) { return `${doc.fields['Doc-ID']}@${doc.fields.Revision}#${contractHash(doc)}`; }
export function parseSpecRefs(value) {
  if (!meaningful(value)) return [];
  const seen = new Set();
  return list(value).map(raw => {
    const m = raw.match(REF);
    if (!m) throw new Error(`Invalid Spec-Refs entry: ${raw}; expected DOC-ID@revision#64-lowercase-hex`);
    if (seen.has(m[1])) throw new Error(`Duplicate Spec-Refs document: ${m[1]}`);
    seen.add(m[1]); return { id: m[1], revision: m[2], hash: m[3], raw };
  });
}
export function bindingStatus(evidence, target, expectedHash = contractHash(target)) {
  const refs = parseSpecRefs(evidence.fields['Spec-Refs']);
  if (!refs.length) return 'unbound';
  const ref = refs.find(r => r.id === target.fields['Doc-ID']);
  if (!ref) return 'missing';
  if (ref.revision !== target.fields.Revision || ref.hash !== expectedHash) return 'stale';
  return 'current';
}
