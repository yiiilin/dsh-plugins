// All fixtures are synthetic and isolated. No network or third-party packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DEFAULTS, globRE, safePath, loadConfig, inventory, updateIndex, documents,
  START, END, parseCLI, header, stripFences, changedPaths, resolveBase, git,
} from '../scripts/lib.mjs';
import { checkRepo } from '../scripts/check-doc-set.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/features/main.md';
const baseBody = '\n## 1. Requirements\n\n### R-MAIN-001 Addition\nReturn the sum of the two input numbers.\n\n## 2. Design\nA pure function; no persistent state.\n';
function textDoc(overrides = {}, body = baseBody) {
  const h = {
    'Doc-ID': 'FEAT-MAIN', Type: 'feature', Revision: '1', Status: 'observed', Baseline: 'unknown',
    Owns: 'src/**', Implementation: 'unknown', Verification: 'not-run', ...overrides,
  };
  return '# Main\n\n' + Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' + body;
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const config = { ...structuredClone(DEFAULTS), ...options.config };
  put('.doc-driven.json', JSON.stringify(config));
  put('src/main.mjs', 'export const add = (a, b) => a + b;\n');
  if (options.doc !== false) put(DOC, textDoc());
  updateIndex(root, config);
  const f = { root, put, config, doc: (h = {}, body) => put(DOC, textDoc(h, body)),
    index: () => updateIndex(root, config), inv: () => inventory(root, config),
    check: options => checkRepo(root, config, options) };
  return f;
}
function cli(name, args, cwd) {
  return spawnSync(process.execPath, [path.join(PKG, 'scripts', `${name}.mjs`), ...args], { cwd, encoding: 'utf8', timeout: 20000 });
}
const fails = (report, part) => assert.ok(report.errors.some(e => e.includes(part)), `${part}\n${JSON.stringify(report, null, 2)}`);
const ok = report => assert.deepEqual(report.errors, []);
function evidence(baseline, result = 'passed', covers = 'R-MAIN-001', id = 'E-MAIN-001') {
  return `${baseBody}\n## Evidence\n\n### ${id} Unit check\nCovers: ${covers}\nMethod: node --test test/main.test.mjs\nResult: ${result}\nBaseline: ${baseline}\nDetail: Synthetic fixture for validating record structure, not an assertion this command ran.\n`;
}
function approve(f, baseline) {
  f.doc({ Status: 'accepted', Approval: 'Test fixture: explicit approval of revision 1; not a real project approval.',
    'Approved revision': '1', Baseline: baseline, Implementation: 'complete', Verification: 'passed' }, evidence(baseline));
  f.index();
}
function progress(f, overrides = {}) {
  const inv = f.inv(), records = {};
  for (const file of inv.files.filter(f => f.candidate)) records[file.path] = {
    sha256: file.sha256, state: 'reviewed', docs: [DOC], note: 'Synthetic reviewed-record fixture.',
  };
  const data = { schemaVersion: 1, inventorySnapshot: inv.snapshot, files: records, ...overrides };
  f.put('docs/adoption/progress.json', JSON.stringify(data));
  return data;
}
function startGit(f) {
  git(f.root, ['init', '-q']);
  git(f.root, ['config', 'user.name', 'Fixture']); git(f.root, ['config', 'user.email', 'fixture@example.invalid']);
  git(f.root, ['config', 'commit.gpgsign', 'false']);
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'baseline']);
  return git(f.root, ['rev-parse', 'HEAD']).trim();
}

test('glob ** matches zero or many directory levels; metacharacters are escaped', () => {
  for (const p of ['src/a.mjs', 'src/deep/a.mjs']) assert.ok(globRE('src/**/*.mjs').test(p));
  assert.ok(globRE('**/*.json').test('package.json'));
  assert.ok(globRE('src/a?.mjs').test('src/ab.mjs'));
  assert.ok(!globRE('src/*.mjs').test('src/deep/a.mjs'));
  assert.ok(globRE('src/a+b.mjs').test('src/a+b.mjs'));
  assert.throws(() => globRE('../*')); assert.throws(() => globRE('src/[ab].mjs'));
});
test('parser rejects unknown options and missing values', () => {
  assert.throws(() => parseCLI(['--surprise']));
  assert.throws(() => parseCLI(['--base'], { '--base': 'value' }));
  assert.throws(() => parseCLI(['--base', 'a', '--base', 'b'], { '--base': 'value' }));
});
test('headers ignore fenced examples and support CRLF', () => {
  const h = header('# X\r\n\r\nDoc-ID: FEAT-X\r\nStatus: observed\r\n## Next\r\nStatus: accepted');
  assert.equal(h.fields.Status, 'observed');
  assert.equal(stripFences('~~~js\nStatus: accepted\n~~~\nreal').trim(), 'real');
});
test('observed documents pass without inventing approval', t => { const f = fixture(t); ok(f.check()); });
test('initialization adds only configuration/index and preserves existing prose and code', t => {
  const f = fixture(t, { doc: false });
  fs.unlinkSync(path.join(f.root, '.doc-driven.json'));
  f.put('docs/README.md', '# Existing handbook\n\nDo not overwrite this.\n');
  const original = fs.readFileSync(path.join(f.root, 'src/main.mjs'), 'utf8');
  const r = cli('init', [f.root, '--mode', 'full'], f.root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadConfig(f.root).adoption, 'full');
  assert.ok(fs.readFileSync(path.join(f.root, 'docs/README.md'), 'utf8').includes('Do not overwrite this.'));
  assert.equal(fs.readFileSync(path.join(f.root, 'src/main.mjs'), 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(f.root, 'AGENTS.md')));
});
test('init is idempotent and does not override existing configuration', t => {
  const f = fixture(t); const config = fs.readFileSync(path.join(f.root, '.doc-driven.json'), 'utf8');
  const before = fs.readFileSync(path.join(f.root, f.config.index), 'utf8');
  assert.equal(cli('init', [f.root, '--mode', 'full'], f.root).status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, '.doc-driven.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(f.root, f.config.index), 'utf8'), before);
});
test('index regeneration preserves both sides and stays deterministic', t => {
  const f = fixture(t), p = path.join(f.root, f.config.index);
  f.put(f.config.index, `TOP\n${START}\nold\n${END}\nBOTTOM\n`);
  f.index(); const one = fs.readFileSync(p, 'utf8');
  assert.ok(one.startsWith('TOP\n')); assert.ok(one.endsWith('\nBOTTOM\n'));
  assert.equal(f.index().changed, false); assert.equal(fs.readFileSync(p, 'utf8'), one); ok(f.check());
});
test('malformed index refuses destructive regeneration', t => {
  const f = fixture(t); f.put(f.config.index, `retain me\n${START}\nno end`);
  assert.throws(() => f.index(), /malformed/);
  assert.ok(fs.readFileSync(path.join(f.root, f.config.index), 'utf8').startsWith('retain me'));
});
test('unrelated Markdown is not forced into the contract lifecycle', t => {
  const f = fixture(t); f.put('docs/guide.md', '# Existing user guide\nNo skill metadata required.');
  f.index(); assert.equal(documents(f.root, f.config).docs.length, 1); ok(f.check());
});
test('legacy headers are reported but not falsely upgraded', t => {
  const f = fixture(t); f.put('docs/old.md', '# Legacy\n\nStatus: implemented\nVersion: v1\nOwns: src/**\n');
  f.index(); const r = f.check(); ok(r); assert.ok(r.warnings.some(x => x.includes('legacy header')));
});
test('custom document roots and index work without moving old docs', t => {
  const f = fixture(t, { doc: false, config: { docsRoots: ['handbook', 'spec'], index: 'handbook/index.md' } });
  f.put('spec/main.md', textDoc()); f.index(); ok(f.check());
});
test('duplicate document identity is rejected', t => {
  const f = fixture(t); f.put('docs/other.md', textDoc({ Owns: '—' }, '## Other\n')); f.index(); fails(f.check(), 'duplicate Doc-ID');
});
test('overlapping primary path ownership is rejected', t => {
  const f = fixture(t); f.put('docs/shared.md', textDoc({ 'Doc-ID': 'MOD-SHARED', Type: 'module', Owns: 'src/main.mjs' }, '## Shared\n'));
  f.index(); fails(f.check(), 'multiple primary owners');
});
test('non-path interface identity has only one primary owner', t => {
  const f = fixture(t); f.doc({ 'Owns names': 'event:main.done' });
  f.put('docs/other.md', textDoc({ 'Doc-ID': 'MOD-OTHER', Owns: '—', 'Owns names': 'event:main.done' }, '## Other\n'));
  f.index(); fails(f.check(), 'Owns names duplicates');
});
test('JSON files do not require a source comment', t => {
  const f = fixture(t); f.put('src/settings.json', '{"enabled":true}'); f.index(); ok(f.check());
});
test('optional valid source pointer is checked without requiring one everywhere', t => {
  const f = fixture(t); f.put('src/main.mjs', '// doc: docs/features/main.md\nexport const add = (a,b) => a+b;'); ok(f.check());
});
test('HTML comment source pointer syntax is supported', t => {
  const f = fixture(t); f.put('src/page.html', '<!-- doc: docs/features/main.md -->\n<html></html>'); ok(f.check());
});
test('a missing source pointer target is rejected', t => {
  const f = fixture(t); f.put('src/main.mjs', '// doc: docs/missing.md\n'); fails(f.check(), 'doc pointer missing');
});
test('a pointer to a nonowner is rejected', t => {
  const f = fixture(t); f.put('docs/other.md', textDoc({ 'Doc-ID': 'ARCH-OTHER', Type: 'architecture', Owns: '—' }, '## Other\n'));
  f.put('src/main.mjs', '// doc: docs/other.md\n'); f.index(); fails(f.check(), 'does not match a current primary owner');
});
test('pointer checking can be disabled explicitly', t => {
  const f = fixture(t, { config: { sourcePointers: 'off' } }); f.put('src/main.mjs', '// doc: missing.md\n'); ok(f.check());
});
test('unknown lifecycle status is rejected', t => { const f = fixture(t); f.doc({ Status: 'implemented' }); f.index(); fails(f.check(), 'invalid Status'); });
test('superseded documents no longer own code or duplicate current requirement IDs', t => {
  const f = fixture(t); f.put('docs/old.md', textDoc({ 'Doc-ID': 'FEAT-OLD', Status: 'superseded', 'Superseded by': DOC }));
  f.index(); ok(f.check());
});
test('supersession cycles are rejected', t => {
  const f = fixture(t); f.doc({ Status: 'superseded', 'Superseded by': 'docs/old.md' });
  f.put('docs/old.md', textDoc({ 'Doc-ID': 'FEAT-OLD', Status: 'superseded', 'Superseded by': DOC })); f.index(); fails(f.check(), 'cyclic supersession');
});
test('accepted needs an actual approval field and revision binding', t => {
  const f = fixture(t); f.doc({ Status: 'accepted' }); f.index(); const r = f.check(); fails(r, 'actual Approval'); fails(r, 'Approved revision');
});
test('approval of an old revision does not authorize a new one', t => {
  const f = fixture(t); f.doc({ Status: 'accepted', Approval: 'Explicit fixture approval of revision 1', Revision: '2', 'Approved revision': '1' }); f.index(); fails(f.check(), 'Approved revision');
});
test('verification passed cannot be declared without evidence', t => {
  const f = fixture(t); f.doc({ Verification: 'passed' }); f.index(); const r = f.check(); fails(r, 'known Baseline'); fails(r, 'matching-baseline passed evidence');
});
test('matching requirement/evidence and snapshot pass structural verification', t => {
  const f = fixture(t); approve(f, `snapshot:${f.inv().snapshot}`); ok(f.check());
});
test('unknown evidence references are rejected', t => {
  const f = fixture(t); f.doc({}, `${baseBody}\nUse E-MISSING-001.\n`); f.index(); fails(f.check(), 'undefined requirement/constraint/evidence');
});
test('duplicate requirement definitions are rejected', t => {
  const f = fixture(t); f.doc({}, `${baseBody}\n### R-MAIN-001 Duplicate\nNo.\n`); f.index(); fails(f.check(), 'duplicate item ID');
});
test('evidence from a different baseline cannot make a document passed', t => {
  const f = fixture(t), base = `snapshot:${f.inv().snapshot}`;
  f.doc({ Baseline: base, Verification: 'passed' }, evidence(`snapshot:${'0'.repeat(64)}`)); f.index(); fails(f.check(), 'matching-baseline passed evidence');
});
test('a failing current evidence record blocks Verification passed', t => {
  const f = fixture(t), base = `snapshot:${f.inv().snapshot}`;
  f.doc({ Baseline: base, Verification: 'passed' }, evidence(base, 'failed')); f.index(); fails(f.check(), 'current evidence fails');
});
test('stale generated index is caught', t => { const f = fixture(t); f.doc({ Implementation: 'partial' }); fails(f.check(), 'index missing, malformed, or stale'); });
test('local inline and reference-style links are checked', t => {
  const f = fixture(t); f.doc({}, `${baseBody}\n[missing](missing.md)\n[x]: absent.md\n`); f.index(); const r = f.check(); fails(r, 'missing.md'); fails(r, 'absent.md');
});
test('relative parent links inside repository work and external links are not fetched', t => {
  const f = fixture(t); f.put('docs/guide.md', '# Guide');
  f.doc({}, `${baseBody}\n[Guide](../guide.md#heading) [Remote](https://example.invalid/no-network)\n`); f.index(); ok(f.check());
});
test('links may not traverse outside the repository', t => {
  const f = fixture(t); f.doc({}, `${baseBody}\n[bad](../../../../etc/passwd)\n`); f.index(); fails(f.check(), 'safe repository-relative path');
});
test('ownership path traversal is rejected', t => {
  const f = fixture(t); f.doc({ Owns: '../outside/**' }); f.index(); fails(f.check(), 'safe repository-relative path');
});
test('filesystem helpers reject symbolic-link escapes', t => {
  const f = fixture(t); fs.symlinkSync(os.tmpdir(), path.join(f.root, 'outside'), 'dir');
  assert.throws(() => safePath(f.root, 'outside/do-not-touch'), /Symbolic/);
  const inv = f.inv(); assert.ok(inv.skipped.some(e => e.path === 'outside' && e.reason.includes('symlink')));
});
test('configuration rejects symlink roots and unsafe/unknown keys', t => {
  const f = fixture(t); fs.symlinkSync(os.tmpdir(), path.join(f.root, 'outside'), 'dir');
  f.put('.doc-driven.json', JSON.stringify({ ...f.config, docsRoots: ['outside'] })); assert.throws(() => loadConfig(f.root), /Symbolic/);
  f.put('.doc-driven.json', JSON.stringify({ ...f.config, magic: true })); assert.throws(() => loadConfig(f.root), /Unknown configuration key/);
});
test('inventory excludes likely secrets, build output, and installed skills', t => {
  const f = fixture(t); f.put('.env.local', 'secret-token'); f.put('src/private.key', 'key');
  f.put('node_modules/demo.js', 'dependency'); f.put('.agents/skills/foreign/SKILL.md', 'foreign');
  const inv = f.inv(); assert.ok(!inv.files.some(f => /\.env|private.key|node_modules|\.agents/.test(f.path)));
  assert.ok(inv.skipped.some(s => s.reason.includes('secret')));
});
test('inventory emits hashes and no source contents or automatic reading claims', t => {
  const f = fixture(t); const r = cli('inventory', [f.root], f.root); assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout); assert.equal(data.files.find(f => f.path === 'src/main.mjs').sha256.length, 64);
  assert.ok(!r.stdout.includes('export const add')); assert.ok(!r.stdout.includes('"state": "reviewed"'));
});
test('large and binary candidates remain visible and are not text-reviewed', t => {
  const f = fixture(t); f.put('src/large.txt', 'x'.repeat(2 * 1024 * 1024 + 1)); f.put('src/binary.bin', Buffer.from([1, 0, 2]));
  const inv = f.inv(); assert.equal(inv.files.find(f => f.path === 'src/large.txt').reviewable, false);
  assert.equal(inv.files.find(f => f.path === 'src/binary.bin').reviewable, false);
});
test('code snapshot is stable across changes to generated docs/inventory', t => {
  const f = fixture(t), before = f.inv().snapshot;
  f.put('docs/notes.md', '# New human notes');
  assert.equal(cli('inventory', [f.root, '--out', 'docs/adoption/inventory.json'], f.root).status, 0);
  assert.equal(f.inv().snapshot, before);
  assert.equal(cli('inventory', [f.root, '--out', 'docs/adoption/inventory.json'], f.root).status, 0);
});
test('inventory output refuses to overwrite a human JSON document', t => {
  const f = fixture(t); f.put('docs/important.json', '{"human":"keep"}');
  const r = cli('inventory', [f.root, '--out', 'docs/important.json'], f.root);
  assert.equal(r.status, 2); assert.ok(r.stderr.includes('Refusing')); assert.equal(fs.readFileSync(path.join(f.root, 'docs/important.json'), 'utf8'), '{"human":"keep"}');
});
test('inventory output must live under configured docsRoots', t => {
  const f = fixture(t); assert.equal(cli('inventory', [f.root, '--out', 'inventory.json'], f.root).status, 2);
});
test('full progress validates current file hashes and document links', t => {
  const f = fixture(t); progress(f); ok(f.check({ progress: 'docs/adoption/progress.json', full: true }));
});
test('full progress rejects missing reading records', t => {
  const f = fixture(t); progress(f, { files: {} }); fails(f.check({ progress: 'docs/adoption/progress.json', full: true }), 'not fully reviewed');
});
test('changed code invalidates saved reading progress', t => {
  const f = fixture(t); progress(f); f.put('src/main.mjs', 'export const changed = true;');
  const r = f.check({ progress: 'docs/adoption/progress.json', full: true }); fails(r, 'content hash is stale'); fails(r, 'inventorySnapshot is stale');
});
test('incremental progress reports gaps as warnings, not mandatory full takeover', t => {
  const f = fixture(t); progress(f, { files: {} }); const r = f.check({ progress: 'docs/adoption/progress.json' }); ok(r); assert.ok(r.warnings.some(w => w.includes('not fully reviewed')));
});
test('reviewed requires a current document, not an unlinked completion tick', t => {
  const f = fixture(t), p = progress(f); p.files['src/main.mjs'].docs = []; f.put('docs/adoption/progress.json', JSON.stringify(p));
  fails(f.check({ progress: 'docs/adoption/progress.json', full: true }), 'reviewed requires');
});
test('binary file cannot be marked reviewed by the text workflow', t => {
  const f = fixture(t); f.put('src/picture.bin', Buffer.from([0, 1])); progress(f);
  fails(f.check({ progress: 'docs/adoption/progress.json', full: true }), 'cannot be marked text-reviewed');
});
test('explicit exclusions require a reason', t => {
  const f = fixture(t), p = progress(f); p.files['src/main.mjs'] = { ...p.files['src/main.mjs'], state: 'excluded', docs: [], note: '' };
  f.put('docs/adoption/progress.json', JSON.stringify(p)); fails(f.check({ progress: 'docs/adoption/progress.json', full: true }), 'nonempty note/reason');
});
test('explicit documented exclusions can close the agreed scope without claiming reading', t => {
  const f = fixture(t), p = progress(f); p.files['src/main.mjs'] = { ...p.files['src/main.mjs'], state: 'excluded', docs: [], note: 'Explicitly outside this synthetic scope.' };
  f.put('docs/adoption/progress.json', JSON.stringify(p)); const r = f.check({ progress: 'docs/adoption/progress.json', full: true }); ok(r); assert.equal(r.stats.progress.excluded, 1);
});
test('deleted paths cannot silently remain reviewed in a full manifest', t => {
  const f = fixture(t); progress(f); fs.unlinkSync(path.join(f.root, 'src/main.mjs'));
  fails(f.check({ progress: 'docs/adoption/progress.json', full: true }), 'not a current candidate');
});
test('Git inventory includes tracked/added files, excludes ignored content and identifies worktree changes', t => {
  const f = fixture(t); f.put('.gitignore', '*.ignored\n'); startGit(f); f.put('src/new.mjs', 'new'); f.put('secret.ignored', 'do not inspect');
  const inv = f.inv(); assert.equal(inv.git.enumeration, 'git'); assert.equal(inv.git.dirty, true);
  assert.ok(inv.files.some(f => f.path === 'src/new.mjs')); assert.ok(!inv.files.some(f => f.path === 'secret.ignored'));
  assert.ok(inv.skipped.some(f => f.reason.includes('gitignored')));
});
test('changed-path gate sees staged, unstaged and untracked source', t => {
  const f = fixture(t), base = startGit(f); f.put('src/staged.mjs', 'stage'); git(f.root, ['add', 'src/staged.mjs']);
  f.put('src/main.mjs', 'unstaged'); f.put('src/new.mjs', 'untracked');
  const changed = changedPaths(f.root, resolveBase(f.root, base));
  for (const p of ['src/main.mjs', 'src/staged.mjs', 'src/new.mjs']) assert.ok(changed.includes(p)); ok(f.check({ base }));
});
test('changed code without a governing document fails the optional path gate', t => {
  const f = fixture(t), base = startGit(f); f.put('unmapped/new.mjs', 'new'); fails(f.check({ base }), 'no current governing document');
});
test('unrelated legacy/unmapped areas do not block a documented local change', t => {
  const f = fixture(t); f.put('legacy/old.mjs', 'old'); const base = startGit(f); f.put('src/main.mjs', 'changed'); ok(f.check({ base }));
});
test('deletion is traced through the previous owner even after its Owns changes', t => {
  const f = fixture(t), base = startGit(f); fs.unlinkSync(path.join(f.root, 'src/main.mjs')); f.doc({ Owns: '—' }); f.index(); ok(f.check({ base }));
});
test('release gate rejects observed docs without blocking a docs-only baseline check', t => {
  const f = fixture(t), base = startGit(f); f.put('src/main.mjs', 'changed'); ok(f.check({ base })); fails(f.check({ base, release: true }), 'release requires accepted');
});
test('release gate passes current accepted, implemented, evidenced fixture', t => {
  const f = fixture(t), base = startGit(f); f.put('src/main.mjs', 'export const add = (a, b) => Number(a) + Number(b);');
  approve(f, `snapshot:${f.inv().snapshot}`); ok(f.check({ base, release: true }));
});
test('release gate detects a changed source snapshot after evidence was recorded', t => {
  const f = fixture(t), base = startGit(f); approve(f, `snapshot:${f.inv().snapshot}`); f.put('src/main.mjs', 'export const add = () => 0;');
  fails(f.check({ base, release: true }), 'does not match the current code snapshot');
});
test('change proposal locks the target revision without duplicating ownership', t => {
  const f = fixture(t); f.put('docs/changes/change.md', textDoc({ 'Doc-ID': 'CHANGE-MAIN-001', Type: 'change', Status: 'proposed', Owns: '—', Targets: `${DOC}@1`, Affects: 'src/**' }, '## Delta\nChange R-MAIN-001.\n'));
  f.index(); ok(f.check()); f.doc({ Revision: '2' }); f.index(); fails(f.check(), 'stale Targets revision');
});
test('superseded proposals retain historical target revisions without blocking later work', t => {
  const f = fixture(t); f.doc({ Revision: '2' });
  f.put('docs/changes/change.md', textDoc({ 'Doc-ID': 'CHANGE-MAIN-001', Type: 'change', Status: 'superseded', Owns: '—', Targets: `${DOC}@1`, 'Superseded by': DOC }, '## Historical delta\n'));
  f.index(); ok(f.check());
});
test('invalid base fails loudly instead of silently skipping checks', t => {
  const f = fixture(t); startGit(f); const r = cli('check-doc-set', [f.root, '--base', 'not-a-real-ref'], f.root); assert.equal(r.status, 2); assert.ok(r.stderr.includes('Git command failed'));
});
test('release requires a scoped base and full requires an explicit progress file', t => {
  const f = fixture(t); assert.throws(() => f.check({ release: true }), /requires --base/); assert.throws(() => f.check({ full: true }), /requires --progress/);
});
test('explicitly disabled repositories are not implicitly adopted', t => {
  const f = fixture(t, { config: { enabled: false } }); const r = f.check(); ok(r); assert.equal(r.stats.disabled, true);
});
test('JSON checker output is parseable and reflects failures', t => {
  const f = fixture(t); f.doc({ Status: 'made-up' }); f.index(); const r = cli('check-doc-set', [f.root, '--json'], f.root);
  assert.equal(r.status, 1); assert.ok(JSON.parse(r.stdout).errors.length > 0);
});
test('end-to-end helpers and a real isolated program test can run without installing packages', t => {
  const f = fixture(t); f.put('test/main.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/main.mjs';\ntest('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 2), 0); });\n");
  f.doc({ Owns: 'src/**, test/**' }); f.index();
  const app = spawnSync(process.execPath, ['--test', 'test/main.test.mjs'], { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  assert.equal(app.status, 0, app.stderr);
  const inv = cli('inventory', [f.root, '--out', 'docs/adoption/inventory.json'], f.root); assert.equal(inv.status, 0, inv.stderr);
  const check = cli('check-doc-set', [f.root], f.root); assert.equal(check.status, 0, check.stderr);
});
test('configuration needs explicit schemaVersion and enabled, not an inferred opt-in', t => {
  const f = fixture(t); f.put('.doc-driven.json', '{}'); assert.throws(() => loadConfig(f.root), /schemaVersion/);
  f.put('.doc-driven.json', '{"schemaVersion":1}'); assert.throws(() => loadConfig(f.root), /boolean enabled/);
});
test('an empty Doc-ID is an invalid managed header, not silently ignored', t => {
  const f = fixture(t); f.doc({ 'Doc-ID': '' }); f.index(); fails(f.check(), 'missing header Doc-ID');
});
test('a Markdown link to the repository root is valid', t => {
  const f = fixture(t); f.doc({}, `${baseBody}\n[Repository](../../)\n`); f.index(); ok(f.check());
});
test('invalid non-string progress notes produce a validation result instead of crashing', t => {
  const f = fixture(t), p = progress(f); p.files['src/main.mjs'].note = 123;
  f.put('docs/adoption/progress.json', JSON.stringify(p)); fails(f.check({ progress: 'docs/adoption/progress.json', full: true }), 'nonempty note/reason');
});
test('new-document proposals can reference an explicitly future target', t => {
  const f = fixture(t); f.put('docs/changes/new.md', textDoc({ 'Doc-ID': 'CHANGE-NEW-001', Type: 'change', Status: 'proposed', Owns: '—', Targets: 'docs/features/future.md@new', Affects: 'src/future/**' }, '## Delta\nFuture scope, not implemented.\n'));
  f.index(); ok(f.check());
});
test('configured include and exclude policies are reflected in inventory', t => {
  const f = fixture(t, { config: { include: ['src/**'], exclude: ['src/internal/**'] } });
  f.put('src/internal/debug.mjs', 'debug'); f.put('other/file.mjs', 'other');
  const inv = f.inv(); assert.equal(inv.summary.candidates, 1);
  assert.ok(inv.skipped.some(x => x.path === 'src/internal/debug.mjs' && x.reason === 'configured exclude'));
  assert.ok(inv.skipped.some(x => x.path === 'other/file.mjs' && x.reason.includes('outside')));
});
test('all helper help commands work without modifying project files', t => {
  const f = fixture(t); const before = f.inv().snapshot;
  for (const name of ['init', 'inventory', 'index', 'check-doc-set', 'check']) {
    const r = cli(name, ['--help'], f.root); assert.equal(r.status, 0, `${name}: ${r.stderr}`); assert.ok(r.stdout.includes('Usage:'));
  }
  assert.equal(f.inv().snapshot, before);
});
test('deletion follows a superseded prior owner to its current replacement', t => {
  const f = fixture(t), base = startGit(f); fs.unlinkSync(path.join(f.root, 'src/main.mjs'));
  f.doc({ Status: 'superseded', 'Superseded by': 'docs/features/replacement.md' });
  f.put('docs/features/replacement.md', textDoc({ 'Doc-ID': 'FEAT-REPLACEMENT', Owns: '—' })); f.index();
  const r = f.check({ base }); ok(r); assert.ok(r.stats.affectedDocuments.includes('docs/features/replacement.md'));
});
