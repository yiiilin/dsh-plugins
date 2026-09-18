#!/usr/bin/env node
import { parseCLI, runCLI, rootDir, loadConfig, updateIndex } from './lib.mjs';
runCLI(() => {
  const args = parseCLI(process.argv.slice(2));
  if (args.flags.help) { console.log('Usage: node index.mjs [repo]\nRegenerates only the marked index block, preserving all surrounding text.'); return; }
  const root = rootDir(args.root), config = loadConfig(root), result = updateIndex(root, config);
  console.log(`${result.changed ? 'UPDATED' : 'UNCHANGED'} ${config.index}: ${result.count} managed document(s).`);
});
