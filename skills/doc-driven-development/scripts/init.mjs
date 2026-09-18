#!/usr/bin/env node
import { parseCLI, runCLI, rootDir } from './lib.mjs';
import { planInit, applyPlan } from './project-install.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), { '--mode': 'value', '--docs-dir': 'value', '--language': 'value' });
  if (args.flags.help) {
    console.log('Usage: node init.mjs [repo] [--mode incremental|full] [--docs-dir docs] [--language zh-CN]\n'
      + 'Creates only configuration/index plus a local safety backup journal. Never installs skill or changes project rules.\n'
      + 'For project installation use install.mjs. Existing prose and configuration are preserved.'); return;
  }
  const plan = planInit(rootDir(args.root), args.flags), result = applyPlan(plan);
  for (const w of plan.warnings) console.log(`WARN ${w}`);
  if (!plan.writes.some(w => w.path === '.doc-driven.json')) console.log('KEPT existing .doc-driven.json.');
  console.log(`Initialized: ${plan.details.config.index}; mode: ${plan.details.config.adoption}; enabled: ${plan.details.config.enabled}.`);
  console.log(`Changed: ${result.changed}; backup/journal: ${result.backup ?? 'none (no change)'}.`);
});
