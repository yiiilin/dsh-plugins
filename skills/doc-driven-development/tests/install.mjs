// Installation fixtures are isolated; no real project, model, network or host is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PACKAGE_ROOT as PKG, STATE, LOCK, DEFAULT_SKILL, RULE_START, RULE_END,
  planInstall, planUninstall, applyPlan, doctor, readPackage, snapshot, loadState, tree,
} from '../scripts/project-install.mjs';
import { sha, DEFAULTS, VERSION, inventory, loadConfig, updateIndex, replaceIndex, START, END } from '../scripts/lib.mjs';
import { decodeText, inspectBlock } from '../scripts/managed-text.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '项目 with spaces'); fs.mkdirSync(root);
  const put = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  const read = rel => fs.readFileSync(path.join(root, rel));
  const has = rel => fs.existsSync(path.join(root, rel));
  const setup = flags => applyPlan(planInstall(root, { host: 'agents', ...flags }));
  return { home, root, put, read, has, setup };
}
function cli(name, root, args = []) {
  return spawnSync(process.execPath, [path.join(PKG, 'scripts', `${name}.mjs`), root, ...args], { encoding: 'utf8', timeout: 30000 });
}
function contents(root, excludeMetadata = false) {
  const out = {};
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = path.relative(root, p).split(path.sep).join('/');
      if (excludeMetadata && rel === '.doc-driven') continue;
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) out[rel] = `LINK:${fs.readlinkSync(p)}`;
      else out[rel] = fs.readFileSync(p).toString('base64');
    }
  }; walk(root); return out;
}
const expectNoWrite = (f, action, regex) => {
  const before = contents(f.root);
  assert.throws(action, regex);
  assert.deepEqual(contents(f.root), before);
};
function sourceCopy(f) {
  const dir = path.join(f.home, 'source', 'doc-driven-development'); fs.cpSync(PKG, dir, { recursive: true }); return dir;
}
function rehash(dir, modify = () => {}) {
  const file = path.join(dir, 'package-manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  modify(manifest);
  manifest.files = Object.fromEntries([...tree(dir)].filter(([p]) => p !== 'package-manifest.json').map(([p, r]) => [p, sha(r.data)]));
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

// Preservation and idempotency.
test('install CLI defaults to a read-only preview, not an implicit write', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Existing\nDo not overwrite.'); f.put('src/index.js', 'existing');
  const before = contents(f.root), result = cli('install', f.root, ['--host', 'agents']);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PREVIEW ONLY/);
  assert.deepEqual(contents(f.root), before); assert.ok(!f.has('.doc-driven'));
});
test('apply creates project-local installation and preserves business code, settings and CI', t => {
  const f = fixture(t);
  for (const rel of ['src/main.js', 'README.md', '.gitignore', '.github/workflows/ci.yml', '.claude/settings.json', '.codex/config.toml']) f.put(rel, `Original ${rel}\n`);
  const before = contents(f.root); f.setup();
  for (const [p, b] of Object.entries(before)) assert.equal(f.read(p).toString('base64'), b);
  assert.ok(f.has(`${DEFAULT_SKILL}/SKILL.md`)); assert.ok(f.has(STATE));
  const d = doctor(f.root); assert.equal(d.static, 'passed', JSON.stringify(d)); assert.equal(d.runtime, 'not-run');
});
for (const [name, original] of [
  ['LF', '# rules\n\nOriginal\n'], ['CRLF', '# rules\r\n\r\nOriginal\r\n'],
  ['mixed newlines', '# rules\r\nChinese 中文\n末尾'], ['no trailing newline', '# rules\nKeep this'],
  ['UTF-8 BOM', '\uFEFF# 规范\r\n原内容\r\n'], ['empty existing file', ''],
]) test(`round trip restores original rule bytes: ${name}`, t => {
  const f = fixture(t); f.put('AGENTS.md', original); f.setup();
  assert.ok(f.read('AGENTS.md').subarray(0, Buffer.byteLength(original)).equals(Buffer.from(original)));
  applyPlan(planUninstall(f.root)); assert.ok(f.has('AGENTS.md')); assert.deepEqual(f.read('AGENTS.md'), Buffer.from(original));
});
test('index update preserves prose before and after its managed region', t => {
  const f = fixture(t); const before = '# My handbook\r\n\r\n', after = '\r\nKeep custom navigation.\r\n';
  f.put('docs/README.md', before + START + '\r\nold table\r\n' + END + after); f.setup();
  const text = f.read('docs/README.md').toString('utf8');
  assert.ok(text.startsWith(before)); assert.ok(text.endsWith(after)); assert.ok(text.includes('\r\n| 文档'));
});
test('existing JSON bytes, directory mapping, language and mode are not reformatted', t => {
  const f = fixture(t), raw = '{ "schemaVersion": 1, "enabled": true, "docsRoots": ["design"], "index": "design/INDEX.md", "adoption": "full", "language": "en" }';
  f.put('.doc-driven.json', raw); f.put('design/INDEX.md', '# Existing index\n');
  const plan = planInstall(f.root, { host: 'agents', mode: 'incremental', 'docs-dir': 'docs', language: 'zh-CN' });
  assert.equal(plan.warnings.length, 3); applyPlan(plan);
  assert.equal(f.read('.doc-driven.json').toString(), raw); assert.ok(!f.has('docs'));
  assert.ok(f.read('AGENTS.md').includes(Buffer.from('design/INDEX.md')));
});
test('reinstall is a no-op: no duplicate blocks, touched mtime, or new backup', t => {
  const f = fixture(t); f.setup(); const before = contents(f.root), st = fs.statSync(path.join(f.root, 'AGENTS.md'));
  const plan = planInstall(f.root), result = applyPlan(plan);
  assert.equal(plan.writes.length, 0); assert.equal(result.changed, 0); assert.equal(result.backup, null);
  assert.deepEqual(contents(f.root), before); assert.equal(fs.statSync(path.join(f.root, 'AGENTS.md')).mtimeMs, st.mtimeMs);
});
test('user changes outside the managed block are retained during reinstall and uninstall', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Original\n'); f.setup();
  const text = 'New human preface\n' + f.read('AGENTS.md') + '\nNew human appendix\n'; f.put('AGENTS.md', text);
  const plan = planInstall(f.root); assert.equal(plan.writes.length, 0); applyPlan(planUninstall(f.root));
  const result = f.read('AGENTS.md').toString(); assert.ok(result.startsWith('New human preface\n# Original\n'));
  assert.ok(result.endsWith('\nNew human appendix\n')); assert.ok(!result.includes(RULE_START));
});
test('original ordinary file permissions survive rule install and uninstall', t => {
  const f = fixture(t); f.put('AGENTS.md', 'Private instructions'); fs.chmodSync(path.join(f.root, 'AGENTS.md'), 0o640);
  f.setup(); assert.equal(fs.statSync(path.join(f.root, 'AGENTS.md')).mode & 0o777, 0o640);
  applyPlan(planUninstall(f.root)); assert.equal(fs.statSync(path.join(f.root, 'AGENTS.md')).mode & 0o777, 0o640);
});
test('modified managed rule block refuses reinstall and uninstall without any writes', t => {
  const f = fixture(t); f.setup(); f.put('AGENTS.md', f.read('AGENTS.md').toString().replace('observed', 'MY CHOICE'));
  expectNoWrite(f, () => planInstall(f.root), /changed or removed/);
  expectNoWrite(f, () => planUninstall(f.root), /changed or missing/);
});
test('legacy manually pasted rules are retained with a duplicate/conflict warning', t => {
  const f = fixture(t), text = '# Policies\nUse doc-driven-development as described in our handbook.\n'; f.put('AGENTS.md', text);
  const p = planInstall(f.root, { host: 'agents' }); assert.ok(p.warnings.some(w => w.includes('legacy/manual'))); applyPlan(p);
  assert.ok(f.read('AGENTS.md').toString().startsWith(text));
});
test('unowned different managed block is not assumed safe to replace', t => {
  const f = fixture(t); f.put('AGENTS.md', `${RULE_START}\nCustom ownership\n${RULE_END}\n`);
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /Unowned managed rule block differs/);
});

// Host routing.
test('Claude prefers existing .claude/CLAUDE.md and leaves AGENTS.md and root untouched', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Another host\n'); f.put('.claude/CLAUDE.md', '# Claude rules\n'); f.setup({ host: 'claude' });
  assert.equal(f.read('AGENTS.md').toString(), '# Another host\n'); assert.ok(!f.has('CLAUDE.md'));
  assert.equal(loadState(f.root).rules[0].path, '.claude/CLAUDE.md');
});
test('both installs each distinct appropriate root entry and preserves all prefaces', t => {
  const f = fixture(t);
  for (const p of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']) f.put(p, `# Existing ${p}\n`);
  f.setup({ host: 'both' }); assert.equal(loadState(f.root).rules.length, 3);
  for (const p of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']) assert.ok(f.read(p).toString().startsWith(`# Existing ${p}\n`));
  assert.equal(doctor(f.root).static, 'passed');
});
test('Codex uses existing nonempty override rather than adding a shadowed AGENTS block', t => {
  const f = fixture(t); f.put('AGENTS.md', 'Base remains exact'); f.put('AGENTS.override.md', 'Override rules'); f.setup({ host: 'codex' });
  assert.equal(f.read('AGENTS.md').toString(), 'Base remains exact'); assert.equal(loadState(f.root).rules[0].path, 'AGENTS.override.md');
});
test('empty override remains empty while Codex attaches to AGENTS', t => {
  const f = fixture(t); f.put('AGENTS.override.md', '\n  '); f.setup({ host: 'codex' });
  assert.equal(f.read('AGENTS.override.md').toString(), '\n  '); assert.equal(loadState(f.root).rules[0].path, 'AGENTS.md');
});
test('auto selection reports it is inferred, not verified live-host discovery', t => {
  const f = fixture(t); const p = planInstall(f.root); assert.ok(p.warnings.some(w => w.includes('not from a running agent')));
  assert.equal(p.details.rules[0].adapter, 'agents');
});
test('auto detects a Claude-only repository without adding AGENTS', t => {
  const f = fixture(t); f.put('CLAUDE.md', 'Existing'); applyPlan(planInstall(f.root)); assert.ok(!f.has('AGENTS.md'));
});
test('adding a second host is additive and does not silently uninstall the first', t => {
  const f = fixture(t); f.setup({ host: 'claude' }); f.setup({ host: 'agents' });
  assert.equal(loadState(f.root).rules.length, 2); assert.ok(f.read('CLAUDE.md').toString().includes(RULE_START));
});
test('custom Markdown entry is supported but automatic host loading is unverified', t => {
  const f = fixture(t); f.put('.custom/RULES.md', '# Custom\n'); f.setup({ host: 'custom', 'rules-file': '.custom/RULES.md' });
  assert.ok(!f.has('AGENTS.md')); assert.ok(doctor(f.root).warnings.some(w => w.includes('no verified automatic-loading')));
});
test('supported alternate skill directory is explicit in every rule entry', t => {
  const f = fixture(t); f.setup({ host: 'claude', 'skill-dir': '.claude/skills/doc-driven-development' });
  assert.ok(f.has('.claude/skills/doc-driven-development/SKILL.md'));
  assert.ok(f.read('CLAUDE.md').toString().includes('.claude/skills/doc-driven-development/SKILL.md'));
});

// Safety refusal is a no-write result.
for (const [name, text] of [
  ['missing end', RULE_START + '\nbody'], ['reversed', `${RULE_END}\n${RULE_START}\n`],
  ['duplicate', `${RULE_START}\na\n${RULE_END}\n${RULE_START}\nb\n${RULE_END}\n`],
  ['inline marker', `prefix ${RULE_START}\na\n${RULE_END}\n`],
  ['inside code', `\`\`\`md\n${RULE_START}\na\n${RULE_END}\n\`\`\`\n`],
  ['unclosed code', '# Existing\n```sh\nDo not hide new rules'],
  ['unclosed comment', '# Existing\n<!-- unfinished'],
  ['unclosed YAML', '---\nkey: value\n'],
  ['marker hidden in comment', `<!--\n${RULE_START}\na\n${RULE_END}\n-->\n`],
]) test(`ambiguous rule Markdown is rejected without changing the project: ${name}`, t => {
  const f = fixture(t); f.put('AGENTS.md', text); expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /marker|Marker|Managed|Unclosed|comment/i);
});
test('malformed document index cannot leave behind a newly created config', t => {
  const f = fixture(t); f.put('docs/README.md', '# Index\n' + START + '\nmissing end');
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /Index markers/);
  const before = contents(f.root), r = cli('init', f.root); assert.equal(r.status, 2); assert.deepEqual(contents(f.root), before);
});
for (const [name, data] of [['UTF16', Buffer.from('Rules', 'utf16le')], ['invalid UTF8', Buffer.from([0xff, 0xfe, 0x80])]])
  test(`lossy rule decoding is refused: ${name}`, t => {
    const f = fixture(t); f.put('AGENTS.md', data); expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /binary|UTF-8|UTF-16/);
  });
test('oversized rule file is refused rather than truncated', t => {
  const f = fixture(t); f.put('AGENTS.md', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /2 MiB/);
});
test('rule symlink outside project is refused and its target is unchanged', t => {
  const f = fixture(t), target = path.join(f.home, 'outside.md'); fs.writeFileSync(target, 'External'); fs.symlinkSync(target, path.join(f.root, 'AGENTS.md'));
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /Symbolic/); assert.equal(fs.readFileSync(target, 'utf8'), 'External');
});
test('symlinked skill ancestor is refused before mutation', t => {
  const f = fixture(t), outside = path.join(f.home, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.root, '.agents'));
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /Symbolic/); assert.deepEqual(fs.readdirSync(outside), []);
});
test('hard-linked rule is refused rather than changing shared file semantics', t => {
  const f = fixture(t); f.put('shared.md', 'Shared'); fs.linkSync(path.join(f.root, 'shared.md'), path.join(f.root, 'AGENTS.md'));
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /hard-linked/);
});
test('directory occupying rule file destination is rejected', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'AGENTS.md'));
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /non-regular/);
});
test('disabled configuration is not silently re-enabled', t => {
  const f = fixture(t); f.put('.doc-driven.json', JSON.stringify({ ...DEFAULTS, enabled: false }));
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /explicitly disabled/);
});
test('invalid custom paths and option combinations are rejected without writes', t => {
  const f = fixture(t);
  for (const flags of [{ host: 'custom' }, { host: 'agents', 'rules-file': 'X.md' }, { host: 'custom', 'rules-file': '../AGENTS.md' },
    { 'skill-dir': 'src/doc-driven-development' }, { mode: 'unsafe' }]) expectNoWrite(f, () => planInstall(f.root, flags));
});
test('CLI rejects --force rather than exposing a blanket overwrite escape', t => {
  const f = fixture(t); for (const name of ['install', 'uninstall']) { const r = cli(name, f.root, ['--force']); assert.equal(r.status, 2); }
  assert.deepEqual(contents(f.root), {});
});
test('CLI refuses contradictory apply/dry-run flags', t => {
  const f = fixture(t); const r = cli('install', f.root, ['--apply', '--dry-run']); assert.equal(r.status, 2); assert.deepEqual(contents(f.root), {});
});

// Upgrade integrity.
test('package manifest verifies complete current release bytes', () => { const p = readPackage(); assert.equal(p.manifest.version, VERSION); assert.ok(p.files.size >= 25); });
test('corrupt source release is rejected before touching the target', t => {
  const f = fixture(t), source = sourceCopy(f); fs.appendFileSync(path.join(source, 'SKILL.md'), '\nUnrecorded change');
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }, source), /Package missing or changed/);
});
test('locally modified installed skill cannot be overwritten by upgrade', t => {
  const f = fixture(t); f.setup(); f.put(`${DEFAULT_SKILL}/SKILL.md`, 'My modifications');
  expectNoWrite(f, () => planInstall(f.root), /locally changed/);
});
test('unrecognized preexisting skill directory is preserved', t => {
  const f = fixture(t); f.put(`${DEFAULT_SKILL}/SKILL.md`, 'An unknown personalized skill');
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /not an unchanged known release/);
});
test('unmanaged exact current release can be adopted without rewriting its files', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(path.join(f.root, DEFAULT_SKILL)), { recursive: true }); fs.cpSync(PKG, path.join(f.root, DEFAULT_SKILL), { recursive: true });
  const p = planInstall(f.root, { host: 'agents' }); assert.ok(!p.writes.some(w => w.path.startsWith(DEFAULT_SKILL + '/'))); applyPlan(p);
  assert.equal(doctor(f.root).static, 'passed');
});
test('known predecessor migrates; obsolete files are removed only when their known hashes match', t => {
  const f = fixture(t), source = sourceCopy(f), old = { 'SKILL.md': 'old known release', 'obsolete.md': 'old owned resource' };
  for (const [p, text] of Object.entries(old)) f.put(`${DEFAULT_SKILL}/${p}`, text);
  f.put(`${DEFAULT_SKILL}/personal.md`, 'Keep this extra');
  rehash(source, m => { m.predecessors = { '0.2.0': Object.fromEntries(Object.entries(old).map(([p, text]) => [p, sha(text)])) }; });
  const plan = planInstall(f.root, { host: 'agents' }, source); applyPlan(plan);
  assert.ok(!f.has(`${DEFAULT_SKILL}/obsolete.md`)); assert.equal(f.read(`${DEFAULT_SKILL}/personal.md`).toString(), 'Keep this extra');
});
test('new release filename collision with personal extras stops upgrade', t => {
  const f = fixture(t), source = sourceCopy(f); f.setup(); f.put(`${DEFAULT_SKILL}/personal.md`, 'Human');
  fs.writeFileSync(path.join(source, 'personal.md'), 'New release-owned file'); rehash(source);
  expectNoWrite(f, () => planInstall(f.root, {}, source), /conflicts with an unowned file/);
});
test('unknown files under installed skill are never removed by uninstall', t => {
  const f = fixture(t); f.setup(); f.put(`${DEFAULT_SKILL}/personal.md`, 'Preserve me'); applyPlan(planUninstall(f.root));
  assert.equal(f.read(`${DEFAULT_SKILL}/personal.md`).toString(), 'Preserve me');
});
test('changing install location on an established installation requires explicit action', t => {
  const f = fixture(t); f.setup(); expectNoWrite(f, () => planInstall(f.root, { 'skill-dir': '.claude/skills/doc-driven-development' }), /explicit uninstall/);
});
test('forged receipt cannot move owned files outside the approved skill directory', t => {
  const f = fixture(t); f.setup(); const s = loadState(f.root); s.packageFiles['../../AGENTS.md'] = sha('x'); f.put(STATE, JSON.stringify(s));
  expectNoWrite(f, () => planUninstall(f.root), /safe repository-relative/);
});

// Transaction failures and backups.
test('baseline change after planning cancels all installer writes', t => {
  const f = fixture(t); f.put('AGENTS.md', 'Before'); const p = planInstall(f.root, { host: 'agents' }); f.put('AGENTS.md', 'New human change');
  expectNoWrite(f, () => applyPlan(p), /changed after planning/);
});
test('all modified file bytes have backup copies before applying', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Original\r\n'); f.put('docs/README.md', '# Navigation'); const before = contents(f.root);
  const result = f.setup(), journal = JSON.parse(f.read(`${result.backup}/transaction.json`)); assert.equal(journal.state, 'completed');
  for (const op of journal.operations.filter(x => x.backup)) {
    assert.equal(f.read(`${result.backup}/${op.backup}`).toString('base64'), before[op.path]);
    assert.equal(sha(f.read(`${result.backup}/${op.backup}`)), op.beforeSha256);
  }
});
test('caught failure rolls back applied project files and keeps backup evidence', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Original'); f.put('docs/README.md', '# Original docs'); const before = contents(f.root);
  const p = planInstall(f.root, { host: 'agents' });
  assert.throws(() => applyPlan(p, { beforeWrite(_w, i) { if (i === 5) throw new Error('Injected I/O failure'); } }), /rolled back/);
  assert.deepEqual(contents(f.root, true), before); assert.ok(!f.has(LOCK)); assert.ok(f.has('.doc-driven/backups'));
});
test('rollback will not overwrite a later concurrent user edit to an already-written file', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Before'); const p = planInstall(f.root, { host: 'agents' });
  assert.throws(() => applyPlan(p, { beforeWrite(w) {
    if (w.path === STATE) { f.put('AGENTS.md', '# Human changed after the installer write'); throw new Error('Injected failure'); }
  } }), /Rollback preserved concurrent edits/);
  assert.equal(f.read('AGENTS.md').toString(), '# Human changed after the installer write'); assert.ok(!f.has(STATE));
});
test('existing installation lock blocks apply without changing original project files', t => {
  const f = fixture(t); f.put(LOCK, JSON.stringify({ pid: process.pid, action: 'other' }));
  expectNoWrite(f, () => applyPlan(planInstall(f.root, { host: 'agents' })), /lock exists/);
});

// Uninstall retains user-owned project assets.
test('uninstall preview writes nothing', t => {
  const f = fixture(t); f.setup(); const before = contents(f.root), r = cli('uninstall', f.root);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /PREVIEW ONLY/); assert.deepEqual(contents(f.root), before);
});
test('uninstall retains config, design documents, source and backups', t => {
  const f = fixture(t); f.setup(); f.put('docs/features/manual.md', '# A design worth preserving'); f.put('src/app.js', 'keep');
  const config = f.read('.doc-driven.json'), index = f.read('docs/README.md'); applyPlan(planUninstall(f.root));
  assert.ok(!f.has(STATE)); assert.ok(!f.has('AGENTS.md')); assert.deepEqual(f.read('.doc-driven.json'), config);
  assert.deepEqual(f.read('docs/README.md'), index); assert.ok(f.has('docs/features/manual.md')); assert.ok(f.has('src/app.js'));
  assert.ok(f.has('.doc-driven/backups'));
});
test('newly-created rule file with later user content is retained', t => {
  const f = fixture(t); f.setup(); fs.appendFileSync(path.join(f.root, 'AGENTS.md'), '\n# New human rule\nDo not delete.\n');
  applyPlan(planUninstall(f.root)); assert.ok(f.has('AGENTS.md')); assert.ok(f.read('AGENTS.md').toString().includes('Do not delete.'));
});
test('keep-skill permits detaching even when a release-owned skill file was customized', t => {
  const f = fixture(t); f.setup(); f.put(`${DEFAULT_SKILL}/SKILL.md`, '# Personal version');
  expectNoWrite(f, () => planUninstall(f.root), /changed or missing/);
  applyPlan(planUninstall(f.root, { 'keep-skill': true })); assert.equal(f.read(`${DEFAULT_SKILL}/SKILL.md`).toString(), '# Personal version');
});
test('uninstall without an installation receipt refuses destructive guessing', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Existing'); expectNoWrite(f, () => planUninstall(f.root), /No managed project installation/);
});

// doctor does not confuse filesystem structure with real agent activation.
test('doctor is read-only and runtime is always explicitly not-run', t => {
  const f = fixture(t); f.setup(); const before = contents(f.root), r = cli('doctor', f.root, ['--json', '--probe']);
  assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout); assert.equal(out.static, 'passed'); assert.equal(out.runtime, 'not-run');
  assert.ok(!out.probe.prompt.includes('doc-driven-development')); assert.deepEqual(contents(f.root), before);
});
test('doctor reports explicitly disabled config as failed, not successful skip', t => {
  const f = fixture(t); f.setup(); const c = loadConfig(f.root); c.enabled = false; f.put('.doc-driven.json', JSON.stringify(c));
  const d = doctor(f.root); assert.equal(d.static, 'failed'); assert.ok(d.errors.some(e => e.includes('disabled')));
});
test('doctor catches a missing skill file', t => {
  const f = fixture(t); f.setup(); fs.unlinkSync(path.join(f.root, DEFAULT_SKILL, 'SKILL.md'));
  assert.equal(doctor(f.root).static, 'failed');
});
test('doctor catches a missing or modified rule entry', t => {
  const f = fixture(t); f.setup(); f.put('AGENTS.md', '# Human replaced it');
  assert.ok(doctor(f.root).errors.some(e => e.includes('Managed rule missing/changed')));
});
test('outside rule edits do not invalidate block ownership', t => {
  const f = fixture(t); f.setup(); fs.appendFileSync(path.join(f.root, 'AGENTS.md'), '\n# Other rule\nUse pnpm.\n');
  assert.equal(doctor(f.root).static, 'passed');
});
test('moving the configured index detects stale entry and can update only the owned block', t => {
  const f = fixture(t); f.setup(); const c = loadConfig(f.root); c.index = 'docs/INDEX.md'; f.put('.doc-driven.json', JSON.stringify(c)); updateIndex(f.root, c);
  assert.ok(doctor(f.root).errors.some(e => e.includes('stale relative to configuration')));
  const p = planInstall(f.root); applyPlan(p); assert.equal(doctor(f.root).static, 'passed');
});
test('doctor detects root override introduced after installation', t => {
  const f = fixture(t); f.setup({ host: 'codex' }); f.put('AGENTS.override.md', '# Newly introduced override');
  assert.ok(doctor(f.root).errors.some(e => e.includes('shadows AGENTS.md')));
});
test('doctor reports nested instructions without modifying or asserting semantic resolution', t => {
  const f = fixture(t); f.setup(); f.put('packages/sub/AGENTS.md', 'Different rules');
  const before = contents(f.root), d = doctor(f.root); assert.ok(d.warnings.some(w => w.includes('Nested project rules'))); assert.deepEqual(contents(f.root), before);
});
test('doctor warns about possible instruction truncation instead of trimming original rules', t => {
  const f = fixture(t), original = '# Large policy\n' + 'Keep content.\n'.repeat(3000); f.put('AGENTS.md', original); f.setup();
  assert.ok(doctor(f.root).warnings.some(w => w.includes('32 KiB'))); assert.ok(f.read('AGENTS.md').toString().startsWith(original));
});
test('doctor rejects leftover lock rather than declaring installation healthy', t => {
  const f = fixture(t); f.setup(); f.put(LOCK, '{}'); assert.ok(doctor(f.root).errors.some(e => e.includes('installation lock')));
});
test('doctor strict mode fails on unresolved warnings', t => {
  const f = fixture(t); f.setup(); f.put('sub/AGENTS.md', '# Nested'); const r = cli('doctor', f.root, ['--strict']); assert.equal(r.status, 1);
});
test('backup and installation metadata do not change the code snapshot or become analysis candidates', t => {
  const f = fixture(t); f.put('.doc-driven.json', JSON.stringify(DEFAULTS)); f.put('src/main.js', 'existing code');
  const before = inventory(f.root, loadConfig(f.root)).snapshot; f.setup(); const inv = inventory(f.root, loadConfig(f.root));
  assert.equal(inv.snapshot, before); assert.equal(inv.summary.candidates, 1);
});
test('all new CLI help paths are usable without an existing installation', t => {
  const f = fixture(t); for (const name of ['install', 'doctor', 'uninstall']) { const r = cli(name, f.root, ['--help']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Usage:/); }
  assert.deepEqual(contents(f.root), {});
});
test('full CLI installation returns distinct applied/static/runtime fields in JSON', t => {
  const f = fixture(t), r = cli('install', f.root, ['--host', 'both', '--apply', '--json']);
  assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout); assert.equal(out.applied, true); assert.equal(out.doctor.static, 'passed'); assert.equal(out.doctor.runtime, 'not-run');
});

test('read-only user rules are not replaced through a writable parent directory', t => {
  const f = fixture(t); f.put('AGENTS.md', '# Explicitly read-only'); fs.chmodSync(path.join(f.root, 'AGENTS.md'), 0o444);
  expectNoWrite(f, () => planInstall(f.root, { host: 'agents' }), /read-only/);
});
test('Git-ignored installation entries are reported without editing ignore rules', t => {
  const f = fixture(t); f.put('.gitignore', '.agents/\n.doc-driven/\n');
  const g = spawnSync('git', ['init', '-q'], { cwd: f.root, encoding: 'utf8' }); assert.equal(g.status, 0, g.stderr);
  f.setup(); const d = doctor(f.root); assert.ok(d.warnings.some(w => w.includes('Git-ignored')));
  assert.equal(f.read('.gitignore').toString(), '.agents/\n.doc-driven/\n');
});
test('index append and regenerate refuse hidden markers inside fenced examples', () => {
  const text = '```md\n' + START + '\nold\n' + END + '\n```\n';
  assert.throws(() => replaceIndex(text, START + '\nnew\n' + END), /hidden/);
});

test('generic AGENTS integration warns about Codex shadowing without pretending it selected Codex', t => {
  const f = fixture(t); f.put('AGENTS.override.md', '# Another agent scope'); f.setup({ host: 'agents' });
  const d = doctor(f.root); assert.equal(d.static, 'passed'); assert.ok(d.warnings.some(w => w.includes('does not claim Codex coverage')));
});
test('both adapter retains explicit Codex routing when AGENTS and Codex share one entry', t => {
  const f = fixture(t); f.setup({ host: 'both' }); f.put('AGENTS.override.md', '# New shadowing entry');
  assert.ok(doctor(f.root).errors.some(e => e.includes('shadows AGENTS.md')));
});
