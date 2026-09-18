// Domain-layout regressions. Synthetic documents are not claims about business behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, loadConfig, updateIndex, inventory } from '../scripts/lib.mjs';
import { checkLayout } from '../scripts/doc-layout.mjs';
import { checkRepo } from '../scripts/check-doc-set.mjs';
import { PACKAGE_ROOT as PKG, DEFAULT_SKILL, planInstall, applyPlan, doctor, tree } from '../scripts/project-install.mjs';

function fixture(t, config = { ...DEFAULTS }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  const read = rel => fs.readFileSync(path.join(root, rel));
  if (config) put('.doc-driven.json', JSON.stringify(config));
  return { root, put, read, config };
}
function prose(id, type, extra = '') {
  return `# Synthetic ${id}\n\nDoc-ID: ${id}\nType: ${type}\nRevision: 1\nStatus: observed\nBaseline: unknown\nOwns: —\nImplementation: unknown\nVerification: not-run\n\n## Scope\nFixture only.\n${extra}`;
}
const doc = (p, type, status = 'observed') => ({ path: p, fields: { Type: type, Status: status } });
const cfg = (layout = 'domain', docsRoots = ['docs']) => ({ ...DEFAULTS, layout, docsRoots });
const ok = r => assert.deepEqual(r.errors, []);
const cli = (name, root, args = []) => spawnSync(process.execPath, [path.join(PKG, 'scripts', `${name}.mjs`), root, ...args], { encoding: 'utf8', timeout: 30000 });
const snapshot = root => Object.fromEntries([...tree(root)].map(([p, r]) => [p, r.data.toString('base64')]));

test('new configurations default to domain, while old files without layout remain byte-for-byte preserve', t => {
  assert.equal(DEFAULTS.layout, 'domain');
  const f = fixture(t, null), raw = '{ "enabled": true, "schemaVersion": 1 }\n';
  f.put('.doc-driven.json', raw); assert.equal(loadConfig(f.root).layout, 'preserve');
  assert.equal(f.read('.doc-driven.json').toString(), raw);
});
for (const value of ['flat', 'domains', '', true, null, {}]) test(`invalid layout ${JSON.stringify(value)} is refused`, t => {
  const f = fixture(t, { ...DEFAULTS, layout: value });
  assert.throws(() => loadConfig(f.root), /layout must be/);
});
for (const [name, type] of [['checkout', 'feature'], ['pricing', 'module']]) test(`canonical domain ${type} passes without a duplicated Domain field`, () => {
  const d = doc(`docs/domains/orders/${type === 'feature' ? 'features' : 'modules'}/${name}.md`, type);
  const r = checkLayout(cfg(), [d]); ok(r); assert.equal(r.domainDocuments, 1);
});
test('Unicode domain names, domain-local subfolders and multiple configured roots remain supported', () => {
  const r = checkLayout(cfg('domain', ['design', 'handbook/specs']), [
    doc('design/domains/订单/features/create.md', 'feature'),
    doc('handbook/specs/domains/platform/modules/storage/cache.md', 'module'),
  ]); ok(r); assert.equal(r.domainDocuments, 2);
});
for (const [p, type] of [
  ['docs/features/checkout.md', 'feature'],
  ['docs/modules/pricing.md', 'module'],
  ['docs/domains/orders.md', 'architecture'],
  ['docs/domains/features/checkout.md', 'feature'],
  ['docs/domains/modules/storage.md', 'module'],
  ['docs/domains/orders/modules/checkout.md', 'feature'],
  ['docs/domains/orders/features/pricing.md', 'module'],
  ['docs/domains/orders/checkout.md', 'feature'],
  ['docs/domains/features/features/checkout.md', 'feature'],
]) test(`domain policy rejects misplaced current document ${p} (${type})`, () => {
  const r = checkLayout(cfg(), [doc(p, type)]); assert.equal(r.errors.length, 1, JSON.stringify(r));
  assert.equal(r.nonconforming, 1); assert.match(r.errors[0], /\[layout:domain\]/);
});
test('optional overview and global documents do not require fake feature or module directories', () => {
  ok(checkLayout(cfg(), [doc('docs/architecture.md', 'architecture'),
    doc('docs/domains/README.md', 'architecture'), doc('docs/domains/orders/README.md', 'architecture'),
    doc('docs/domains/orders/architecture.md', 'architecture'), doc('docs/changes/new.md', 'change'),
    doc('docs/requirements.md', 'requirements')]));
  ok(checkLayout(cfg(), []));
});
test('historical superseded paths are not forced to move', () => {
  const r = checkLayout(cfg(), [doc('docs/features/old.md', 'feature', 'superseded')]);
  ok(r); assert.equal(r.nonconforming, 0);
});
test('preserve reports the exact mixed-layout symptom without writing or downgrading any document', t => {
  const f = fixture(t, { ...DEFAULTS, layout: 'preserve' });
  f.put('docs/domains/orders.md', prose('ARCH-ORDERS', 'architecture'));
  f.put('docs/features/checkout.md', prose('FEAT-CHECKOUT', 'feature'));
  f.put('docs/modules/pricing.md', prose('MOD-PRICING', 'module'));
  updateIndex(f.root, f.config); const before = snapshot(f.root);
  const r = checkRepo(f.root, f.config); ok(r); assert.equal(r.stats.layout.nonconforming, 3);
  assert.equal(r.warnings.filter(w => w.startsWith('[layout:preserve]')).length, 3);
  assert.deepEqual(snapshot(f.root), before);
});
test('check-doc-set CLI fails in domain mode for root-level feature; it does not fix, move or loosen config', t => {
  const f = fixture(t); f.put('docs/features/checkout.md', prose('FEAT-CHECKOUT', 'feature'));
  updateIndex(f.root, f.config); const before = snapshot(f.root);
  const result = cli('check-doc-set', f.root, ['--json']); assert.equal(result.status, 1, result.stderr);
  assert.ok(JSON.parse(result.stdout).errors.some(s => s.includes('[layout:domain]')));
  assert.deepEqual(snapshot(f.root), before);
});
test('cross-domain links and index use one main specification in each owning domain', t => {
  const f = fixture(t);
  f.put('docs/domains/orders/features/checkout.md', prose('FEAT-CHECKOUT', 'feature', '[pricing](../modules/pricing.md)\n[identity](../../identity/modules/token.md)\n'));
  f.put('docs/domains/orders/modules/pricing.md', prose('MOD-PRICING', 'module'));
  f.put('docs/domains/identity/modules/token.md', prose('MOD-TOKEN', 'module'));
  updateIndex(f.root, f.config); const r = checkRepo(f.root, f.config); ok(r);
  assert.equal(r.stats.layout.domainDocuments, 3);
  assert.match(f.read('docs/README.md').toString(), /domains\/orders\/features\/checkout\.md/);
});
test('full reading progress can point at the canonical domain feature', t => {
  const f = fixture(t); const d = 'docs/domains/orders/features/checkout.md';
  f.put('src/order.mjs', 'export const order = () => null;\n');
  f.put(d, prose('FEAT-CHECKOUT', 'feature')); updateIndex(f.root, f.config);
  const inv = inventory(f.root, f.config), file = inv.files.find(f => f.path === 'src/order.mjs');
  f.put('docs/adoption/progress.json', JSON.stringify({ schemaVersion: 1, inventorySnapshot: inv.snapshot,
    files: { [file.path]: { sha256: file.sha256, state: 'reviewed', docs: [d], note: 'Synthetic reading record for structural test only.' } } }));
  ok(checkRepo(f.root, f.config, { progress: 'docs/adoption/progress.json', full: true }));
});
test('plain untagged historic prose is explicitly outside managed layout checks', t => {
  const f = fixture(t); f.put('docs/domains/old.md', '# Old prose without Doc-ID\n');
  updateIndex(f.root, f.config); ok(checkRepo(f.root, f.config));
});
test('new installation defaults to domain but creates no invented domains or specs', t => {
  const f = fixture(t, null); applyPlan(planInstall(f.root, { host: 'agents' }));
  assert.equal(loadConfig(f.root).layout, 'domain');
  assert.ok(!fs.existsSync(path.join(f.root, 'docs/domains')));
  assert.match(f.read('AGENTS.md').toString(), /LAYOUT\.md/);
  assert.equal(doctor(f.root).layout.policy, 'domain');
});
test('initial adoption of existing managed flat docs chooses preserve instead of silently imposing domain', t => {
  const f = fixture(t, null); f.put('docs/features/old.md', prose('FEAT-OLD', 'feature')); const original = f.read('docs/features/old.md');
  const plan = planInstall(f.root, { host: 'agents' });
  assert.ok(plan.warnings.some(w => w.includes('Existing managed feature/module')));
  applyPlan(plan); assert.equal(loadConfig(f.root).layout, 'preserve');
  assert.deepEqual(f.read('docs/features/old.md'), original);
});
test('layout CLI changes new configurations only; existing JSON is not rewritten', t => {
  const f = fixture(t, null);
  const r = cli('install', f.root, ['--host', 'agents', '--layout', 'preserve', '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(loadConfig(f.root).layout, 'preserve');
  const raw = f.read('.doc-driven.json'), again = cli('install', f.root, ['--layout', 'domain', '--apply', '--json']);
  assert.equal(again.status, 0, again.stderr); assert.deepEqual(f.read('.doc-driven.json'), raw);
  assert.ok(JSON.parse(again.stdout).warnings.some(w => w.includes('--layout does not replace')));
});
test('init compatibility alias forwards layout to the same complete install', t => {
  const f = fixture(t, null); const r = cli('init', f.root, ['--layout', 'domain', '--host', 'agents', '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(loadConfig(f.root).layout, 'domain');
  assert.ok(fs.existsSync(path.join(f.root, DEFAULT_SKILL, 'LAYOUT.md')));
  assert.equal(JSON.parse(r.stdout).activation, 'ready');
});
test('invalid installer layout has no side effects', t => {
  const f = fixture(t, null); const before = snapshot(f.root);
  const r = cli('install', f.root, ['--layout', 'flat', '--apply']);
  assert.equal(r.status, 2); assert.deepEqual(snapshot(f.root), before);
});
test('doctor reports layout failure separately from a valid project installation; document check still fails', t => {
  const f = fixture(t, null); applyPlan(planInstall(f.root, { host: 'agents' }));
  const config = loadConfig(f.root); f.put('docs/features/misplaced.md', prose('FEAT-MISPLACED', 'feature'));
  updateIndex(f.root, config); const before = snapshot(f.root), d = doctor(f.root);
  assert.equal(d.activation, 'ready'); assert.equal(d.runtime, 'not-run'); assert.equal(d.layout.status, 'failed');
  assert.ok(d.warnings.some(w => w.includes('Document layout requires review')));
  assert.ok(checkRepo(f.root, config).errors.length); assert.deepEqual(snapshot(f.root), before);
});
test('standalone init-only legacy JSON and wrong document paths survive full installation repair', t => {
  const f = fixture(t, null), raw = '{ "schemaVersion": 1, "enabled": true }\n';
  f.put('.doc-driven.json', raw); f.put('AGENTS.md', '# Original rules without newline');
  f.put('docs/domains/orders.md', prose('ARCH-ORDERS', 'architecture'));
  f.put('docs/features/checkout.md', prose('FEAT-CHECKOUT', 'feature')); const original = f.read('docs/features/checkout.md');
  applyPlan(planInstall(f.root, { host: 'agents' }));
  assert.equal(doctor(f.root).activation, 'ready'); assert.equal(doctor(f.root).layout.policy, 'preserve');
  assert.ok(doctor(f.root).layout.nonconforming >= 2);
  assert.equal(f.read('.doc-driven.json').toString(), raw); assert.deepEqual(f.read('docs/features/checkout.md'), original);
  assert.ok(!fs.existsSync(path.join(f.root, 'docs/domains/orders/features/checkout.md')));
});
test('current agent entry, templates and recovery example all prescribe the same domain hierarchy', () => {
  const read = rel => fs.readFileSync(path.join(PKG, rel), 'utf8');
  for (const p of ['SKILL.md', 'README.md', 'LAYOUT.md', 'ADOPTION.md', 'FORMATS/feature.md', 'FORMATS/module.md'])
    assert.match(read(p), /domains\/<domain>\//, p);
  assert.match(read('ADOPTION.md'), /docs\/domains\/data-import\/features\/import\.md/);
  assert.match(read('FORMATS/change.md'), /Targets: docs\/domains\//);
  assert.match(read('LAYOUT.md'), /迁移必须单独授权/);
});
