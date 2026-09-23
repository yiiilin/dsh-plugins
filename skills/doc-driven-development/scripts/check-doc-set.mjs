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

import { itemHeadings } from './identity.mjs';
import { checkRun, receiptCovers } from './verification.mjs';
import { checkDelivery } from './delivery.mjs';
import { checkLayout } from './doc-layout.mjs';
import { DESIGN_FORMAT, designFingerprint, validateDesign, scanDesign } from './design-check.mjs';
import { EVIDENCE_FORMAT, bindingStatus, parseSpecRefs, contractHash, evidenceSections, meaningful } from './contract.mjs';

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
  if (!config.enabled && options['verification-report']) throw new Error('Disabled workflow cannot validate a verification receipt.');
  if (!config.enabled) return { errors, warnings: ['Workflow disabled in .doc-driven.json; no checks performed.'], stats: { disabled: true } };
  if (options.release && !options.base) throw new Error('--release requires --base to select this change, not every historical observed document.');
  if (options.full && !options.progress) throw new Error('--full requires --progress <path>.');
  const { docs, legacy } = documents(root, config);
  const layout = checkLayout(config, docs);
  errors.push(...layout.errors); warnings.push(...layout.warnings);
  stats.layout = { policy: layout.policy, domainDocuments: layout.domainDocuments, nonconforming: layout.nonconforming };
  for (const p of legacy) warn(`${p}: legacy header detected; not treated as an approved v0.2 document.`);
  const byId = new Map(), byPath = new Map(docs.map(d => [d.path, d]));
  const definitions = new Map(), evidence = [], bodies = new Map();
  const bindingCounts = { current: 0, unbound: 0, stale: 0, semantic: 'not-assessed' };
  // Cache immutable document identities once per check, not once per requirement/evidence pair.
  const contractHashes = new Map(docs.map(d => [d, contractHash(d)]));
  const bindingState = (e, d) => bindingStatus(e, d, contractHashes.get(d));
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
    if (h['Evidence-Format'] && h['Evidence-Format'] !== EVIDENCE_FORMAT) error(`${d.path}: unsupported Evidence-Format ${h['Evidence-Format']}`);
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
    const parsedItems = itemHeadings(d.text), scan = parsedItems.scan, headings = parsedItems.headings;
    for (const message of parsedItems.errors) error(`${d.path}: ${message}`);
    const clean = scan.visible.join('\n');
    if (h.Status !== 'superseded') bodies.set(d.path, clean);
    const records = evidenceSections(d.text).sections;
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];
      if (!heading.id || h.Status === 'superseded') continue;
      const id = heading.id;
      if (/^[RC]-/.test(id) && records.some(e => heading.line > e.start && heading.line < e.end))
        error(`${d.path}: requirement/constraint ${id} cannot be defined inside excluded evidence records`);
      const end = headings[i + 1]?.line ?? scan.lines.length;
      const content = scan.visible.slice(heading.line + 1, end).join('\n');
      const parsed = header(content), info = { id, doc: d, fields: parsed.fields };
      for (const key of parsed.duplicates) error(`${d.path}: ${id} duplicate record field ${key}`);
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
  for (const d of docs.filter(d => d.fields.Status !== 'superseded')) for (const id of list(d.fields['Depends on'])) {
    const target = byId.get(id) ?? definitions.get(id)?.doc;
    if (!target || target.fields.Status === 'superseded') error(`${d.path}: Depends on missing/current identity: ${id}`);
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
  // Evidence is a claim about BOTH a specification revision/content and code baseline.
  // Legacy records remain readable, but cannot satisfy strict release or review gates.
  for (const e of evidence) {
    const h = e.fields, kind = h.Kind ?? 'verification';
    if (!['verification', 'design-review'].includes(kind)) error(`${e.doc.path}: ${e.id} invalid evidence Kind`);
    if (kind === 'design-review') {
      if (['passed', 'failed'].includes(h.Result) && !meaningful(h.Reviewer)) error(`${e.doc.path}: ${e.id} design-review requires Reviewer (self/independent must be honest)`);
      if ((['passed', 'failed'].includes(h.Result) || meaningful(h['Open blockers'])) && !/^(?:0|[1-9]\d*)$/.test(h['Open blockers'] ?? '')) error(`${e.doc.path}: ${e.id} requires integer Open blockers`);
      if (h.Result === 'passed' && h['Open blockers'] !== '0') error(`${e.doc.path}: ${e.id} review cannot pass with open blockers`);
    }
    if (['passed', 'failed'].includes(h.Result) && meaningful(h['Spec-Refs']) && (!meaningful(h.Method) || !meaningful(h.Detail)))
      error(`${e.doc.path}: ${e.id} completed bound records require non-placeholder Method and Detail`);
    if (kind === 'verification' && h.Result === 'passed' && meaningful(h['Spec-Refs']) && !meaningful(h.Environment))
      error(`${e.doc.path}: ${e.id} bound passed verification requires Environment`);
    try {
      const refs = parseSpecRefs(h['Spec-Refs']);
      for (const ref of refs) {
        const target = byId.get(ref.id);
        if (!target || target.fields.Status === 'superseded') error(`${e.doc.path}: ${e.id} Spec-Refs target missing/historical: ${ref.id}`);
        else if (bindingState(e, target) !== 'current') warn(`${e.doc.path}: ${e.id} stale Spec-Refs for ${ref.id}; re-read/review or rerun, do not just refresh the hash`);
      }
      const targets = [...new Set(list(h.Covers).map(id => byId.get(id) ?? definitions.get(id)?.doc).filter(Boolean))];
      for (const target of targets) {
        const status = bindingState(e, target);
        if (status === 'current') bindingCounts.current++; else if (status === 'unbound') bindingCounts.unbound++; else bindingCounts.stale++;
        if (h.Result === 'passed' && status !== 'current') {
          warn(`${e.doc.path}: ${e.id} ${status} specification evidence for ${target.fields['Doc-ID']}; not verified against the current contract`);
        }
      }
    } catch (ex) { error(`${e.doc.path}: ${e.id}: ${ex.message}`); }
  }
  const requirementsFor = d => {
    const items = [...definitions.values()].filter(x => x.doc.path === d.path && /^[RC]-/.test(x.id)).map(x => x.id);
    return items.length ? items : [d.fields['Doc-ID']];
  };
  const isBound = (e, d) => { try { return bindingState(e, d) === 'current'; } catch { return false; } };
  const checkBoundVerification = d => {
    for (const id of requirementsFor(d)) {
      const matches = evidence.filter(e => (e.fields.Kind ?? 'verification') === 'verification' && list(e.fields.Covers).includes(id)
        && e.fields.Baseline === d.fields.Baseline && isBound(e, d));
      if (!matches.some(e => e.fields.Result === 'passed' && meaningful(e.fields.Environment)))
        error(`${d.path}: current specification revision/content lacks bound passed evidence for ${id} (Spec-Refs + Environment required)`);
      if (matches.some(e => e.fields.Result === 'failed')) error(`${d.path}: bound evidence fails ${id}`);
    }
  };
  for (const d of docs.filter(d => d.fields.Verification === 'passed' && d.fields.Status !== 'superseded')) {
    if (d.fields.Baseline === 'unknown') error(`${d.path}: Verification passed needs a known Baseline`);
    const requirements = [...definitions.values()].filter(x => x.doc.path === d.path && /^[RC]-/.test(x.id)).map(x => x.id);
    if (!requirements.length && ['feature', 'module', 'requirements'].includes(d.fields.Type))
      error(`${d.path}: passed feature/module/requirements needs at least one numbered requirement or constraint`);
    const needed = requirements.length ? requirements : [d.fields['Doc-ID']];
    for (const id of needed) {
      const relevant = evidence.filter(e => (e.fields.Kind ?? 'verification') === 'verification' && e.doc.fields.Status !== 'superseded' && list(e.fields.Covers).includes(id) && e.fields.Baseline === d.fields.Baseline
        && (!meaningful(e.fields['Spec-Refs']) || isBound(e, d)));
      if (!relevant.some(e => e.fields.Result === 'passed')) error(`${d.path}: passed lacks matching-baseline passed evidence for ${id}`);
      if (relevant.some(e => e.fields.Result === 'failed')) error(`${d.path}: current evidence fails ${id}, cannot claim Verification passed`);
    }
  }
  for (const d of docs.filter(d => d.fields.Verification === 'passed' && d.fields.Status !== 'superseded' && (d.fields['Evidence-Format'] === EVIDENCE_FORMAT || evidence.some(e => meaningful(e.fields['Spec-Refs']) && list(e.fields.Covers).some(id => requirementsFor(d).includes(id)))))) checkBoundVerification(d);
  stats.evidenceBindings = bindingCounts;
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

  const changedDesignPaths = new Set(), affectedDesignPaths = new Set();
  if (options.base) {
    if (inv.git.enumeration !== 'git') throw new Error('--base requires Git and the actual worktree root.');
    const ref = resolveBase(root, options.base), changed = changedPaths(root, ref), affected = new Set();
    const prior = docsAtBase(root, config, ref);
    const priorById = new Map(prior.map(d => [d.fields['Doc-ID'], d]));
    for (const d of docs.filter(d => d.fields.Status !== 'superseded' && !['adoption', 'verification'].includes(d.fields.Type))) {
      const before = priorById.get(d.fields['Doc-ID']);
      if(before?.fields['Verification-Format']==='runner-v1' && d.fields['Verification-Format']!=='runner-v1') error(`${d.path}: cannot silently remove the runner verification profile; preserve it or perform an explicitly reviewed workflow change.`);
      if (before && contractHash(before) !== contractHash(d) && Number(d.fields.Revision) <= Number(before.fields.Revision)) {
        const strict = options.release || d.fields['Evidence-Format'] === EVIDENCE_FORMAT;
        (strict ? error : warn)(`${d.path}: contract content changed without increasing Revision; review/approval/evidence cannot silently carry over`);
      }
    }
    for (const d of docs.filter(d => ['feature', 'module'].includes(d.fields.Type) && d.fields.Status !== 'superseded')) {
      const before = priorById.get(d.fields['Doc-ID']);
      if (!before || before.fields.Type !== d.fields.Type || before.fields['Design-Format'] !== d.fields['Design-Format']
        || designFingerprint(before.text) !== designFingerprint(d.text)) changedDesignPaths.add(d.path);
    }
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
    for (const p of affected) affectedDesignPaths.add(p);
    stats.changedCode = changedCode.length; stats.affectedDocuments = [...affected];
    if (options.release) {
      const cleanSource = inv.git.head && !changedPaths(root, inv.git.head).some(p => candidatePath(p, config));
      for (const p of affected) {
        const d = byPath.get(p), h = d.fields;
        if (h.Status !== 'accepted') error(`${p}: release requires accepted, found ${h.Status}`);
        if (h.Implementation !== 'complete') error(`${p}: release requires Implementation complete`);
        if (h.Verification !== 'passed') error(`${p}: release requires Verification passed`);
        checkBoundVerification(d);
        const currentBaseline = h.Baseline === `snapshot:${inv.snapshot}` || (cleanSource && h.Baseline?.startsWith('git:') && inv.git.head?.startsWith(h.Baseline.slice(4)));
        if (!currentBaseline) error(`${p}: release Baseline does not match the current code snapshot/clean Git HEAD`);
      }
    }
  }
  // Human-facing design structure is independently reported from installation and
  // metadata validity. Preserve old prose; never auto-rewrite or mark approval here.
  const designStats = { current: 0, profiled: 0, legacy: 0, strict: 0, incomplete: 0, changedDesigns: [...changedDesignPaths] };
  const resolveDiagram = (from, link) => {
    if (!link || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(link) || link.includes('?')) throw new Error('use a local current managed-document path');
    const absolute = resolveLink(root, from.path, link);
    return byPath.get(path.relative(root, absolute).split(path.sep).join('/'));
  };
  for (const d of docs.filter(d => ['feature', 'module'].includes(d.fields.Type) && d.fields.Status !== 'superseded')) {
    designStats.current++;
    const declared = d.fields['Design-Format'];
    if (declared) designStats.profiled++; else designStats.legacy++;
    const forced = Boolean(options.design && (!options.base || affectedDesignPaths.has(d.path) || changedDesignPaths.has(d.path)));
    const strict = forced || (d.fields.Status === 'accepted' && (Boolean(declared) || changedDesignPaths.has(d.path)));
    if (strict) designStats.strict++;
    const issues = validateDesign(d, { resolveReference: resolveDiagram });
    if (declared && declared !== DESIGN_FORMAT) error(`[design] ${d.path}: unsupported Design-Format ${declared}`);
    if (changedDesignPaths.has(d.path) && !declared) issues.unshift({ code: 'format', message: 'new/substantively changed feature/module must declare Design-Format: layered-v1; migrate only this scope' });
    if (issues.length) designStats.incomplete++;
    if (!declared && !forced && !changedDesignPaths.has(d.path)) {
      if (issues.length) warn(`[design:legacy] ${d.path}: three-layer design not complete (${issues.map(x => x.code).filter((x, i, a) => a.indexOf(x) === i).join(', ')}); preserved, use --design for details; not a semantic pass`);
    } else for (const issue of issues) (strict ? error : warn)(`[design] ${d.path}: ${issue.message}`);
  }
  stats.design = { ...designStats, status: !designStats.current ? 'not-assessed' : designStats.incomplete ? 'incomplete' : 'structure-passed', semantic: 'not-assessed' };

  // Explicit pre-implementation review gate; a design review is NOT a behavior test.
  stats.review = { status: 'not-assessed', checked: 0, semantic: 'not-assessed' };
  if (options.review) {
    const scope = docs.filter(d => d.fields.Status !== 'superseded' && ['feature', 'module', 'architecture', 'requirements', 'change'].includes(d.fields.Type)
      && (!options.base || affectedDesignPaths.has(d.path) || changedDesignPaths.has(d.path)));
    const cleanCode = inv.git.head && !changedPaths(root, inv.git.head).some(p => candidatePath(p, config));
    const currentCode = value => value === `snapshot:${inv.snapshot}` || (cleanCode && value?.startsWith('git:') && inv.git.head.startsWith(value.slice(4)));
    let failures = 0;
    for (const d of scope) {
      const reviews = evidence.filter(e => e.fields.Kind === 'design-review' && isBound(e, d) && currentCode(e.fields.Baseline)
        && list(e.fields.Covers).includes(d.fields['Doc-ID']));
      if (!reviews.some(e => e.fields.Result === 'passed' && e.fields['Open blockers'] === '0' && meaningful(e.fields.Reviewer))
        || reviews.some(e => e.fields.Result === 'failed' || Number(e.fields['Open blockers']) > 0)) {
        error(`${d.path}: --review requires a current spec/code-bound design-review with no unresolved blockers`); failures++;
      }
    }
    stats.review = { status: failures ? 'incomplete' : scope.length ? 'record-structure-passed' : 'not-assessed', checked: scope.length, semantic: 'not-assessed' };
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
  // Runner execution proof is separate from manually supplied evidence metadata.
  const runCache=new Map();
  const readRun=(rel,hash,plan)=>{
    const key=JSON.stringify([rel,hash,plan]);
    if(!runCache.has(key))runCache.set(key,checkRun(root,config,rel,{hash,plan}));
    return runCache.get(key);
  };
  let supplied=null;
  if(options['verification-report']) {
    supplied=readRun(options['verification-report']);
    errors.push(...supplied.errors.map(e=>`[runner] ${e}`));
  }
  const currentSnapshot=`snapshot:${inv.snapshot}`;
  for(const e of evidence.filter(e=>e.fields['Runner-Receipt'] && e.fields.Result==='passed')) {
    const m=e.fields['Runner-Receipt'].match(/^(.+\/run\.json)#([a-f0-9]{64})$/);
    if(!m){error(`${e.doc.path}: invalid Runner-Receipt`);continue;}
    const v=readRun(m[1],m[2]),x=v.report?.results.find(c=>c.id===e.fields['Runner-Check']);
    const issues=[...v.errors];
    if(!x || x.kind!=='test' || x.status!=='passed' || !(x.level===e.fields.Level || x.alsoLevels?.includes(e.fields.Level)) || !list(e.fields.Covers).every(id=>x.covers.includes(id)))issues.push('Evidence fields do not match the recorded runner check.');
    if(v.report && e.fields.Baseline!==v.report.initial.codeBaseline)issues.push('Evidence baseline differs from runner receipt.');
    for(const issue of issues)(e.fields.Baseline===currentSnapshot?error:warn)(`${e.doc.path}: ${e.id}: ${issue}`);
  }
  let runnerRequired=0;
  for(const d of docs.filter(d=>d.fields.Status!=='superseded' && d.fields['Verification-Format'])) {
    if(d.fields['Verification-Format']!=='runner-v1'){error(`${d.path}: unsupported Verification-Format`);continue;}
    const selected=!options.base || affectedDesignPaths.has(d.path);
    if(!selected || !options.release)continue;
    runnerRequired++;
    const plan=d.fields['Verification-Plan'];
    if(!meaningful(plan) || plan==='pending'){error(`${d.path}: runner-v1 requires an actual Verification-Plan before delivery.`);continue;}
    const candidates=[];
    if(supplied && supplied.report?.plan===plan)candidates.push(supplied);
    for(const e of evidence.filter(e=>e.fields['Runner-Receipt'] && e.fields.Result==='passed' && list(e.fields.Covers).some(id=>requirementsFor(d).includes(id)))){
      const m=e.fields['Runner-Receipt'].match(/^(.+\/run\.json)#([a-f0-9]{64})$/);if(m)candidates.push(readRun(m[1],m[2],plan));
    }
    for(const id of requirementsFor(d))if(!candidates.some(v=>receiptCovers(v,[id],['acceptance'])))error(`${d.path}: no current runner acceptance receipt for ${id}; hand-written passed cannot complete runner-v1.`);
  }
  stats.execution={status:supplied?supplied.status:runnerRequired?'runner-receipts-required':'not-assessed',profiledScope:runnerRequired,semantic:'not-assessed',authenticity:'local-unsigned'};
  if (options.delivery) {
    const result = checkDelivery(root, config, options.delivery, { complete: Boolean(options.release) });
    errors.push(...result.errors); warnings.push(...result.warnings); stats.delivery = result;
  } else stats.delivery = { status: 'not-assessed', notice: 'No delivery packet selected; doc checks alone do not prove a runtime path works.' };
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], stats,
    limitations: 'Structural checks only: approval authenticity, code semantics, actual reading/test execution, diagram semantics/coverage, discussion quality, symbols, Markdown anchors and external links are not verified.' };
}

function main() {
  const args = parseCLI(process.argv.slice(2), { '--json': 'flag', '--base': 'value', '--release': 'flag', '--progress': 'value', '--full': 'flag', '--design': 'flag', '--review': 'flag', '--delivery': 'value', '--verification-report': 'value' });
  if (args.flags.help) {
    console.log('Usage: node check-doc-set.mjs [repo] [--json] [--design] [--review] [--verification-report .doc-driven/verification/runs/ID/run.json] [--delivery docs/changes/task.md] [--base REF [--release]] [--progress docs/adoption/progress.json [--full]]\n--design: strictly check current feature/module design bodies; with --base only the affected scope. Draft gaps remain reportable, not auto-fixed.\n--review: require version-bound design-review records for the selected scope; never invokes a reviewer or proves review quality.\n--release also requires spec-revision/content-bound execution evidence; legacy unbound claims cannot pass.\nExit 0: structural checks pass (warnings may remain); 1: validation failures; 2: invocation/configuration error.');
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
