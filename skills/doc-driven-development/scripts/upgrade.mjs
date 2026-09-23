#!/usr/bin/env node
// Run this entry from the NEW, externally unpacked release. Reuses the safe installer.
// No downloads, destructive extraction, auto-migration, or separate upgrade state machine.
import { runCLI } from './lib.mjs';
import { runInstall } from './install.mjs';
runCLI(() => runInstall(process.argv.slice(2), { upgrade: true }));
