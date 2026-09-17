#!/usr/bin/env node
// Doc-set check for a repo that follows the doc-driven-development convention.
//
//   node check-doc-set.mjs [repo-root]      (default: the working directory)
//
// Five things the convention declares but nothing else enforces:
//   1. every doc carries a header whose Status is one of the five
//   2. every relative link in the doc set resolves
//   3. every doc appears in docs/README.md — a doc not in the index does not exist
//   4. each index row's status matches the doc's own header (the drift failure mode)
//   5. `Owns:` globs and `// doc:` headers agree, in both directions
//
// This checks a repo's doc set. `check.mjs` in this skill's own scripts/ checks
// the skill package itself; they are different jobs.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'

const ROOT = resolve(process.argv[2] ?? '.')
const DOCS = join(ROOT, 'docs')
const INDEX = join(DOCS, 'README.md')
const STATUSES = ['draft', 'awaiting confirmation', 'confirmed', 'implemented', 'superseded']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'docs'])
const fail = []

if (!existsSync(DOCS)) {
  console.error(`FAIL  no docs/ directory at ${ROOT} — nothing to check`)
  process.exit(1)
}

const walk = (dir, skip = SKIP_DIRS) =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p, skip) : [p]
  })

const rel = (p) => relative(ROOT, p).split(sep).join('/')
const strip = (t) => t.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '')

// the doc set: everything under docs/ except the index, plus adr/ which is
// indexed as a directory rather than per file
const allDocs = walk(DOCS, new Set())
const docs = allDocs.filter(
  (f) => f.endsWith('.md') && f !== INDEX && !rel(f).startsWith('docs/adr/'),
)

const header = (file) => {
  const lines = readFileSync(file, 'utf8').split('\n').slice(0, 20)
  const out = {}
  for (const line of lines) {
    if (/^#/.test(line) && Object.keys(out).length) break
    const m = line.match(/^([A-Z][A-Za-z ]*):\s*(.+?)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// 1 — a Status the convention knows. CONTEXT.md is a glossary, not a contract
// doc, so it carries no lifecycle and is not checked here.
for (const f of docs) {
  const h = header(f)
  if (!h.Status) fail.push(`${rel(f)}: no Status in the header`)
  else if (!STATUSES.includes(h.Status.replace(/`/g, '')))
    fail.push(`${rel(f)}: unknown status "${h.Status}" — expected one of ${STATUSES.join(' / ')}`)
}

// 2 — links resolve
let links = 0
for (const f of allDocs) {
  for (const [, link] of strip(readFileSync(f, 'utf8')).matchAll(/\]\(([^)#\s]+?)\)/g)) {
    if (/^(https?:|mailto:)/.test(link)) continue
    links += 1
    if (!existsSync(resolve(dirname(f), link))) fail.push(`${rel(f)}: link does not resolve -> ${link}`)
  }
}

// 3 + 4 — the index lists every doc, and its status column matches the header
const rows = new Map() // absolute path -> status cell
if (!existsSync(INDEX)) {
  fail.push('docs/README.md: missing — the index is the only map of the doc set')
} else {
  for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    const link = cells[1]?.match(/\]\(([^)]+)\)/)
    if (!link) continue
    rows.set(resolve(DOCS, link[1]), cells[3])
  }
  for (const f of docs) {
    if (!rows.has(f)) {
      fail.push(`${rel(f)}: not in the index — a doc that is not in docs/README.md does not exist`)
      continue
    }
    const listed = (rows.get(f) ?? '').replace(/`/g, '').replace(/\s+v\d+$/, '')
    const own = (header(f).Status ?? '').replace(/`/g, '')
    if (listed && own && listed !== own)
      fail.push(`${rel(f)}: index says "${listed}", the header says "${own}" — the index is fixed from the header`)
  }
  for (const [p] of rows) {
    if (existsSync(p) || !p.endsWith('.md')) continue
    fail.push(`docs/README.md: row points at a file that does not exist -> ${rel(p)}`)
  }
}

// 5 — Owns: globs and `// doc:` headers agree
const globRe = (glob) =>
  new RegExp(
    '^' +
      glob
        .split('/')
        .map((seg) => (seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
        .join('/')
        .replace(/\/\.\*$/, '(/.*)?') +
      '$',
  )
const owned = [] // [doc, glob]
for (const f of docs) {
  const raw = header(f).Owns
  if (!raw || raw === '—') continue
  for (const glob of raw.replace(/`/g, '').split(',').map((s) => s.trim()).filter(Boolean))
    owned.push([f, glob])
}
const codeFiles = walk(ROOT).filter((f) => !rel(f).startsWith('docs/'))
for (const f of codeFiles) {
  const named = readFileSync(f, 'utf8').split('\n').slice(0, 12).join('\n').match(/doc:\s*(\S+?)\s*$/m)?.[1]
  const owners = owned.filter(([, glob]) => globRe(glob).test(rel(f)))
  if (named) {
    const target = resolve(ROOT, named)
    if (!existsSync(target)) fail.push(`${rel(f)}: // doc: ${named} does not exist`)
    else if (!owners.some(([doc]) => doc === target))
      fail.push(`${rel(f)}: // doc: ${named} but that doc's Owns does not cover ${rel(f)}`)
  } else if (owners.length) {
    fail.push(`${rel(f)}: owned by ${rel(owners[0][0])} but its header has no \`// doc:\` line`)
  }
}

if (fail.length) {
  console.error(fail.map((l) => `FAIL  ${l}`).join('\n'))
  process.exit(1)
}
console.log(
  `ok — ${docs.length} docs, ${links} links resolve, ${rows.size} index rows, ${owned.length} owned globs`,
)
