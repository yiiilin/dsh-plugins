// Unit/integration checks of binding and records; NOT live multi-turn model tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contractHash, specRef, parseSpecRefs, bindingStatus } from '../scripts/contract.mjs';
import { header } from '../scripts/lib.mjs';
import { fixture, makeDoc, BODY, FILE, approved, record } from './fixtures.mjs';
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = r => assert.deepEqual(r.errors, [], JSON.stringify(r));
const has = (r, text) => assert.ok(r.errors.some(e => e.includes(text)), JSON.stringify(r));
const boundPass = f => {
  let d = makeDoc({ ...approved, Baseline: f.baseline(), Verification: 'passed' });
  d = { ...d, text: d.text + record(d, f.baseline()) }; f.save(d); return d;
};
test('spec refs bind identity revision and lowercase 64-byte hash', () => {
  const d = makeDoc(), ref = specRef(d); assert.match(ref, /^FEAT-MAIN@1#[a-f0-9]{64}$/); assert.equal(parseSpecRefs(ref)[0].hash, contractHash(d));
});
for (const ref of ['FEAT-MAIN@0#'+'a'.repeat(64), 'FEAT-MAIN@1#'+'A'.repeat(64), 'FEAT-MAIN@1', 'x', 'FEAT-MAIN@1#abc'])
  test(`malformed binding rejected: ${ref.slice(0,20)}`, () => assert.throws(() => parseSpecRefs(ref), /Invalid/));
test('duplicate bound document cannot silently choose one revision', () => assert.throws(() => parseSpecRefs(`${specRef(makeDoc())}, ${specRef(makeDoc())}`), /Duplicate/));
test('contract hash excludes approval implementation verification bookkeeping', () => {
  const d = makeDoc(), h = makeDoc({ ...approved, Baseline: 'git:1234567', Verification: 'passed' }); assert.equal(contractHash(d), contractHash(h));
});
test('CRLF blank-line and trailing-space edits do not change contract hash', () => {
  const d = makeDoc(); assert.equal(contractHash(d), contractHash({ ...d, text: d.text.replace(/\n/g, '  \r\n\r\n') }));
});
for (const change of ['requirement', 'diagram', 'acceptance', 'dependency', 'ownership']) test(`${change} changes contract fingerprint even with unchanged Revision`, () => {
  const d = makeDoc(), altered = change === 'dependency' ? makeDoc({ 'Depends on': 'MOD-OTHER' }) : change === 'ownership' ? makeDoc({ Owns: 'lib/**' })
    : makeDoc({}, BODY.replace(change === 'diagram' ? '[Compute]' : change === 'acceptance' ? 'return 9;' : 'sum', change === 'diagram' ? '[Alternative]' : change === 'acceptance' ? 'return 5;' : 'difference'));
  assert.notEqual(contractHash(d), contractHash(altered));
});
test('adding or editing independent E subtrees cannot invalidate their own binding', () => {
  const d = makeDoc(), text = d.text + record(d, 'snapshot:'+'a'.repeat(64)); assert.equal(contractHash(d), contractHash({ ...d, text }));
  assert.equal(contractHash(d), contractHash({ ...d, text: text.replace('Synthetic method', 'Updated method') }));
});
test('an E-like heading inside a code example cannot hide subsequent contract text', () => {
  const d = makeDoc({}, BODY + '\n```text\n### E-FAKE-001\n```\nRequired behavior\n');
  assert.notEqual(contractHash(d), contractHash({ ...d, text: d.text.replace('Required behavior', 'Changed behavior') }));
});
test('requirement definitions nested under excluded evidence cannot evade binding', t => {
  const f = fixture(t), d = makeDoc(); f.save({ ...d, text: d.text + record(d, f.baseline()) + '\n#### R-HIDDEN-001 Hidden\nChange it secretly.\n' });
  has(f.check(), 'cannot be defined inside');
});
test('current bound passed verification is structurally valid', t => { const f = fixture(t); boundPass(f); ok(f.check()); assert.equal(f.check().stats.evidenceBindings.current, 1); });
test('reported sum-to-difference regression rejects old evidence despite same code snapshot', t => {
  const f = fixture(t); const d = boundPass(f), base = f.base();
  let text = d.text.replace('Revision: 1', 'Revision: 2').replace('Approved revision: 1','Approved revision: 2').replace('sum of two', 'difference of two').replace('return 9;', 'return 5;');
  f.save({ path: FILE, fields: header(text).fields, text }); const result = f.check({ base, design: true, release: true });
  has(result, 'bound passed evidence'); assert.ok(result.warnings.some(w => w.includes('stale Spec-Refs')));
});
test('changing contract without incrementing Revision is detected in strict release', t => {
  const f = fixture(t), d = boundPass(f), base = f.base(); f.save({ ...d, text: d.text.replace('sum of two','difference of two') });
  has(f.check({ base, release: true }), 'without increasing Revision');
});
test('fresh evidence can coexist with historical passed record without rewriting old history', t => {
  const f = fixture(t), old = boundPass(f);
  const d = makeDoc({ ...approved, Revision:'2', 'Approved revision':'2', Baseline:f.baseline(), Verification:'passed' }, BODY.replace('sum', 'difference'));
  f.save({ ...d, text: d.text + record(old,f.baseline()) + record(d,f.baseline(),{id:'E-MAIN-002'}) }); ok(f.check());
});
test('historical failed evidence cannot veto a current passing revision', t => {
  const f=fixture(t), old=makeDoc(), d=makeDoc({ ...approved, Revision:'2', 'Approved revision':'2', Baseline:f.baseline(), Verification:'passed' });
  f.save({ ...d,text:d.text+record(old,f.baseline(),{Result:'failed'})+record(d,f.baseline(),{id:'E-MAIN-002'}) }); ok(f.check());
});
test('legacy unbound passed records remain warnings in ordinary checks', t => {
  const f=fixture(t), d=makeDoc({ ...approved, Baseline:f.baseline(), Verification:'passed', 'Evidence-Format':null });
  f.save({ ...d,text:d.text+record(d,f.baseline(),{'Spec-Refs':null,Environment:null}) }); ok(f.check()); assert.ok(f.check().stats.evidenceBindings.unbound>0);
});
test('legacy unbound evidence cannot bypass release by deleting format fields', t => {
  const f=fixture(t), base=f.base(), d=makeDoc({ ...approved, Baseline:f.baseline(), Verification:'passed', 'Evidence-Format':null });
  f.save({ ...d,text:d.text+record(d,f.baseline(),{'Spec-Refs':null,Environment:null}) }); has(f.check({base,release:true}), 'bound passed evidence');
});
test('new format cannot claim Verification passed with unbound evidence', t => {
  const f=fixture(t), d=makeDoc({ ...approved,Baseline:f.baseline(),Verification:'passed' }); f.save({ ...d,text:d.text+record(d,f.baseline(),{'Spec-Refs':null}) }); has(f.check(),'bound passed evidence');
});
test('new passed evidence needs an explicit environment', t => {
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,f.baseline(),{Environment:'unknown'})});has(f.check(),'requires Environment');
});
test('cross-document covers needs each defining document bound', t => {
  const f=fixture(t), other=makeDoc({'Doc-ID':'MOD-OTHER',Type:'module',Owns:'—'},BODY.replaceAll('R-MAIN-001','C-OTHER-001'),'docs/domains/calculation/modules/other.md');f.save(other);
  const d=makeDoc({...approved,Baseline:f.baseline(),Verification:'passed'});f.save({...d,text:d.text+record(d,f.baseline(),{Covers:'R-MAIN-001, C-OTHER-001'})});
  assert.ok(f.check().warnings.some(w=>w.includes('missing specification evidence for MOD-OTHER')));
  // A claim on OTHER cannot pass using MAIN's unrelated binding.
  f.save(makeDoc({...other.fields,Baseline:f.baseline(),Verification:'passed'},BODY.replaceAll('R-MAIN-001','C-OTHER-001'),other.path));has(f.check(),'bound passed evidence');
});
test('duplicate evidence field is rejected rather than last-value wins',t=>{
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,f.baseline())+'Result: failed\n'});has(f.check(),'duplicate record field Result');
});
test('unresolved explicit dependency is diagnosed',t=>{const f=fixture(t);f.save(makeDoc({'Depends on':'MOD-MISSING'}));has(f.check(),'Depends on missing');});
test('current design review satisfies explicit preimplementation gate without authorizing implementation',t=>{
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,f.baseline(),{Kind:'design-review',Covers:'FEAT-MAIN',Reviewer:'single-context self-review; synthetic', 'Open blockers':'0'})});
  const result=f.check({design:true,review:true});ok(result);assert.equal(result.stats.review.status,'record-structure-passed');assert.equal(header(f.read(FILE)).fields.Status,'proposed');
});
test('missing design review is blocked only when the review gate is requested',t=>{const f=fixture(t);ok(f.check());has(f.check({review:true}),'--review requires');});
test('a review cannot pass with outstanding blockers',t=>{
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,f.baseline(),{Kind:'design-review',Covers:'FEAT-MAIN',Reviewer:'Synthetic reviewer','Open blockers':'1'})});has(f.check({review:true}),'cannot pass with open blockers');
});
test('stale review after contract change requires real targeted re-review',t=>{
  const f=fixture(t),d=makeDoc(),text=d.text+record(d,f.baseline(),{Kind:'design-review',Covers:'FEAT-MAIN',Reviewer:'self-review synthetic','Open blockers':'0'});
  f.save({...d,text:text.replace('sum of two','difference of two')});has(f.check({review:true}),'--review requires');
});
test('stale review after source change is also rejected',t=>{
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,f.baseline(),{Kind:'design-review',Covers:'FEAT-MAIN',Reviewer:'self-review synthetic','Open blockers':'0'})});
  f.put('src/main.mjs','export const add=(a,b)=>a-b;');has(f.check({review:true}),'--review requires');
});
test('design review is never counted as behavior verification',t=>{
  const f=fixture(t),d=makeDoc({...approved,Baseline:f.baseline(),Verification:'passed'});f.save({...d,text:d.text+record(d,f.baseline(),{Kind:'design-review',Covers:'R-MAIN-001',Reviewer:'synthetic','Open blockers':'0'})});has(f.check(),'matching-baseline passed evidence');
});
test('binding parser distinguishes missing stale and current without trusting code baseline',()=>{
  const d=makeDoc();assert.equal(bindingStatus({fields:{}},d),'unbound');assert.equal(bindingStatus({fields:{'Spec-Refs':specRef(d)}},d),'current');
  assert.equal(bindingStatus({fields:{'Spec-Refs':specRef(d)}},makeDoc({Revision:'2'})),'stale');assert.equal(bindingStatus({fields:{'Spec-Refs':specRef(makeDoc({'Doc-ID':'MOD-OTHER'}))}},d),'missing');
});
test('review CLI advertises records-only limits and accepts the explicit option',t=>{
  const f=fixture(t),p=path.join(PKG,'scripts/check-doc-set.mjs');const a=spawnSync(process.execPath,[p,'--help'],{encoding:'utf8'});assert.equal(a.status,0);assert.match(a.stdout,/--review/);
  const b=spawnSync(process.execPath,[p,f.root,'--review','--json'],{encoding:'utf8'});assert.equal(b.status,1);assert.match(b.stdout,/semantic/);
});
test('installed entry and design references contain concrete capture/explain/review/refresh triggers',()=>{
  const skill=fs.readFileSync(path.join(PKG,'SKILL.md'),'utf8'),design=fs.readFileSync(path.join(PKG,'DESIGN.md'),'utf8'),rules=fs.readFileSync(path.join(PKG,'scripts/project-install.mjs'),'utf8');
  for(const text of [skill,design,rules]){assert.match(text,/本轮结束前|本轮即记录/);assert.match(text,/场景|什么时候/);assert.match(text,/自审|self-review/);assert.match(text,/旧证据|Spec-Refs|代码版本/);}
});

for (const state of ['not-run', 'blocked']) test(`unperformed review ${state} can truthfully keep reviewer/blockers unknown`,t=>{
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,'unknown',{Kind:'design-review',Covers:'FEAT-MAIN',Result:state,Reviewer:'unknown','Open blockers':'unknown','Spec-Refs':'unknown'})});
  ok(f.check());has(f.check({review:true}),'--review requires');
});
for (const field of ['Method','Detail']) test(`completed bound evidence cannot use placeholder ${field}`,t=>{
  const f=fixture(t),d=makeDoc();f.save({...d,text:d.text+record(d,f.baseline(),{[field]:'TODO'})});has(f.check(),'non-placeholder');
});
test('docs-only evidence recording does not require spurious revision changes',t=>{
  const f=fixture(t),base=f.base();boundPass(f);ok(f.check({base,release:true}));
});
