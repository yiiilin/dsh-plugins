#!/usr/bin/env node
// Deprecated filename kept for old agents. There is no independent init operation.
// Share the install CLI so flags, preview, preservation, receipt and doctor cannot diverge.
import { runCLI } from './lib.mjs';
import { runInstall } from './install.mjs';

runCLI(() => runInstall(process.argv.slice(2), { legacyInit: true }));
