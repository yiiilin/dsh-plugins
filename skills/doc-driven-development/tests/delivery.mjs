// Synthetic permission/evidence records test checker boundaries, not real human approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, makeDoc, record, approved, FILE, BODY } from './fixtures.mjs';
import { header } from '../scripts/lib.mjs';
import { specRef, contractHash } from '../scripts/contract.mjs';
import { itemHeadings } from '../scripts/identity.mjs';
import { checkDelivery, readPacket } from '../scripts/delivery.mjs';
import { buildContext, contextReport } from '../scripts/context.mjs';
import { PACKAGE_ROOT } from '../scripts/project-install.mjs';
const PACKET='docs/changes/current.md';
const hide=s=>s.replace(/^(#{2,6}) ([RCDE]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+) (.+)$/gm,(_,h,id,t)=>`${h} ${t}\n<!-- ddd:item ${id} -->`);
const good=r=>assert.deepEqual(r.errors,[],JSON.stringify(r,null,2));
const bad=(r,re)=>assert.ok(r.errors.some(s=>re.test(s)),JSON.stringify(r,null,2));
function setup(t,{done=false,body=BODY}={}){
  const f=fixture(t),d=makeDoc({...approved,Baseline:f.baseline(),Verification:'not-run'},body);f.save(d);
  const p={kind:'ddd-delivery-v1',schemaVersion:1,title:'计算领域 / 求和',authorization:{mode:'implement',source:'Synthetic original implementation request and explicit design approval fixture',specRefs:[specRef(d)]},
    units:[{name:'计算 / 模块 / 返回求和',outcome:'输入 7 和 2 返回 9',covers:['R-MAIN-001'],writePaths:['src/**'],state:done?'done':'queued',integration:'required',entryPoints:['src/main.mjs'],runtimePath:'src/main.mjs -> exported add -> caller result',requiredLevels:['integration','acceptance'],evidence:done?['E-MAIN-001','E-MAIN-002']:[],codeBaseline:done?f.baseline():'unknown'}]};
  const save=()=>f.put(PACKET,'# Current task\n\n<!-- ddd:delivery -->\n```json\n'+JSON.stringify(p,null,2)+'\n```\n');
  if(done){f.put('.doc-driven/runs/result.log','Synthetic nonempty artifact, not a real command run\n');f.save({...d,text:d.text+record(d,f.baseline(),{Level:'integration',Executed:'1',Skipped:'0',Failed:'0',Artifact:'.doc-driven/runs/result.log'})+record(d,f.baseline(),{id:'E-MAIN-002',Level:'acceptance',Executed:'1',Skipped:'0',Failed:'0',Artifact:'.doc-driven/runs/result.log'})});}
  save();return {...f,p,d,savePacket:save,delivery:o=>checkDelivery(f.root,f.config,PACKET,o)};
}
test('authorized pending work returns continue, not another approval request',t=>{const f=setup(t),r=f.delivery();good(r);assert.equal(r.status,'continue-authorized-work');assert.equal(r.units[0].nextAction,'continue-without-reconfirmation');});
test('queued unit cannot be delivered as complete',t=>{const f=setup(t);bad(f.delivery({complete:true}),/not done/);});
test('done needs both runtime integration and acceptance records',t=>{const f=setup(t,{done:true});good(f.delivery({complete:true}));});
for(const mode of ['design-only','hold'])test(`${mode} is not implementation authorization`,t=>{const f=setup(t,{done:true});f.p.authorization.mode=mode;f.savePacket();bad(f.delivery({complete:true}),/without recorded implementation authorization/);});
test('design-only queued is a valid non-implementation record',t=>{const f=setup(t);f.p.authorization.mode='design-only';f.savePacket();good(f.delivery());assert.equal(f.delivery().status,'not-authorized-for-implementation');});
for(const source of ['unknown','none',''])test(`no invented approval source: ${source}`,t=>{const f=setup(t);f.p.authorization.source=source;f.savePacket();bad(f.delivery(),/actual original request/);});
test('new requirement cannot disappear from the task decomposition',t=>{const f=setup(t,{body:BODY.replace('### 1.2 验收条件','### R-MAIN-002 Invalid input\nReject invalid input.\n### 1.2 验收条件')});bad(f.delivery(),/no delivery unit/);});
test('scoped subset requires recorded scope source',t=>{const f=setup(t);f.p.selectedItems=['R-MAIN-001'];f.savePacket();bad(f.delivery(),/scopeSource/);f.p.scopeSource='Synthetic original task explicitly limited to this requirement';f.savePacket();good(f.delivery());});
test('cannot select an item outside bound specs',t=>{const f=setup(t);f.p.selectedItems=['R-OTHER-001'];f.p.scopeSource='Synthetic';f.savePacket();bad(f.delivery(),/outside bound/);});
test('silent defer is rejected',t=>{const f=setup(t);f.p.deferred=[{item:'R-MAIN-001',reason:'Difficult'}];f.savePacket();bad(f.delivery(),/deferred item needs/);});
test('approved defer does not authorize continuing the deferred item',t=>{const f=setup(t);f.p.deferred=[{item:'R-MAIN-001',reason:'Later slice',source:'Synthetic explicit defer'}];f.savePacket();bad(f.delivery(),/out-of-scope/);});
test('blocker carries actual next action instead of generic need your help',t=>{const f=setup(t);f.p.units[0].state='blocked';f.savePacket();bad(f.delivery(),/blocker requires/);f.p.units[0].blocker={kind:'dependency',reason:'Consumer interface absent in current dependency',nextAction:'Investigate approved dependency adapter before any new decision'};f.savePacket();good(f.delivery());assert.equal(f.delivery().status,'blocked');});
test('contract changed even same item ID invalidates task authorization identity',t=>{const f=setup(t);f.put(FILE,f.read(FILE).replace('sum of','difference of'));bad(f.delivery(),/authorized specification changed/);});
test('unrelated code change after worker result requires final integration baseline',t=>{const f=setup(t,{done:true});f.put('src/new.mjs','export const changed=1;');bad(f.delivery(),/completion baseline is stale/);});
test('entry method name alone is not an existing runtime entry file',t=>{const f=setup(t,{done:true});f.p.units[0].entryPoints=['src/missing.mjs'];f.savePacket();bad(f.delivery(),/missing runtime entry/);});
test('empty log is not completion evidence',t=>{const f=setup(t,{done:true});f.put('.doc-driven/runs/result.log','');bad(f.delivery(),/nonempty/);});
for(const [field,value,re] of [['Executed','0',/no executed/],['Skipped','1',/skipped/],['Result','blocked',/not passed/],['Environment','unknown',/actual environment/],['Level','component',/lacks required/],['Artifact','../outside',/local inspectable/]])test(`invalid completion evidence ${field}=${value}`,t=>{const f=setup(t,{done:true});f.put(FILE,f.read(FILE).replace(new RegExp(`^${field}:.*$`,'gm'),`${field}: ${value}`));bad(f.delivery(),re);});
test('design review can never replace runtime evidence',t=>{const f=setup(t,{done:true});f.put(FILE,f.read(FILE).replaceAll('Kind: verification','Kind: design-review'));bad(f.delivery(),/design review cannot substitute/);});
test('pure function can explain no integration while still requiring acceptance',t=>{const f=setup(t,{done:true});Object.assign(f.p.units[0],{integration:'not-applicable',integrationReason:'Pure library operation without lifecycle or runtime wiring',requiredLevels:['acceptance'],entryPoints:[]});f.savePacket();good(f.delivery({complete:true}));});
test('missing consumer cannot be blank not-applicable',t=>{const f=setup(t);f.p.units[0].integration='not-applicable';f.savePacket();bad(f.delivery(),/explain why/);});
for(const rel of ['.doc-driven.json','../x.md','AGENTS.md'])test(`packet output is never arbitrary file: ${rel}`,t=>{const f=setup(t);assert.throws(()=>readPacket(f.root,f.config,rel),/under docsRoots/);});
test('ordinary quoted delivery marker cannot fabricate an executable packet',t=>{const f=setup(t);f.put(PACKET,'# Example\n```text\n<!-- ddd:delivery -->\n```\n');assert.throws(()=>f.delivery(),/exactly one/);});
test('packet cannot bind itself recursively',t=>{const f=setup(t);const d=makeDoc({'Doc-ID':'CHANGE-TASK',Type:'change',Owns:'—'},'## Goal\nTask record\n',PACKET);f.save(d);f.p.authorization.specRefs=[specRef(d)];f.savePacket();bad(f.delivery(),/missing\/current target|self-binding/);});
test('standalone helper is read-only and returns natural unit names',t=>{const f=setup(t);const original=f.read(FILE);const r=spawnSync(process.execPath,[path.join(PACKAGE_ROOT,'scripts/delivery.mjs'),f.root,'--packet',PACKET,'--json'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'continue-authorized-work');assert.equal(f.read(FILE),original);});
test('check-doc-set --delivery is composed into strict error reporting',t=>{const f=setup(t);f.p.units[0].covers=[];f.savePacket();bad(f.check({delivery:PACKET}),/covers must/);});
test('without packet checker does not claim delivery verified',t=>{const f=setup(t);assert.equal(f.check().stats.delivery.status,'not-assessed');});
test('disabled config is not an authorized-delivery shortcut',t=>{const f=setup(t);assert.throws(()=>checkDelivery(f.root,{...f.config,enabled:false},PACKET),/disabled/);});

// Identity preservation tests exercise real parsing, hashing, evidence and querying.
test('hide stable requirement identity without changing contract fingerprint',()=>{const d=makeDoc();assert.equal(contractHash(d),contractHash({...d,text:hide(d.text)}));assert.equal(itemHeadings(hide(d.text)).headings.find(h=>h.id)?.label,'Addition');});
test('hidden evidence identity works and cannot invalidate its own contract',()=>{const d=makeDoc(),text=hide(d.text+record(d,'snapshot:'+'a'.repeat(64)));assert.equal(contractHash(d),contractHash({...d,text}));});
test('hidden evidence participates in closure checks',t=>{const f=setup(t,{done:true});f.put(FILE,hide(f.read(FILE)));good(f.delivery({complete:true}));good(f.check());});
test('actual body change still invalidates hidden-identity contract',()=>{const d=makeDoc(),hidden=hide(d.text);assert.notEqual(contractHash(d),contractHash({...d,text:hidden.replace('sum of','difference of')}));});
test('changing identity is not a presentation-only change',()=>{const d=makeDoc();assert.notEqual(contractHash(d),contractHash({...d,text:hide(d.text).replace('R-MAIN-001','R-MAIN-099')}));});
for(const text of ['```text\n### Fake\n<!-- ddd:item R-FAKE-001 -->\n```','<!--\n### Fake\n<!-- ddd:item R-FAKE-001 -->\n-->'])test('identity inside examples/comments not defined: '+JSON.stringify(text),()=>{assert.equal(itemHeadings(text).headings.filter(h=>h.id).length,0);});
for(const text of ['### Title\nProse\n<!-- ddd:item R-MAIN-001 -->','### R-MAIN-001 Title\n<!-- ddd:item R-MAIN-001 -->','### Title\n<!-- ddd:item bad -->','<!-- ddd:item R-MAIN-001 -->'])test('malformed or duplicate marker rejected: '+JSON.stringify(text),()=>{assert.ok(itemHeadings(text).errors.length>0);});
test('hidden requirements cannot live under excluded hidden evidence',t=>{const f=setup(t);f.put(FILE,hide(f.read(FILE)+record(f.d,f.baseline())+'\n#### R-HIDDEN-001 Hidden behavior\nStill a requirement\n'));bad(f.check(),/cannot be defined inside/);});
test('duplicate visible and hidden identities in different headings rejected',t=>{const f=setup(t);f.put(FILE,f.read(FILE)+'\n### Duplicate\n<!-- ddd:item R-MAIN-001 -->\nOther\n');bad(f.check(),/duplicate item ID/);});
test('hidden D and R are searchable by natural names with stable internal ownership',t=>{const f=setup(t);f.put(FILE,hide(f.read(FILE))+'\n### Use existing request\n<!-- ddd:item D-MAIN-001 -->\nKnown scenario\n');const r=buildContext(f.root,f.config).snapshot;assert.equal(r.nodes.find(n=>n.id==='R-MAIN-001').title,'Addition');assert.ok(r.nodes.some(n=>n.id==='D-MAIN-001'));});
test('human context mode does not dump item identity or hashes',t=>{const f=setup(t);f.put(FILE,hide(f.read(FILE)));const r=spawnSync(process.execPath,[path.join(PACKAGE_ROOT,'scripts/context.mjs'),f.root,'--query','Addition','--human'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Addition/);assert.doesNotMatch(r.stdout,/R-MAIN-001|[a-f0-9]{64}/);});
test('natural navigation replaces document IDs in human link text',t=>{const f=setup(t);const index=f.read('docs/README.md');assert.match(index,/calculation \/ Fixture/);assert.doesNotMatch(index,/\[FEAT-MAIN\]/);});
test('natural title containing brackets does not break generated navigation',t=>{const f=setup(t);f.save({...f.d,text:f.d.text.replace('# Fixture','# Fixture [sum]')});good(f.check());assert.match(f.read('docs/README.md'),/Fixture \\\[sum\\\]/);});

test('invalid combined context output flags cannot write a snapshot',t=>{const f=setup(t);const rel='.doc-driven/context/invalid.json';const r=spawnSync(process.execPath,[path.join(PACKAGE_ROOT,'scripts/context.mjs'),f.root,'--human','--json','--out',rel],{encoding:'utf8'});assert.equal(r.status,2);assert.ok(!fs.existsSync(path.join(f.root,rel)));});
for(const value of ['1','-1','unknown'])test(`failed required cases cannot be hidden by a passed label: ${value}`,t=>{const f=setup(t,{done:true});f.put(FILE,f.read(FILE).replaceAll('Failed: 0',`Failed: ${value}`));bad(f.delivery({complete:true}),/failed required cases/);});
test('missing failed-case count is not evidence of zero failures',t=>{const f=setup(t,{done:true});f.put(FILE,f.read(FILE).replace(/^Failed: 0\n/gm,''));bad(f.delivery({complete:true}),/failed required cases/);});

test('human delivery summary uses behavior names and direct continuation language',t=>{const f=setup(t);const r=spawnSync(process.execPath,[path.join(PACKAGE_ROOT,'scripts/delivery.mjs'),f.root,'--packet',PACKET],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/已有授权，继续未完成工作/);assert.match(r.stdout,/计算 \/ 模块 \/ 返回求和/);assert.doesNotMatch(r.stdout,/continue-without-reconfirmation|R-MAIN-001/);});
