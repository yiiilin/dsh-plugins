#!/usr/bin/env node
// Structural consistency only. This script cannot authenticate approval, understand
// program semantics, or prove that a reported test/reading session actually happened.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseCLI, runCLI, rootDir, loadConfig, documents, inventory, list, matches, globRE,
  safePath, readJSON, stripFences, header, localLinks, resolveLink, indexBlock,
  START, END, candidatePath, resolveBase, changedPaths, docsAtBase,
} from './lib.mjs';

const STATUSES = ['observed', 'proposed', 'accepted', 'superseded'];
const TYPES = ['feature', 'architecture', 'module', 'change', 'adoption', 'verification', 'adr', 'requirements'];
const IMPLEMENTATIONS = ['unknown', 'missing', 'partial', 'complete', 'divergent', 'not-applicable'];
const VERIFICATIONS = ['not-run', 'partial', 'passed', 'failed', 'blocked', 'stale', 'not-applicable'];
const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const BASELINE = /^(?:unknown|git:[a-f0-9]{7,64}|snapshot:[a-f0-9]{64})$/;
const ITEM = /\b[CRE]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/g;
const notBlank = s => Boolean(s?.trim() && !/^(?:none|—|-|unknown)$/i.test(s.trim()));

export function checkRepo(root, config, options = {}) {
  const errors = [], warnings = [], stats = {};
  const error = s => errors.push(s), warn = s => warnings.push(s);
  if (!config.enabled) return { errors, warnings: ['Workflow disabled in .doc-driven.json; no checks performed.'], stats: { disabled: true } };
  if (options.release && !options.base) throw new Error('--release requires --base to select this change, not every historical observed document.');
  if (options.full && !options.progress) throw new Error('--full requires --progress <path>.');
  const { docs, legacy } = documents(root, config);
  for (const p of legacy) warn(`${p}: legacy header detected; not treated as an approved v0.2 document.`);
  const byId = new Map(), byPath = new Map(docs.map(d => [d.path, d]));
  const definitions = new Map(), evidence = [], bodies = new Map();
  const owners = [], nameOwners = new Map();
  const addDefinition = (id, info) => {
    if (definitions.has(id)) error(`${info.doc.path}: duplicate item ID ${id}, already defined in ${definitions.get(id).doc.path}`);
    else definitions.set(id, info);
  };
  for (const d of docs) {
    const h = d.fields;
    for (const key of ['Doc-ID', 'Type', 'Revision', 'Status', 'Baseline', 'Owns', 'Implementation', 'Verification'])
      if (!h[key]) error(`${d.path}: missing header ${key}`);
    for (const k of d.duplicates) error(`${d.path}: duplicate header ${k}`);
    if (!ID.test(h['Doc-ID'] ?? '')) error(`${d.path}: invalid Doc-ID`);
    if (byId.has(h['Doc-ID'])) error(`${d.path}: duplicate Doc-ID ${h['Doc-ID']}`); else byId.set(h['Doc-ID'], d);
    if (!TYPES.includes(h.Type)) error(`${d.path}: invalid Type ${h.Type}`);
    if (!STATUSES.includes(h.Status)) error(`${d.path}: invalid Status ${h.Status}`);
    if (!/^[1-9]\d*$/.test(h.Revision ?? '')) error(`${d.path}: Revision must be a positive integer`);
    if (!BASELINE.test(h.Baseline ?? '')) error(`${d.path}: invalid Baseline`);
    if (!IMPLEMENTATIONS.includes(h.Implementation)) error(`${d.path}: invalid Implementation ${h.Implementation}`);
    if (!VERIFICATIONS.includes(h.Verification)) error(`${d.path}: invalid Verification ${h.Verification}`);
    if (h.Status === 'accepted') {
      if (!notBlank(h.Approval)) error(`${d.path}: accepted requires an actual Approval source`);
      if (h['Approved revision'] !== h.Revision) error(`${d.path}: Approved revision must match Revision`);
    }
    for (const field of ['Owns', 'Affects']) for (const p of list(h[field])) {
      try { globRE(p); } catch (e) { error(`${d.path}: ${field}: ${e.message}`); }
    }
    if (h.Type === 'change' && list(h.Owns).length) error(`${d.path}: a change uses Affects, not duplicate Owns`);
    if (h.Status !== 'superseded' && h.Type !== 'change') {
      for (const p of list(h.Owns)) {
        try { owners.push({ doc: d, pattern: p, re: globRE(p) }); } catch { /* Reported above. */ }
      }
      for (const name of list(h['Owns names'])) {
        if (nameOwners.has(name)) error(`${d.path}: Owns names duplicates ${name} from ${nameOwners.get(name)}`);
        else nameOwners.set(name, d.path);
      }
    }
    const clean = stripFences(d.text), headings = [...clean.matchAll(/^#{1,6}\s+([^\n]+)$/gm)];
    if (h.Status !== 'superseded') bodies.set(d.path, clean);
    for (let i = 0; i < headings.length; i++) {
      const item = headings[i][1].match(/^([CRE]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)\b/);
      if (!item || h.Status === 'superseded') continue;
      const id = item[1], content = clean.slice(headings[i].index + headings[i][0].length, headings[i + 1]?.index ?? clean.length);
      const info = { id, doc: d, fields: header(content).fields };
      addDefinition(id, info);
      if (id.startsWith('E-')) evidence.push(info);
    }
    for (const link of localLinks(d.text)) {
      try { if (!fs.existsSync(resolveLink(root, d.path, link))) error(`${d.path}: broken local link ${link}`); }
      catch (e) { error(`${d.path}: ${e.message}`); }
    }
  }
  // Supersession and target revisions refer to current document identity, not a copied status in the index.
  for (const d of docs) {
    const h = d.fields;
    if (h.Status === 'superseded') {
      const target = h['Superseded by'];
      if (!target || !byPath.has(target) || target === d.path) error(`${d.path}: superseded needs a different existing managed Superseded by target`);
      else {
        const visited = new Set([d.path]); let next = byPath.get(target);
        while (next?.fields.Status === 'superseded') {
          if (visited.has(next.path)) { error(`${d.path}: cyclic supersession`); break; }
          visited.add(next.path); next = byPath.get(next.fields['Superseded by']);
        }
      }
    }
    if (h.Type === 'change' && h.Status !== 'superseded') {
      if (!list(h.Targets).length) error(`${d.path}: change requires Targets`);
      for (const target of list(h.Targets)) {
        const m = target.match(/^(.*)@(new|[1-9]\d*)$/);
        if (!m) { error(`${d.path}: invalid Targets entry ${target}`); continue; }
        try { safePath(root, m[1]); } catch (e) { error(`${d.path}: ${e.message}`); continue; }
        if (m[2] === 'new') continue;
        const current = byPath.get(m[1]);
        if (!current) error(`${d.path}: target is not a managed document: ${m[1]}`);
        else if (current.fields.Revision !== m[2]) error(`${d.path}: stale Targets revision for ${m[1]} (expected ${m[2]}, current ${current.fields.Revision})`);
      }
    }
  }
  for (const [p, body] of bodies) for (const m of body.matchAll(ITEM))
    if (!definitions.has(m[0])) error(`${p}: undefined requirement/constraint/evidence reference ${m[0]}`);
  for (const e of evidence) {
    const h = e.fields;
    if (!list(h.Covers).length) error(`${e.doc.path}: ${e.id} requires Covers`);
    for (const id of list(h.Covers)) {
      if (!byId.has(id) && !definitions.has(id)) error(`${e.doc.path}: ${e.id} covers unknown item ${id}`);
      if (id.startsWith('E-')) error(`${e.doc.path}: ${e.id} must cover a requirement/constraint/document, not another evidence item`);
    }
    if (!h.Method?.trim()) error(`${e.doc.path}: ${e.id} requires Method`);
    if (!['passed', 'failed', 'blocked', 'not-run'].includes(h.Result)) error(`${e.doc.path}: ${e.id} has invalid Result`);
    if (!BASELINE.test(h.Baseline ?? '')) error(`${e.doc.path}: ${e.id} requires a valid Baseline`);
    if (!h.Detail?.trim()) error(`${e.doc.path}: ${e.id} requires Detail`);
    if (h.Result === 'passed' && h.Baseline === 'unknown') error(`${e.doc.path}: ${e.id} cannot pass on an unknown Baseline`);
  }
  for (const d of docs.filter(d => d.fields.Verification === 'passed' && d.fields.Status !== 'superseded')) {
    if (d.fields.Baseline === 'unknown') error(`${d.path}: Verification passed needs a known Baseline`);
    const requirements = [...definitions.values()].filter(x => x.doc.path === d.path && /^[RC]-/.test(x.id)).map(x => x.id);
    if (!requirements.length && ['feature', 'module', 'requirements'].includes(d.fields.Type))
      error(`${d.path}: passed feature/module/requirements needs at least one numbered requirement or constraint`);
    const needed = requirements.length ? requirements : [d.fields['Doc-ID']];
    for (const id of needed) {
      const relevant = evidence.filter(e => e.doc.fields.Status !== 'superseded' && list(e.fields.Covers).includes(id) && e.fields.Baseline === d.fields.Baseline);
      if (!relevant.some(e => e.fields.Result === 'passed')) error(`${d.path}: passed lacks matching-baseline passed evidence for ${id}`);
      if (relevant.some(e => e.fields.Result === 'failed')) error(`${d.path}: current evidence fails ${id}, cannot claim Verification passed`);
    }
  }
  const index = safePath(root, config.index);
  if (!fs.existsSync(index)) error(`${config.index}: missing index; run index.mjs`);
  else {
    const text = fs.readFileSync(index, 'utf8'), a = text.indexOf(START), b = text.indexOf(END);
    if (a < 0 || b < a || text.slice(a, b + END.length) !== indexBlock(config, docs)
      || text.indexOf(START, a + START.length) >= 0 || text.indexOf(END, b + END.length) >= 0)
      error(`${config.index}: generated index missing, malformed, or stale; run index.mjs`);
    for (const link of localLinks(text)) {
      try { if (!fs.existsSync(resolveLink(root, config.index, link))) error(`${config.index}: broken local link ${link}`); }
      catch (e) { error(`${config.index}: ${e.message}`); }
    }
  }
  const inv = inventory(root, config), candidates = inv.files.filter(f => f.candidate);
  warnings.push(...inv.warnings);
  for (const entry of inv.skipped.filter(e => e.blocked)) {
    (options.full ? error : warn)(`Inventory ${entry.path}: could not inspect: ${entry.reason}`);
  }
  let mapped = 0;
  for (const file of candidates) {
    const owning = [...new Set(owners.filter(o => o.re.test(file.path)).map(o => o.doc.path))];
    if (owning.length) mapped++;
    if (owning.length > 1) error(`${file.path}: multiple primary owners: ${owning.join(', ')}`);
    if (config.sourcePointers === 'optional' && file.reviewable) {
      const first = fs.readFileSync(safePath(root, file.path), 'utf8').split(/\r?\n/).slice(0, 40);
      for (const line of first) {
        const m = line.match(/^\s*(?:\/\/|#|--|\/\*|\*|<!--)\s*doc:\s*(.*?)\s*(?:\*\/|-->)?\s*$/);
        if (!m) continue;
        const target = m[1].trim().replace(/^`|`$/g, '');
        try {
          if (!fs.existsSync(safePath(root, target))) error(`${file.path}: doc pointer missing: ${target}`);
          else if (!byPath.has(target)) warn(`${file.path}: pointer refers to an unmanaged/legacy doc: ${target}`);
          else if (!owning.includes(target)) error(`${file.path}: pointer ${target} does not match a current primary owner`);
        } catch (e) { error(`${file.path}: ${e.message}`); }
      }
    }
  }
  for (const owner of owners) if (!inv.files.some(f => owner.re.test(f.path))) {
    const message = `${owner.doc.path}: Owns pattern matches no scanned file: ${owner.pattern} (also check exclusions)`;
    if (owner.doc.fields.Implementation === 'complete') error(message); else warn(message);
  }
  if (candidates.length > mapped) warn(`${candidates.length - mapped}/${candidates.length} candidate files have no primary Owns mapping; allowed during incremental adoption.`);
  if (!docs.length) warn('No managed documents yet. Initialization alone does not document a project.');
  Object.assign(stats, { documents: docs.length, legacyDocuments: legacy.length, candidates: candidates.length, mappedCandidates: mapped,
    skippedEntries: inv.skipped.length, reviewableCandidates: inv.summary.reviewableCandidates,
    requirementDefinitions: [...definitions.keys()].filter(id => /^[RC]-/.test(id)).length, evidenceRecords: evidence.length, snapshot: inv.snapshot });

  if (options.base) {
    if (inv.git.enumeration !== 'git') throw new Error('--base requires Git and the actual worktree root.');
    const ref = resolveBase(root, options.base), changed = changedPaths(root, ref), affected = new Set();
    const prior = docsAtBase(root, config, ref);
    const priorOwners = prior.filter(d => d.fields.Status !== 'superseded' && d.fields.Type !== 'change');
    const changedCode = changed.filter(p => candidatePath(p, config));
    for (const p of changedCode) {
      let current = [...new Set(owners.filter(o => o.re.test(p)).map(o => o.doc))];
      if (!current.length && !fs.existsSync(safePath(root, p))) {
        const old = priorOwners.filter(d => matches(p, list(d.fields.Owns)));
        current = old.map(d => {
          let target = byId.get(d.fields['Doc-ID']); const seen = new Set();
          while (target?.fields.Status === 'superseded' && !seen.has(target.path)) {
            seen.add(target.path); target = byPath.get(target.fields['Superseded by']);
          }
          return target;
        }).filter(Boolean);
      }
      if (!current.length) error(`${p}: changed code/config/test has no current governing document (deleted files need their previous document retained/updated)`);
      for (const d of current) affected.add(d.path);
    }
    for (const p of changed) {
      const d = byPath.get(p);
      if (d && d.fields.Status !== 'superseded' && !['adoption', 'verification', 'adr'].includes(d.fields.Type)) affected.add(p);
    }
    stats.changedCode = changedCode.length; stats.affectedDocuments = [...affected];
    if (options.release) {
      const cleanSource = inv.git.head && !changedPaths(root, inv.git.head).some(p => candidatePath(p, config));
      for (const p of affected) {
        const d = byPath.get(p), h = d.fields;
        if (h.Status !== 'accepted') error(`${p}: release requires accepted, found ${h.Status}`);
        if (h.Implementation !== 'complete') error(`${p}: release requires Implementation complete`);
        if (h.Verification !== 'passed') error(`${p}: release requires Verification passed`);
        const currentBaseline = h.Baseline === `snapshot:${inv.snapshot}` || (cleanSource && h.Baseline?.startsWith('git:') && inv.git.head?.startsWith(h.Baseline.slice(4)));
        if (!currentBaseline) error(`${p}: release Baseline does not match the current code snapshot/clean Git HEAD`);
      }
    }
  }
  if (options.progress) {
    const progress = readJSON(safePath(root, options.progress));
    const issue = options.full ? error : warn;
    if (!progress || progress.schemaVersion !== 1 || !progress.files || Array.isArray(progress.files) || typeof progress.files !== 'object') {
      error('Progress must have schemaVersion: 1 and a files object.');
    } else {
      if (progress.inventorySnapshot !== inv.snapshot) issue('Progress inventorySnapshot is stale or missing; refresh inventory and review changed files before updating it.');
      const lookup = new Map(candidates.map(f => [f.path, f]));
      const counts = { reviewed: 0, partial: 0, blocked: 0, excluded: 0, unreviewed: 0, stale: 0 };
      for (const [p, record] of Object.entries(progress.files)) {
        try { safePath(root, p); } catch (e) { error(`Progress ${p}: ${e.message}`); continue; }
        if (!lookup.has(p)) { issue(`Progress ${p}: not a current candidate (deleted, excluded, or documentation)`); continue; }
        if (!record || !['reviewed', 'partial', 'blocked', 'excluded'].includes(record.state)) { error(`Progress ${p}: invalid state`); continue; }
        counts[record.state]++;
        if (typeof record.note !== 'string' || !record.note.trim()) error(`Progress ${p}: a nonempty note/reason is required`);
        if (record.sha256 !== lookup.get(p).sha256) { counts.stale++; issue(`Progress ${p}: content hash is stale`); }
        if (record.state === 'reviewed') {
          if (!lookup.get(p).reviewable) error(`Progress ${p}: binary/oversized/unreadable file cannot be marked text-reviewed`);
          if (!Array.isArray(record.docs) || !record.docs.length) error(`Progress ${p}: reviewed requires at least one managed document`);
          else for (const doc of record.docs) {
            if (typeof doc !== 'string' || !byPath.has(doc) || byPath.get(doc).fields.Status === 'superseded') error(`Progress ${p}: missing/noncurrent managed document ${doc}`);
          }
        }
      }
      for (const file of candidates) {
        const record = progress.files[file.path];
        if (!record) counts.unreviewed++;
        if (!record || !['reviewed', 'excluded'].includes(record.state)) issue(`Progress ${file.path}: not fully reviewed or explicitly excluded`);
      }
      stats.progress = counts;
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], stats,
    limitations: 'Structural checks only: approval authenticity, code semantics, actual reading/test execution, symbols, Markdown anchors and external links are not verified.' };
}

function main() {
  const args = parseCLI(process.argv.slice(2), { '--json': 'flag', '--base': 'value', '--release': 'flag', '--progress': 'value', '--full': 'flag' });
  if (args.flags.help) {
    console.log('Usage: node check-doc-set.mjs [repo] [--json] [--base REF [--release]] [--progress docs/adoption/progress.json [--full]]\nExit 0: structural checks pass (warnings may remain); 1: validation failures; 2: invocation/configuration error.');
    return;
  }
  const root = rootDir(args.root), result = checkRepo(root, loadConfig(root), args.flags);
  if (args.flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const s of result.errors) console.error(`FAIL ${s}`);
    for (const s of result.warnings) console.warn(`WARN ${s}`);
    console.log(`${result.errors.length ? 'FAILED' : 'OK'} ${JSON.stringify(result.stats)}`);
    if (result.limitations) console.log(result.limitations);
  }
  if (result.errors.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCLI(main);
