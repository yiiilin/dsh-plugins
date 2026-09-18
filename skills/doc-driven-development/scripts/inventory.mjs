#!/usr/bin/env node
import fs from 'node:fs';
import { parseCLI, runCLI, rootDir, loadConfig, inventory, documents, list, matches, safePath, readJSON, writeAtomic } from './lib.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), { '--out': 'value' });
  if (args.flags.help) {
    console.log('Usage: node inventory.mjs [repo] [--out docs/adoption/inventory.json]\nWithout --out, emits JSON to stdout. Inventories files; does not infer design or mark anything reviewed.');
    return;
  }
  const root = rootDir(args.root), config = loadConfig(root, false);
  let output;
  if (args.flags.out) {
    output = args.flags.out;
    if (!output.endsWith('.json') || !config.docsRoots.some(d => output.startsWith(`${d}/`)))
      throw new Error('--out must be a .json file inside a configured docsRoot, so generated output cannot contaminate the code snapshot.');
    const target = safePath(root, output);
    if (fs.existsSync(target) && readJSON(target).kind !== 'doc-driven-inventory')
      throw new Error(`Refusing to overwrite a non-inventory file: ${output}`);
  }
  const result = inventory(root, config), { docs } = documents(root, config);
  const owners = docs.filter(d => d.fields.Status !== 'superseded' && d.fields.Type !== 'change');
  result.kind = 'doc-driven-inventory';
  for (const file of result.files) file.documentIds = owners.filter(d => matches(file.path, list(d.fields.Owns))).map(d => d.fields['Doc-ID']);
  result.summary.mappedCandidates = result.files.filter(f => f.candidate && f.documentIds.length).length;
  result.summary.unmappedCandidates = result.summary.candidates - result.summary.mappedCandidates;
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    writeAtomic(root, output, json);
    console.log(`WROTE ${output}: ${result.summary.candidates} candidate(s); snapshot:${result.snapshot}`);
    console.log('Mapping is structural only. No file has been marked reviewed. Inspect skipped items and warnings.');
  } else process.stdout.write(json);
});
