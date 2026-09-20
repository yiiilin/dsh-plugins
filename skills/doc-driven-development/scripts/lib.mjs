// Shared, dependency-free helpers. Never follow a repository symlink or run project code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decodeText, mergeBlock } from './managed-text.mjs';

export const VERSION = '0.2.3';
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const DEFAULTS = {
  schemaVersion: 1, enabled: true, docsRoots: ['docs'], index: 'docs/README.md',
  adoption: 'incremental', language: 'zh-CN', include: ['**'], exclude: [], sourcePointers: 'optional', layout: 'domain',
};
export const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor',
  '.doc-driven', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.agents', '.claude', '.dsh', '.codex',
]);
const SECRET = /(^|\/)(?:\.env[^/]*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx))$/i;
export const START = '<!-- doc-driven:index:start -->';
export const END = '<!-- doc-driven:index:end -->';
export const slash = p => p.split(path.sep).join('/');
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const list = value => !value || ['—', '-', 'none'].includes(value.trim()) ? []
  : value.split(',').map(s => s.trim().replace(/^`|`$/g, '')).filter(Boolean);

export function assertNode() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required for the optional helpers. The Markdown workflow can be used without Node.js.');
}
export function parseCLI(argv, definitions = {}) {
  const flags = {}, positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (arg.startsWith('--')) {
      if (!Object.hasOwn(definitions, arg)) throw new Error(`Unknown option: ${arg}`);
      if (Object.hasOwn(flags, arg.slice(2))) throw new Error(`Duplicate option: ${arg}`);
      if (definitions[arg] === 'value') {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        flags[arg.slice(2)] = value;
      } else flags[arg.slice(2)] = true;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length > 1) throw new Error('Expected at most one repository directory.');
  return { root: path.resolve(positionals[0] ?? '.'), flags };
}
export function runCLI(main) {
  try { assertNode(); main(); } catch (error) { console.error(`ERROR ${error.message}`); process.exitCode = 2; }
}
export function rootDir(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Repository directory does not exist: ${root}`);
  return fs.realpathSync(root);
}
export function validateRel(p, { glob = false } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\\') || /[\x00-\x1f]/.test(p)
    || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split('/').some(s => s === '..' || s === '.' || !s)) {
    throw new Error(`Expected a safe repository-relative path using '/': ${JSON.stringify(p)}`);
  }
  if (glob && /[\[\]{}!]/.test(p)) throw new Error(`Unsupported glob syntax: ${p}; use *, ?, or **.`);
  if (!glob && /[*?]/.test(p)) throw new Error(`Wildcards are not allowed here: ${p}`);
  return p;
}
export function safePath(root, rel) {
  validateRel(rel);
  let current = root;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not followed: ${rel}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
export function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON ${file}: ${error.message}`); }
}
export function writeAtomic(root, rel, contents, { exclusive = false } = {}) {
  const target = safePath(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  safePath(root, rel); // Recheck created components before writing.
  if (exclusive) { fs.writeFileSync(target, contents, { flag: 'wx' }); return; }
  const previous = fs.existsSync(target) ? fs.lstatSync(target) : null;
  if (previous && (!previous.isFile() || previous.nlink > 1)) throw new Error(`Refusing non-regular/hard-linked target: ${rel}`);
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(temp, contents, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o644 }); fs.renameSync(temp, target); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function loadConfig(root, required = true) {
  const file = safePath(root, '.doc-driven.json');
  if (!fs.existsSync(file)) {
    if (required) throw new Error('No .doc-driven.json. Use install.mjs to preview project setup, then install.mjs --apply to install the skill, project rules and configuration together. Do not create enabled: true as a substitute for installation.');
    return structuredClone(DEFAULTS);
  }
  const data = readJSON(file);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('.doc-driven.json must be an object.');
  for (const k of Object.keys(data)) if (!Object.hasOwn(DEFAULTS, k)) throw new Error(`Unknown configuration key: ${k}`);
  const c = { ...structuredClone(DEFAULTS), ...data, layout: data.layout ?? 'preserve' };
  if (Object.hasOwn(data, 'layout') && !['domain', 'preserve'].includes(data.layout))
    throw new Error('layout must be domain or preserve; an absent legacy key preserves existing paths.');
  if (data.schemaVersion !== 1 || typeof data.enabled !== 'boolean') throw new Error('Expected schemaVersion: 1 and a boolean enabled.');
  for (const key of ['docsRoots', 'include', 'exclude']) {
    if (!Array.isArray(c[key]) || c[key].some(x => typeof x !== 'string')) throw new Error(`${key} must be a string array.`);
    for (const p of c[key]) { validateRel(p, { glob: key !== 'docsRoots' }); if (key === 'docsRoots') safePath(root, p); }
  }
  if (!c.docsRoots.length || !c.include.length) throw new Error('docsRoots and include must not be empty.');
  for (let i = 0; i < c.docsRoots.length; i++) for (let j = i + 1; j < c.docsRoots.length; j++) {
    if (c.docsRoots[i] === c.docsRoots[j] || c.docsRoots[i].startsWith(`${c.docsRoots[j]}/`) || c.docsRoots[j].startsWith(`${c.docsRoots[i]}/`))
      throw new Error('docsRoots must be distinct, non-overlapping directories.');
  }
  safePath(root, c.index);
  if (!c.index.endsWith('.md')) throw new Error('index must be a Markdown file.');
  if (!['incremental', 'full'].includes(c.adoption)) throw new Error('adoption must be incremental or full.');
  if (!['optional', 'off'].includes(c.sourcePointers)) throw new Error('sourcePointers must be optional or off.');
  if (typeof c.language !== 'string' || !c.language.trim() || /[\r\n]/.test(c.language)) throw new Error('language must be a nonempty, single-line string.');
  return c;
}
export function globRE(pattern) {
  validateRel(pattern, { glob: true });
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
      else out += '.*';
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
export const matches = (p, patterns) => patterns.some(pattern => globRE(pattern).test(p));
export function git(root, args, { optional = false } = {}) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error(`Git command failed: git ${args[0]}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  return result.stdout;
}
function policyReason(p, config) {
  if (p.split('/').some(s => SKIP_DIRS.has(s))) return 'dependency/build/tool/VCS directory';
  if (SECRET.test(p)) return 'potential secret/key file';
  if (!matches(p, config.include)) return 'outside configured include';
  if (matches(p, config.exclude)) return 'configured exclude';
  return null;
}
function enumerate(root, config) {
  const skipped = [], paths = [], warnings = [];
  const top = git(root, ['rev-parse', '--show-toplevel'], { optional: true });
  const usingGit = top && path.resolve(top.trim()) === root;
  if (usingGit) {
    const names = new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
    for (const p of [...names].sort()) {
      const reason = policyReason(p, config);
      if (reason) skipped.push({ path: p, reason });
      else paths.push(p);
    }
    const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    for (const p of ignored.split('\0').filter(Boolean)) skipped.push({ path: p, reason: 'gitignored (not read)' });
  } else {
    warnings.push('Not at a Git worktree root, or Git unavailable: filesystem walk used; .gitignore was not interpreted.');
    const visit = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, e.name), rel = slash(path.relative(root, file));
        if (e.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink (not followed)' }); continue; }
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) { skipped.push({ path: `${rel}/`, reason: 'dependency/build/tool/VCS directory' }); continue; }
          visit(file);
        } else if (e.isFile()) {
          const reason = policyReason(rel, config);
          if (reason) skipped.push({ path: rel, reason }); else paths.push(rel);
        } else skipped.push({ path: rel, reason: 'non-regular file' });
      }
    };
    visit(root);
  }
  return {
    paths, skipped, warnings,
    git: usingGit ? { head: git(root, ['rev-parse', '--verify', 'HEAD'], { optional: true })?.trim() ?? null,
      dirty: Boolean(git(root, ['status', '--porcelain=v1', '-z']).length), enumeration: 'git' }
      : { head: null, dirty: null, enumeration: 'filesystem' },
  };
}
function classify(p, config) {
  if (p === '.doc-driven.json' || p === config.index || config.docsRoots.some(d => p.startsWith(`${d}/`)) || /\.(?:md|mdx|rst|adoc)$/i.test(p)) return 'documentation';
  if (/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/.test(p)) return 'lockfile';
  if (/(^|\/)(?:tests?|__tests__|spec)(\/|\.)|\.(?:test|spec)\./i.test(p)) return 'test';
  if (/\.(?:json|ya?ml|toml|ini|cfg|conf|xml|properties|sql|proto|graphql|gql)$/i.test(p) || /(^|\/)(?:Dockerfile|Makefile|\.gitignore|\.npmrc)(?:\.|$)/.test(p)) return 'configuration';
  if (/\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|c|h|cpp|hpp|cs|swift|m|mm|rb|php|sh|bash|zsh|ps1|vue|svelte|css|scss|html|ex|exs|erl|hs|lua|dart)$/i.test(p)) return 'source';
  return 'other';
}
export function inventory(root, config) {
  const enumeration = enumerate(root, config), files = [];
  for (const rel of enumeration.paths) {
    let full, stat;
    try { full = safePath(root, rel); stat = fs.lstatSync(full); }
    catch (error) { enumeration.skipped.push({ path: rel, reason: error.message, blocked: error.code !== 'ENOENT' && !error.message.startsWith('Symbolic links') }); continue; }
    if (!stat.isFile()) { enumeration.skipped.push({ path: rel, reason: 'not a regular file (submodule or special file)' }); continue; }
    const kind = classify(rel, config), item = {
      path: rel, kind, bytes: stat.size, sha256: null, reviewable: false, candidate: kind !== 'documentation',
    };
    if (stat.size > MAX_TEXT_BYTES) { item.reason = 'larger than 2 MiB; not read'; item.modified = stat.mtimeMs; }
    else {
      try {
        const buf = fs.readFileSync(full);
        item.sha256 = sha(buf);
        item.reviewable = !buf.subarray(0, 8192).includes(0);
        if (!item.reviewable) item.reason = 'binary content; not text-reviewed';
      } catch (error) { item.reason = `read failed: ${error.code ?? error.message}`; item.modified = stat.mtimeMs; }
    }
    files.push(item);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const candidates = files.filter(f => f.candidate);
  const snapshot = sha(JSON.stringify({
    include: config.include, exclude: config.exclude, docsRoots: config.docsRoots,
    files: candidates.map(f => [f.path, f.sha256 ?? [f.bytes, f.modified ?? null, f.reason]]),
  }));
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), snapshot, git: enumeration.git,
    policy: { includes: config.include, excludes: config.exclude, skippedDirectories: [...SKIP_DIRS],
      potentialSecretsExcluded: true, maxTextBytes: MAX_TEXT_BYTES, documentationExcludedFromCodeSnapshot: true },
    summary: { files: files.length, candidates: candidates.length, reviewableCandidates: candidates.filter(f => f.reviewable).length },
    files, skipped: enumeration.skipped, warnings: enumeration.warnings,
  };
}
export function stripFences(text) {
  let fence = null;
  return text.split(/\r?\n/).map(line => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = { ch: m[1][0], n: m[1].length };
      else if (m[1][0] === fence.ch && m[1].length >= fence.n) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}
export function header(text) {
  const fields = {}, duplicates = [];
  for (const line of stripFences(text).split(/\r?\n/).slice(0, 80)) {
    if (/^##\s/.test(line)) break;
    const m = line.match(/^([A-Za-z][A-Za-z -]*):\s*(.*?)\s*$/);
    if (m) { if (Object.hasOwn(fields, m[1])) duplicates.push(m[1]); fields[m[1]] = m[2]; }
  }
  return { fields, duplicates };
}
export function documents(root, config) {
  const docs = [], legacy = [];
  const visit = dir => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) visit(file);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = slash(path.relative(root, file));
        if (rel === config.index) continue;
        if (fs.statSync(file).size > MAX_TEXT_BYTES) throw new Error(`Managed-doc candidate too large: ${rel}; split or place it outside docsRoots.`);
        const text = fs.readFileSync(file, 'utf8'), parsed = header(text);
        if (Object.hasOwn(parsed.fields, 'Doc-ID')) docs.push({ path: rel, text, ...parsed });
        else if (parsed.fields.Status && (parsed.fields.Version || parsed.fields.Owns)) legacy.push(rel);
      }
    }
  };
  for (const d of config.docsRoots) visit(safePath(root, d));
  return { docs, legacy };
}
export function localLinks(text) {
  const clean = stripFences(text).replace(/<!--[\s\S]*?-->/g, '');
  const links = [];
  for (const m of clean.matchAll(/\]\((?:<([^>\n]+)>|([^\s()]+))(?:\s+["'][^\n]*?["'])?\)/g)) links.push(m[1] ?? m[2]);
  for (const m of clean.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) links.push(m[1] ?? m[2]);
  return links.filter(l => !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(l));
}
export function resolveLink(root, from, link) {
  let decoded;
  try { decoded = decodeURIComponent(link.split('#')[0].split('?')[0]); }
  catch { throw new Error(`Invalid percent encoding in link: ${link}`); }
  if (path.isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded) || decoded.includes('\\')) throw new Error(`Unsafe local link: ${link}`);
  const rel = slash(path.relative(root, path.resolve(root, path.dirname(from), decoded)));
  return rel === '' ? root : safePath(root, rel);
}
const cell = s => String(s ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
export function indexBlock(config, docs) {
  const lines = [START, '| 文档 | 类型 | 状态 | 实现 | 验证 |', '|---|---|---|---|---|'];
  for (const d of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = slash(path.relative(path.dirname(config.index), d.path));
    const h = d.fields;
    lines.push(`| [${cell(h['Doc-ID'])}](${encodeURI(rel).replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/\(/g, '%28').replace(/\)/g, '%29')}) | ${cell(h.Type)} | ${cell(h.Status)} | ${cell(h.Implementation)} | ${cell(h.Verification)} |`);
  }
  lines.push(END);
  return lines.join('\n');
}
export function replaceIndex(text, block) {
  try { return mergeBlock(text, block, START, END).text; }
  catch (error) { throw new Error(`Index markers: ${error.message}`); }
}
export function updateIndex(root, config) {
  const file = safePath(root, config.index);
  const old = fs.existsSync(file) ? decodeText(fs.readFileSync(file), config.index) : '# 项目设计文档\n\n先读系统概要，再读本次涉及的功能与共享模块。\n';
  const { docs } = documents(root, config), next = replaceIndex(old, indexBlock(config, docs));
  if (next !== old) writeAtomic(root, config.index, next);
  return { count: docs.length, changed: next !== old };
}

export function candidatePath(rel, config) {
  validateRel(rel);
  return !policyReason(rel, config) && classify(rel, config) !== 'documentation';
}
export function resolveBase(root, ref) {
  if (!ref || ref.startsWith('-') || /[\r\n\0]/.test(ref)) throw new Error('Invalid --base reference.');
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}
export function changedPaths(root, ref) {
  const tracked = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', ref, '--']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set((tracked + untracked).split('\0').filter(Boolean))].sort();
}
export function docsAtBase(root, config, ref) {
  const names = git(root, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean);
  const docs = [];
  for (const p of names.filter(p => p.endsWith('.md') && config.docsRoots.some(d => p.startsWith(`${d}/`)))) {
    if (p === config.index) continue;
    const text = git(root, ['show', `${ref}:${p}`]), parsed = header(text);
    if (parsed.fields['Doc-ID']) docs.push({ path: p, text, ...parsed });
  }
  return docs;
}
