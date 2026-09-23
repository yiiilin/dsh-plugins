// Synthetic fixtures validate structure and safe integration, not any model's behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, updateIndex, git, header } from '../scripts/lib.mjs';
import { DESIGN_FORMAT, scanDesign, validateDesign, designFingerprint } from '../scripts/design-check.mjs';
import { checkRepo } from '../scripts/check-doc-set.mjs';
import { PACKAGE_ROOT as PKG, DEFAULT_SKILL, ruleBlock, probeText, readPackage, planInstall, applyPlan, doctor } from '../scripts/project-install.mjs';

const FILE = 'docs/domains/sample/features/main.md';
const graph = kind => `<!-- ddd:diagram ${kind} -->\n\`\`\`text\n[Input] --valid data--> [Transform] --result--> [Output]\n\`\`\`\n`;
function body(id = 'FEAT-MAIN') {
  return `## 摘要\nThis is a synthetic pure transformation, not a real implementation.\n\n## 1. 需求说明\n<!-- ddd:section requirements -->\n\n### R-${id}-001 Output\nGiven valid input, return the transformed value without side effects.\n\n### 1.2 验收条件\nCheck a valid input and an invalid input against the documented result.\n\n## 2. 概要设计\n<!-- ddd:section overview -->\n\nA boundary validator calls a pure transformation.\n\n### 2.1 Flow\n${graph('flow')}\n### 2.2 Data\n${graph('data')}\n## 3. 详细设计\n<!-- ddd:section detail -->\n\nThe operation validates first and does not write persistent storage.\n\n### 3.1 State\n<!-- ddd:diagram state not-applicable: This pure function keeps no persistent or cross-call state. -->\n\n### 3.2 Mechanism\nReject invalid inputs before transformation, returning a documented error.\n\n## 4. 实现与验证\nNo implementation or execution evidence is claimed.\n`;
}
function doc(extra = {}, content, id = 'FEAT-MAIN', file = FILE) {
  const fields = { 'Doc-ID': id, Type: 'feature', Revision: '1', Status: 'proposed', Baseline: 'unknown', Owns: '—', Implementation: 'missing', Verification: 'not-run', 'Design-Format': DESIGN_FORMAT, ...extra };
  const text = '# Fixture\n\n' + Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + (content ?? body(id));
  return { path: file, fields: header(text).fields, text };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-design-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  const config = structuredClone(DEFAULTS);
  put('.doc-driven.json', JSON.stringify(config));
  put('src/main.mjs', 'export const identity = x => x;\n');
  const save = d => { put(d.path, d.text); updateIndex(root, config); return d; };
  const check = opts => checkRepo(root, config, opts);
  updateIndex(root, config);
  return { root, config, put, save, check, read: rel => fs.readFileSync(path.join(root, rel), 'utf8') };
}
const accepted = { Status: 'accepted', Approval: 'Synthetic fixture approval; not a real decision.', 'Approved revision': '1' };
const ok = r => assert.deepEqual(r.errors, [], JSON.stringify(r));
const hasIssue = (issues, match) => assert.ok(issues.some(x => x.message.includes(match)), JSON.stringify(issues));
const hasError = (r, match) => assert.ok(r.errors.some(x => x.includes(match)), JSON.stringify(r));
function base(f) { git(f.root, ['init', '-q']); git(f.root, ['config', 'user.name', 'Fixture']); git(f.root, ['config', 'user.email', 'fixture@example.invalid']); git(f.root, ['config', 'commit.gpgsign', 'false']); git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'baseline']); return git(f.root, ['rev-parse', 'HEAD']).trim(); }
const cli = (f, ...args) => spawnSync(process.execPath, [path.join(PKG, 'scripts/check-doc-set.mjs'), f.root, ...args], { encoding: 'utf8', timeout: 20000 });

test('complete three-layer pure-function design passes with truthful state inapplicability', () => assert.deepEqual(validateDesign(doc()), []));
test('English headings are supported without mandatory Chinese names or section markers', () => {
  const b = body().replace('1. 需求说明', '1. Requirements').replace('2. 概要设计', '2. High-level design').replace('3. 详细设计', '3. Detailed design').replace('1.2 验收条件', '1.2 Acceptance').replace(/^<!-- ddd:section .* -->\n/gm, '');
  assert.deepEqual(validateDesign(doc({}, b)), []);
});
test('localized titles use stable section and acceptance markers, preserving human text', () => {
  const b = body().replace('1. 需求说明', 'Objetivos').replace('2. 概要设计', 'Arquitetura').replace('3. 详细设计', 'Detalhes').replace('### 1.2 验收条件', '### Critérios\n<!-- ddd:acceptance -->');
  assert.deepEqual(validateDesign(doc({}, b)), []);
});
for (const key of ['requirements', 'overview', 'detail']) test(`missing ${key} H2 is diagnosed`, () => {
  const titles = { requirements: '1. 需求说明', overview: '2. 概要设计', detail: '3. 详细设计' };
  const b = body().replace(`## ${titles[key]}\n<!-- ddd:section ${key} -->`, '### removed layer');
  hasIssue(validateDesign(doc({}, b)), `${key} H2`);
});
test('duplicate layers and invalid order are not three-layer completion', () => {
  hasIssue(validateDesign(doc({}, body() + '\n## 需求说明\nSecond copy.\n')), 'found 2');
  const b = body().replace('ddd:section requirements', 'ddd:section detail').replace('ddd:section detail -->\n\nThe', 'ddd:section requirements -->\n\nThe');
  hasIssue(validateDesign(doc({}, b)), 'requirements -> overview -> detail');
});
test('floating marker in prose does not rename an unrelated heading', () => {
  const b = body().replace('## 2. 概要设计\n<!-- ddd:section overview -->', '## Misc\nSome actual prose before alias.\n<!-- ddd:section overview -->');
  hasIssue(validateDesign(doc({}, b)), 'unattached');
});
test('only headers and Notes reproduce the reported v0.2.2 gap and now produce design issues', () => {
  const issues = validateDesign(doc({}, '## Notes\nNo actual design.\n'));
  for (const layer of ['requirements', 'overview', 'detail']) hasIssue(issues, `${layer} H2`);
});
test('headings and diagrams quoted in examples do not satisfy the actual document', () => {
  hasIssue(validateDesign(doc({}, '````markdown\n' + body() + '\n````\n')), 'requirements H2');
});
test('ordinary HTML comments cannot fake the design body', () => {
  hasIssue(validateDesign(doc({}, '<!--\n## 需求说明\n## 概要设计\n## 详细设计\n-->\n## Notes\nOnly prose.\n')), 'requirements H2');
});
test('an empty requirements or acceptance section is not complete', () => {
  hasIssue(validateDesign(doc({}, body().replace('Given valid input, return the transformed value without side effects.', '').replace('Check a valid input and an invalid input against the documented result.', ''))), 'requirements needs explanatory');
  hasIssue(validateDesign(doc({}, body().replace('Check a valid input and an invalid input against the documented result.', ''))), 'acceptance cannot be an empty');
});
test('acceptance requires a named subheading or explicit semantic marker', () => {
  hasIssue(validateDesign(doc({}, body().replace('### 1.2 验收条件', '### Results'))), 'acceptance heading');
});
for (const kind of ['flow', 'data', 'state']) test(`missing ${kind} diagram or justified alternative is diagnosed`, () => {
  const b = body().replace(new RegExp(`^<!-- ddd:diagram ${kind}.*-->\\n`, 'm'), '');
  hasIssue(validateDesign(doc({}, b)), `${kind}: expected one`);
});
test('state diagram is business state in detailed design, not placed with overview', () => {
  const state = '<!-- ddd:diagram state not-applicable: This pure function keeps no persistent or cross-call state. -->';
  const b = body().replace(state, '').replace('### 2.2 Data', `${state}\n\n### 2.2 Data`);
  hasIssue(validateDesign(doc({}, b)), 'state: marker belongs in detail');
});
test('ASCII state transitions can replace the state inapplicability declaration', () => {
  const b = body().replace(/<!-- ddd:diagram state.*-->/, graph('state').trim());
  assert.deepEqual(validateDesign(doc({}, b)), []);
});
for (const reason of ['', '不适用', '无状态', 'N/A', 'TODO']) test(`generic or empty inapplicability is rejected: ${reason || 'empty'}`, () => {
  const b = body().replace(/state not-applicable: .* -->/, `state not-applicable: ${reason} -->`);
  assert.ok(validateDesign(doc({}, b)).length);
});
test('unknown is pending rather than a fabricated graph or false inapplicability', () => {
  hasIssue(validateDesign(doc({}, body().replace(/state not-applicable: .* -->/, 'state pending: Must read restart behavior before drawing. -->'))), 'pending');
});
test('Mermaid does not substitute for a readable ASCII primary diagram', () => {
  hasIssue(validateDesign(doc({}, body().replace('```text', '```mermaid'))), 'text/ascii');
});
test('tilde ASCII fences, CRLF and Unicode node labels are supported', () => {
  const b = body().replace(/```text/g, '~~~ascii').replace(/```/g, '~~~').replace(/\[Input\]/g, '[中文输入]').replace(/\n/g, '\r\n');
  assert.deepEqual(validateDesign(doc({}, b)), []);
});
test('unclosed fences cannot count as a diagram', () => {
  hasIssue(validateDesign(doc({}, body().replace('```text', '````text'))), 'closed text/ascii');
});
test('a prose gap between primary marker and fence is not silently attached', () => {
  hasIssue(validateDesign(doc({}, body().replace('ddd:diagram flow -->\n', 'ddd:diagram flow -->\nUnrelated content.\n'))), 'immediately precede');
});
test('a list of node names without directional connections is not a flow', () => {
  hasIssue(validateDesign(doc({}, body().replace(/--valid data-->|--result-->/g, ' '))), 'ASCII direction arrows');
});
test('Unicode arrows and decorative placeholder graphs are diagnosed', () => {
  hasIssue(validateDesign(doc({}, body().replace('--valid data-->', '→'))), 'ASCII connectors');
  hasIssue(validateDesign(doc({}, body().replace('[Input]', '[TODO]'))), 'placeholder');
});
test('vertical ASCII direction arrows are supported', () => {
  assert.deepEqual(validateDesign(doc({}, body().replace('[Input] --valid data--> [Transform] --result--> [Output]', '[输入]\n   |\n   v\n[输出]'))), []);
});
test('one main graph per kind prevents accidental duplicated sources', () => {
  hasIssue(validateDesign(doc({}, body().replace('### 2.2 Data', graph('flow') + '\n### 2.2 Data'))), 'flow: expected one diagram marker, found 2');
});
test('standalone template placeholders in otherwise substantial prose are diagnosed', () => {
  hasIssue(validateDesign(doc({}, body().replace('A boundary validator', 'TODO\n\nA boundary validator'))), 'standalone template placeholder');
});
test('unsupported format values fail even a draft, rather than silently downgrade', t => {
  const f = fixture(t); f.save(doc({ 'Design-Format': 'layered-v999' })); hasError(f.check(), 'unsupported Design-Format');
});
for (const status of ['observed', 'proposed']) test(`${status} gaps remain warnings during ordinary work, never automatic acceptance`, t => {
  const f = fixture(t); f.save(doc({ Status: status }, '## Notes\nUnfinished analysis.\n'));
  const r = f.check(); ok(r); assert.ok(r.warnings.some(s => s.startsWith('[design]'))); assert.equal(r.stats.design.status, 'incomplete');
  assert.match(f.read(FILE), new RegExp(`Status: ${status}`));
});
test('accepted profiled Notes-only document fails even ordinary checks', t => {
  const f = fixture(t); f.save(doc(accepted, '## Notes\nNo actual design.\n')); hasError(f.check(), 'requirements H2');
});
test('legacy Notes-only document is preserved with an explicit incomplete assessment', t => {
  const f = fixture(t); f.save(doc({ ...accepted, 'Design-Format': null }, '## Notes\nLegacy text must be preserved.\n'));
  const before = f.read(FILE), r = f.check(); ok(r); assert.ok(r.warnings.some(s => s.includes('[design:legacy]'))); assert.equal(r.stats.design.status, 'incomplete'); assert.equal(r.stats.design.semantic, 'not-assessed'); assert.equal(f.read(FILE), before);
});
test('explicit --design catches incomplete legacy and draft prose without rewriting', t => {
  const f = fixture(t); f.save(doc({ 'Design-Format': null }, '## Notes\nLegacy.\n')); const before = f.read(FILE);
  const r = cli(f, '--design', '--json'); assert.equal(r.status, 1, r.stderr); hasError(JSON.parse(r.stdout), 'requirements H2'); assert.equal(f.read(FILE), before);
});
test('no documents means not-assessed rather than a design pass', t => {
  const f = fixture(t); assert.equal(f.check().stats.design.status, 'not-assessed');
});
test('new accepted document without a format cannot evade --base design checks', t => {
  const f = fixture(t), ref = base(f); f.save(doc({ ...accepted, 'Design-Format': null })); hasError(f.check({ base: ref }), 'must declare Design-Format');
});
test('new well-structured proposed document can be recorded without blanket approval', t => {
  const f = fixture(t), ref = base(f); f.save(doc()); ok(f.check({ base: ref }));
});
test('substantively edited accepted legacy body enters scope; metadata-only updates do not', t => {
  const f = fixture(t); const d = doc({ ...accepted, 'Design-Format': null }, '## Notes\nOriginal contract.\n'); f.save(d); const ref = base(f);
  f.save(doc({ ...accepted, 'Design-Format': null, Baseline: `snapshot:${'a'.repeat(64)}` }, '## Notes\nOriginal contract.\n')); ok(f.check({ base: ref }));
  f.save(doc({ ...accepted, 'Design-Format': null }, '## Notes\nDifferent contract.\n')); hasError(f.check({ base: ref }), 'must declare Design-Format');
});
test('removing a declared profile is detected against the design baseline', t => {
  const f = fixture(t); f.save(doc(accepted)); const ref = base(f); f.save(doc({ ...accepted, 'Design-Format': null })); hasError(f.check({ base: ref }), 'must declare Design-Format');
});
test('evidence-only changes do not demand wholesale legacy redesign', () => {
  assert.equal(designFingerprint(body()), designFingerprint(body() + '\n### E-EXAMPLE-001 New evidence\nResult: not-run\n'));
});
test('code-only repair leaves old design warnings but explicit --design checks the affected owner', t => {
  const f = fixture(t); f.save(doc({ ...accepted, 'Design-Format': null, Owns: 'src/main.mjs' }, '## Notes\nOld contract.\n')); const ref = base(f);
  f.put('src/main.mjs', 'export const identity = x => x + 0;\n'); ok(f.check({ base: ref })); hasError(f.check({ base: ref, design: true }), 'requirements H2');
});
test('--design with --base does not force unrelated legacy documents to be rewritten', t => {
  const f = fixture(t); f.save(doc({ ...accepted, Owns: 'src/main.mjs' }));
  f.save(doc({ ...accepted, 'Design-Format': null }, '## Notes\nUnrelated old contract.\n', 'FEAT-OTHER', 'docs/domains/other/features/old.md'));
  const ref = base(f); f.put('src/main.mjs', 'export const identity = x => { return x; };\n');
  const r = f.check({ base: ref, design: true }); ok(r); assert.equal(r.stats.design.strict, 1);
});
test('a new unprofiled draft reports migration gaps without blocking incremental capture', t => {
  const f = fixture(t), ref = base(f); f.save(doc({ 'Design-Format': null }, '## Notes\nWork in progress.\n'));
  const r = f.check({ base: ref }); ok(r); assert.ok(r.warnings.some(s => s.includes('must declare Design-Format')));
});
test('shared state diagram references avoid copying and support current managed modules', t => {
  const f = fixture(t), target = 'docs/domains/sample/modules/store.md';
  f.save(doc({ Type: 'module' }, body('MOD-STORE'), 'MOD-STORE', target));
  f.save(doc({}, body().replace(/state not-applicable: .* -->/, 'state ref: ../modules/store.md -->')));
  ok(f.check({ design: true }));
});
for (const target of ['../modules/missing.md', 'https://example.invalid/state.md', '../../../../../../outside.md']) test(`unsafe/missing diagram reference is not silently accepted: ${target}`, t => {
  const f = fixture(t); f.save(doc({}, body().replace(/state not-applicable: .* -->/, `state ref: ${target} -->`)));
  hasError(f.check({ design: true }), 'state:');
});
test('unmanaged prose cannot supply a checked shared diagram', t => {
  const f = fixture(t); f.put('docs/domains/sample/modules/raw.md', '# Unmanaged\n' + body());
  f.save(doc({}, body().replace(/state not-applicable: .* -->/, 'state ref: ../modules/raw.md -->'))); hasError(f.check({ design: true }), 'unmanaged');
});
test('diagram reference cycles fail with an explicit path', t => {
  const f = fixture(t); f.save(doc({}, body().replace(/state not-applicable: .* -->/, 'state ref: ../modules/store.md -->')));
  f.save(doc({ Type: 'module' }, body('MOD-STORE').replace(/state not-applicable: .* -->/, 'state ref: ../features/main.md -->'), 'MOD-STORE', 'docs/domains/sample/modules/store.md'));
  hasError(f.check({ design: true }), 'cyclic diagram');
});
test('wrong-kind reference does not satisfy a missing state diagram', t => {
  const f = fixture(t); f.save(doc({ Type: 'module' }, body('MOD-STORE').replace(/^<!-- ddd:diagram state.*\n/m, ''), 'MOD-STORE', 'docs/domains/sample/modules/store.md'));
  f.save(doc({}, body().replace(/state not-applicable: .* -->/, 'state ref: ../modules/store.md -->'))); hasError(f.check({ design: true }), 'state: expected one');
});
test('superseded design bodies are not migrated during current design checking', t => {
  const f = fixture(t); f.save(doc());
  f.save(doc({ Status: 'superseded', 'Superseded by': FILE }, '## Notes\nHistorical.\n', 'FEAT-OLD', 'docs/domains/sample/features/old.md'));
  ok(f.check({ design: true })); assert.equal(f.check().stats.design.current, 1);
});
test('declared gaps in an observed shared diagram propagate to an accepted consumer', t => {
  const f = fixture(t); f.save(doc({ Type: 'module' }, body('MOD-STORE').replace(/state not-applicable: .* -->/, 'state pending: Need to inspect restart behavior. -->'), 'MOD-STORE', 'docs/domains/sample/modules/store.md'));
  f.save(doc(accepted, body().replace(/state not-applicable: .* -->/, 'state ref: ../modules/store.md -->'))); hasError(f.check(), 'pending');
});
test('release status/implementation/evidence checks remain separate from good diagrams', t => {
  const f = fixture(t); f.save(doc({ Owns: 'src/main.mjs' })); const ref = base(f); f.put('src/main.mjs', 'export const identity = x => { return x; };\n');
  hasError(f.check({ base: ref, release: true, design: true }), 'release requires accepted');
});
test('shipped hypothetical example has a valid structural body without claiming approval/execution', t => {
  const f = fixture(t), text = fs.readFileSync(path.join(PKG, 'examples/import-design.md'), 'utf8');
  f.save({ path: FILE, text }); const r = f.check({ design: true }); ok(r);
  assert.equal(header(text).fields.Status, 'proposed'); assert.equal(header(text).fields.Verification, 'not-run');
});
test('feature and module template bodies retain explicit draft gaps, not fake completeness', t => {
  for (const name of ['feature', 'module']) {
    const text = fs.readFileSync(path.join(PKG, `FORMATS/${name}.md`), 'utf8');
    const content = text.match(/````markdown\n([\s\S]*?)\n````/)[1];
    const d = { path: FILE, text: content, fields: header(content).fields };
    assert.equal(d.fields['Design-Format'], DESIGN_FORMAT); hasIssue(validateDesign(d), 'pending');
    const s = scanDesign(content); assert.deepEqual(s.sections.filter(x => x.key).map(x => x.key), ['requirements', 'overview', 'detail']);
  }
});
test('installed rule and fresh-session probe include discussion, document challenge and graph roles', () => {
  const r = ruleBlock(DEFAULT_SKILL, DEFAULTS), probe = probeText();
  for (const term of ['主动', '场景', '代价', '已确认文档可以质疑', '需求说明', '概要设计', '详细设计', 'ASCII', '不得整篇重建']) assert.ok(r.includes(term), term);
  for (const term of ['矛盾', '主动讨论', '三层文档', 'ASCII']) assert.ok(probe.includes(term), term);
});
test('known v0.2.2 unmanaged predecessor is included for safe upgrade', () => {
  const pkg = readPackage(); assert.ok(pkg.manifest.predecessors['0.2.2']['SKILL.md']); assert.ok(pkg.manifest.predecessors['0.2.2']['package-manifest.json']);
});
test('fresh install adds new discussion rule but never rewrites existing specs/config/protected prose', t => {
  const f = fixture(t), rules = '\ufeff# 项目规则\r\n中文与安全边界。', cfg = f.read('.doc-driven.json');
  f.put('AGENTS.md', rules); f.save(doc({ 'Design-Format': null }, '## Notes\nOriginal hand-written design.\n'));
  const original = f.read(FILE), plan = planInstall(f.root, { host: 'agents' }); applyPlan(plan);
  assert.ok(f.read('AGENTS.md').startsWith(rules)); assert.ok(f.read('AGENTS.md').includes('主动查找'));
  assert.equal(f.read('.doc-driven.json'), cfg); assert.equal(f.read(FILE), original); assert.equal(doctor(f.root).activation, 'ready');
  assert.equal(planInstall(f.root, { host: 'agents' }).writes.length, 0);
});


test('recognized human headings cannot be silently relabeled by conflicting markers', () => {
  hasIssue(validateDesign(doc({}, body().replace('ddd:section overview', 'ddd:section detail'))), 'contradicts recognized heading');
});

test('main scenario reference points to the current example rather than duplicating obsolete unprofiled prose', () => {
  const s = fs.readFileSync(path.join(PKG, 'examples/scenarios.md'), 'utf8');
  assert.ok(s.includes('(import-design.md)')); assert.ok(!s.includes('正常流程：读取 → 校验'));
});
