// Evaluator-owned actual behavior check; not visible as a requested implementation edit.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {run}=await import(pathToFileURL(path.join(process.argv[2],'src/entry.mjs')).href);
assert.equal(run(7,2),9);
assert.equal(run(-3,2),-1);
console.log('Actual entry returns the required results.');
