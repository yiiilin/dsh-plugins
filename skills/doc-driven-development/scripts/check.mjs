#!/usr/bin/env node
// doc: docs/architecture.md
// Contract check for this skill package:  node scripts/check.mjs
//
// Five invariants, each of which was silently violated at least once while this
// skill was written (a 620-char description the catalog truncated; a pointer to a
// TEMPLATES/ directory that never existed; an architecture rule forbidding
// something SKILL.md did). Nothing else validates them.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_DESC = 500 // harness: length <= 500 passes; past that it renders slice(0, 497) + '...'

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const files = walk(ROOT) // every file, so a non-markdown orphan is caught too
const mds = files.filter((f) => f.endsWith('.md'))
const rel = (p) => relative(ROOT, p)
const text = new Map(mds.map((f) => [f, readFileSync(f, 'utf8')]))
const strip = (t) => t.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '')
const fail = []

// 1 + 2 — SKILL.md frontmatter parses and the description survives the catalog
const skillPath = join(ROOT, 'SKILL.md')
const fm = text.get(skillPath)?.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
if (!fm) {
  fail.push('SKILL.md: no frontmatter block at line 1 (the skill disappears from the catalog)')
} else {
  const field = (k) => fm[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim()
  for (const k of ['name', 'description']) {
    if (!field(k)) fail.push(`SKILL.md: frontmatter is missing ${k} (the skill disappears from the catalog)`)
  }
  const desc = (field('description') ?? '').replace(/^["']|["']$/g, '')
  if (desc.length > MAX_DESC) {
    fail.push(`SKILL.md: description is ${desc.length} chars, cap is ${MAX_DESC} — the catalog truncates it mid-sentence`)
  } else if (desc) {
    console.log(`  description ${desc.length}/${MAX_DESC} chars`)
  }
}

// 3 + 4 — every relative link resolves, and every file is the target of one.
// Resolving the link (rather than matching its text) is what makes a doc linked
// as `verifications/x.md` from inside `docs/` count as referenced; a link to a
// directory references everything under it.
const referenced = new Set()
let links = 0
for (const [f, body] of text) {
  for (const [, link] of strip(body).matchAll(/\]\(([^)#\s]+?)\)/g)) {
    if (/^(https?:|mailto:)/.test(link)) continue
    links += 1
    const target = resolve(dirname(f), link)
    if (!existsSync(target)) {
      fail.push(`${rel(f)}: link does not resolve -> ${link}`)
    } else if (statSync(target).isDirectory()) {
      for (const g of walk(target)) referenced.add(g)
    } else {
      referenced.add(target)
    }
  }
}
for (const f of files) {
  // Entry points are reached by convention rather than by a link: SKILL.md through
  // the catalog, an index through step 1 of the loop.
  if (f === skillPath || f.endsWith('README.md')) continue
  if (!referenced.has(f)) fail.push(`${rel(f)}: orphan — no markdown link resolves to it`)
}

// 5 — the line budgets stated in docs/architecture.md
const budget = [[skillPath, 200], ...mds.filter((f) => rel(f).startsWith('FORMATS/')).map((f) => [f, 120])]
for (const [f, cap] of budget) {
  const n = text.get(f).split('\n').length
  if (n > cap) fail.push(`${rel(f)}: ${n} lines, budget is ${cap} — split it or cut it`)
}

if (fail.length) {
  console.error(fail.map((l) => `FAIL  ${l}`).join('\n'))
  process.exit(1)
}
console.log(`ok — ${mds.length} docs, ${files.length} files, ${links} links resolve, no orphans, budgets met`)
