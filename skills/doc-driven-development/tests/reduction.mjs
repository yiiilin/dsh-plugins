// v0.3.1: less bookkeeping must not weaken coverage, methods, provenance or gates.
// Program tests actually run; authorization fields are explicitly synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, makeDoc, approved, FILE, BODY, record } from './fixtures.mjs';
import { specRef, contractHash } from '../scripts/contract.mjs';
import { sha, header, updateIndex } from '../scripts/lib.mjs';
import { previewPlan, runVerification, checkRun, receiptEvidence, PACKAGE } from '../scripts/verification.mjs';
import { receiptSummary, parseReceiptRef } from '../scripts/receipt-view.mjs';
import { checkRepo } from '../scripts/check-doc-set.mjs';
import { checkDelivery } from '../scripts/delivery.mjs';
import { ruleBlock, DEFAULT_SKILL } from '../scripts/project-install.mjs';
const PLAN='docs/changes/entry.verify.json', PACKET='docs/changes/current.md';
const good=r=>assert.deepEqual(r.errors,[],JSON.stringify(r));
const bad=r=>assert.ok(r.errors.length,JSON.stringify(r));
const cli=(f,...args)=>spawnSync(process.execPath,[path.join(PACKAGE,'scripts/verify.mjs'),f.root,...args],{encoding:'utf8',timeout:20000});
function setup(t) {
  const f=fixture(t);
  f.d=f.save(makeDoc({...approved,Owns:'src/**, tests/**','Verification-Format':'runner-v1','Verification-Plan':PLAN}));
  f.put('src/entry.mjs',"import {add} from './main.mjs';export const run=add;\n");
  f.test="import test from 'node:test';import assert from 'node:assert/strict';import {run} from '../src/entry.mjs';test('entry returns sum',()=>assert.equal(run(7,2),9));\n";
  f.put('tests/entry.test.mjs',f.test);
  f.p={kind:'ddd-verification-plan-v1',schemaVersion:1,name:'计算 / 正式入口 / 求和',authorization:{mode:'verify',source:'Synthetic isolated test permission, not a real user approval'},specRefs:[specRef(f.d)],environment:{name:'isolated test',scope:'isolated',resources:'Only disposable local files; no network or databases',limitations:'No production or model efficacy claims'},checks:[{id:'entry',name:'正式入口收到求和结果',kind:'test',level:'acceptance',alsoLevels:['integration'],covers:['R-MAIN-001'],scenario:'run(7,2) returns 9 through the real entry',command:{executable:'node',args:['--test','--test-reporter={skill}/scripts/node-reporter.mjs','tests/entry.test.mjs']},parser:'json-v1',requiredCases:['entry returns sum'],inputs:['tests/entry.test.mjs','src/entry.mjs'],timeoutMs:10000}]};
  f.savePlan=()=>f.put(PLAN,JSON.stringify(f.p,null,2)+'\n'); f.savePlan();
  f.run=()=>runVerification(f.root,f.config,PLAN,{expectPlan:previewPlan(f.root,f.config,PLAN).planHash});
  f.mark=(r,ptr=`${r.path}#${r.sha256}`)=>{
    let text=f.read(FILE).replace(/^Baseline:.*$/m,`Baseline: ${r.report.initial.codeBaseline}`).replace(/^Verification:.*$/m,'Verification: passed').replace(/^Verification-Receipt:.*\n/m,'');
    if(ptr!==null)text=text.replace(/^Verification-Plan:.*$/m,`Verification-Plan: ${PLAN}\nVerification-Receipt: ${ptr}`);
    f.put(FILE,text);updateIndex(f.root,f.config);
  };
  f.packet=r=>({kind:'ddd-delivery-v1',schemaVersion:1,title:'计算入口交付',authorization:{mode:'implement',source:'Synthetic implementation-scope fixture',specRefs:f.p.specRefs},verification:{mode:'runner-v1',plan:PLAN},units:[{name:'计算 / 正式入口 / 求和',outcome:'Caller gets 9 from run(7,2)',covers:['R-MAIN-001'],state:'done',writePaths:['src/**','tests/**'],integration:'required',entryPoints:['src/entry.mjs'],runtimePath:'caller -> run -> add -> result',requiredLevels:['integration','acceptance'],runs:[`${r.path}#${r.sha256}`]}]});
  f.savePacket=p=>f.put(PACKET,'# Delivery fixture\n<!-- ddd:delivery -->\n```json\n'+JSON.stringify(p,null,2)+'\n```\n');
  return f;
}
function tree(root){const out={};const walk=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else out[path.relative(root,p)]=sha(fs.readFileSync(p));}};walk(root);return out;}

test('one pinned header satisfies ordinary and strict release without any E copy',async t=>{const f=setup(t),base=f.base();f.put('src/main.mjs',f.read('src/main.mjs')+'// in-scope change\n');const r=await f.run();assert.equal(r.report.status,'passed');f.mark(r);good(f.check());good(f.check({base,design:true,release:true}));assert.equal(f.check().stats.evidenceRecords,0);});
test('one captured run supplies two levels with no duplicate E or unit baseline',async t=>{const f=setup(t),r=await f.run();f.mark(r);f.savePacket(f.packet(r));good(checkDelivery(f.root,f.config,PACKET,{complete:true}));assert.equal(r.report.results.length,1);});
test('same current run accepted through explicit CLI report when no persistent pointer yet',async t=>{const f=setup(t),base=f.base();f.put('src/main.mjs',f.read('src/main.mjs')+'// change\n');const r=await f.run();f.mark(r,null);good(f.check({base,release:true,'verification-report':r.path}));bad(f.check());});
test('new view is read-only and does not create a second execution or evidence records',async t=>{const f=setup(t),r=await f.run(),before=tree(f.root),s=receiptSummary(f.root,f.config,r.path);good(s);assert.equal(s.pointer,`${r.path}#${r.sha256}`);assert.match(s.text,/正式入口收到求和结果/);assert.match(s.text,/场景验收 \/ 集成/);assert.doesNotMatch(s.text,/ddd:item E-|Executed:|Skipped:|Failed:/);assert.deepEqual(tree(f.root),before);});
test('header pointer and status updates cannot self-invalidate contract or runner',async t=>{const f=setup(t),hash=contractHash(f.d),r=await f.run();f.mark(r);const text=f.read(FILE);assert.equal(contractHash({text,fields:header(text).fields}),hash);good(checkRun(f.root,f.config,r.path));});
test('ordinary prose still participates in contract identity; summary cannot hide new requirements',async t=>{const f=setup(t),r=await f.run();f.mark(r);f.put(FILE,f.read(FILE)+'\nNew behavior: return a different result.\n');bad(f.check());});
test('changing spec text and revision does not reuse a short pointer as evidence',async t=>{const f=setup(t),r=await f.run();f.mark(r);f.put(FILE,f.read(FILE).replace('Revision: 1','Revision: 2').replace('Approved revision: 1','Approved revision: 2').replace('sum of','difference of'));bad(f.check());assert.equal(receiptSummary(f.root,f.config,r.path).pointer,null);});
for(const kind of ['code','test','config','plan','input','rules','unrelated-code'])test(`short pointer retains conservative invalidation: ${kind}`,async t=>{
 const f=setup(t);if(kind==='input'){f.put('.doc-driven/local-input','before');f.p.checks[0].inputs.push('.doc-driven/local-input');f.savePlan();}if(kind==='rules')f.put('AGENTS.md','Original');
 const r=await f.run();f.mark(r);
 if(kind==='code')f.put('src/main.mjs','export const add=(a,b)=>a-b;');
 if(kind==='test')f.put('tests/entry.test.mjs',f.test+'// changed\n');
 if(kind==='config')f.put('.doc-driven.json',JSON.stringify({...f.config,language:'en'}));
 if(kind==='plan'){f.p.checks[0].scenario+=' changed';f.savePlan();}
 if(kind==='input')f.put('.doc-driven/local-input','after');
 if(kind==='rules')f.put('AGENTS.md','Changed');
 if(kind==='unrelated-code')f.put('src/not-imported.mjs','export const value=1;');
 bad(checkRepo(f.root,JSON.parse(f.read('.doc-driven.json'))));
 const s=receiptSummary(f.root,JSON.parse(f.read('.doc-driven.json')),r.path);assert.equal(s.pointer,null);assert.match(s.text,/不能认定已验证/);
});
for(const type of ['wrong-hash','missing','wrong-plan','no-profile','wrong-baseline'])test(`pinned pointer rejects ${type}`,async t=>{const f=setup(t),r=await f.run();f.mark(r);if(type==='wrong-hash')f.mark(r,`${r.path}#${'0'.repeat(64)}`);if(type==='missing')f.mark(r,`.doc-driven/verification/runs/missing/run.json#${r.sha256}`);if(type==='wrong-plan')f.put(FILE,f.read(FILE).replace(`Verification-Plan: ${PLAN}`,'Verification-Plan: docs/changes/other.json'));if(type==='no-profile')f.put(FILE,f.read(FILE).replace(/^Verification-Format:.*\n/m,''));if(type==='wrong-baseline')f.put(FILE,f.read(FILE).replace(/^Baseline:.*$/m,`Baseline: snapshot:${'a'.repeat(64)}`));bad(f.check());});
for(const ref of ['plain-path/run.json','run.json#abc','../run.json#xyz','x/run.json#'+'A'.repeat(64),null])test(`malformed receipt pin rejected: ${ref}`,()=>assert.throws(()=>parseReceiptRef(ref)));
for(const variant of ['skip','todo','empty','missing-case','assert-fails','plain-ok','duplicate','timeout','missing-env','output-limit'])test(`one-line evidence cannot make ${variant} pass`,async t=>{
 const f=setup(t);
 if(variant==='skip')f.put('tests/entry.test.mjs',"import test from 'node:test';test.skip('entry returns sum',()=>{});");
 if(variant==='todo')f.put('tests/entry.test.mjs',"import test from 'node:test';test.todo('entry returns sum');");
 if(variant==='empty')f.put('tests/entry.test.mjs','// no tests');
 if(variant==='missing-case')f.put('tests/entry.test.mjs',"import test from 'node:test';test('unrelated',()=>{});");
 if(variant==='assert-fails')f.put('src/entry.mjs','export const run=()=>null;');
 if(variant==='duplicate')f.put('tests/entry.test.mjs',f.test+"test('entry returns sum',()=>{});");
 if(variant==='plain-ok')f.p.checks[0].command.args=['-e',"console.log('all passed')"];
 if(variant==='timeout'){f.p.checks[0].command.args=['-e','setTimeout(()=>{},10000)'];f.p.checks[0].timeoutMs=100;}
 if(variant==='output-limit'){f.p.checks[0].maxOutputBytes=256;f.p.checks[0].command.args=['-e',"console.log('x'.repeat(1000))"];}
 if(variant==='missing-env'){delete process.env.TEST_V031_MISSING;f.p.checks[0].requiresEnv=['TEST_V031_MISSING'];}
 f.savePlan();const r=await f.run();assert.notEqual(r.report.status,'passed');f.mark(r);bad(f.check());const summary=receiptSummary(f.root,f.config,r.path);assert.equal(summary.pointer,null);assert.doesNotMatch(summary.text,/Verification-Receipt:/);f.savePacket(f.packet(r));bad(checkDelivery(f.root,f.config,PACKET,{complete:true}));
});
test('a static command cannot replace business acceptance even when it actually passes',async t=>{const f=setup(t);Object.assign(f.p.checks[0],{kind:'command',level:'static',parser:'exit-code',command:{executable:'node',args:['--check','src/main.mjs']}});delete f.p.checks[0].requiredCases;delete f.p.checks[0].alsoLevels;f.savePlan();const r=await f.run();assert.equal(r.report.status,'passed');f.mark(r);bad(f.check());const s=receiptSummary(f.root,f.config,r.path);assert.match(s.text,/静态检查/);assert.match(s.text,/完整业务交付仍需/);f.savePacket(f.packet(r));bad(checkDelivery(f.root,f.config,PACKET,{complete:true}));});
test('manual acceptance never gets an automatic passing pointer',async t=>{const f=setup(t);f.p.checks=[{id:'manual',name:'使用体验人工验收',kind:'manual',level:'acceptance',covers:['R-MAIN-001'],scenario:'Review experience',reason:'Requires an actual human judgment'}];f.savePlan();const r=await f.run();assert.equal(r.report.status,'manual-required');f.mark(r);bad(f.check());assert.equal(receiptSummary(f.root,f.config,r.path).pointer,null);});
test('legitimate optional skip remains visible without changing required-case decisions',async t=>{const f=setup(t);f.put('tests/entry.test.mjs',f.test+"test.skip('optional environment',()=>{});");f.p.checks[0].optionalCases=['optional environment'];f.p.checks[0].optionalReason='Separate environment not required for this local scope';f.savePlan();const r=await f.run();assert.equal(r.report.status,'passed');f.mark(r);good(f.check());assert.match(receiptSummary(f.root,f.config,r.path).text,/optional environment/);});
for(const kind of ['log','receipt-count','rehashed-count','empty-output'])test(`short view and gates reject altered ${kind}`,async t=>{const f=setup(t),r=await f.run();f.mark(r);if(kind==='log')f.put(r.report.results[0].artifacts[0].path,f.read(r.report.results[0].artifacts[0].path)+'tamper');if(kind==='empty-output')f.put(r.report.results[0].artifacts[0].path,'');if(kind.includes('count')){const data=JSON.parse(f.read(r.path));data.results[0].counts.executed=999;f.put(r.path,JSON.stringify(data));if(kind==='rehashed-count'){const h=sha(f.read(r.path));f.put(r.path.replace('run.json','run.sha256'),h);f.mark(r,`${r.path}#${h}`);}}bad(f.check());assert.equal(receiptSummary(f.root,f.config,r.path).pointer,null);});
test('all bound requirements still need actual acceptance; selected plan cannot mask the rest',async t=>{const f=setup(t);f.d=f.save(makeDoc({...f.d.fields},BODY.replace('### 1.2 验收条件','### R-MAIN-002 Reject invalid inputs\nReject nonnumeric values.\n### 1.2 验收条件')));f.p.specRefs=[specRef(f.d)];f.p.selectedItems=['R-MAIN-001'];f.p.scopeSource='Synthetic limited test plan; not full feature completion';f.savePlan();const r=await f.run();f.mark(r);const checked=f.check();bad(checked);assert.ok(checked.errors.some(x=>x.includes('R-MAIN-002')));});
test('plan omissions still rejected before executing any process',t=>{const f=setup(t);f.d=f.save(makeDoc(f.d.fields,BODY+'\n### R-MAIN-002 Another required behavior\nReject invalid inputs.\n'));f.p.specRefs=[specRef(f.d)];f.savePlan();assert.throws(()=>previewPlan(f.root,f.config,PLAN),/Every selected/);assert.ok(!fs.existsSync(path.join(f.root,'.doc-driven/verification')));});
for(const mutation of ['no-runs','bad-run','missing-level','missing-entry','out-of-scope','design-only','old-explicit-baseline','unknown-E'])test(`minimal delivery still rejects ${mutation}`,async t=>{const f=setup(t),r=await f.run();const p=f.packet(r);if(mutation==='no-runs')delete p.units[0].runs;if(mutation==='bad-run')p.units[0].runs=[`${r.path}#${'0'.repeat(64)}`];if(mutation==='missing-level')p.units[0].requiredLevels.push('regression');if(mutation==='missing-entry')p.units[0].entryPoints=['src/nonexistent.mjs'];if(mutation==='out-of-scope')p.units[0].covers.push('R-MAIN-002');if(mutation==='design-only')p.authorization.mode='design-only';if(mutation==='old-explicit-baseline')p.units[0].codeBaseline=`snapshot:${'0'.repeat(64)}`;if(mutation==='unknown-E')p.units[0].evidence=['E-NO-001'];f.savePacket(p);bad(checkDelivery(f.root,f.config,PACKET,{complete:true}));});
test('correct legacy duplicate E stays compatible in document and delivery checks',async t=>{const f=setup(t),r=await f.run();f.mark(r);const old=receiptEvidence(f.root,f.config,r.path);f.put(FILE,f.read(FILE)+old);const p=f.packet(r);p.units[0].evidence=[...old.matchAll(/ddd:item (E-[A-Z0-9-]+)/g)].map(x=>x[1]);p.units[0].codeBaseline=r.report.initial.codeBaseline;f.savePacket(p);good(f.check());good(checkDelivery(f.root,f.config,PACKET,{complete:true}));});
test('contradictory optional legacy E is not silently ignored',async t=>{const f=setup(t),r=await f.run();f.mark(r);f.put(FILE,f.read(FILE)+receiptEvidence(f.root,f.config,r.path).replace(/Executed: 1/g,'Executed: 0'));const ids=[...f.read(FILE).matchAll(/ddd:item (E-[A-Z0-9-]+)/g)].map(x=>x[1]);const p=f.packet(r);p.units[0].evidence=ids;f.savePacket(p);bad(f.check());bad(checkDelivery(f.root,f.config,PACKET,{complete:true}));});
test('current failed legacy evidence is not erased by selecting a new pointer',async t=>{const f=setup(t),r=await f.run();f.mark(r);f.put(FILE,f.read(FILE)+record(f.d,r.report.initial.codeBaseline,{Result:'failed'}));bad(f.check());});
test('runner passing record cannot serve as design review or human approval',async t=>{const f=setup(t),r=await f.run();f.mark(r);bad(f.check({review:true}));f.put(FILE,f.read(FILE).replace(/^Approval:.*\n/m,''));bad(f.check());});
test('records-only legacy delivery still requires E and explicit baseline',async t=>{const f=setup(t),r=await f.run(),p=f.packet(r);delete p.verification;f.savePacket(p);const result=checkDelivery(f.root,f.config,PACKET,{complete:true});bad(result);assert.ok(result.errors.some(x=>x.includes('evidence references')));assert.ok(result.errors.some(x=>x.includes('baseline')));});
test('summary CLI returns honest failure and never writes on stale data',async t=>{const f=setup(t),r=await f.run();f.put('src/main.mjs',f.read('src/main.mjs')+'// change\n');const before=tree(f.root),p=cli(f,'--report',r.path,'--summary');assert.equal(p.status,1,p.stderr);assert.match(p.stdout,/不能认定已验证/);assert.doesNotMatch(p.stdout,/Verification-Receipt:/);assert.deepEqual(tree(f.root),before);});
test('summary and old evidence export both honor an explicitly selected plan',async t=>{const f=setup(t),r=await f.run();for(const flag of ['--summary','--evidence']){const p=cli(f,'--report',r.path,'--plan','docs/changes/other.json',flag);assert.equal(p.status,1,p.stderr);assert.doesNotMatch(p.stdout,/Verification-Receipt:|Runner-Receipt:/);}});
for(const args of [['--summary'],['--plan',PLAN,'--summary'],['--report','missing','--summary','--evidence'],['--report','missing','--summary','--json'],['--run','--plan',PLAN,'--summary']])test(`invalid view invocation has zero writes: ${args.join(' ')}`,t=>{const f=setup(t),before=tree(f.root),p=cli(f,...args);assert.equal(p.status,2,p.stderr);assert.deepEqual(tree(f.root),before);});
test('runtime/records can be read without treating automatic summary as a model evaluation',async t=>{const f=setup(t),r=await f.run();const s=receiptSummary(f.root,f.config,r.path);assert.equal(s.semantic,'not-assessed');assert.equal(s.provenance,'local-unsigned');assert.match(s.text,/真实批准/);});
test('short guides route to full validation and maintenance docs without mandatory all-package loading',()=>{const read=p=>fs.readFileSync(path.join(PACKAGE,p),'utf8'),entry=read('SKILL.md'),block=ruleBlock(DEFAULT_SKILL,{index:'docs/README.md'});assert.ok(entry.length<6000);assert.ok(block.length<1100);assert.match(entry,/VERIFICATION.md/);assert.match(entry,/仅|只读取/);assert.match(entry,/EVALUATION.md/);assert.match(read('VERIFICATION.md'),/精简不得改变验证责任/);assert.match(read('DESIGN.md'),/不省略本次验收/);});
test('runner specification cannot downgrade standalone delivery to legacy hand-recorded evidence',async t=>{const f=setup(t),r=await f.run();f.mark(r);const old=receiptEvidence(f.root,f.config,r.path);f.put(FILE,f.read(FILE)+old);const p=f.packet(r);delete p.verification;delete p.units[0].runs;p.units[0].codeBaseline=r.report.initial.codeBaseline;p.units[0].evidence=[...old.matchAll(/ddd:item (E-[A-Z0-9-]+)/g)].map(x=>x[1]);f.savePacket(p);const result=checkDelivery(f.root,f.config,PACKET,{complete:true});bad(result);assert.ok(result.errors.some(x=>x.includes('cannot silently downgrade')));});
test('runner verification status is derived from validated receipt, not metadata count',async t=>{const f=setup(t),r=await f.run();f.mark(r);const checked=f.check();good(checked);assert.equal(checked.stats.execution.status,'verified');assert.equal(checked.stats.execution.verifiedScope,1);assert.equal(checked.stats.evidenceRecords,0);});
