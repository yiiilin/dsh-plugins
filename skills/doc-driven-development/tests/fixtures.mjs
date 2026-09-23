// Synthetic records for mechanical tests only; no real approval or agent behavior.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULTS, header, updateIndex, inventory, git } from '../scripts/lib.mjs';
import { specRef } from '../scripts/contract.mjs';
import { checkRepo } from '../scripts/check-doc-set.mjs';
export const FILE = 'docs/domains/calculation/features/main.md';
export const BODY = `## 摘要
Synthetic sum operation with a fixed acceptance scenario.

## 1. 需求说明
### R-MAIN-001 Addition
Return the sum of two finite numbers.
### 1.2 验收条件
For inputs 7 and 2 return 9; reject invalid numbers.

## 2. 概要设计
A validator calls a pure operation and returns the result.
<!-- ddd:diagram flow -->
\`\`\`text
[Input] --valid--> [Compute] --result--> [Output]
\`\`\`
<!-- ddd:diagram data -->
\`\`\`text
[Caller] --two numbers--> [Operation] --number--> [Caller]
\`\`\`

## 3. 详细设计
Reject non-finite input before computation; do not persist state.
<!-- ddd:diagram state not-applicable: The pure operation has no persistent or cross-call state. -->

## 4. 实现与验证
`;
export function makeDoc(fields = {}, body = BODY, file = FILE) {
  const h = { 'Doc-ID': 'FEAT-MAIN', Type: 'feature', Revision: '1', Status: 'proposed', Baseline: 'unknown', Owns: 'src/**',
    Implementation: 'missing', Verification: 'not-run', 'Design-Format': 'layered-v1', 'Evidence-Format': 'bound-v1', ...fields };
  const text = '# Fixture\n\n' + Object.entries(h).filter(([, v]) => v !== null).map(([k,v]) => `${k}: ${v}`).join('\n') + '\n\n' + body;
  return { path: file, fields: header(text).fields, text };
}
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-closure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = structuredClone(DEFAULTS);
  const put = (p, text) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const read = p => fs.readFileSync(path.join(root, p), 'utf8');
  put('.doc-driven.json', JSON.stringify(config)); put('src/main.mjs', 'export const add = (a, b) => a + b;\n');
  const save = d => { put(d.path, d.text); updateIndex(root, config); return d; };
  const baseline = () => `snapshot:${inventory(root, config).snapshot}`;
  const base = () => {
    git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']); return git(root, ['rev-parse', 'HEAD']).trim();
  };
  save(makeDoc());
  return { root, config, put, read, save, baseline, base, check: opts => checkRepo(root, config, opts) };
}
export const approved = { Status: 'accepted', Approval: 'Synthetic explicit approval fixture only', 'Approved revision': '1', Implementation: 'complete' };
export function record(d, baseline, overrides = {}) {
  const fields = { Kind: 'verification', Covers: 'R-MAIN-001', 'Spec-Refs': specRef(d), Environment: 'Synthetic isolated fixture; not real execution evidence',
    Method: 'Synthetic method record for validator tests', Result: 'passed', Baseline: baseline, Detail: 'Synthetic fixture, not an assertion a model or user approved/executed it', ...overrides };
  const id = fields.id ?? 'E-MAIN-001'; delete fields.id;
  return `\n### ${id} Mechanical record\n` + Object.entries(fields).filter(([, v]) => v !== null).map(([k,v]) => `${k}: ${v}`).join('\n') + '\n';
}
