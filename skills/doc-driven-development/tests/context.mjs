// Deterministic local context behavior, not agent memory or graph completeness claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildContext, contextReport, walkGraph, compareContext } from '../scripts/context.mjs';
import { specRef } from '../scripts/contract.mjs';
import { git } from '../scripts/lib.mjs';
import { fixture, makeDoc, BODY, FILE, record } from './fixtures.mjs';
const PKG=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const moduleDoc=(extra={})=>makeDoc({'Doc-ID':'MOD-STORAGE',Type:'module',Owns:'lib/storage.mjs',...extra},BODY.replaceAll('R-MAIN-001','C-STORAGE-001'),'docs/domains/calculation/modules/storage.md');
const files=root=>{
  const out={};const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile())out[path.relative(root,p)]=fs.readFileSync(p).toString('base64');}};walk(root);return out;
};
test('default context query is read-only and reports reading not assessed',t=>{
  const f=fixture(t),before=files(f.root),r=contextReport(f.root,f.config);assert.deepEqual(files(f.root),before);assert.equal(r.reading,'not-assessed');assert.equal(r.semantic,'not-assessed');
});
test('binding output selects the current document and actual code snapshot',t=>{
  const f=fixture(t),d=makeDoc(),r=contextReport(f.root,f.config,{doc:'FEAT-MAIN',bindings:true});assert.equal(r.bindings['Spec-Refs'],specRef(d));assert.equal(r.bindings.Baseline,f.baseline());
  assert.match(r.bindings.notice,/Not a test result/);
});
test('item and file path can select its owning specification',t=>{
  const f=fixture(t);for(const doc of ['R-MAIN-001',FILE]){const r=contextReport(f.root,f.config,{doc,bindings:true});assert.match(r.bindings['Spec-Refs'],/^FEAT-MAIN@1#/);}
});
test('unknown identity does not return an invented context',t=>{const f=fixture(t);assert.throws(()=>contextReport(f.root,f.config,{doc:'FEAT-NO'}),/Unknown/);});
test('Chinese short query works as literal text search without tokenization dependencies',t=>{
  const f=fixture(t);f.save(makeDoc({},BODY+'\n幂等用来描述重复提交。\n'));const r=contextReport(f.root,f.config,{query:'幂等'});assert.ok(r.matches.some(n=>n.id==='FEAT-MAIN'));
});
test('query text never executes regular expression syntax',t=>{const f=fixture(t);assert.equal(contextReport(f.root,f.config,{query:'.*'}).matches.length,0);});
test('dependency traversal finds explicit neighboring contracts',t=>{
  const f=fixture(t);f.put('lib/storage.mjs','export const save=()=>true;');f.save(moduleDoc());f.save(makeDoc({'Depends on':'C-STORAGE-001'}));
  const r=contextReport(f.root,f.config,{doc:'FEAT-MAIN',direction:'dependencies',depth:'5'});assert.ok(r.matches.some(n=>n.id==='MOD-STORAGE'));assert.ok(r.matches.some(n=>n.path==='lib/storage.mjs'));
});
test('reverse impact traversal reaches calling feature and evidence',t=>{
  const f=fixture(t);f.put('lib/storage.mjs','export const save=()=>true;');f.save(moduleDoc());const d=makeDoc({'Depends on':'MOD-STORAGE'});f.save({...d,text:d.text+record(d,f.baseline())});
  const r=contextReport(f.root,f.config,{doc:'MOD-STORAGE',direction:'impact',depth:'5'});assert.ok(r.matches.some(n=>n.id==='FEAT-MAIN'));assert.ok(r.matches.some(n=>n.id==='E-MAIN-001'));
});
test('ordinary hyperlinks are references, not inferred strong dependencies',t=>{
  const f=fixture(t);f.save(moduleDoc({Owns:'—'}));f.save(makeDoc({},BODY+'\n[Reading](../modules/storage.md)\n'));
  const snap=buildContext(f.root,f.config).snapshot;assert.ok(snap.edges.some(e=>e.kind==='reference'));
  const r=contextReport(f.root,f.config,{doc:'MOD-STORAGE',direction:'impact'});assert.ok(!r.matches.some(n=>n.id==='FEAT-MAIN'));
});
test('unresolved dependency gives a warning, not a fabricated node',t=>{
  const f=fixture(t);f.save(makeDoc({'Depends on':'MOD-UNKNOWN'}));const r=contextReport(f.root,f.config,{doc:'FEAT-MAIN'});assert.ok(r.warnings.some(x=>x.includes('unresolved')));assert.ok(!r.matches.some(n=>n.id==='MOD-UNKNOWN'));
});
test('duplicate identities require conflict resolution rather than arbitrary last writer',t=>{
  const f=fixture(t);f.save(makeDoc({},BODY,'docs/domains/calculation/features/copy.md'));assert.throws(()=>contextReport(f.root,f.config),/Duplicate context identity/);
});
test('history is opt-in and cannot create current evidence bindings',t=>{
  const f=fixture(t);f.save(makeDoc({Status:'superseded','Superseded by':'docs/next.md'}));assert.ok(!contextReport(f.root,f.config).matches.some(n=>n.id==='FEAT-MAIN'));
  assert.ok(contextReport(f.root,f.config,{history:true}).matches.some(n=>n.id==='FEAT-MAIN'));
  assert.throws(()=>contextReport(f.root,f.config,{doc:'FEAT-MAIN',history:true,bindings:true}),/current document/);
});
test('comparison detects source config and document changes plus additions and deletions',t=>{
  const f=fixture(t),before=buildContext(f.root,f.config).snapshot;
  f.put('src/new.mjs','new');fs.unlinkSync(path.join(f.root,'src/main.mjs'));f.save(makeDoc({Revision:'2'},BODY.replace('sum','difference')));
  f.put('.doc-driven.json',JSON.stringify({...f.config,language:'en'}));const after=buildContext(f.root,{...f.config,language:'en'}).snapshot;
  const c=compareContext(before,after);assert.equal(c.status,'changed');assert.ok(c.added.includes('src/new.mjs'));assert.ok(c.removed.includes('src/main.mjs'));assert.ok(c.modified.includes(FILE));assert.ok(c.modified.includes('.doc-driven.json'));
});
test('deleted owner or dependency remains in old/new impact union',t=>{
  const f=fixture(t);f.put('lib/storage.mjs','old');f.save(moduleDoc());f.save(makeDoc({'Depends on':'MOD-STORAGE'}));const before=buildContext(f.root,f.config).snapshot;
  fs.unlinkSync(path.join(f.root,'lib/storage.mjs'));const c=compareContext(before,buildContext(f.root,f.config).snapshot);assert.ok(c.affected.some(n=>n.id==='FEAT-MAIN'));
});
test('project rule edits are visible even though excluded from code snapshot',t=>{
  const f=fixture(t);f.put('AGENTS.md','original');const before=buildContext(f.root,f.config).snapshot;f.put('AGENTS.md','changed');const after=buildContext(f.root,f.config).snapshot;
  assert.equal(before.codeBaseline,after.codeBaseline);assert.ok(compareContext(before,after).modified.includes('AGENTS.md'));
});
test('unchanged context remains unchanged despite generatedAt differences',t=>{
  const f=fixture(t);const a=buildContext(f.root,f.config).snapshot,b=buildContext(f.root,f.config).snapshot;b.generatedAt='tomorrow';assert.equal(compareContext(a,b).status,'unchanged');
});
test('branch or commit change invalidates cached context even with same file content',t=>{
  const f=fixture(t);f.base();const a=buildContext(f.root,f.config).snapshot;git(f.root,['commit','--allow-empty','-qm','different context']);const b=buildContext(f.root,f.config).snapshot;
  assert.equal(compareContext(a,b).status,'changed');
});
test('snapshots cannot be silently reused across different worktrees',t=>{
  const f=fixture(t),g=fixture(t);assert.throws(()=>compareContext(buildContext(f.root,f.config).snapshot,buildContext(g.root,g.config).snapshot),/different worktree/);
});
test('out creates a new metadata snapshot without changing docs rules or config',t=>{
  const f=fixture(t);f.put('AGENTS.md','custom rules');const before=files(f.root),out='.doc-driven/context/start.json';const r=contextReport(f.root,f.config,{out});assert.equal(r.saved,out);
  for(const [p,v]of Object.entries(before))assert.equal(files(f.root)[p],v);
  const stored=JSON.parse(f.read(out));assert.equal(stored.kind,'ddd-context-v1');assert.equal(stored.reading,'not-assessed');assert.ok(!JSON.stringify(stored).includes('Return the sum of'));
});
test('writing snapshot does not change source/context fingerprint',t=>{
  const f=fixture(t),a=contextReport(f.root,f.config,{out:'.doc-driven/context/start.json'}),b=contextReport(f.root,f.config,{compare:'.doc-driven/context/start.json'});
  assert.equal(a.fingerprint,b.fingerprint);assert.equal(b.comparison.status,'unchanged');
});
for(const out of ['AGENTS.md','.doc-driven.json','docs/features/evil.json','../outside.json','.doc-driven/context/../../config.json'])test(`arbitrary output path rejected: ${out}`,t=>{
  const f=fixture(t),before=files(f.root);assert.throws(()=>contextReport(f.root,f.config,{out}),/--out must/);assert.deepEqual(files(f.root),before);
});
test('existing context or personal file is not overwritten even with a valid output name',t=>{
  const f=fixture(t),out='.doc-driven/context/start.json';f.put(out,'personal data');assert.throws(()=>contextReport(f.root,f.config,{out}),/EEXIST/);assert.equal(f.read(out),'personal data');
});
test('symlink output is refused and target contents retained',t=>{
  const f=fixture(t);f.put('personal.txt','retain');fs.mkdirSync(path.join(f.root,'.doc-driven/context'),{recursive:true});fs.symlinkSync(path.join(f.root,'personal.txt'),path.join(f.root,'.doc-driven/context/start.json'));
  assert.throws(()=>contextReport(f.root,f.config,{out:'.doc-driven/context/start.json'}),/Symbolic links/);assert.equal(f.read('personal.txt'),'retain');
});
test('snapshot comparison refuses invalid JSON shape',t=>{
  const f=fixture(t);f.put('.doc-driven/context/bad.json','{}');assert.throws(()=>contextReport(f.root,f.config,{compare:'.doc-driven/context/bad.json'}),/Not a valid/);
});
test('disabled projects cannot generate a context pretending to be active',t=>{const f=fixture(t);assert.throws(()=>contextReport(f.root,{...f.config,enabled:false}),/disabled/);});
test('secret filenames and tool cache are not included in context source candidates',t=>{
  const f=fixture(t);f.put('.env','TOKEN=private');f.put('secrets.json','private');f.put('.doc-driven/cache/private.txt','private');const snap=buildContext(f.root,f.config).snapshot;
  assert.ok(!Object.hasOwn(snap.files,'.env'));assert.ok(!Object.hasOwn(snap.files,'secrets.json'));assert.ok(!Object.hasOwn(snap.files,'.doc-driven/cache/private.txt'));
});
test('cycles terminate and depth/limit truncation is explicitly reported',()=>{
  const snap={edges:[{from:'A',to:'B',kind:'depends-on'},{from:'B',to:'C',kind:'depends-on'},{from:'C',to:'A',kind:'depends-on'}]};
  assert.equal(walkGraph(snap,['A'],{direction:'dependencies',depth:5}).results.length,3);
  assert.equal(walkGraph(snap,['A'],{direction:'dependencies',depth:1}).truncated,true);
  assert.equal(walkGraph(snap,['A'],{direction:'dependencies',depth:5,limit:2}).truncated,true);
});
for(const options of [{depth:'0'},{limit:'301'},{depth:'1.5'},{doc:'FEAT-MAIN',direction:'reverse'},{bindings:true},{direction:'impact'},{query:' '}])test(`invalid query options fail: ${JSON.stringify(options)}`,t=>{
  const f=fixture(t);assert.throws(()=>contextReport(f.root,f.config,options));
});
test('CLI outputs JSON and never promotes snapshot to reading or verification',t=>{
  const f=fixture(t),result=spawnSync(process.execPath,[path.join(PKG,'scripts/context.mjs'),f.root,'--doc','FEAT-MAIN','--bindings'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).reading,'not-assessed');assert.match(JSON.parse(result.stdout).bindings['Spec-Refs'],/^FEAT-MAIN@1#/);
});

test('context cache does not invalidate itself by making a Git tree dirty',t=>{
  const f=fixture(t);f.base();const a=contextReport(f.root,f.config,{out:'.doc-driven/context/start.json'});
  const b=contextReport(f.root,f.config,{compare:'.doc-driven/context/start.json'});assert.equal(a.fingerprint,b.fingerprint);assert.equal(b.comparison.status,'unchanged');
});

test('switching branches at the same commit still refreshes context',t=>{
  const f=fixture(t);f.base();const a=buildContext(f.root,f.config).snapshot;git(f.root,['checkout','-qb','another-context']);
  const b=buildContext(f.root,f.config).snapshot;assert.equal(a.git.head,b.git.head);assert.notEqual(a.git.branch,b.git.branch);assert.equal(compareContext(a,b).status,'changed');
});
