#!/usr/bin/env node
// Preview by default; project commands require --run and the reviewed plan hash.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCLI, rootDir, loadConfig } from './lib.mjs';
import { runAsyncCLI } from './run-process.mjs';
import { previewPlan, runVerification, checkRun, receiptEvidence } from './verification.mjs';
import { receiptSummary } from './receipt-view.mjs';
async function main(){
  const a=parseCLI(process.argv.slice(2),{'--plan':'value','--run':'flag','--expect-plan':'value','--report':'value','--evidence':'flag','--summary':'flag','--json':'flag'});
  if(a.flags.help){console.log(`Usage:
  node verify.mjs [repo] --plan docs/changes/task.verify.json [--json]
  node verify.mjs [repo] --plan docs/changes/task.verify.json --run --expect-plan HASH [--json]
  node verify.mjs [repo] --report .doc-driven/verification/runs/ID/run.json [--plan PATH] [--json | --summary | --evidence]
Preview/report are read-only. --run executes reviewed project commands with bounded output/time, no implicit shell, no auto-install/migration/cleanup, and no sandbox.
--summary prints a human-readable result and one pinned header reference; never edits documents.
--evidence is the legacy full Markdown export, optional for runner-v1. Exit 0: selected action passed; 1: failed/blocked/stale/manual; 2: invocation/config error.`);return;}
  if((a.flags.evidence || a.flags.summary) && (!a.flags.report || a.flags.json || a.flags.run || (a.flags.evidence && a.flags.summary)))throw new Error('--summary/--evidence require --report and exclude each other, --json and --run.');
  if(a.flags.run && (a.flags.report || !a.flags.plan))throw new Error('--run requires --plan and excludes --report.');
  if(a.flags['expect-plan'] && !a.flags.run)throw new Error('--expect-plan only applies to --run.');
  const root=rootDir(a.root),config=loadConfig(root);let result;
  if(a.flags.report){
    if(a.flags.summary){const s=receiptSummary(root,config,a.flags.report,{plan:a.flags.plan});console.log(s.text);if(s.errors.length)process.exitCode=1;return;}
    if(a.flags.evidence){const v=checkRun(root,config,a.flags.report,{plan:a.flags.plan});if(v.errors.length){console.error(v.errors.join('\n'));process.exitCode=1;return;}console.log(receiptEvidence(root,config,a.flags.report));return;}
    result=checkRun(root,config,a.flags.report,{plan:a.flags.plan});if(result.errors.length)process.exitCode=1;
  }else if(a.flags.plan){
    if(a.flags.run){result=await runVerification(root,config,a.flags.plan,{expectPlan:a.flags['expect-plan']});if(result.report.status!=='passed')process.exitCode=1;}
    else result=previewPlan(root,config,a.flags.plan);
  }else throw new Error('Select --plan or --report.');
  if(a.flags.json){console.log(JSON.stringify(result,null,2));return;}
  if(result.execution==='not-run'){
    console.log(`${result.name}：仅预览，未运行、未写入。\n计划指纹：${result.planHash}`);
    for(const c of result.checks){console.log(`- ${c.name}：${c.scenario}`);if(c.command)console.log(`  命令：${JSON.stringify(c.command)}`);if(c.missingEnv.length)console.log(`  缺少环境：${c.missingEnv.join(', ')}`);}
    console.log('核对实际命令、环境、资源和已有授权后，使用 --run --expect-plan 指纹 执行；不要把预览当验证通过。');
  }else{
    const r=result.report, labels={passed:'已验证（本次约定场景）',failed:'验证失败',blocked:'环境或依赖受阻',stale:'证据过期',invalid:'报告无法判定','manual-required':'待人工验收','timed-out':'超时',interrupted:'已中断'};
    console.log(`${r?.name??'验证记录'}：${result.errors?.length?'当前不能认定已验证':labels[r?.status]??r?.status}`);
    for(const x of r?.results??[])console.log(`- ${x.name}：${labels[x.status]??x.status}；${x.reason}`);
    if(result.path)console.log(`实际运行记录：${result.path}`);
    for(const e of result.errors??[])console.error(`FAIL ${e}`);
    console.log('本地自动采证不是防篡改证明；断言充分性、真实批准与外部环境仍需评审。');
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runAsyncCLI(main);
