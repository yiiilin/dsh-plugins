#!/usr/bin/env node
import fs from 'node:fs';
import { DEFAULTS, parseCLI, runCLI, rootDir, safePath, loadConfig, updateIndex, writeAtomic, validateRel } from './lib.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), { '--mode': 'value', '--docs-dir': 'value', '--language': 'value' });
  if (args.flags.help) {
    console.log('Usage: node init.mjs [repo] [--mode incremental|full] [--docs-dir docs] [--language zh-CN]\nCreates only .doc-driven.json and an additive index. Never changes business code or existing project instruction files.');
    return;
  }
  const root = rootDir(args.root), file = safePath(root, '.doc-driven.json');
  const mode = args.flags.mode ?? 'incremental', dir = args.flags['docs-dir'] ?? 'docs';
  if (!['incremental', 'full'].includes(mode)) throw new Error('--mode must be incremental or full.');
  validateRel(dir);
  let config;
  if (fs.existsSync(file)) {
    config = loadConfig(root);
    console.log('KEPT existing .doc-driven.json; initialization flags do not override it.');
  } else {
    const language = args.flags.language ?? 'zh-CN';
    if (!language.trim() || /[\r\n]/.test(language)) throw new Error('--language must be a nonempty, single-line string.');
    config = { ...structuredClone(DEFAULTS), adoption: mode, docsRoots: [dir], index: `${dir}/README.md`, language };
    // Check all destinations before making any change.
    safePath(root, dir); safePath(root, config.index);
    writeAtomic(root, '.doc-driven.json', `${JSON.stringify(config, null, 2)}\n`, { exclusive: true });
    console.log('CREATED .doc-driven.json');
  }
  const result = updateIndex(root, config);
  console.log(`${result.changed ? 'UPDATED' : 'KEPT'} ${config.index}: ${result.count} managed document(s).`);
  console.log(`Mode: ${config.adoption}; enabled: ${config.enabled}. Read README.md for the explicit host instruction block.`);
});
