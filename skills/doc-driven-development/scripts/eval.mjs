#!/usr/bin/env node
// Explicit, bounded host-adapter evaluation. Never pretends a fixture is a model.
// Workspace separation is NOT an OS sandbox. Run untrusted hosts in external isolation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseCLI, safePath, validateRel, sha, globRE } from './lib.mjs';
import { execute, restrictedEnv, executable, redact, runAsyncCLI, fileHash } from './run-process.mjs';
import { PACKAGE } from './verification.mjs';
const ensure=(x,m)=>{if(!x)throw new Error(m);};
function read(file){const s=fs.lstatSync(file);ensure(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<8*1024*1024,'Expected regular bounded JSON.');return JSON.parse(fs.readFileSync(file,'utf8'));}
function tree(root){
 const entries=[];
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name),rel=path.relative(root,p).split(path.sep).join('/');ensure(!e.isSymbolicLink(),'Eval fixture/workspace symlinks are not followed.');if(e.isDirectory())walk(p);else{ensure(e.isFile(),'No special files in eval trees.');const s=fs.lstatSync(p);ensure(s.nlink===1 && s.size<=8*1024*1024,'Eval file too large or hard-linked.');entries.push([rel,fileHash(p)]);}}};walk(root);return entries;
}
function copyTree(from,to){fs.mkdirSync(to,{recursive:true,mode:0o700});for(const [rel]of tree(from)){const dest=safePath(to,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(safePath(from,rel),dest,fs.constants.COPYFILE_EXCL);}}
const write=(file,value)=>fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export function evalPreview({suite,adapter,skill=PACKAGE,repeats=1}){
 const suiteFile=path.resolve(suite),adapterFile=path.resolve(adapter),s=read(suiteFile),a=read(adapterFile),base=path.dirname(suiteFile),adapterBase=path.dirname(adapterFile);
 ensure(s.kind==='ddd-eval-suite-v1' && Array.isArray(s.cases)&&s.cases.length>0&&s.cases.length<=50,'Expected bounded ddd-eval-suite-v1.');
 ensure(a.kind==='ddd-eval-adapter-v1' && ['real-host','fixture'].includes(a.mode),'Adapter must honestly declare real-host or fixture mode.');
 ensure(a.name && a.command?.executable && Array.isArray(a.command.args)&&a.command.args.every(x=>typeof x==='string'),'Adapter needs name and argument-array command.');
 ensure(Number.isInteger(a.timeoutMs)&&a.timeoutMs>=50&&a.timeoutMs<=3600000,'Adapter timeoutMs required.');
 ensure(Array.isArray(a.inputs)&&a.inputs.length,'Bind adapter implementation inputs.');
 for(const rel of a.inputs)validateRel(rel);
 ensure(Number.isInteger(repeats)&&repeats>=1&&repeats<=10,'repeats must be 1–10; higher budgets need a separate approved run.');
 ensure(!a.passEnv || (Array.isArray(a.passEnv)&&a.passEnv.every(n=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)&&!n.startsWith('DDD_'))),'Invalid adapter passEnv.');
 const names=new Set(),materials=[];
 const graderInputs=s.graderInputs??[];ensure(Array.isArray(graderInputs),'graderInputs must be an array.');graderInputs.forEach(validateRel);
 for(const c of s.cases){
  ensure(/^[a-z][a-z0-9-]{0,63}$/.test(c.id??'')&&!names.has(c.id),'Each case needs unique safe id.');names.add(c.id);
  ensure(c.title && Array.isArray(c.turns)&&c.turns.length>0&&c.turns.every(t=>typeof t==='string'&&t.trim()),'Case needs title and actual scripted user turns.');
  validateRel(c.seed);const seed=safePath(base,c.seed);ensure(fs.statSync(seed).isDirectory(),'Case seed missing.');materials.push([c.id,tree(seed)]);
  ensure(Array.isArray(c.writePaths)&&c.writePaths.length,'Declare allowed change paths; use a specific read-only case list when needed.');c.writePaths.forEach(globRE);
  ensure(Array.isArray(c.graders)&&c.graders.length,'Each case needs objective graders.');
  for(const g of c.graders){ensure(g.name&&['unchanged','contains','absent','command'].includes(g.kind),'Unknown grader.');
   if(g.kind==='command'){ensure(g.command?.executable && Array.isArray(g.command.args)&&g.command.args.every(x=>typeof x==='string') && Number.isInteger(g.timeoutMs)&&g.timeoutMs>=50&&g.timeoutMs<=60000,'Command grader needs bounded command.');}
   else {validateRel(g.path);if(g.kind==='contains')ensure(typeof g.text==='string'&&g.text.length,'Contains grader needs expected text.');}
  }
 }
 const skillRoot=fs.realpathSync(skill);ensure(fs.existsSync(safePath(skillRoot,'SKILL.md')),'Skill source must be a complete readable directory.');
 const identity={suite:sha(fs.readFileSync(suiteFile)),fixtures:materials,graderInputs:graderInputs.map(rel=>[rel,fileHash(safePath(base,rel))]),harness:fileHash(fileURLToPath(import.meta.url)),adapter:sha(fs.readFileSync(adapterFile)),adapterInputs:a.inputs.map(rel=>[rel,fileHash(safePath(adapterBase,rel))]),skill:tree(skillRoot),repeats};
 return {kind:'ddd-eval-preview-v1',name:s.name,mode:a.mode,hash:sha(JSON.stringify(identity)),suite:suiteFile,adapter:adapterFile,skill:skillRoot,repeats,trials:s.cases.length*repeats,execution:'not-run',s,a,base,adapterBase,identity};
}
export async function runEval(options){
 const p=evalPreview(options);ensure(options.expect===p.hash,'--expect-suite must match preview, including adapter, fixtures, skill and repeat budget.');
 const out=path.resolve(options.out);
 ensure(out!==p.skill && !out.startsWith(p.skill+path.sep),'Output cannot be inside the selected skill.');
 for(const c of p.s.cases){const seed=safePath(p.base,c.seed);ensure(out!==seed && !out.startsWith(seed+path.sep),'Output cannot be inside a seed fixture.');}
 ensure(!fs.existsSync(out),'Eval --out must be a new directory; previous trials are never overwritten.');
 // Refuse existing symlink ancestors before creating the output tree.
 let ancestor=path.parse(out).root;for(const part of out.slice(ancestor.length).split(path.sep).filter(Boolean)){ancestor=path.join(ancestor,part);if(fs.existsSync(ancestor))ensure(!fs.lstatSync(ancestor).isSymbolicLink(),'Output ancestors cannot be symlinks.');}
 fs.mkdirSync(out,{recursive:true,mode:0o700});write(path.join(out,'preview.json'),{...p,s:undefined,a:undefined,base:undefined,adapterBase:undefined});
 const results=[],secretNames=p.a.passEnv??[];const clean=s=>redact(s,secretNames);
 trials: for(const c of p.s.cases)for(let repeat=1;repeat<=p.repeats;repeat++){
  // Do not continue after an adapter, fixture or skill source changed mid-experiment.
  ensure(evalPreview(options).hash===p.hash,'Evaluation material changed between trials; preserve partial output and start a fresh comparison.');
  const id=`${c.id}-${repeat}`,dir=path.join(out,id),workspace=path.join(dir,'workspace');fs.mkdirSync(dir,{mode:0o700});copyTree(safePath(p.base,c.seed),workspace);
  const before=tree(workspace),runId=crypto.randomBytes(16).toString('hex');
  const request={kind:'ddd-agent-request-v1',runId,workspace,skillSource:p.skill,task:c.title,turns:c.turns,writePaths:c.writePaths,
   boundaries:'Read the selected skill. Preserve existing project rules. Execute only this task. Do not edit graders or evidence outside workspace. Respect design-only/hold instructions. Return actual transcript and usage if provided by host.'};
  const reqPath=path.join(dir,'request.json'),resPath=path.join(dir,'response.json');write(reqPath,request);
  const args=p.a.command.args.map(x=>x.replaceAll('{request}',reqPath).replaceAll('{response}',resPath).replaceAll('{workspace}',workspace).replaceAll('{adapter}',p.adapterBase));
  let proc;
  try{proc=await execute({command:executable(p.adapterBase,p.a.command.executable),args,cwd:workspace,env:restrictedEnv(secretNames,{DDD_EVAL_REQUEST:reqPath,DDD_EVAL_RESPONSE:resPath}),timeoutMs:p.a.timeoutMs,maxOutputBytes:4*1024*1024});}
  catch(e){proc={exitCode:null,error:e.message,reason:null,stdout:'',stderr:'',durationMs:0};}
  write(path.join(dir,'host.stdout.log'),clean(proc.stdout));write(path.join(dir,'host.stderr.log'),clean(proc.stderr));
  let response=null,adapterError=null;
  try{response=read(resPath);ensure(response.kind==='ddd-agent-response-v1' && response.runId===runId && response.mode===p.a.mode && Array.isArray(response.turns)&&response.turns.length===c.turns.length && response.turns.every(t=>typeof t.response==='string'), 'Adapter must return the actual per-turn transcript, matching mode and nonce.');}
  catch(e){adapterError=e.message;}
  // Adapter output is untrusted data, never an instruction to execute another command.
  const grades=[],changed=[];
  try{
   ensure(evalPreview(options).hash===p.hash,'Host changed fixtures, grader, adapter or skill materials; do not trust this trial.');
   const after=tree(workspace),old=new Map(before),now=new Map(after);
   for(const rel of new Set([...old.keys(),...now.keys()]))if(old.get(rel)!==now.get(rel))changed.push(rel);
   const unauthorized=changed.filter(rel=>!c.writePaths.some(g=>globRE(g).test(rel)));
   grades.push({name:'Changes stay inside allowed paths',passed:!unauthorized.length,detail:unauthorized});
   for(let gi=0;gi<c.graders.length;gi++){
    const g=c.graders[gi];let passed=false,detail='';
    if(g.kind==='unchanged')passed=old.has(g.path)&&old.get(g.path)===now.get(g.path);
    if(g.kind==='absent')passed=!fs.existsSync(safePath(workspace,g.path));
    if(g.kind==='contains'){const f=safePath(workspace,g.path);passed=fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes(g.text);}
    if(g.kind==='command'){
     const command=executable(p.base,g.command.executable),argv=g.command.args.map(x=>x.replaceAll('{workspace}',workspace).replaceAll('{suite}',p.base));
     const r=await execute({command,args:argv,cwd:workspace,env:restrictedEnv(),timeoutMs:g.timeoutMs,maxOutputBytes:2*1024*1024});
     passed=r.exitCode===0&&!r.reason&&!r.error;detail={exitCode:r.exitCode,reason:r.reason,error:r.error};
     write(path.join(dir,`grader-${gi}.log`),clean(r.stdout+r.stderr));
    }
    grades.push({name:g.name,passed,detail});
   }
  }catch(e){grades.push({name:'Workspace inspection',passed:false,detail:e.message});}
  if(response){const file=safePath(dir,'response.json');const st=fs.lstatSync(file);ensure(st.isFile()&&st.nlink===1&&!st.isSymbolicLink(),'Unsafe adapter response.');fs.writeFileSync(file,clean(JSON.stringify(response,null,2)+'\n'),{mode:0o600});}
  const hostOK=proc.exitCode===0&&!proc.reason&&!proc.error&&!adapterError;
  const result={id,title:c.title,repeat,mode:p.a.mode,hostCompleted:hostOK,mechanicalOutcome:hostOK&&grades.every(g=>g.passed)?'passed':'failed',
    grades,changedPaths:changed,adapterError,process:{exitCode:proc.exitCode,reason:proc.reason,error:proc.error,durationMs:proc.durationMs},
    identity:response?.identity??null,usage:response?.usage??null,usageSource:'adapter-reported; not independently billed',
    manualRubric:c.manualRubric??[],manualAssessment:'not-run',transcript:response?.turns??null};
  write(path.join(dir,'trial.json'),clean(JSON.stringify(result,null,2)+'\n'));results.push(result);
  // Raw adapter response may contain private content. The harness does not auto-delete
  // evidence; document local-only handling and user-controlled retention.
  if(proc.reason==='interrupted')break trials;
 }
 const summary={kind:'ddd-eval-results-v1',mode:p.a.mode,suite:p.name,materialHash:p.hash,skill:path.basename(p.skill),repeats:p.repeats,trials:results.length,
  mechanicallyPassed:results.filter(r=>r.mechanicalOutcome==='passed').length,hostFailures:results.filter(r=>!r.hostCompleted).length,
  realAgentEfficacy:p.a.mode==='fixture'?'not-assessed; fixture plumbing only':'requires transcript/manual assessment; adapter identity is not authenticated',
  manualAssessment:'not-run',cost:'per-trial adapter-reported usage or null; no invented savings',results};
 write(path.join(out,'results.json'),clean(JSON.stringify(summary,null,2)+'\n'));return summary;
}
async function main(){
 const a=parseCLI(process.argv.slice(2),{'--suite':'value','--adapter':'value','--skill':'value','--repeats':'value','--out':'value','--run':'flag','--expect-suite':'value','--json':'flag'});
 if(a.flags.help){console.log('Usage: node eval.mjs --suite suite.json --adapter adapter.json [--skill FULL_PACKAGE] [--repeats N] [--json]\nExecution additionally needs --run --expect-suite HASH --out NEW_DIRECTORY.\nNo network/SDK/model is built in. Adapter must invoke the actual authorized host. Fixture mode is never a real-agent benchmark. Graders inspect final files and actual command results; qualitative rubrics remain manual. Not an OS sandbox.');return;}
 ensure(a.flags.suite&&a.flags.adapter,'--suite and --adapter are required.');
 const options={suite:a.flags.suite,adapter:a.flags.adapter,skill:a.flags.skill??PACKAGE,repeats:a.flags.repeats?Number(a.flags.repeats):1,out:a.flags.out,expect:a.flags['expect-suite']};
 if(a.flags.run){ensure(options.out,'--out is required for execution.');const r=await runEval(options);console.log(a.flags.json?JSON.stringify(r,null,2):`${r.suite}: ${r.mechanicallyPassed}/${r.trials} mechanical trials; mode=${r.mode}; qualitative review not-run. Results: ${path.resolve(options.out)}/results.json`);if(r.mechanicallyPassed!==r.trials)process.exitCode=1;}
 else{ensure(!a.flags.out&&!a.flags['expect-suite'],'Preview does not accept --out or --expect-suite.');const r=evalPreview(options);const view={...r,s:undefined,a:undefined,base:undefined,adapterBase:undefined};console.log(a.flags.json?JSON.stringify(view,null,2):`${r.name}: preview only; ${r.trials} trials; mode=${r.mode}\nMaterial hash: ${r.hash}\nNo models or commands invoked.`);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runAsyncCLI(main);
