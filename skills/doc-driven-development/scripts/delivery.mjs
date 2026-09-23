#!/usr/bin/env node
// Optional, read-only delivery-packet checker. Never runs tests, authorizes a task,
// launches workers, upgrades docs, or equates records with independently observed facts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCLI, runCLI, rootDir, loadConfig, documents, inventory, safePath, header, list, globRE, MAX_TEXT_BYTES } from './lib.mjs';
import { checkRun, receiptCovers } from './verification.mjs';
import { itemHeadings } from './identity.mjs';
import { meaningful, specRef, parseSpecRefs, bindingStatus } from './contract.mjs';

const STATES = new Set(['queued', 'implementing', 'integrating', 'verifying', 'done', 'blocked']);
const LEVELS = new Set(['component', 'integration', 'acceptance', 'regression']);
const strings = x => Array.isArray(x) && x.every(v => typeof v === 'string' && v.trim());
function regular(root, rel) {
  const file = safePath(root, rel), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error(`Expected a regular file no larger than 2 MiB: ${rel}`);
  return file;
}
export function readPacket(root, config, rel) {
  if (!rel.endsWith('.md') || !config.docsRoots.some(d => rel.startsWith(`${d}/`)))
    throw new Error('Delivery packet must live in an existing change Markdown under docsRoots, not an arbitrary JSON/config file.');
  const parsed = itemHeadings(fs.readFileSync(regular(root, rel), 'utf8'));
  const marks = parsed.scan.markers.filter(m => m.type === 'delivery');
  if (marks.length !== 1 || marks[0].value) throw new Error('Expected exactly one standalone <!-- ddd:delivery --> marker.');
  let line = marks[0].line + 1; while (!parsed.scan.lines[line]?.trim() && line < parsed.scan.lines.length) line++;
  const fence = parsed.scan.fences.find(f => f.start === line && f.closed && f.info === 'json');
  if (!fence) throw new Error('ddd:delivery must immediately precede one closed json code block.');
  const packet = JSON.parse(fence.body);
  if (!packet || packet.kind !== 'ddd-delivery-v1' || packet.schemaVersion !== 1)
    throw new Error('Expected kind ddd-delivery-v1, schemaVersion 1.');
  return packet;
}
export function checkDelivery(root, config, rel, { complete = false } = {}) {
  if (!config.enabled) throw new Error('Workflow disabled; a skipped check is not a completed delivery.');
  const p = readPacket(root, config, rel), errors = [], warnings = [];
  const fail = s => errors.push(s), warn = s => warnings.push(s);
  const { docs } = documents(root, config), current = docs.filter(d => d.fields.Status !== 'superseded');
  const byId = new Map(), items = new Map(), evidence = new Map();
  for (const d of current) {
    if (byId.has(d.fields['Doc-ID'])) fail(`Duplicate Doc-ID ${d.fields['Doc-ID']}`);
    byId.set(d.fields['Doc-ID'], d);
    const parsed = itemHeadings(d.text);
    errors.push(...parsed.errors.map(x => `${d.path}: ${x}`));
    for (let i = 0; i < parsed.headings.length; i++) {
      const h = parsed.headings[i]; if (!h.id) continue;
      if (items.has(h.id)) fail(`Duplicate item ${h.id}`);
      const record = header(parsed.scan.visible.slice(h.line + 1, parsed.headings[i + 1]?.line ?? parsed.scan.lines.length).join('\n'));
      items.set(h.id, { doc: d, title: h.label });
      if (h.id.startsWith('E-')) {
        if (record.duplicates.length) fail(`${h.id}: duplicate evidence fields`);
        evidence.set(h.id, { doc: d, fields: record.fields });
      }
    }
  }
  if (!meaningful(p.title)) fail('Packet needs a human-readable title.');
  const a = p.authorization;
  if (!a || !['implement', 'design-only', 'hold'].includes(a.mode)) fail('authorization.mode must be implement, design-only or hold; never inferred from a passed test.');
  if (!meaningful(a?.source)) fail('Record the actual original request/decision source, not a fresh request for the same approval.');
  if (!strings(a?.specRefs) || !a.specRefs.length) fail('authorization.specRefs must bind the actual approved specification scope.');
  const runnerMode = p.verification?.mode === 'runner-v1';
  if(p.verification && !runnerMode) fail('Unknown delivery verification mode.');
  const runCache=new Map();
  const targets = [], targetIds = new Set();
  if (strings(a?.specRefs)) for (const raw of a.specRefs) {
    try {
      const refs = parseSpecRefs(raw); if (refs.length !== 1) throw new Error('one specRef per array element');
      const ref = refs[0], d = byId.get(ref.id);
      if (targetIds.has(ref.id)) fail(`Duplicate bound document ${ref.id}`); targetIds.add(ref.id);
      if (!d || d.path === rel) { fail(`${ref.id}: missing/current target or self-binding packet; keep packet in a separate existing change note.`); continue; }
      targets.push(d);
      if (specRef(d) !== raw) fail(`${d.path}: authorized specification changed; compare scope, do not merely refresh authorization hash.`);
    } catch (e) { fail(`Invalid authorization specRef: ${e.message}`); }
  }
  if (targets.some(d => d.fields['Verification-Format'] === 'runner-v1') && !runnerMode)
    fail('Bound runner-v1 specifications require runner-v1 delivery; legacy evidence cannot silently downgrade execution checks.');
  // Whole selected documents by default; selected-item work requires a recorded scope source.
  let required = [...items.entries()].filter(([id, v]) => /^[RC]-/.test(id) && targetIds.has(v.doc.fields['Doc-ID'])).map(([id]) => id);
  if (!required.length) fail('The bound delivery scope needs real requirement/constraint definitions.');
  if (p.selectedItems !== undefined) {
    if (!strings(p.selectedItems) || !p.selectedItems.length || !meaningful(p.scopeSource)) fail('selectedItems requires explicit, nonempty scope plus actual scopeSource.');
    else { for (const id of p.selectedItems) if (!required.includes(id)) fail(`Selected item is outside bound requirements: ${id}`); required = p.selectedItems; }
  }
  const deferred = p.deferred ?? [];
  if (!Array.isArray(deferred)) fail('deferred must be an array of explicitly approved exclusions.');
  const excluded = new Set();
  if (Array.isArray(deferred)) for (const d of deferred) {
    if (!d || !required.includes(d.item) || excluded.has(d.item) || !meaningful(d.reason) || !meaningful(d.source)) fail('A deferred item needs a unique in-scope item, reason and actual approval source.');
    else excluded.add(d.item);
  }
  const units = p.units;
  if (!Array.isArray(units) || !units.length) fail('Packet needs at least one end-to-end delivery unit, not just metadata work.');
  const inv = inventory(root, config), baseline = `snapshot:${inv.snapshot}`, assigned = new Set(), names = new Set(), results = [];
  for (const u of Array.isArray(units) ? units : []) {
    if (!u || typeof u !== 'object') { fail('Invalid delivery unit.'); continue; }
    const name = u.name ?? '(unnamed)';
    if (!meaningful(u.name) || names.has(u.name)) fail('Each unit needs a unique human name such as 领域 / 模块 / 行为.'); names.add(u.name);
    if (!STATES.has(u.state)) fail(`${name}: unknown state.`);
    if (!strings(u.covers) || !u.covers.length) fail(`${name}: covers must contain actual scoped requirements.`);
    for (const id of strings(u.covers) ? u.covers : []) {
      if (!required.includes(id) || excluded.has(id)) fail(`${name}: unapproved/out-of-scope requirement ${id}`);
      assigned.add(id);
    }
    if (!strings(u.writePaths) || !u.writePaths.length) fail(`${name}: record bounded writePaths, not blanket repository authority.`);
    else for (const g of u.writePaths) { try { globRE(g); } catch (e) { fail(`${name}: ${e.message}`); } }
    if (!meaningful(u.outcome)) fail(`${name}: describe the observable outcome, not functions created.`);
    if (!strings(u.requiredLevels) || !u.requiredLevels.includes('acceptance') || u.requiredLevels.some(l => !LEVELS.has(l))) fail(`${name}: requiredLevels needs acceptance and only known levels.`);
    if (!['required', 'not-applicable'].includes(u.integration)) fail(`${name}: integration must be required or justified not-applicable.`);
    if (u.integration === 'required') {
      if (!meaningful(u.runtimePath) || !strings(u.entryPoints) || !u.entryPoints.length || !(strings(u.requiredLevels) && u.requiredLevels.includes('integration'))) fail(`${name}: required integration needs entryPoints, runtimePath and integration verification.`);
    } else if (u.integration === 'not-applicable' && !meaningful(u.integrationReason)) fail(`${name}: explain why no assembly/caller integration is needed.`);
    if (u.state === 'blocked') {
      if (!u.blocker || !['decision', 'environment', 'dependency', 'permission'].includes(u.blocker.kind) || !meaningful(u.blocker.reason) || !meaningful(u.blocker.nextAction)) fail(`${name}: blocker requires kind, concrete reason and nextAction.`);
    }
    if (a?.mode !== 'implement' && ['implementing','integrating','verifying','done'].includes(u.state)) fail(`${name}: work advanced without recorded implementation authorization.`);
    if (complete && u.state !== 'done') fail(`${name}: not done (${u.state}); do not ask whether to implement already-authorized unfinished work.`);
    const checkDone = u.state === 'done';
    if (checkDone) {
      if ((!runnerMode || u.codeBaseline !== undefined) && u.codeBaseline !== baseline) fail(`${name}: completion baseline is stale; check actual integration/worktree, not only worker branch.`);
      for (const entry of strings(u.entryPoints) ? u.entryPoints : []) { try { regular(root, entry); } catch (e) { fail(`${name}: missing runtime entry ${entry}: ${e.message}`); } }
      if (!runnerMode && (!strings(u.evidence) || !u.evidence.length)) fail(`${name}: done requires actual evidence references.`);
      if (u.evidence !== undefined && !strings(u.evidence)) fail(`${name}: evidence, when provided, must be an array of record references.`);
      const valid = [];
      if (runnerMode) {
        const vr=p.verification;
        if (!meaningful(vr.plan) || !strings(u.runs) || !u.runs.length) fail(`${name}: runner-v1 completion needs the plan and captured run references.`);
        const checks=[];
        for (const ref of strings(u.runs) ? u.runs : []) {
          const m=ref.match(/^(.+\/run\.json)#([a-f0-9]{64})$/);
          if(!m){fail(`${name}: invalid pinned runner receipt.`);continue;}
          if(!runCache.has(ref))runCache.set(ref,checkRun(root,config,m[1],{plan:vr.plan,hash:m[2]}));
          const v=runCache.get(ref);checks.push(v);for(const e of v.errors)fail(`${name}: runner: ${e}`);
        }
        for(const id of strings(u.covers)?u.covers:[]) for(const level of strings(u.requiredLevels)?u.requiredLevels:[])
          if(!checks.some(v=>receiptCovers(v,[id],[level])))fail(`${name}: no current runner-observed ${level} case for ${id}`);
      }
      for (const eid of strings(u.evidence) ? u.evidence : []) {
        const e = evidence.get(eid), h = e?.fields;
        if (!e) { fail(`${name}: missing evidence ${eid}`); continue; }
        if ((h.Kind ?? 'verification') !== 'verification') { fail(`${name}: design review cannot substitute runtime verification (${eid}).`); continue; }
        if (h.Result !== 'passed' || h.Baseline !== baseline) { fail(`${name}: ${eid} is not passed on the current code baseline.`); continue; }
        if (!LEVELS.has(h.Level)) fail(`${name}: ${eid} needs a verification Level.`);
        if (!/^[1-9]\d*$/.test(h.Executed ?? '') || h.Skipped !== '0') fail(`${name}: ${eid} has no executed required cases or contains skipped required cases; exit 0 is insufficient.`);
        if (h.Failed !== '0') fail(`${name}: ${eid} needs an explicit zero failed required cases; a passed label cannot override failures.`);
        if (![h.Environment, h.Method, h.Detail].every(meaningful)) fail(`${name}: ${eid} needs actual environment, method and outcomes.`);
        try {
          if (!meaningful(h.Artifact) || fs.statSync(regular(root, h.Artifact)).size === 0) throw new Error('missing/empty artifact');
        } catch (err) { fail(`${name}: ${eid} needs a nonempty, local inspectable artifact (${err.message}).`); }
        for (const id of list(h.Covers).filter(id => (strings(u.covers) && u.covers.includes(id)))) {
          const d = items.get(id)?.doc;
          try { if (!d || bindingStatus(e, d) !== 'current') fail(`${name}: ${eid} is bound to an old/different specification.`); }
          catch (err) { fail(`${name}: ${eid}: ${err.message}`); }
        }
        valid.push(e);
      }
      for (const id of strings(u.covers) ? u.covers : []) for (const level of strings(u.requiredLevels) ? u.requiredLevels : []) {
        if (!runnerMode && !valid.some(e => e.fields.Level === level && list(e.fields.Covers).includes(id))) fail(`${name}: ${items.get(id)?.title ?? id} lacks required ${level} coverage.`);
      }
    }
    results.push({ name, outcome: u.outcome, state: u.state, nextAction: u.state === 'blocked' ? u.blocker?.nextAction : u.state === 'done' ? 'report-verified-scope' : a?.mode === 'implement' ? 'continue-without-reconfirmation' : 'respect-current-authorization' });
  }
  for (const id of required) if (!excluded.has(id) && !assigned.has(id)) fail(`Approved requirement has no delivery unit: ${items.get(id)?.title ?? id} (${id}).`);
  if (complete && a?.mode !== 'implement') fail('A design-only/hold packet cannot claim implementation completion.');
  const allDone = results.length > 0 && results.every(u => u.state === 'done');
  if (excluded.size) warn('Completion excludes explicitly deferred scope; user report must state those omissions.');
  const status = errors.length ? 'needs-attention' : allDone ? (excluded.size ? 'done-with-approved-exclusions' : 'done-records-checked') : a?.mode !== 'implement' ? 'not-authorized-for-implementation' : results.some(u => u.state !== 'done' && u.state !== 'blocked') ? 'continue-authorized-work' : 'blocked';
  return { kind:'ddd-delivery-report-v1', title:p.title, status, units:results, errors, warnings, codeBaseline:baseline,
    execution:runnerMode?'runner-receipts-checked':'records-only; actual execution not assessed', authenticity:'not-assessed', semantic:'not-assessed', limitations:'Record/coverage/file/version checks only. Cannot prove human approval, test execution, true production reachability or semantic completeness. Review the actual diff and artifacts. No agents or commands were launched.' };
}
function main() {
  const args = parseCLI(process.argv.slice(2), {'--packet':'value','--complete':'flag','--json':'flag'});
  if (args.flags.help) { console.log('Usage: node delivery.mjs [repo] --packet docs/changes/task.md [--complete] [--json]\nRead-only coverage/version/evidence checker. Never executes project code or supplies approval.'); return; }
  if (!args.flags.packet) throw new Error('--packet is required.');
  const root = rootDir(args.root), report = checkDelivery(root, loadConfig(root), args.flags.packet, {complete:args.flags.complete});
  if (args.flags.json) console.log(JSON.stringify(report,null,2));
  else {
    const states = {queued:'待执行', implementing:'开发中', integrating:'正在接通', verifying:'验证中', done:'完成记录已核对', blocked:'受阻'};
    const statuses = {'needs-attention':'检查发现缺口', 'done-records-checked':'完成记录检查通过（不代表语义已证明）', 'done-with-approved-exclusions':'批准范围内完成，仍有已批准延期', 'continue-authorized-work':'已有授权，继续未完成工作', 'not-authorized-for-implementation':'仅设计或暂停，不实施', blocked:'存在具体阻塞'};
    const actions = {'continue-without-reconfirmation':'继续执行，不重复请求同一批准', 'report-verified-scope':'说明已验证范围与限制', 'respect-current-authorization':'遵守当前只设计/暂停范围'};
    console.log(`${report.title}：${statuses[report.status] ?? report.status}`);
    for (const u of report.units) console.log(`- ${u.name}：${states[u.state] ?? u.state}；${actions[u.nextAction] ?? u.nextAction}`);
    for (const e of report.errors) console.error(`FAIL ${e}`);
    for (const w of report.warnings) console.log(`WARN ${w}`);
    console.log('仅检查记录、覆盖、路径和版本；没有代替执行测试、认证批准或证明实际运行链路。');
  }
  if (report.errors.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCLI(main);
