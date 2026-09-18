#!/usr/bin/env node
// Check the skill package, not the user's repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPackage } from './project-install.mjs';
import { VERSION, parseCLI, runCLI, localLinks, resolveLink } from './lib.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), { '--no-tests': 'flag' });
  if (args.flags.help) { console.log('Usage: node scripts/check.mjs [--no-tests]\nChecks package metadata, local links and JS syntax; runs isolated regression tests by default.'); return; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error(`Unexpected symlink in skill package: ${p}`);
      if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p);
    }
  };
  walk(root);
  const errors = [];
  try { readPackage(root); } catch (e) { errors.push(e.message); }
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const fm = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) errors.push('SKILL.md lacks a frontmatter block.');
  else {
    const field = key => {
      const value = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1];
      if (!value) return '';
      if (value.startsWith('"')) { try { return JSON.parse(value); } catch { errors.push(`Invalid quoted scalar ${key}`); return ''; } }
      return value;
    };
    const name = field('name'), description = field('description'), compatibility = field('compatibility');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name !== path.basename(root)) errors.push('Invalid skill name or directory/name mismatch.');
    if (!description || description.length > 1024) errors.push('Description must contain 1–1024 characters.');
    if (compatibility.length > 500) errors.push('Compatibility field exceeds 500 characters.');
    if (!fm[1].includes(`  version: "${VERSION}"`)) errors.push('Metadata and script versions differ.');
    console.log(`Metadata: ${name} v${VERSION}; description ${description.length} characters.`);
  }
  if (skill.split('\n').length > 500) errors.push('SKILL.md exceeds the 500-line packaging guideline.');
  const required = ['README.md', 'REFERENCE.md', 'ADOPTION.md', 'CHANGELOG.md', 'TESTING.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md',
    'FORMATS/feature.md', 'FORMATS/architecture.md', 'FORMATS/module.md', 'FORMATS/change.md', 'FORMATS/adoption.md',
    'INSTALL.md', 'package-manifest.json', 'scripts/install.mjs', 'scripts/uninstall.mjs', 'scripts/doctor.mjs', 'scripts/project-install.mjs', 'scripts/managed-text.mjs', 'tests/install.mjs',
    'examples/scenarios.md', 'scripts/init.mjs', 'scripts/inventory.mjs', 'scripts/index.mjs', 'scripts/check-doc-set.mjs', 'tests/run.mjs'];
  for (const p of required) if (!fs.existsSync(path.join(root, p))) errors.push(`Missing required package file: ${p}`);
  let links = 0;
  for (const p of files.filter(p => p.endsWith('.md'))) {
    const rel = path.relative(root, p);
    for (const link of localLinks(fs.readFileSync(p, 'utf8'))) {
      links++;
      try { if (!fs.existsSync(resolveLink(root, rel, link))) errors.push(`${rel}: broken local link ${link}`); }
      catch (e) { errors.push(`${rel}: ${e.message}`); }
    }
  }
  for (const p of files.filter(p => p.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) errors.push(`${path.relative(root, p)}: ${result.stderr || result.error?.message || 'syntax check failed'}`);
  }
  if (errors.length) { for (const e of errors) console.error(`FAIL ${e}`); process.exitCode = 1; return; }
  console.log(`Package OK: ${files.length} files, ${links} local links, JavaScript syntax checked.`);
  if (!args.flags['no-tests']) {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(root, 'tests/run.mjs'), path.join(root, 'tests/install.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
      if (result.error) console.error(result.error.message);
      process.exitCode = 1; return;
    }
    const summary = result.stdout.split('\n').filter(l => /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(l));
    console.log(summary.join('\n'));
  }
});
