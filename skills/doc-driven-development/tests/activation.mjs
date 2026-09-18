// Regression for v0.2.2: a requested workflow is not a complete project installation.
// All repositories are synthetic; no network, real host or model is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as installation from '../scripts/project-install.mjs';
import { DEFAULTS, VERSION, loadConfig } from '../scripts/lib.mjs';

const { PACKAGE_ROOT: PKG, STATE, LOCK, DEFAULT_SKILL, RULE_START, RULE_END,
  planInstall, planUninstall, applyPlan, doctor, tree } = installation;
const cli = (name, root, args = []) => spawnSync(process.execPath,
  [path.join(PKG, 'scripts', `${name}.mjs`), root, ...args], { encoding: 'utf8', timeout: 30000 });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-activation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'existing 项目 with spaces'); fs.mkdirSync(root);
  const put = (p, data) => { const dest = path.join(root, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); };
  const read = p => fs.readFileSync(path.join(root, p));
  const has = p => fs.existsSync(path.join(root, p));
  return { root, put, read, has };
}
const bytes = f => Object.fromEntries([...tree(f.root)].map(([p, r]) => [p, r.data.toString('base64')]));
function partial(f, { enabled = true, custom = false } = {}) {
  const raw = custom
    ? `{ "schemaVersion":1, "enabled":${enabled}, "docsRoots":["design"], "index":"design/NAV.md", "adoption":"full", "language":"en" }`
    : `{ "schemaVersion": 1, "enabled": ${enabled}, "docsRoots": ["docs"], "index": "docs/README.md" }`;
  f.put('.doc-driven.json', raw);
  f.put('AGENTS.md', '\uFEFF# 项目规范\r\n只能使用既定目录；不得覆盖我的规则。\n末尾不换行');
  f.put(custom ? 'design/NAV.md' : 'docs/README.md', '# 人工导航\r\n已有文档不可删除。');
  f.put(custom ? 'design/existing.md' : 'docs/existing.md', '# 既有设计\nPreserve exactly.');
  f.put('src/main.js', 'export const existing = true;\n');
  return raw;
}
function ready(f) {
  const d = doctor(f.root); assert.equal(d.activation, 'ready', JSON.stringify(d));
  assert.equal(d.static, 'passed'); assert.equal(d.runtime, 'not-run'); assert.equal(d.requestedEnabled, true);
  assert.ok(f.has(`${DEFAULT_SKILL}/SKILL.md`)); assert.ok(f.has(STATE));
  assert.ok(f.read('AGENTS.md').includes(Buffer.from(RULE_START)));
  return d;
}

test('config-only planning is no longer exported as a public API', () => {
  assert.equal(Object.hasOwn(installation, 'planInit'), false);
});
test('legacy init without apply cannot create an enabled-only project', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Original'); const before = bytes(f);
  const r = cli('init', f.root);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DEPRECATED/);
  assert.match(r.stdout, /PREVIEW IS NOT ACTIVATION/); assert.match(r.stdout, /Setup is not completed/);
  assert.deepEqual(bytes(f), before); assert.ok(!f.has('.doc-driven.json')); assert.ok(!f.has('.doc-driven'));
});
test('init and install previews share the same complete installation plan', t => {
  const f = fixture(t); partial(f); const before = bytes(f);
  const a = cli('init', f.root, ['--host', 'both', '--mode', 'full', '--json']);
  const b = cli('install', f.root, ['--host', 'both', '--mode', 'full', '--json']);
  assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
  const one = JSON.parse(a.stdout), two = JSON.parse(b.stdout);
  assert.equal(one.entrypoint, 'init-compat'); assert.equal(two.entrypoint, 'install');
  for (const result of [one, two]) {
    assert.equal(result.applied, false); assert.equal(result.setupComplete, false);
    assert.equal(result.activation, 'incomplete'); assert.equal(result.activationBefore, 'incomplete');
    assert.ok(result.changes.some(c => c.path === `${DEFAULT_SKILL}/SKILL.md`));
    assert.ok(result.changes.some(c => c.path === 'AGENTS.md'));
    assert.ok(result.changes.some(c => c.path === 'CLAUDE.md'));
    assert.ok(result.changes.some(c => c.path === STATE));
    assert.ok(!result.changes.some(c => c.path === '.doc-driven.json'));
  }
  assert.deepEqual(one.changes.map(c => [c.path, c.operation]), two.changes.map(c => [c.path, c.operation]));
  assert.deepEqual(bytes(f), before);
});
for (const mode of ['incremental', 'full']) test(`legacy init --apply deploys all required project pieces: ${mode}`, t => {
  const f = fixture(t); const original = '# My original rules\r\n保留。'; f.put('AGENTS.md', original);
  const r = cli('init', f.root, ['--host', 'both', '--mode', mode, '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout);
  assert.equal(out.entrypoint, 'init-compat'); assert.equal(out.setupComplete, true);
  assert.equal(out.activationBefore, 'not-installed'); assert.equal(out.activation, 'ready');
  assert.equal(loadConfig(f.root).adoption, mode); assert.equal(out.doctor.runtime, 'not-run');
  assert.ok(f.read('AGENTS.md').toString().startsWith(original));
  assert.ok(f.has('CLAUDE.md')); assert.ok(f.has('docs/README.md')); ready(f);
});
test('doctor diagnoses exact user state as incomplete even though enabled is true', t => {
  const f = fixture(t); partial(f); const before = bytes(f);
  const r = cli('doctor', f.root, ['--json']); assert.equal(r.status, 1, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.requestedEnabled, true); assert.equal(d.activation, 'incomplete');
  assert.equal(d.static, 'failed'); assert.equal(d.runtime, 'not-run');
  assert.ok(d.errors.some(e => e.includes('No managed project installation')));
  assert.ok(d.errors.some(e => e.includes('No project-local skill entry')));
  assert.ok(d.errors.some(e => e.includes('No managed rule connection')));
  assert.equal(d.next.action, 'preview-complete-install');
  assert.equal(d.next.previewArgv.at(-1), f.root); assert.equal(d.next.applyArgv.at(-1), '--apply');
  assert.deepEqual(bytes(f), before);
});
for (const entry of ['install', 'init']) test(`${entry} repairs init-only state without rewriting config, rules or design prose`, t => {
  const f = fixture(t); const raw = partial(f), rules = f.read('AGENTS.md'), index = f.read('docs/README.md');
  const design = f.read('docs/existing.md'), source = f.read('src/main.js');
  const r = cli(entry, f.root, ['--host', 'agents', '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout);
  assert.equal(out.setupComplete, true); assert.equal(out.activationBefore, 'incomplete');
  assert.equal(f.read('.doc-driven.json').toString(), raw);
  assert.ok(f.read('AGENTS.md').subarray(0, rules.length).equals(rules));
  assert.ok(f.read('docs/README.md').subarray(0, index.length).equals(index));
  assert.deepEqual(f.read('docs/existing.md'), design); assert.deepEqual(f.read('src/main.js'), source);
  assert.equal(f.read('AGENTS.md').toString().split(RULE_START).length, 2); ready(f);
});
test('custom document locations and existing full-mode config are preserved during repair', t => {
  const f = fixture(t); const raw = partial(f, { custom: true });
  const r = cli('install', f.root, ['--host', 'agents', '--mode', 'incremental', '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(f.read('.doc-driven.json').toString(), raw);
  assert.ok(!f.has('docs')); assert.ok(f.read('AGENTS.md').includes(Buffer.from('design/NAV.md')));
  assert.equal(loadConfig(f.root).adoption, 'full'); ready(f);
});
test('init forwards custom host and alternate skill location instead of doing partial setup', t => {
  const f = fixture(t); f.put('.custom/RULES.md', '# Local custom instructions');
  const r = cli('init', f.root, ['--host', 'custom', '--rules-file', '.custom/RULES.md',
    '--skill-dir', '.claude/skills/doc-driven-development', '--docs-dir', 'design', '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); const d = doctor(f.root);
  assert.equal(d.activation, 'ready'); assert.equal(d.runtime, 'not-run');
  assert.ok(f.has('.claude/skills/doc-driven-development/SKILL.md'));
  assert.ok(f.read('.custom/RULES.md').toString().startsWith('# Local custom instructions'));
  assert.ok(f.read('.custom/RULES.md').includes(Buffer.from('design/README.md')));
  assert.ok(!f.has('AGENTS.md'));
});
for (const entry of ['install', 'init']) test(`explicitly disabled project is not silently activated by ${entry}`, t => {
  const f = fixture(t); partial(f, { enabled: false }); const before = bytes(f);
  const r = cli(entry, f.root, ['--apply']); assert.equal(r.status, 2); assert.match(r.stderr, /disabled/);
  assert.deepEqual(bytes(f), before);
  const d = doctor(f.root); assert.equal(d.activation, 'disabled'); assert.equal(d.requestedEnabled, false);
  assert.equal(d.next.action, 'review-disabled-config'); assert.equal(d.next.applyArgv, undefined);
});
test('ready installation needs no second write or duplicated rule block through compatibility alias', t => {
  const f = fixture(t); partial(f); applyPlan(planInstall(f.root, { host: 'agents' }));
  const before = bytes(f); const r = cli('init', f.root, ['--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout);
  assert.equal(out.activationBefore, 'ready'); assert.equal(out.result.changed, 0);
  assert.equal(out.result.backup, null); assert.equal(out.setupComplete, true); assert.deepEqual(bytes(f), before);
});
test('preview of an already ready project remains a preview, not a new setup action', t => {
  const f = fixture(t); applyPlan(planInstall(f.root, { host: 'agents' })); const before = bytes(f);
  const r = cli('install', f.root, ['--json']); assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.activation, 'ready'); assert.equal(out.applied, false);
  assert.equal(out.setupComplete, false); assert.deepEqual(bytes(f), before);
});
test('merely copying the complete skill into the project is not activation', t => {
  const f = fixture(t); f.put('.doc-driven.json', JSON.stringify(DEFAULTS));
  fs.cpSync(PKG, path.join(f.root, DEFAULT_SKILL), { recursive: true });
  const d = doctor(f.root); assert.equal(d.activation, 'incomplete'); assert.equal(d.static, 'failed');
  assert.equal(d.unmanagedSkillEntries.length, 1); assert.equal(d.rules.length, 0);
  applyPlan(planInstall(f.root, { host: 'agents' })); ready(f);
});
test('no configuration and no installation reports not-installed, without creating anything', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Plain project rules'); const before = bytes(f);
  const r = cli('doctor', f.root, ['--json']); assert.equal(r.status, 1);
  const d = JSON.parse(r.stdout); assert.equal(d.activation, 'not-installed'); assert.equal(d.requestedEnabled, null);
  assert.deepEqual(bytes(f), before);
});
test('invalid configuration is incomplete rather than an enabled or disabled success', t => {
  const f = fixture(t); f.put('.doc-driven.json', '{ "enabled": "true" }'); const before = bytes(f);
  assert.equal(doctor(f.root).activation, 'incomplete'); assert.equal(doctor(f.root).requestedEnabled, null);
  const r = cli('install', f.root, ['--apply']); assert.equal(r.status, 2); assert.deepEqual(bytes(f), before);
});
test('missing-config errors direct callers to the complete installer, not standalone init', t => {
  const f = fixture(t);
  assert.throws(() => loadConfig(f.root), e => /install\.mjs/.test(e.message) && !/Run init\.mjs/.test(e.message));
});
test('new enabled configuration is scheduled after the complete package, rules and receipt', t => {
  const f = fixture(t); const plan = planInstall(f.root, { host: 'both' });
  assert.equal(plan.writes.at(-1).path, '.doc-driven.json');
  for (const p of [`${DEFAULT_SKILL}/SKILL.md`, 'AGENTS.md', 'CLAUDE.md', STATE, 'docs/README.md'])
    assert.ok(plan.writes.findIndex(w => w.path === p) < plan.writes.length - 1);
});
test('failure before final configuration write rolls back copied files and preserves original prose', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Rules without newline'); f.put('docs/README.md', '# Original index');
  const rules = f.read('AGENTS.md'), index = f.read('docs/README.md');
  const plan = planInstall(f.root, { host: 'agents' });
  assert.throws(() => applyPlan(plan, { beforeWrite(w) {
    if (w.path !== '.doc-driven.json') return;
    assert.ok(f.has(STATE)); assert.ok(f.has(`${DEFAULT_SKILL}/SKILL.md`));
    assert.ok(f.read('AGENTS.md').includes(Buffer.from(RULE_START))); assert.ok(!f.has('.doc-driven.json'));
    throw new Error('synthetic final-step failure');
  } }), /rolled back/);
  assert.ok(!f.has('.doc-driven.json')); assert.ok(!f.has(STATE)); assert.ok(!f.has(`${DEFAULT_SKILL}/SKILL.md`));
  assert.ok(!f.has(LOCK)); assert.deepEqual(f.read('AGENTS.md'), rules); assert.deepEqual(f.read('docs/README.md'), index);
  assert.notEqual(doctor(f.root).activation, 'ready');
});
for (const entry of ['install', 'init']) test(`malformed rule marker blocks ${entry} repair without touching configuration or files`, t => {
  const f = fixture(t); partial(f); f.put('AGENTS.md', '# Keep mine\n' + RULE_START + '\nUnfinished');
  const before = bytes(f); const r = cli(entry, f.root, ['--host', 'agents', '--apply']);
  assert.equal(r.status, 2); assert.deepEqual(bytes(f), before); assert.ok(!f.has(STATE));
});
test('partial or modified skill is not overwritten under the name of repairing activation', t => {
  const f = fixture(t); partial(f); f.put(`${DEFAULT_SKILL}/SKILL.md`, '# My modifications'); const before = bytes(f);
  const r = cli('install', f.root, ['--apply']); assert.equal(r.status, 2);
  assert.match(r.stderr, /not an unchanged known release/); assert.deepEqual(bytes(f), before);
});
test('local changes to a managed rule still block repair and preserve every file', t => {
  const f = fixture(t); applyPlan(planInstall(f.root, { host: 'agents' }));
  f.put('AGENTS.md', f.read('AGENTS.md').toString().replace(RULE_END, 'My managed change\n' + RULE_END));
  const before = bytes(f); assert.equal(doctor(f.root).activation, 'incomplete');
  const r = cli('init', f.root, ['--apply']); assert.equal(r.status, 2); assert.deepEqual(bytes(f), before);
});
test('post-install doctor failure never produces setupComplete true even for a no-op apply', t => {
  const f = fixture(t); applyPlan(planInstall(f.root, { host: 'agents' })); f.put(LOCK, '{}'); const before = bytes(f);
  const r = cli('install', f.root, ['--apply', '--json']); assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.applied, true); assert.equal(out.setupComplete, false);
  assert.equal(out.activation, 'incomplete'); assert.equal(out.doctor.runtime, 'not-run'); assert.deepEqual(bytes(f), before);
});
test('version mismatch is diagnosed and never counted as ready for the newer workflow', t => {
  const f = fixture(t); applyPlan(planInstall(f.root, { host: 'agents' }));
  const s = JSON.parse(f.read(STATE)); s.version = '0.2.1'; f.put(STATE, JSON.stringify(s));
  const d = doctor(f.root); assert.equal(d.activation, 'incomplete');
  assert.ok(d.errors.some(e => e.includes('Installed version 0.2.1')));
});
test('uninstall preserves the true preference but doctor no longer reports ready', t => {
  const f = fixture(t); const raw = partial(f), original = f.read('AGENTS.md');
  applyPlan(planInstall(f.root, { host: 'agents' })); ready(f); applyPlan(planUninstall(f.root));
  assert.equal(f.read('.doc-driven.json').toString(), raw); assert.deepEqual(f.read('AGENTS.md'), original);
  const d = doctor(f.root); assert.equal(d.requestedEnabled, true); assert.equal(d.activation, 'incomplete');
});
test('legacy init refuses mutually exclusive apply/dry-run and unsupported force flags without writing', t => {
  const f = fixture(t); partial(f); const before = bytes(f);
  for (const args of [['--apply', '--dry-run'], ['--force']]) assert.equal(cli('init', f.root, args).status, 2);
  assert.deepEqual(bytes(f), before);
});
test('legacy init help describes a full-install alias and has no side effects', t => {
  const f = fixture(t); const r = cli('init', f.root, ['--help']); assert.equal(r.status, 0);
  assert.match(r.stdout, /deprecated compatibility alias/); assert.match(r.stdout, /No configuration-only/);
  assert.deepEqual(bytes(f), {});
});
test('maintained entry docs no longer prescribe standalone init as a project activation command', () => {
  for (const p of ['SKILL.md', 'README.md', 'INSTALL.md', 'ADOPTION.md']) {
    const text = fs.readFileSync(path.join(PKG, p), 'utf8');
    assert.ok(!/node[^\n]*scripts\/init\.mjs/.test(text), p);
  }
  const skill = fs.readFileSync(path.join(PKG, 'SKILL.md'), 'utf8');
  assert.ok(skill.indexOf('## 先完成项目接入') < skill.indexOf('## 先确定工作模式'));
  for (const term of ['项目级采用', 'activation: ready', 'incomplete', 'enabled: true', '不重复索取', '仅本次'])
    assert.ok(skill.includes(term), term);
});
test('package supports known unmanaged 0.2.0 and 0.2.1 predecessors', () => {
  const manifest = installation.readPackage().manifest;
  assert.equal(manifest.version, VERSION);
  assert.ok(manifest.predecessors['0.2.0']);
  assert.ok(manifest.predecessors['0.2.1']['package-manifest.json']);
});


test('orphaned transaction lock is incomplete, not a fresh uninstalled project', t => {
  const f = fixture(t); f.put(LOCK, '{}'); const before = bytes(f);
  const d = doctor(f.root); assert.equal(d.activation, 'incomplete');
  assert.ok(d.errors.some(e => e.includes('installation lock'))); assert.deepEqual(bytes(f), before);
});
