// Host adapter protocol tests only. Every adapter here declares fixture mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {evalPreview,runEval} from '../scripts/eval.mjs';
import {PACKAGE} from '../scripts/verification.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ddd-eval-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=(p,text)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),text);};
 put('seed/AGENTS.md','# Keep original\n');put('seed/src/main.mjs','export const answer=()=>null;\n');
 put('grader.mjs',"import assert from 'node:assert/strict'; const m=await import(process.argv[2]+'/src/main.mjs');assert.equal(m.answer(),9);\n");
 const adapterCode=`import fs from 'node:fs';const q=JSON.parse(fs.readFileSync(process.env.DDD_EVAL_REQUEST));fs.writeFileSync(q.workspace+'/src/main.mjs','export const answer=()=>9;\\n');fs.writeFileSync(process.env.DDD_EVAL_RESPONSE,JSON.stringify({kind:'ddd-agent-response-v1',runId:q.runId,mode:'fixture',identity:{host:'fixture',model:null},turns:q.turns.map(()=>({response:'Synthetic response, not a model'})),usage:null}));`;
 put('adapter.mjs',adapterCode);
 const suite={kind:'ddd-eval-suite-v1',name:'Fixture adapter protocol',graderInputs:['grader.mjs'],cases:[{id:'implementation',title:'Implement sum behavior',seed:'seed',turns:['Implement answer returning 9','Use the confirmed design; finish it'],writePaths:['src/**'],graders:[{name:'Rules preserved',kind:'unchanged',path:'AGENTS.md'},{name:'Actual behavior',kind:'command',command:{executable:'node',args:['{suite}/grader.mjs','{workspace}']},timeoutMs:5000}],manualRubric:['Did the real agent avoid redundant confirmation? This fixture does not assess it.']}]};
 const adapter={kind:'ddd-eval-adapter-v1',name:'Fixture only',mode:'fixture',inputs:['adapter.mjs'],command:{executable:'node',args:['{adapter}/adapter.mjs']},timeoutMs:5000};
 const save=()=>{put('suite.json',JSON.stringify(suite));put('adapter.json',JSON.stringify(adapter));};save();
 const opts={suite:path.join(root,'suite.json'),adapter:path.join(root,'adapter.json'),skill:PACKAGE,out:path.join(root,'results')};
 return {root,put,suite,adapter,save,opts,adapterCode,run:()=>runEval({...opts,expect:evalPreview(opts).hash})};
}
test('eval preview neither launches adapter nor writes workspace',t=>{const f=fixture(t);const p=evalPreview(f.opts);assert.equal(p.execution,'not-run');assert.equal(p.mode,'fixture');assert.ok(!fs.existsSync(f.opts.out));});
test('actual fixture adapter and independent program grader execute, never claim model success',async t=>{const f=fixture(t);const r=await f.run();assert.equal(r.mechanicallyPassed,1,JSON.stringify(r));assert.equal(r.mode,'fixture');assert.match(r.realAgentEfficacy,/not-assessed/);assert.equal(r.manualAssessment,'not-run');assert.equal(r.results[0].transcript.length,2);assert.equal(r.results[0].usage,null);});
test('missing reviewed material hash refuses before writes',async t=>{const f=fixture(t);await assert.rejects(runEval({...f.opts,expect:'old'}),/expect-suite/);assert.ok(!fs.existsSync(f.opts.out));});
test('eval never overwrites prior trial outputs',async t=>{const f=fixture(t);fs.mkdirSync(f.opts.out);await assert.rejects(f.run(),/new directory/);});
test('lying adapter summary does not override independent failing program',async t=>{const f=fixture(t);f.put('adapter.mjs',f.adapterCode.replace('answer=()=>9','answer=()=>null'));const r=await f.run();assert.equal(r.mechanicallyPassed,0);assert.equal(r.results[0].hostCompleted,true);});
test('unauthorized edits fail even when runtime behavior passes',async t=>{const f=fixture(t);f.put('adapter.mjs',f.adapterCode+"fs.writeFileSync(q.workspace+'/AGENTS.md','Overwritten');");const r=await f.run();assert.equal(r.mechanicallyPassed,0);assert.ok(r.results[0].changedPaths.includes('AGENTS.md'));});
test('adapter cannot quietly claim a real model while declared as fixture',async t=>{const f=fixture(t);f.put('adapter.mjs',f.adapterCode.replace("mode:'fixture'","mode:'real-host'"));const r=await f.run();assert.equal(r.mechanicallyPassed,0);assert.match(r.results[0].adapterError,/matching mode/);});
test('missing transcript is an adapter failure rather than model pass',async t=>{const f=fixture(t);f.put('adapter.mjs',"console.log('done')");const r=await f.run();assert.equal(r.hostFailures,1);});
test('repeat trials use fresh workspaces and preserve each result',async t=>{const f=fixture(t);f.opts.repeats=2;const r=await f.run();assert.equal(r.trials,2);assert.equal(r.mechanicallyPassed,2);assert.ok(fs.existsSync(path.join(f.opts.out,'implementation-1/trial.json')));assert.ok(fs.existsSync(path.join(f.opts.out,'implementation-2/trial.json')));});
test('adapter timeout recorded as infrastructure/host failure',async t=>{const f=fixture(t);f.adapter.timeoutMs=80;f.save();f.put('adapter.mjs','setInterval(()=>{},1000);');const r=await f.run();assert.equal(r.hostFailures,1);assert.equal(r.results[0].process.reason,'timeout');});
test('old nonce response cannot be reused for another trial',async t=>{const f=fixture(t);f.put('adapter.mjs',f.adapterCode.replace('runId:q.runId',"runId:'stale'"));const r=await f.run();assert.equal(r.hostFailures,1);});
test('fixture path traversal is rejected',t=>{const f=fixture(t);f.suite.cases[0].seed='../outside';f.save();assert.throws(()=>evalPreview(f.opts),/relative/);});
test('grader source changes are part of material fingerprint',t=>{const f=fixture(t);const before=evalPreview(f.opts).hash;f.put('grader.mjs','process.exit(0)');assert.notEqual(evalPreview(f.opts).hash,before);});
test('adapter changes to external grader cannot produce a valid result',async t=>{const f=fixture(t);f.put('adapter.mjs',f.adapterCode+`fs.writeFileSync(${JSON.stringify(path.join(f.root,'grader.mjs'))},'process.exit(0)');`);const r=await f.run();assert.equal(r.mechanicallyPassed,0);assert.match(JSON.stringify(r.results[0].grades),/changed fixtures/);});
test('unknown adapter mode is not silently treated as actual model',t=>{const f=fixture(t);f.adapter.mode='auto';f.save();assert.throws(()=>evalPreview(f.opts),/declare/);});
