#!/usr/bin/env node
// Disposable, in-process example. No network, dependencies, formal runner or project writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = `import { createImportTasks } from './imports/index.mjs';
export function createApp(publish) {
  const tasks = createImportTasks(publish);
  return { submit: tasks.submit, find: tasks.find };
}
`;
const PUBLIC = `export { createImportTasks } from './private/tasks.mjs';\n`;
const TASKS = `export function createImportTasks(publish) {
  const tasks = new Map();
  const copy = task => task ? { ...task.result } : null;
  return {
    submit({ requestId, rows } = {}) {
      if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('INVALID_REQUEST_ID');
      if (!Array.isArray(rows) || !rows.length || [...rows].some(row => typeof row !== 'string' || !row.trim())) throw new Error('INVALID_ROWS');
      const fingerprint = JSON.stringify(rows);
      const existing = tasks.get(requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('REQUEST_CONFLICT');
        return copy(existing);
      }
      const task = { fingerprint, result: { requestId, state: 'processing', rowCount: rows.length } };
      tasks.set(requestId, task);
      try {
        publish([...rows]);
        task.result.state = 'published';
      } catch {
        task.result.state = 'failed';
        task.result.error = 'PUBLICATION_FAILED';
      }
      return copy(task);
    },
    find(requestId) { return copy(tasks.get(requestId)); }
  };
}
`;

export async function withFixture(action) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-module-boundaries-')));
  const put = (relative, text) => {
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Fixture path escapes its root');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  put('src/app.mjs', APP);
  put('src/imports/index.mjs', PUBLIC);
  put('src/imports/private/tasks.mjs', TASKS);
  const load = relative => import(pathToFileURL(path.join(root, relative)).href);
  try {
    return await action({ root, put,
      boot: async publish => (await load('src/app.mjs')).createApp(publish),
      publicModule: () => load('src/imports/index.mjs') });
  } finally {
    // Verify the exact directory made above before deleting its disposable contents.
    assert.equal(fs.realpathSync(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Only this fixture's literal, single-line ESM import/re-export form is recognized.
// Not a JavaScript parser: dynamic imports, require, comments/strings and aliases are not analyzed.
export function checkDependencies(root) {
  const files = ['src/app.mjs', 'src/imports/index.mjs', 'src/imports/private/tasks.mjs'];
  const allowed = new Map([
    [files[0], [files[1]]], [files[1], [files[2]]], [files[2], []]
  ]);
  const reasons = ['app must use the public entry', 'public entry must expose only its private implementation', 'private task rules have no static source dependencies'];
  const edges = new Map(), issues = [];
  for (const [i, from] of files.entries()) {
    const text = fs.readFileSync(path.join(root, from), 'utf8');
    const imports = [...text.matchAll(/^\s*(?:import\s+(?:[^'"\n]*?\s+from\s+)?|export\s+[^'"\n]*?\s+from\s+)['"]([^'"]+)['"]/gm)];
    const targets = imports.map(([, specifier]) => specifier.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : specifier);
    edges.set(from, targets);
    for (const to of targets) if (!allowed.get(from).includes(to)) issues.push({ from, to, reason: reasons[i] });
  }
  const visited = new Set();
  function visit(from, chain) {
    if (chain.includes(from)) { issues.push({ reason: 'cycle', chain: [...chain.slice(chain.indexOf(from)), from] }); return; }
    if (visited.has(from)) return;
    for (const to of edges.get(from) ?? []) if (edges.has(to)) visit(to, [...chain, from]);
    visited.add(from);
  }
  for (const from of files) visit(from, []);
  return issues;
}

export async function runDemo() {
  const checks = [];
  const passed = name => checks.push({ name, status: 'passed' });
  await withFixture(async f => {
    const publications = [];
    const app = await f.boot(rows => publications.push(rows));
    const request = { requestId: 'first', rows: ['alpha', 'beta'] };
    const result = app.submit(request);
    assert.deepEqual(result, { requestId: 'first', state: 'published', rowCount: 2 });
    assert.deepEqual(publications, [['alpha', 'beta']]);
    passed('assembled entry publishes valid rows');
    assert.deepEqual(app.submit(request), result);
    assert.equal(publications.length, 1);
    assert.throws(() => app.submit({ ...request, rows: ['changed'] }), { message: 'REQUEST_CONFLICT' });
    passed('repeat returns original task; changed content conflicts');
    assert.throws(() => app.submit({ requestId: 'invalid', rows: [''] }), { message: 'INVALID_ROWS' });
    assert.equal(app.find('invalid'), null);
    assert.equal(publications.length, 1);
    passed('invalid input changes neither task state nor publications');
    result.state = 'failed';
    assert.equal(app.find('first').state, 'published');
    assert.deepEqual(Object.keys(await f.publicModule()), ['createImportTasks']);
    assert.deepEqual(checkDependencies(f.root), []);
    passed('public entry isolates owned state and respects dependency rules');
    f.put('src/app.mjs', "import { createImportTasks } from './imports/private/tasks.mjs';\n");
    assert.ok(checkDependencies(f.root).some(i => i.reason === 'app must use the public entry'));
    f.put('src/app.mjs', APP);
    f.put('src/imports/private/tasks.mjs', "import '../../app.mjs';\n");
    assert.ok(checkDependencies(f.root).some(i => i.reason === 'cycle'));
    passed('private import and reverse dependency counterexamples are detected');
  });
  await withFixture(async f => {
    let attempts = 0;
    const app = await f.boot(() => { attempts++; throw new Error('fixture unavailable'); });
    const request = { requestId: 'failure', rows: ['alpha'] };
    const result = app.submit(request);
    assert.deepEqual(result, { requestId: 'failure', state: 'failed', rowCount: 1, error: 'PUBLICATION_FAILED' });
    assert.deepEqual(app.submit(request), result);
    assert.equal(attempts, 1);
    passed('failed publication stays failed on repeat');
  });
  await withFixture(async f => {
    f.put('src/app.mjs', 'export const createApp = () => ({ submit: () => null });\n');
    const broken = await f.boot(() => {});
    assert.throws(() => assert.deepEqual(broken.submit({ requestId: 'broken', rows: ['alpha'] }),
      { requestId: 'broken', state: 'published', rowCount: 1 }), { code: 'ERR_ASSERTION' });
    passed('behavior assertion rejects disconnected app even without forbidden imports');
  });
  return { kind: 'ddd-module-boundaries-demo-v1', checks, formalRunner: 'not-run',
    limitations: ['Synchronous in-memory fixture; no crash recovery or durable transactions.',
      'Publisher must complete synchronously and publish all rows or throw before writing any.',
      'Static scan covers only three fixture files and literal single-line ESM dependencies.',
      'No user approval, project acceptance, formal runner receipt or agent evaluation is claimed.'] };
}

async function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    console.log('Run: node examples/module-boundaries.mjs --run\nCreates and removes isolated temporary fixtures. No network, dependencies or formal runner.');
    return;
  }
  if (args.length !== 1 || args[0] !== '--run') throw new Error('Expected --run or --help');
  console.log(JSON.stringify(await runDemo(), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
