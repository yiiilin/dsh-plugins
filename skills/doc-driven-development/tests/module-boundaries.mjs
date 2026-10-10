import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { header, globRE } from '../scripts/lib.mjs';
import { scanDesign, validateDesign } from '../scripts/design-check.mjs';
import { checkLayout } from '../scripts/doc-layout.mjs';
import { withFixture, checkDependencies, runDemo } from '../examples/module-boundaries.mjs';

test('assembled public entry publishes once and repeated submission returns its original result', async () => {
  let root;
  await withFixture(async f => {
    root = f.root;
    const writes = [];
    const app = await f.boot(rows => writes.push(rows));
    const request = { requestId: 'same', rows: ['first', 'second'] };
    const result = app.submit(request);
    assert.deepEqual(result, { requestId: 'same', state: 'published', rowCount: 2 });
    assert.deepEqual(app.submit(request), result);
    assert.deepEqual(writes, [['first', 'second']]);
    assert.deepEqual(app.find('same'), result);
    assert.deepEqual(checkDependencies(f.root), []);
  });
  assert.equal(fs.existsSync(root), false);
});

test('publication failure remains failed on repeat; invalid input creates no task or publication', async () => {
  await withFixture(async f => {
    let attempts = 0;
    const app = await f.boot(() => { attempts++; throw new Error('fixture storage unavailable'); });
    const request = { requestId: 'failed', rows: ['first'] };
    const failed = { requestId: 'failed', state: 'failed', rowCount: 1, error: 'PUBLICATION_FAILED' };
    assert.deepEqual(app.submit(request), failed);
    assert.deepEqual(app.submit(request), failed);
    assert.equal(attempts, 1);
    assert.throws(() => app.submit({ requestId: 'invalid', rows: [''] }), { message: 'INVALID_ROWS' });
    assert.equal(app.find('invalid'), null);
    assert.equal(attempts, 1);
  });
});

test('conflicting request content is rejected and callers cannot modify owned task state', async () => {
  await withFixture(async f => {
    const app = await f.boot(() => {});
    const request = { requestId: 'owned', rows: ['first'] };
    const result = app.submit(request);
    request.rows.push('changed after call');
    result.state = 'failed';
    assert.deepEqual(app.find('owned'), { requestId: 'owned', state: 'published', rowCount: 1 });
    assert.throws(() => app.submit(request), { message: 'REQUEST_CONFLICT' });
    const publicModule = await f.publicModule();
    assert.deepEqual(Object.keys(publicModule), ['createImportTasks']);
    const tasks = publicModule.createImportTasks(() => {});
    assert.deepEqual(Object.keys(tasks).sort(), ['find', 'submit']);
  });
});

test('direct private import and private re-export each violate the public entry rule', async () => {
  await withFixture(async f => {
    f.put('src/app.mjs', "import { createImportTasks } from './imports/private/tasks.mjs';\n");
    assert.deepEqual(checkDependencies(f.root), [{ from: 'src/app.mjs', to: 'src/imports/private/tasks.mjs', reason: 'app must use the public entry' }]);
    f.put('src/app.mjs', "export { createImportTasks } from './imports/private/tasks.mjs';\n");
    assert.equal(checkDependencies(f.root).length, 1);
  });
});

test('private code depending on the app exposes the reverse edge and cycle', async () => {
  await withFixture(async f => {
    f.put('src/imports/private/tasks.mjs', "import '../../../app.mjs';\n");
    assert.deepEqual(checkDependencies(f.root), [{ from: 'src/imports/private/tasks.mjs', to: 'app.mjs', reason: 'private task rules have no static source dependencies' }]);
    f.put('src/imports/private/tasks.mjs', "import '../../app.mjs';\n");
    const issues = checkDependencies(f.root);
    assert.ok(issues.some(i => i.reason === 'private task rules have no static source dependencies'));
    assert.ok(issues.some(i => i.reason === 'cycle' && i.chain.join(' -> ') === 'src/app.mjs -> src/imports/index.mjs -> src/imports/private/tasks.mjs -> src/app.mjs'));
  });
});

test('sparse rows are rejected before creating a task or publishing', async () => {
  await withFixture(async f => {
    const writes = [];
    const app = await f.boot(rows => writes.push(rows));
    const sparseInputs = [new Array(1), ['first', , 'third']];
    for (const [index, rows] of sparseInputs.entries()) {
      const requestId = `sparse-${index}`;
      assert.throws(() => app.submit({ requestId, rows }), { message: 'INVALID_ROWS' });
      assert.equal(app.find(requestId), null);
      assert.deepEqual(writes, []);
    }
  });
});

test('fenced candidate contract is parsed as a valid unverified domain module', () => {
  const markdown = fs.readFileSync(new URL('../examples/module-boundaries.md', import.meta.url), 'utf8');
  const samples = scanDesign(markdown).fences.filter(f => f.ch === '`' && f.n === 4 && f.info === 'markdown');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].closed, true);
  const text = samples[0].body;
  const doc = { path: 'docs/domains/imports/modules/tasks.md', text, fields: header(text).fields };
  assert.equal(doc.fields.Type, 'module');
  assert.equal(doc.fields['Design-Format'], 'layered-v1');
  assert.equal(doc.fields['Verification-Format'], 'runner-v1');
  assert.equal(doc.fields.Status, 'observed');
  assert.equal(doc.fields.Verification, 'not-run');
  assert.equal(doc.fields['Verification-Plan'], 'pending');
  assert.equal(doc.fields.Approval, 'none');
  assert.equal(doc.fields['Verification-Receipt'], undefined);
  const owns = globRE(doc.fields.Owns);
  assert.equal(owns.test('src/imports/index.mjs'), true);
  assert.equal(owns.test('src/imports/private/tasks.mjs'), true);
  assert.equal(owns.test('src/app.mjs'), false);
  assert.deepEqual(validateDesign(doc), []);
  const config = { layout: 'domain', docsRoots: ['docs'] };
  const layout = checkLayout(config, [doc]);
  assert.equal(layout.status, 'passed');
  assert.equal(layout.domainDocuments, 1);
  assert.deepEqual(layout.errors, []);
  assert.ok(validateDesign({ ...doc, fields: { ...doc.fields, 'Design-Format': 'unsupported' } }).length > 0);
  assert.equal(checkLayout(config, [{ ...doc, path: 'docs/modules/tasks.md' }]).errors.length, 1);
});

test('standalone demonstration executes behavior and catches a deliberately broken entry', async () => {
  const report = await runDemo();
  assert.equal(report.checks.length, 7);
  assert.ok(report.checks.every(c => c.status === 'passed'));
  assert.equal(report.formalRunner, 'not-run');
});
