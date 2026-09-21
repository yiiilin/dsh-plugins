// Path-shape checks only. Never infer business boundaries from filenames or move documents.
// A missing policy is legacy preserve, not an implicit migration.
const plural = { feature: 'features', module: 'modules' };
const reserved = new Set(['features', 'modules', 'changes', 'adoption', 'verifications', 'adr']);

export function checkLayout(config, docs) {
  const policy = config.layout ?? 'preserve', errors = [], warnings = [];
  let domainDocuments = 0, nonconforming = 0;
  const issue = (doc, message) => {
    nonconforming++;
    (policy === 'domain' ? errors : warnings).push(`[layout:${policy}] ${doc.path}: ${message}${policy === 'preserve' ? ' Existing path is preserved; record the mapping and request approval before moving it.' : ''}`);
  };
  for (const d of docs) {
    if (d.fields.Status === 'superseded') continue; // Do not migrate historical records to satisfy layout checks.
    const root = config.docsRoots.find(r => d.path.startsWith(`${r}/`));
    if (!root) continue;
    const rel = d.path.slice(root.length + 1), type = d.fields.Type;
    if (Object.hasOwn(plural, type)) {
      const match = rel.match(/^domains\/([^/]+)\/(features|modules)\/(.+)\.md$/);
      if (!match || reserved.has(match[1]) || match[1].startsWith('.') || match[2] !== plural[type]) {
        issue(d, `Type ${type} belongs at ${root}/domains/<domain>/${plural[type]}/<name>.md; a flat domain summary or root-level ${plural[type]}/ is not the domain's feature/module container.`);
      } else domainDocuments++;
    } else if (/^domains\/[^/]+\.md$/.test(rel) && rel !== 'domains/README.md') {
      issue(d, `A domain overview belongs at ${root}/domains/<domain>/README.md (or architecture.md when independently useful), not a peer <domain>.md standing in for that domain's documents.`);
    }
  }
  return { policy, status: errors.length ? 'failed' : warnings.length ? 'needs-review' : 'passed', domainDocuments, nonconforming, errors, warnings,
    limitations: 'Managed current document path shapes only; not business-domain correctness, completeness, or an automatic migration. Unmanaged prose is not classified by this check.' };
}
