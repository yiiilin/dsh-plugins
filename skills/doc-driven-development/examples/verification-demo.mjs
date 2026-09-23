#!/usr/bin/env node
// Real, isolated behavior demonstration. Creates only an explicitly NEW directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseCLI,DEFAULTS,header,updateIndex} from '../scripts/lib.mjs';
import {specRef} from '../scripts/contract.mjs';
import {previewPlan,runVerification,checkRun} from '../scripts/verification.mjs';
import {runAsyncCLI} from '../scripts/run-process.mjs';
async function main(){
 const a=parseCLI(process.argv.slice(2),{'--out':'value','--run':'flag'});
 if(a.flags.help||!a.flags.run){console.log('Isolated demonstration: disconnected entry fails; real wiring passes; specification drift invalidates evidence; SKIP+ok fails.\nRun explicitly: node examples/verification-demo.mjs --run --out NEW_DIRECTORY\nNo network, models, database or Docker; existing directories are refused.');return;}
 if(!a.flags.out)throw new Error('--out NEW_DIRECTORY is required.');const root=path.resolve(a.flags.out);if(fs.existsSync(root))throw new Error('Refusing an existing output directory.');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const put=(rel,s)=>{const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
 const docPath='docs/domains/calculation/features/sum.md',planPath='docs/changes/sum.verify.json';
 let text='# 求和演示（合成规格，不是用户授权）\n\nDoc-ID: FEAT-DEMO\nType: feature\nRevision: 1\nStatus: proposed\nBaseline: unknown\nOwns: src/**, tests/**\nImplementation: partial\nVerification: not-run\n\n## 需求说明\n### R-DEMO-001 正式入口求和\nrun(7,2) 返回 9，必须通过正式入口而不是仅测试内部组件。\n';
 put('.doc-driven.json',JSON.stringify(DEFAULTS));put(docPath,text);updateIndex(root,DEFAULTS);
 put('src/component.mjs','export const add=(a,b)=>a+b;\n');put('src/entry.mjs','export const run=()=>null;\n');
 const testText="import test from 'node:test';import assert from 'node:assert/strict';import {run} from '../src/entry.mjs';test('入口返回求和结果',()=>assert.equal(run(7,2),9));\n";put('tests/entry.test.mjs',testText);
 const plan={kind:'ddd-verification-plan-v1',schemaVersion:1,name:'计算 / 正式入口 / 求和',authorization:{mode:'verify',source:'Synthetic demonstration; explicit --run creates and executes only this new fixture'},specRefs:[specRef({path:docPath,text,fields:header(text).fields})],environment:{name:'Local disposable demo',scope:'isolated',resources:'Only this new directory, no external resources',limitations:'Not a real user project or agent evaluation'},checks:[{id:'entry',name:'正式入口返回正确求和',kind:'test',level:'acceptance',alsoLevels:['integration'],covers:['R-DEMO-001'],scenario:'Through run(7,2), observe 9',command:{executable:'node',args:['--test','--test-reporter={skill}/scripts/node-reporter.mjs','tests/entry.test.mjs']},parser:'json-v1',requiredCases:['入口返回求和结果'],inputs:['tests/entry.test.mjs','src/entry.mjs'],timeoutMs:10000}]};
 put(planPath,JSON.stringify(plan,null,2));const run=()=>runVerification(root,DEFAULTS,planPath,{expectPlan:previewPlan(root,DEFAULTS,planPath).planHash});
 const broken=await run();assert.equal(broken.report.status,'failed');
 put('src/entry.mjs',"import {add} from './component.mjs';export const run=add;\n");const wired=await run();assert.equal(wired.report.status,'passed');assert.deepEqual(checkRun(root,DEFAULTS,wired.path).errors,[]);
 put(docPath,text.replace('Revision: 1','Revision: 2').replace('返回 9','返回 5'));const stale=checkRun(root,DEFAULTS,wired.path);assert.ok(stale.errors.length);put(docPath,text);
 put('tests/entry.test.mjs',"import test from 'node:test';test('入口返回求和结果',{skip:'demo missing database'},()=>{});\n");const skipped=await run();assert.equal(skipped.report.results[0].process.exitCode,0);assert.equal(skipped.report.status,'failed');
 put('tests/entry.test.mjs',testText);const final=await run();assert.equal(final.report.status,'passed');
 const result={kind:'ddd-real-demo-v1',root,disconnected:broken.path,connected:wired.path,specificationChanged:stale.errors,skipExitZero:skipped.path,final:final.path,agentEvaluation:'not-run'};
 put('.doc-driven/demo-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runAsyncCLI(main);
