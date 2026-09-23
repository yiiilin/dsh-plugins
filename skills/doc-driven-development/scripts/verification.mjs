// Executable verification contracts and local run receipts. Not signed attestations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION, safePath, validateRel, sha, documents, inventory, loadConfig } from './lib.mjs';
import { specRef, parseSpecRefs, meaningful } from './contract.mjs';
import { itemHeadings } from './identity.mjs';
import { execute, executable, restrictedEnv, redact, fileHash } from './run-process.mjs';
import { judge } from './test-results.mjs';

export const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = '.doc-driven/verification/runs';
const LOCK = '.doc-driven/verification.lock';
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const LEVELS = ['component','integration','acceptance','regression','static'];
const STRINGS = v => Array.isArray(v) && v.every(x=>typeof x==='string' && x.trim());
const ownKeys = (o, allowed, label) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${label} must be an object.`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${label}: unknown field ${k}`);
};
const demand = (yes, message) => {if (!yes) throw new Error(message);};
const unique = (values,label) => {demand(STRINGS(values) && new Set(values).size===values.length,`${label} must be unique nonempty strings.`);};
export function regular(root, rel, max = 8*1024*1024) {
  const file = safePath(root,rel), s = fs.lstatSync(file);
  demand(s.isFile() && s.nlink===1 && s.size<=max,`Expected bounded regular non-hard-linked file: ${rel}`);
  return file;
}
function inputPath(root, rel) {
  return rel.startsWith('@skill/') ? regular(PACKAGE,rel.slice(7),64*1024*1024) : regular(root,rel,64*1024*1024);
}
function validateInput(rel) {validateRel(rel.startsWith('@skill/')?rel.slice(7):rel);}
function hashInput(root,rel) { try {return {path:rel,sha256:fileHash(inputPath(root,rel))};} catch(e) {return {path:rel,missing:e.message};} }
function toolHash() {
  return sha(JSON.stringify(['verification.mjs','verify.mjs','run-process.mjs','test-results.mjs','node-reporter.mjs','contract.mjs','identity.mjs','lib.mjs','design-check.mjs']
    .map(n=>[n,fileHash(path.join(PACKAGE,'scripts',n))])));
}
export function loadPlan(root, config, rel) {
  demand(config.enabled,'Workflow disabled; a skipped verification is not a pass.');
  demand(rel.endsWith('.json') && config.docsRoots.some(r=>rel.startsWith(`${r}/`)), 'Verification plan must be a JSON file under docsRoots.');
  const bytes=fs.readFileSync(regular(root,rel)), p=JSON.parse(bytes.toString('utf8'));
  ownKeys(p,['kind','schemaVersion','name','authorization','specRefs','selectedItems','scopeSource','environment','checks'],'plan');
  demand(p.kind==='ddd-verification-plan-v1' && p.schemaVersion===1,'Expected ddd-verification-plan-v1, schemaVersion 1.');
  demand(meaningful(p.name) && !/[\r\n]/.test(p.name),'Plan needs a single-line human-readable name.');
  ownKeys(p.authorization,['mode','source'],'authorization');
  demand(['verify','implement','design-only','hold'].includes(p.authorization.mode) && meaningful(p.authorization.source),'Record verification/implementation intent and actual source.');
  ownKeys(p.environment,['name','scope','resources','limitations'],'environment');
  demand(meaningful(p.environment.name) && !/[\r\n]/.test(p.environment.name) && ['isolated','local'].includes(p.environment.scope) && meaningful(p.environment.resources) && meaningful(p.environment.limitations),
    'Environment needs name, local/isolated scope, resource boundaries and limitations. Production execution is not supported.');
  unique(p.specRefs,'specRefs'); demand(p.specRefs.length>0,'Bind at least one specification.');
  const {docs}=documents(root,config), byId=new Map(), itemDocs=new Map();
  for (const d of docs.filter(d=>d.fields.Status!=='superseded')) {
    demand(!byId.has(d.fields['Doc-ID']),`Duplicate Doc-ID: ${d.fields['Doc-ID']}`); byId.set(d.fields['Doc-ID'],d);
    const parsed=itemHeadings(d.text); demand(!parsed.errors.length,`${d.path}: ${parsed.errors.join('; ')}`);
    for(const h of parsed.headings.filter(h=>/^[RC]-/.test(h.id??''))) {
      demand(!itemDocs.has(h.id),`Duplicate requirement: ${h.id}`); itemDocs.set(h.id,{doc:d,title:h.label});
    }
  }
  const ids=new Set(), bound=[];
  for(const value of p.specRefs) {
    const refs=parseSpecRefs(value); demand(refs.length===1,'One binding per specRefs element.'); const ref=refs[0],d=byId.get(ref.id);
    demand(d && specRef(d)===value,`Specification missing/stale: ${ref.id}. Review the change before updating the plan.`);
    demand(!ids.has(ref.id),`Duplicate bound document: ${ref.id}`); ids.add(ref.id); bound.push(d);
  }
  let required=[...itemDocs].filter(([,v])=>ids.has(v.doc.fields['Doc-ID'])).map(([id])=>id);
  demand(required.length>0,'Bound specifications must define requirements/constraints.');
  if(p.selectedItems!==undefined) {
    unique(p.selectedItems,'selectedItems'); demand(p.selectedItems.length && meaningful(p.scopeSource),'Partial scope requires actual scopeSource.');
    demand(p.selectedItems.every(x=>required.includes(x)),'selectedItems outside bound scope.'); required=p.selectedItems;
  }
  demand(Array.isArray(p.checks) && p.checks.length>0 && p.checks.length<=100,'Need 1–100 checks.');
  const seen=new Set(), covered=new Set();
  for(const c of p.checks) {
    ownKeys(c,['id','name','kind','level','covers','scenario','command','parser','requiredCases','optionalCases','optionalReason','requiresEnv','passEnv','inputs','timeoutMs','maxOutputBytes','dependsOn','reason','alsoLevels'],'check');
    demand(ID.test(c.id??'') && !seen.has(c.id),'Check id must be a unique lowercase stable name.');
    demand(meaningful(c.name) && !/[\r\n]/.test(c.name) && meaningful(c.scenario),'Check needs a natural name and observable assertion/scenario.');
    demand(['test','command','manual'].includes(c.kind) && LEVELS.includes(c.level),'Unknown check kind/level.');
    if(c.alsoLevels!==undefined){unique(c.alsoLevels,'alsoLevels');demand(c.kind==='test' && c.alsoLevels.every(l=>LEVELS.includes(l) && l!==c.level),'alsoLevels is only for distinct test-coverage levels.');}
    unique(c.covers,'covers'); demand(c.covers.length && c.covers.every(x=>required.includes(x)),'Check must cover selected requirements.'); c.covers.forEach(x=>covered.add(x));
    if(c.dependsOn!==undefined){unique(c.dependsOn,'dependsOn'); demand(c.dependsOn.every(x=>seen.has(x)),'Dependencies must name earlier checks, not cycles/forward references.');}
    seen.add(c.id);
    if(c.kind==='manual') {demand(meaningful(c.reason) && !c.command && !c.parser,'Manual checks need a reason and cannot execute a command.'); continue;}
    ownKeys(c.command,['executable','args','cwd'],'command');
    demand(meaningful(c.command.executable) && Array.isArray(c.command.args) && c.command.args.every(a=>typeof a==='string' && !a.includes('\0')),'Use executable plus argument array, never an implicit shell string.');
    const cwd=c.command.cwd??'.'; if(cwd!=='.') validateRel(cwd);
    demand(Number.isSafeInteger(c.timeoutMs) && c.timeoutMs>=50 && c.timeoutMs<=3600000,'timeoutMs must be 50–3600000.');
    if(c.maxOutputBytes!==undefined) demand(Number.isSafeInteger(c.maxOutputBytes) && c.maxOutputBytes>=256 && c.maxOutputBytes<=16*1024*1024,'maxOutputBytes must be 256–16777216.');
    unique(c.inputs,'inputs'); demand(c.inputs.length,'Declare test/adapter/config inputs; they are bound even when ignored by Git.'); c.inputs.forEach(validateInput);
    for(const key of ['requiresEnv','passEnv']) if(c[key]!==undefined) {unique(c[key],key); demand(c[key].every(n=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !n.startsWith('DDD_')),`${key}: invalid/reserved environment name.`);}
    if(c.kind==='test') {
      demand(['json-v1','tap-flat-v13'].includes(c.parser),'Test parser must be json-v1 or tap-flat-v13; unknown output cannot pass.');
      unique(c.requiredCases,'requiredCases'); demand(c.requiredCases.length>0,'Tests need named required cases, not only an exit code.');
      if(c.optionalCases!==undefined){unique(c.optionalCases,'optionalCases'); demand(c.optionalCases.every(x=>!c.requiredCases.includes(x)) && meaningful(c.optionalReason),'Optional skips need disjoint names and a specific reason.');}
    } else {
      demand(c.parser==='exit-code' && ['static','component'].includes(c.level),'Exit-code-only checks cannot stand in for integration/acceptance tests.');
      demand(c.requiredCases===undefined && c.optionalCases===undefined,'Command checks do not invent test counts.');
    }
  }
  demand(required.every(x=>covered.has(x)),'Every selected requirement needs at least one check.');
  return {plan:p,path:rel,hash:sha(bytes),bound,required,itemDocs};
}
function capture(root, config, loaded) {
  const inv=inventory(root,config), inputs=new Map();
  for(const c of loaded.plan.checks) for(const rel of c.inputs??[]) inputs.set(rel,hashInput(root,rel));
  const installedRules=[];
  try{const receipt=JSON.parse(fs.readFileSync(regular(root,'.doc-driven/install.json'),'utf8'));for(const rule of receipt.rules??[])if(typeof rule.path==='string')installedRules.push(rule.path);}catch(e){if(e.code!=='ENOENT')installedRules.push('.doc-driven/install.json');}
  const ruleFiles=inv.files.filter(f=>/(^|\/)(?:AGENTS(?:\.override)?|CLAUDE)\.md$/.test(f.path)).map(f=>f.path);
  for(const rel of ['.doc-driven.json',...ruleFiles,...installedRules,'.claude/CLAUDE.md']) if(fs.existsSync(safePath(root,rel))) inputs.set(rel,hashInput(root,rel));
  const commands=loaded.plan.checks.filter(c=>c.command).map(c=>{
    try {const file=executable(root,c.command.executable);return {id:c.id,path:file,sha256:fileHash(file)};}
    catch(e){return {id:c.id,missing:e.message};}
  });
  const state={codeBaseline:`snapshot:${inv.snapshot}`,planHash:loaded.hash,specRefs:loaded.plan.specRefs,inputs:[...inputs.values()].sort((a,b)=>a.path.localeCompare(b.path)),commands,toolHash:toolHash()};
  return {...state,identity:sha(JSON.stringify(state)),git:inv.git,excluded:inv.skipped.map(x=>({path:x.path,reason:x.reason})),warnings:inv.warnings};
}
export function previewPlan(root,config,rel) {
  const loaded=loadPlan(root,config,rel),state=capture(root,config,loaded);
  return {kind:'ddd-verification-preview-v1',name:loaded.plan.name,plan:rel,planHash:loaded.hash,authorizedMode:loaded.plan.authorization.mode,
    checks:loaded.plan.checks.map(c=>({name:c.name,kind:c.kind,level:c.level,scenario:c.scenario,command:c.command??null,
      requiredCases:c.requiredCases??[],missingEnv:(c.requiresEnv??[]).filter(n=>!process.env[n])})),state,execution:'not-run',writes:[],sandbox:'none'};
}
function secretNames(p){return [...new Set(p.checks.flatMap(c=>[...(c.passEnv??[]),...(c.requiresEnv??[])]))];}
function exclusive(root,rel,text){const file=safePath(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});safePath(root,rel);fs.writeFileSync(file,text,{flag:'wx',mode:0o600});}
function aggregate(results){
  if(results.some(r=>r.status==='stale'))return 'stale';
  if(results.some(r=>['failed','invalid','timed-out','interrupted'].includes(r.status)))return 'failed';
  if(results.some(r=>r.status==='blocked'))return 'blocked';
  if(results.some(r=>r.status==='manual-required'))return 'manual-required';
  return results.length && results.every(r=>r.status==='passed')?'passed':'not-run';
}
export async function runVerification(root,config,rel,{expectPlan}={}) {
  const loaded=loadPlan(root,config,rel),p=loaded.plan;
  demand(expectPlan===loaded.hash,'--expect-plan must match the reviewed plan hash from preview; no execution occurred.');
  demand(['verify','implement'].includes(p.authorization.mode),'Design-only/hold does not authorize executing project code.');
  const initial=capture(root,config,loaded),runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomBytes(6).toString('hex')}`;
  const dir=`${RUNS}/${runId}`;fs.mkdirSync(safePath(root,'.doc-driven'),{recursive:true,mode:0o700});
  const lock=safePath(root,LOCK);let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(e){throw new Error(`Verification lock exists/unavailable; do not remove an active run lock: ${e.message}`);}
  const results=[],names=secretNames(p),startedAt=new Date().toISOString();
  const safe=s=>redact(s,names);
  const save=(name,data)=>exclusive(root,`${dir}/${name}`,data);
  try {
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,runId,startedAt}));
    fs.mkdirSync(safePath(root,RUNS),{recursive:true,mode:0o700});
    fs.mkdirSync(safePath(root,dir),{recursive:false,mode:0o700});
    for(const c of p.checks) {
      let r={id:c.id,name:c.name,kind:c.kind,level:c.level,alsoLevels:c.alsoLevels??[],covers:c.covers,status:'not-run',reason:'',process:null,cases:[]};
      if(c.kind==='manual'){r.status='manual-required';r.reason=c.reason;results.push(r);continue;}
      if((c.dependsOn??[]).some(id=>results.find(x=>x.id===id)?.status!=='passed')){r.status='blocked';r.reason='A required dependency did not pass.';results.push(r);continue;}
      let before;
      try {before=capture(root,config,loadPlan(root,loadConfig(root),rel));if(before.identity!==initial.identity)throw new Error('Project/plan changed since run start.');}
      catch(e){r.status='stale';r.reason=e.message;results.push(r);continue;}
      const missingEnv=(c.requiresEnv??[]).filter(n=>!process.env[n]);
      const missingInputs=(c.inputs??[]).map(i=>hashInput(root,i)).filter(i=>i.missing);
      if(missingEnv.length || missingInputs.length){r.status='blocked';r.reason=`Missing environment names: ${missingEnv.join(', ')}; unavailable inputs: ${missingInputs.map(x=>x.path).join(', ')}`;results.push(r);continue;}
      let resolved,cwd;
      try {resolved=executable(root,c.command.executable);cwd=(c.command.cwd??'.')==='.'?root:safePath(root,c.command.cwd);demand(fs.statSync(cwd).isDirectory(),'cwd must be a directory.');}
      catch(e){r.status='blocked';r.reason=e.message;results.push(r);continue;}
      const nonce=`${runId}/${c.id}`,args=c.command.args.map(a=>a.replaceAll('{skill}',PACKAGE));
      const proc=await execute({command:resolved,args,cwd,env:restrictedEnv([...(c.passEnv??[]),...(c.requiresEnv??[])],{DDD_RUN_ID:nonce}),timeoutMs:c.timeoutMs,maxOutputBytes:c.maxOutputBytes});
      const judged=judge(c,proc,nonce);
      const stdout=safe(proc.stdout),stderr=safe(proc.stderr);
      const {stdout:unusedOut,stderr:unusedErr,...facts}=proc;
      r={...r,...judged,process:{...facts,command:resolved,args,cwd:path.relative(root,cwd)||'.'},nonce,
        artifacts:[{path:`${dir}/${c.id}.stdout.log`,sha256:sha(stdout),bytes:Buffer.byteLength(stdout)},{path:`${dir}/${c.id}.stderr.log`,sha256:sha(stderr),bytes:Buffer.byteLength(stderr)}]};
      save(`${c.id}.stdout.log`,stdout);save(`${c.id}.stderr.log`,stderr);
      try{const after=capture(root,loadConfig(root),loadPlan(root,loadConfig(root),rel));if(after.identity!==before.identity){r.status='stale';r.reason='Specification, code, test, config, plan or tool changed during execution.';}}
      catch(e){r.status='stale';r.reason=`Unable to bind final state: ${e.message}`;}
      // Secrets are removed from serialized results as well as logs. Fail closed if this
      // changes parser-critical names; the subsequent receipt check will reject it.
      r=JSON.parse(safe(JSON.stringify(r)));results.push(r);
      if(proc.reason==='interrupted')break;
    }
    let finalState;
    try{finalState=capture(root,loadConfig(root),loadPlan(root,loadConfig(root),rel));}catch(e){finalState={identity:null,error:safe(e.message)};}
    const status=initial.identity!==finalState.identity?'stale':results.length!==p.checks.length?'failed':aggregate(results);
    const report={kind:'ddd-verification-run-v1',schemaVersion:1,version:VERSION,runId,name:p.name,plan:rel,planHash:loaded.hash,startedAt,endedAt:new Date().toISOString(),
      status,initial,final:finalState,environment:{...p.environment,platform:process.platform,arch:process.arch,node:process.version,forwardedNames:names,values:'not-recorded'},results,
      provenance:'local-runner; unsigned; not tamper-proof',semantic:'not-assessed',sandbox:'none',limitations:'Exact commands and supported reports observed locally. Requirement sufficiency, approval authenticity, external environment state and hostile-process containment are not proved.'};
    const content=safe(JSON.stringify(report,null,2)+'\n');save('run.json',content);save('run.sha256',sha(content)+'\n');
    return {report:JSON.parse(content),path:`${dir}/run.json`,sha256:sha(content)};
  } finally {
    fs.closeSync(fd);
    // Only remove the lock we created, never an unrelated replacement.
    try{const info=JSON.parse(fs.readFileSync(lock,'utf8'));if(info.runId===runId)fs.unlinkSync(lock);}catch{/* leave unknown lock for inspection */}
  }
}
export function checkRun(root,config,rel,{plan:expectedPlan,hash:expectedHash}={}) {
  const errors=[],error=s=>errors.push(s);
  let r,loaded;
  try {
    demand(/^\.doc-driven\/verification\/runs\/[A-Za-z0-9-]+\/run\.json$/.test(rel),'Expected a runner-owned run.json path.');
    const bytes=fs.readFileSync(regular(root,rel,32*1024*1024)),digest=sha(bytes);
    demand(fs.readFileSync(regular(root,rel.replace(/run\.json$/,'run.sha256')),'utf8').trim()===digest,'Run receipt checksum mismatch.');
    if(expectedHash)demand(digest===expectedHash,'Pinned receipt hash changed.');
    r=JSON.parse(bytes.toString('utf8'));demand(r.kind==='ddd-verification-run-v1' && r.schemaVersion===1,'Unsupported run receipt.');
    demand(path.posix.basename(path.posix.dirname(rel))===r.runId,'Run identity/path mismatch.');
    if(expectedPlan)demand(r.plan===expectedPlan,'Receipt belongs to a different verification plan.');
    loaded=loadPlan(root,config,r.plan);demand(loaded.hash===r.planHash,'Verification plan changed since run.');
    const state=capture(root,config,loaded);demand(state.identity===r.initial.identity && state.identity===r.final.identity,'Run is stale for current specification/code/test/config/tool.');
    demand(Array.isArray(r.results) && r.results.length===loaded.plan.checks.length,'Missing check results.');
    for(let i=0;i<loaded.plan.checks.length;i++) {
      const c=loaded.plan.checks[i],x=r.results[i];demand(x.id===c.id && x.name===c.name && x.level===c.level && x.kind===c.kind && JSON.stringify(x.alsoLevels??[])===JSON.stringify(c.alsoLevels??[]) && JSON.stringify(x.covers)===JSON.stringify(c.covers),'Check identity/scope mismatch.');
      if(x.process) {
        demand(x.nonce===`${r.runId}/${c.id}`,'Result nonce mismatch.');
        demand(Array.isArray(x.artifacts) && x.artifacts.length===2,'Missing captured output.');
        const logs=[];
        for(const [j,a] of x.artifacts.entries()) {
          const expected=`${path.posix.dirname(rel)}/${c.id}.${j===0?'stdout':'stderr'}.log`;
          demand(a.path===expected,'Artifact escaped its check/run.');const b=fs.readFileSync(regular(root,a.path,16*1024*1024));
          demand(sha(b)===a.sha256 && b.length===a.bytes,'Captured artifact missing/changed.');logs.push(b.toString('utf8'));
        }
        const computed=judge(c,{...x.process,stdout:logs[0],stderr:logs[1]},x.nonce);
        demand(computed.status===x.status && JSON.stringify(computed.cases)===JSON.stringify(x.cases),'Recorded status/cases disagree with captured output.');
        if(x.counts)demand(JSON.stringify(computed.counts)===JSON.stringify(x.counts),'Recorded test counts disagree with output.');
      } else demand(x.status!=='passed','No process was observed; cannot pass.');
      if(x.status!=='passed')error(`${c.name}: ${x.status} — ${x.reason}`);
    }
    demand(aggregate(r.results)===r.status,'Overall result disagrees with check results.');
    if(r.status!=='passed')error(`Run outcome: ${r.status}`);
  }catch(e){error(e.message);}
  return {kind:'ddd-verification-validation-v1',status:errors.length?'not-verified':'verified',errors,report:r??null,plan:loaded?.plan??null,provenance:'local-unsigned',semantic:'not-assessed'};
}
export function receiptCovers(validation,items,levels) {
  if(validation.errors.length)return false;
  return items.every(id=>levels.every(level=>validation.report.results.some(c=>c.status==='passed' && c.kind==='test' && c.covers.includes(id) && (c.level===level || c.alsoLevels?.includes(level)))));
}
export function receiptEvidence(root,config,rel) {
  const checked=checkRun(root,config,rel);demand(!checked.errors.length,checked.errors.join('\n'));
  const r=checked.report,digest=sha(fs.readFileSync(regular(root,rel,32*1024*1024)));
  return r.results.filter(x=>x.kind==='test').flatMap(x=>[x.level,...(x.alsoLevels??[])].map(level=>{
    const required=checked.plan.checks.find(c=>c.id===x.id).requiredCases;
    const id=`E-RUN-${sha(`${r.runId}/${x.id}/${level}`).slice(0,12).toUpperCase()}-001`;
    return `### ${x.name}\n<!-- ddd:item ${id} -->\nKind: verification\nCovers: ${x.covers.join(', ')}\nSpec-Refs: ${r.initial.specRefs.join(', ')}\nBaseline: ${r.initial.codeBaseline}\nEnvironment: ${r.environment.name}; ${r.environment.platform}; Node ${r.environment.node}\nMethod: runner check ${x.id}; see captured command in receipt\nResult: passed\nLevel: ${level}\nExecuted: ${required.length}\nSkipped: 0\nFailed: 0\nArtifact: ${rel}\nRunner-Receipt: ${rel}#${digest}\nRunner-Check: ${x.id}\nDetail: Required named cases passed in one recorded local execution; optional results and limitations remain in receipt. Unsigned, not a semantic proof.\n`;
  })).join('\n');
}
