// Strict supported formats only. Unknown/nested TAP is rejected, not guessed.
const CASE_STATES = new Set(['passed','failed','skipped','todo']);
export function normalizeJSON(text, runId) {
  const r = JSON.parse(text);
  if (r?.kind !== 'ddd-test-results-v1' || r.runId !== runId || r.complete !== true || !Array.isArray(r.cases))
    throw new Error('Expected complete ddd-test-results-v1 with the current DDD_RUN_ID and cases.');
  if (r.cases.length > 50000) throw new Error('Too many reported cases.');
  const seen = new Set();
  const cases = r.cases.map(c => {
    if (!c || typeof c.name !== 'string' || !c.name.trim() || /[\r\n\0]/.test(c.name) || !CASE_STATES.has(c.status) || seen.has(c.name))
      throw new Error('Each reported case needs a unique nonempty name and passed/failed/skipped/todo status.');
    seen.add(c.name);
    return { name: c.name, status: c.status, detail: typeof c.detail === 'string' ? c.detail : '' };
  });
  return cases;
}
export function parseFlatTAP(text) {
  const lines = text.replace(/\r\n/g,'\n').split('\n');
  let plan = null, yaml = false, version = false, next = 1;
  const cases = [], seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^Bail out!/i.test(line)) throw new Error('TAP bailed out.');
    if (/^\s+(?:not )?ok\b|^\s+1\.\./.test(line)) throw new Error('Nested TAP is unsupported; use the Node reporter or normalized JSON adapter.');
    if (/^  ---\s*$/.test(line)) { yaml = true; continue; }
    if (yaml) { if (/^  \.\.\.\s*$/.test(line)) yaml = false; continue; }
    if (line === 'TAP version 13') { if (version) throw new Error('Repeated TAP header.'); version = true; continue; }
    if (/^#/.test(line)) continue;
    let m = line.match(/^1\.\.(\d+)(?:\s+#.*)?$/);
    if (m) { if (plan !== null) throw new Error('Multiple TAP plans.'); plan = Number(m[1]); continue; }
    m = line.match(/^(not ok|ok)\s+(\d+)\s+(?:-\s+)?(.+?)(?:\s+#\s*(SKIP|TODO)\b(.*))?\s*$/i);
    if (!m || Number(m[2]) !== next++) throw new Error('Unsupported or malformed TAP line/sequence.');
    const name = m[3].trim(); if (seen.has(name)) throw new Error('Duplicate TAP test name.'); seen.add(name);
    cases.push({ name, status: m[4] ? m[4].toLowerCase() === 'skip' ? 'skipped':'todo' : m[1].toLowerCase() === 'ok' ? 'passed':'failed', detail: m[5]?.trim() ?? '' });
  }
  if (!version || yaml || plan === null || plan !== cases.length) throw new Error('Incomplete TAP report or case-count mismatch.');
  return cases;
}
export function judge(check, processResult, runId) {
  if (processResult.reason) return { status: processResult.reason === 'timeout' ? 'timed-out' : processResult.reason === 'interrupted' ? 'interrupted' : 'invalid', reason: processResult.reason, cases: [] };
  if (processResult.error) return {status:'blocked',reason:`Cannot start check: ${processResult.error}`,cases:[]};
  if (check.kind === 'command') return {status:processResult.exitCode === 0 && !processResult.signal?'passed':'failed', reason:'Exit-code check only; no behavioral test coverage inferred.',cases:[]};
  let cases;
  try { cases = check.parser === 'json-v1' ? normalizeJSON(processResult.stdout,runId) : parseFlatTAP(processResult.stdout); }
  catch(e) { return {status:processResult.exitCode !== 0?'failed':'invalid',reason:e.message,cases:[]}; }
  const lookup = new Map(cases.map(c=>[c.name,c]));
  const missing = check.requiredCases.filter(n => !lookup.has(n));
  const notPassed = check.requiredCases.filter(n => lookup.has(n) && lookup.get(n).status !== 'passed');
  const skips = cases.filter(c => ['skipped','todo'].includes(c.status) && !(check.optionalCases ?? []).includes(c.name));
  const failures = cases.filter(c=>c.status==='failed');
  const counts = {executed:cases.filter(c=>['passed','failed'].includes(c.status)).length, passed:cases.filter(c=>c.status==='passed').length,
    failed:failures.length,skipped:cases.filter(c=>c.status==='skipped').length,todo:cases.filter(c=>c.status==='todo').length};
  const problems = [];
  if (processResult.exitCode !== 0 || processResult.signal) problems.push('Nonzero exit or signal.');
  if (!counts.executed) problems.push('No tests executed.');
  if (missing.length) problems.push(`Missing required cases: ${missing.join(', ')}`);
  if (notPassed.length) problems.push(`Required cases did not pass: ${notPassed.join(', ')}`);
  if (skips.length) problems.push('Unapproved skipped/TODO cases.');
  if (failures.length) problems.push('Actual test failures.');
  return {status:problems.length?'failed':'passed',reason:problems.join(' ') || 'Required named cases actually reported as passed.',cases,counts};
}
