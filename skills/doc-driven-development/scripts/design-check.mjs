// Deliberately structural: never infer business correctness, approval or diagram semantics.
// Supports ATX headings, backtick/tilde fences and standalone markers; no Markdown dependency.
export const DESIGN_FORMAT = 'layered-v1';
const LAYERS = ['requirements', 'overview', 'detail'];
const KINDS = { flow: 'overview', data: 'overview', state: 'detail' };
const PLACEHOLDER = /^(?:TODO|TBD|待填写|待补充|待替换|占位|\.\.\.|…|<[^>]+>|\{\{[^}]+\}\})[。.!！]?$/i;
const blankReason = s => !s?.trim() || /^(?:n\/?a|none|unknown|不适用|无|略|未知|待定|无状态)[。.!！]?$/i.test(s.trim()) || PLACEHOLDER.test(s.trim());
const normalize = s => s.replace(/^\d+(?:\.\d+)*[.、)）\s]*/, '').replace(/\s*#+\s*$/, '').trim().toLowerCase();
function layerName(s) {
  s = normalize(s);
  if (/^(?:需求说明|需求与验收|需求与模块约束|需求与约束来源|requirements(?: and (?:acceptance|module constraints))?)$/.test(s)) return 'requirements';
  if (/^(?:概要设计|局部概要设计|high[- ]level design|overview design)$/.test(s)) return 'overview';
  if (/^(?:详细设计|关键详细设计|detailed design|key detailed design)$/.test(s)) return 'detail';
  return null;
}
export function scanDesign(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), visible = [...lines], fences = [], headings = [], markers = [];
  let fence = null, comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      visible[i] = '';
      if (new RegExp(`^ {0,3}${fence.ch}{${fence.n},}\\s*$`).test(line)) {
        fences.push({ ...fence, end: i, body: lines.slice(fence.start + 1, i).join('\n'), closed: true }); fence = null;
      }
      continue;
    }
    if (comment) { visible[i] = ''; if (line.includes('-->')) comment = false; continue; }
    const mark = line.match(/^\s*<!--\s*ddd:(section|diagram|acceptance)\b\s*([^]*?)\s*-->\s*$/);
    if (mark) { markers.push({ type: mark[1], value: mark[2].trim(), line: i }); visible[i] = ''; continue; }
    if (line.includes('<!--')) { visible[i] = ''; comment = !line.includes('-->', line.indexOf('<!--') + 4); continue; }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})([^]*)$/);
    if (open) { fence = { ch: open[1][0], n: open[1].length, info: open[2].trim().toLowerCase(), start: i }; visible[i] = ''; continue; }
    const h = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
    if (h) headings.push({ level: h[1].length, title: h[2], line: i });
  }
  if (fence) fences.push({ ...fence, end: lines.length, body: lines.slice(fence.start + 1).join('\n'), closed: false });
  const h2 = headings.filter(h => h.level === 2);
  const sections = h2.map((h, i) => ({ ...h, end: h2[i + 1]?.line ?? lines.length, key: layerName(h.title) }));
  for (const m of markers.filter(m => m.type === 'section')) {
    const s = sections.find(s => s.line < m.line && m.line < s.end);
    // A stable alias must immediately follow the real human-facing H2, not float in prose.
    if (s && LAYERS.includes(m.value) && lines.slice(s.line + 1, m.line).every(l => !l.trim())) {
      s.markerConflict = Boolean(s.key && s.key !== m.value);
      s.marker = m.value; s.key = m.value; m.attached = true;
    }
  }
  return { lines, visible, fences, headings, markers, sections };
}

// Ignore header/evidence-only changes when gradually adopting old prose. This is a
// change-selection heuristic, not a semantic equivalence claim. --design is explicit.
export function designFingerprint(text) {
  const s = scanDesign(text), first = s.sections[0]?.line;
  if (first === undefined) return '';
  const end = s.sections.find(x => /^(?:实现与验证|实现定位与验证记录|实现与验证记录|实现定位与验证|evidence|implementation(?: and verification)?|verification records|verification)$/i.test(normalize(x.title)))?.line ?? s.lines.length;
  return s.lines.slice(first, end).map(l => l.trimEnd()).join('\n').trim();
}

export function validateDesign(doc, { resolveReference } = {}) {
  const issues = [], scan = scanDesign(doc.text), layers = new Map();
  const add = (code, message) => issues.push({ code, message });
  if (doc.fields['Design-Format'] && doc.fields['Design-Format'] !== DESIGN_FORMAT) add('format', `unsupported Design-Format ${doc.fields['Design-Format']}`);
  for (const section of scan.sections) if (section.markerConflict) add('marker', `section marker contradicts recognized heading at line ${section.line + 1}`);
  for (const key of LAYERS) {
    const found = scan.sections.filter(s => s.key === key);
    if (found.length !== 1) { add('section', `expected exactly one ${key} H2 section, found ${found.length}`); continue; }
    layers.set(key, found[0]);
    const s = found[0];
    const prose = scan.visible.slice(s.line + 1, s.end).filter(l => l.trim() && !/^\s*#|^\s*\|?\s*:?-{3,}/.test(l));
    if (!prose.some(l => !PLACEHOLDER.test(l.trim()))) add('empty', `${key} needs explanatory prose or an explained reference, not just headings/diagrams/placeholders`);
  }
  if (LAYERS.every(k => layers.has(k)) && !(layers.get('requirements').line < layers.get('overview').line && layers.get('overview').line < layers.get('detail').line)) add('order', 'sections must appear in requirements -> overview -> detail order');
  for (const m of scan.markers.filter(m => m.type === 'section' && !m.attached)) add('marker', `unattached or unknown section marker at line ${m.line + 1}`);
  const req = layers.get('requirements');
  if (req) {
    const hasAcceptance = scan.headings.some(h => h.line > req.line && h.line < req.end && /验收|acceptance/i.test(h.title))
      || scan.markers.some(m => m.type === 'acceptance' && !m.value && m.line > req.line && m.line < req.end);
    if (!hasAcceptance) add('acceptance', 'requirements needs an acceptance heading (or standalone ddd:acceptance marker) with scenarios/references');
    else {
      const anchors = [...scan.headings.filter(h => h.line > req.line && h.line < req.end && /验收|acceptance/i.test(h.title)),
        ...scan.markers.filter(m => m.type === 'acceptance' && !m.value && m.line > req.line && m.line < req.end)];
      if (!anchors.some(a => scan.visible.slice(a.line + 1, Math.min(req.end, scan.headings.find(h => h.line > a.line)?.line ?? req.end))
        .some(l => l.trim() && !/^\s*#/.test(l) && !PLACEHOLDER.test(l.trim())))) add('acceptance', 'acceptance cannot be an empty heading');
    }
  }
  for (const m of scan.markers.filter(m => m.type === 'diagram')) {
    if (!/^(flow|data|state)(?:\s+(?:not-applicable|pending|ref):\s*.+)?$/.test(m.value)) add('marker', `unknown/malformed diagram marker at line ${m.line + 1}`);
  }
  function diagram(target, kind, seen) {
    const key = `${target.path}:${kind}`;
    if (seen.has(key)) return [`${kind}: cyclic diagram reference (${target.path})`];
    if (seen.size >= 16) return [`${kind}: diagram reference depth exceeds 16; simplify the chain`];
    const next = new Set(seen).add(key), s = target === doc ? scan : scanDesign(target.text);
    const ms = s.markers.filter(m => m.type === 'diagram' && m.value.split(/\s+/)[0] === kind);
    if (ms.length !== 1) return [`${kind}: expected one diagram marker, found ${ms.length}; use one overview then named subordinate diagrams`];
    const m = ms[0], owner = s.sections.find(x => m.line > x.line && m.line < x.end);
    if (owner?.key !== KINDS[kind]) return [`${kind}: marker belongs in ${KINDS[kind]}`];
    const mode = m.value.match(/^(flow|data|state)(?:\s+(not-applicable|pending|ref):\s*(.+))?$/);
    if (!mode) return [`${kind}: malformed marker`];
    if (mode[2] === 'pending') return [`${kind}: pending (${mode[3]}); investigate/discuss, do not invent a graph`];
    if (mode[2] === 'not-applicable') return blankReason(mode[3]) ? [`${kind}: not-applicable requires a concrete reason`] : [];
    if (mode[2] === 'ref') {
      if (!resolveReference) return [`${kind}: no local reference resolver available`];
      try {
        const other = resolveReference(target, mode[3]);
        if (!other || other.fields.Status === 'superseded') return [`${kind}: referenced document is missing, unmanaged or historical: ${mode[3]}`];
        const linked = diagram(other, kind, next);
        return linked.map(x => `${target.path} -> ${other.path}: ${x}`);
      } catch (e) { return [`${kind}: unsafe/invalid diagram reference: ${e.message}`]; }
    }
    let i = m.line + 1; while (i < owner.end && !s.lines[i].trim()) i++;
    const f = s.fences.find(f => f.start === i);
    if (!f || !['text', 'ascii'].includes(f.info) || !f.closed || f.end >= owner.end) return [`${kind}: marker must immediately precede a closed text/ascii code fence`];
    const nodes = [...f.body.matchAll(/\[[^\]\n]+\]|\([^()\n]+\)/g)];
    if (nodes.length < 2 || !/(?:-+>|<-+|^\s*[v^]\s*$)/m.test(f.body)) return [`${kind}: expected at least two labeled nodes and ASCII direction arrows`];
    if (/[\u2190-\u21ff\u2500-\u257f]/u.test(f.body)) return [`${kind}: use ASCII connectors, not Unicode arrows/box-drawing characters`];
    if (f.body.split('\n').some(l => PLACEHOLDER.test(l.trim()) || /\[(?:TODO|TBD|待填写|占位)\]/i.test(l))) return [`${kind}: unresolved diagram placeholder`];
    return [];
  }
  for (const kind of Object.keys(KINDS)) for (const message of diagram(doc, kind, new Set())) add('diagram', message);
  for (const layer of layers.values()) {
    if (scan.visible.slice(layer.line + 1, layer.end).some(l => PLACEHOLDER.test(l.trim()))) add('placeholder', `${layer.key}: standalone template placeholder remains`);
  }
  return issues;
}
