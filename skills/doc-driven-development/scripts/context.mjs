#!/usr/bin/env node
// Fresh, rebuildable dependency/context index. Read-only unless --out is explicit.
// Never calls a model, modifies specs, records approval, or marks files as read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCLI, runCLI, rootDir, loadConfig, documents, inventory, sha, list, safePath,
  readJSON, writeAtomic, localLinks, resolveLink, globRE, MAX_TEXT_BYTES, git,
} from './lib.mjs';
import { scanDesign } from './design-check.mjs';
import { specRef } from './contract.mjs';

const KIND = 'ddd-context-v1';
const positive = (v, fallback, max, name) => {
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(String(v)) || Number(v) > max || Number(v) < 1) throw new Error(`${name} must be 1..${max}`);
  return Number(v);
};
export function buildContext(root, config) {
  if (!config.enabled) throw new Error('Workflow disabled; no context/index is generated. Do not re-enable it automatically.');
  const { docs } = documents(root, config), inv = inventory(root, config), nodes = [], edges = [], warnings = [...inv.warnings];
  const identities = new Map(), byPath = new Map(), files = Object.create(null), queryText = new Map();
  const add = node => {
    if (identities.has(node.id)) throw new Error(`Duplicate context identity: ${node.id}; resolve the source conflict first.`);
    identities.set(node.id, node); nodes.push(node); return node;
  };
  for (const f of inv.files) files[f.path] = f.sha256 ?? `unreadable:${f.bytes}:${f.modified ?? 0}`;
  for (const d of docs) {
    const scan = scanDesign(d.text), current = d.fields.Status !== 'superseded';
    const n = add({ id: d.fields['Doc-ID'], kind: 'document', path: d.path, title: scan.headings.find(h => h.level === 1)?.title ?? d.fields['Doc-ID'],
      status: d.fields.Status, revision: d.fields.Revision, current, binding: specRef(d) });
    byPath.set(d.path, n); files[d.path] = sha(d.text); queryText.set(n.id, d.text.toLocaleLowerCase());
    if (current) for (const h of scan.headings) {
      const id = h.title.match(/^([RCDE]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)\b/)?.[1];
      if (!id) continue;
      add({ id, kind: 'item', path: d.path, line: h.line + 1, title: h.title, current: true, owner: n.id, status: d.fields.Status, revision: d.fields.Revision });
      edges.push({ from: id, to: n.id, kind: 'defined-in', source: d.path });
    }
  }
  const edge = (from, id, kind, source) => {
    const target = identities.get(id);
    if (!target) { warnings.push(`${source}: unresolved ${kind} identity ${id}`); return; }
    edges.push({ from, to: id, kind, source });
    if (!target.current) warnings.push(`${source}: ${kind} points to historical ${id}; not a current authority`);
  };
  for (const d of docs.filter(d => d.fields.Status !== 'superseded')) {
    const id = d.fields['Doc-ID'];
    for (const dep of list(d.fields['Depends on'])) edge(id, dep, 'depends-on', d.path);
    for (const target of list(d.fields.Targets)) {
      const m = target.match(/^(.*)@(new|[1-9]\d*)$/), n = m && byPath.get(m[1]);
      if (n) { edge(id, n.id, 'proposes-change-to', d.path); if (m[2] !== n.revision) warnings.push(`${d.path}: Targets revision is stale for ${n.path}`); }
    }
    for (const pattern of list(d.fields.Owns)) {
      const re = globRE(pattern);
      for (const f of inv.files.filter(f => f.candidate && re.test(f.path))) {
        const fid = `file:${f.path}`;
        if (!identities.has(fid)) add({ id: fid, kind: 'file', path: f.path, current: true, sha256: f.sha256 });
        edge(id, fid, 'owns', d.path);
      }
    }
    // Links remain references, not inferred strong dependencies.
    for (const link of localLinks(d.text)) {
      try {
        const p = path.relative(root, resolveLink(root, d.path, link)).split(path.sep).join('/'), n = byPath.get(p);
        if (n && n.id !== id) edge(id, n.id, 'reference', d.path);
      } catch (e) { warnings.push(`${d.path}: ${e.message}`); }
    }
    const s = scanDesign(d.text);
    for (let i = 0; i < s.headings.length; i++) {
      const h = s.headings[i], eid = h.title.match(/^(E-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)\b/)?.[1];
      if (!eid) continue;
      const content = s.visible.slice(h.line + 1, s.headings[i + 1]?.line ?? s.lines.length).join('\n');
      const covers = content.match(/^Covers:\s*(.+)$/m)?.[1];
      for (const covered of list(covers)) edge(eid, covered, 'covers', d.path);
    }
  }
  // Config + actual rule entries affect task context even though not part of the code snapshot.
  const controls = new Set(['.doc-driven.json', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.claude/CLAUDE.md']);
  const receipt = safePath(root, '.doc-driven/install.json');
  if (fs.existsSync(receipt)) {
    const stat = fs.statSync(receipt);
    if (stat.size > MAX_TEXT_BYTES) throw new Error('Installation receipt too large for context inspection');
    const s = readJSON(receipt);
    for (const rule of s.rules ?? []) if (typeof rule.path === 'string') {
      if (!rule.path.endsWith('.md') || rule.path.includes('skills/') || rule.path.startsWith('.doc-driven/')) throw new Error('Unsafe rule path in receipt');
      controls.add(rule.path);
    }
    files['.doc-driven/install.json'] = sha(fs.readFileSync(receipt));
  }
  for (const p of controls) {
    const full = safePath(root, p);
    if (fs.existsSync(full)) {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_TEXT_BYTES) throw new Error(`Cannot inspect control file: ${p}`);
      files[p] = sha(fs.readFileSync(full));
    }
  }
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const unique = [...new Map(edges.map(e => [`${e.from}\0${e.kind}\0${e.to}`, e])).values()];
  const branch = inv.git.enumeration === 'git' ? git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { optional: true })?.trim() ?? null : null;
  const snapshot = { schemaVersion: 1, kind: KIND, worktree: sha(root), generatedAt: new Date().toISOString(),
    fingerprint: sha(JSON.stringify({ files: ordered, config, git: { head: inv.git.head, branch, enumeration: inv.git.enumeration } })), codeBaseline: `snapshot:${inv.snapshot}`, git: { ...inv.git, branch },
    files: ordered, nodes, edges: unique, warnings: [...new Set(warnings)], skipped: inv.skipped,
    reading: 'not-assessed', semantic: 'not-assessed', limitations: 'Non-atomic filesystem snapshot; recheck sources before/after the actual action. File/explicit-link index only. Hashing is not reading; links are not inferred dependencies; no guarantee of complete impact coverage. Exclusions follow inventory. The index cannot authorize implementation or certify evidence.' };
  return { snapshot, queryText };
}
export function walkGraph(snapshot, seeds, { direction = 'impact', depth = 3, limit = 80 } = {}) {
  if (!['impact', 'dependencies'].includes(direction)) throw new Error('direction must be impact or dependencies');
  const adjacency = new Map(), push = (a, b) => { if (!adjacency.has(a)) adjacency.set(a, new Set()); adjacency.get(a).add(b); };
  for (const e of snapshot.edges) {
    if (e.kind === 'reference') continue;
    if (direction === 'impact') push(e.to, e.from); else push(e.from, e.to);
    // A document's contract is the versioning unit; include its defined items.
    if (e.kind === 'defined-in') { push(e.from, e.to); push(e.to, e.from); }
  }
  const seen = new Set(), queue = seeds.map(id => [id, 0]), results = []; let truncated = false;
  // Index-based queue and sets avoid quadratic repeated whole-graph scans.
  for (let i = 0; i < queue.length; i++) {
    const [id, distance] = queue[i]; if (seen.has(id)) continue;
    if (seen.size >= limit) { truncated = true; break; }
    seen.add(id); results.push({ id, distance });
    const next = [...(adjacency.get(id) ?? [])].filter(n => !seen.has(n));
    if (distance >= depth) { if (next.length) truncated = true; continue; }
    for (const n of next) queue.push([n, distance + 1]);
  }
  return { results, truncated, direction, depth, limit };
}
export function compareContext(before, after) {
  if (before?.kind !== KIND || before.schemaVersion !== 1 || !before.files || typeof before.files !== 'object' || Array.isArray(before.files)
    || !Array.isArray(before.nodes) || !Array.isArray(before.edges)) throw new Error('Not a valid context snapshot');
  if (before.worktree !== after.worktree) throw new Error('Context snapshot belongs to a different worktree; do not reuse branch/worktree memory blindly.');
  const added = [], modified = [], removed = [];
  for (const p of Object.keys(after.files)) {
    if (!Object.hasOwn(before.files, p)) added.push(p); else if (before.files[p] !== after.files[p]) modified.push(p);
  }
  for (const p of Object.keys(before.files)) if (!Object.hasOwn(after.files, p)) removed.push(p);
  const changed = new Set([...added, ...modified, ...removed]), seeds = new Set();
  for (const n of [...before.nodes, ...after.nodes]) if (changed.has(n.path)) seeds.add(n.id);
  const merged = { edges: [...before.edges, ...after.edges] };
  const impact = walkGraph(merged, [...seeds], { direction: 'impact', depth: 12, limit: 300 });
  return { status: before.fingerprint === after.fingerprint ? 'unchanged' : 'changed', added, modified, removed,
    affected: impact.results, truncated: impact.truncated,
    action: 'Re-read changed sources and affected constraints before relying on old decisions, review or evidence. This comparison does not mark anything read.' };
}
export function contextReport(root, config, options = {}) {
  const { snapshot, queryText } = buildContext(root, config);
  const depth = positive(options.depth, 3, 12, '--depth'), limit = positive(options.limit, 40, 300, '--limit');
  if (options.direction && !options.doc) throw new Error('--direction requires --doc');
  if (options.bindings && !options.doc) throw new Error('--bindings requires --doc to identify the actual reviewed scope');
  let nodes = snapshot.nodes.filter(n => options.history || n.current), selected, traversal;
  if (options.doc) {
    const n = nodes.find(n => n.id === options.doc || n.path === options.doc && n.kind === 'document');
    if (!n) throw new Error(`Unknown/current identity or document path: ${options.doc}`);
    selected = n;
    traversal = walkGraph(snapshot, [n.id], { direction: options.direction ?? 'dependencies', depth, limit });
    const ids = new Set(traversal.results.map(n => n.id)); nodes = nodes.filter(n => ids.has(n.id));
  }
  if (options.query) {
    const q = options.query.trim().toLocaleLowerCase(); if (!q) throw new Error('--query must not be blank');
    nodes = nodes.filter(n => `${n.id} ${n.title ?? ''} ${n.path}`.toLocaleLowerCase().includes(q) || (n.kind === 'document' && queryText.get(n.id)?.includes(q)));
  }
  const result = { kind: 'ddd-context-report-v1', codeBaseline: snapshot.codeBaseline, git: snapshot.git, fingerprint: snapshot.fingerprint,
    selected: selected ?? null, matches: nodes.slice(0, limit), truncated: nodes.length > limit || Boolean(traversal?.truncated),
    relationships: traversal ? snapshot.edges.filter(e => nodes.some(n => n.id === e.from) || nodes.some(n => n.id === e.to)).slice(0, limit * 4) : [],
    warnings: snapshot.warnings, skippedCount: snapshot.skipped.length, reading: 'not-assessed', semantic: 'not-assessed', limitations: snapshot.limitations };
  if (options.bindings) {
    const owner = selected.kind === 'document' ? selected : snapshot.nodes.find(n => n.id === selected.owner);
    if (!owner?.current || !owner.binding) throw new Error('--bindings requires a current document or its defined item');
    result.bindings = { 'Spec-Refs': owner.binding, Baseline: snapshot.codeBaseline, notice: 'Identifiers for recording a real check only. Not a test result, approval, read receipt or automatic evidence refresh.' };
  }
  if (options.compare) {
    if (!/^\.doc-driven\/context\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(options.compare)) throw new Error('--compare must be .doc-driven/context/<name>.json');
    const file = safePath(root, options.compare), st = fs.statSync(file);
    if (!st.isFile() || st.size > 32 * 1024 * 1024) throw new Error('Context snapshot is not a regular file or exceeds 32 MiB');
    result.comparison = compareContext(readJSON(file), snapshot);
  }
  if (options.out) {
    if (!/^\.doc-driven\/context\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(options.out)) throw new Error('--out must be a new .doc-driven/context/<name>.json (never a design, config or arbitrary JSON file)');
    const payload = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error('Snapshot exceeds 32 MiB; narrow inventory scope or use separate worktrees/subscopes transparently');
    writeAtomic(root, options.out, payload, { exclusive: true }); result.saved = options.out;
  }
  return result;
}
function main() {
  const args = parseCLI(process.argv.slice(2), { '--doc': 'value', '--query': 'value', '--direction': 'value', '--depth': 'value', '--limit': 'value',
    '--bindings': 'flag', '--history': 'flag', '--compare': 'value', '--out': 'value', '--json': 'flag' });
  if (args.flags.help) {
    console.log('Usage: node context.mjs [repo] [--doc ID|path] [--query text] [--direction dependencies|impact] [--depth 1..12] [--limit 1..300] [--bindings] [--history] [--compare .doc-driven/context/name.json] [--out .doc-driven/context/new-name.json] [--json]\nAlways rebuilds from current files, never queries a stale cached index. Default read-only. --out saves a NEW fingerprint snapshot, never a read/approval/evidence claim. JSON output; no database, network, model or project code execution.'); return;
  }
  const root = rootDir(args.root), result = contextReport(root, loadConfig(root), args.flags);
  console.log(JSON.stringify(result, null, 2));
  // Changes are data to inspect, not a script failure; operational errors use exit 2.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCLI(main);
