// Native node:test custom reporter. Named leaf tests should be unique across a run.
// Usage: node --test --test-reporter=/.../node-reporter.mjs test/file.test.mjs
import path from 'node:path';
export default async function* reporter(source) {
  const cases = [], diagnostics = [];
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (d.details?.type === 'suite') continue;
      // node:test treats an otherwise empty file as a passed file wrapper. It is
      // not a named behavior case and must not establish that tests executed.
      if(d.file && path.resolve(d.name)===path.resolve(d.file) && d.line===1 && d.column===1) continue;
      cases.push({name:d.name,status:d.skip?'skipped':d.todo?'todo':event.type==='test:pass'?'passed':'failed',
        detail:d.details?.error?.message ?? (typeof d.skip==='string'?d.skip:typeof d.todo==='string'?d.todo:'')});
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') diagnostics.push(d.message ?? '');
  }
  yield JSON.stringify({kind:'ddd-test-results-v1',runId:process.env.DDD_RUN_ID,complete:true,cases,diagnostics})+'\n';
}
