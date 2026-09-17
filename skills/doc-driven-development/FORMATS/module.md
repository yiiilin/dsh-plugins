# Module format — `docs/domains/<domain>/modules/<name>.md`

Function-level detail for one module, split out of a feature doc when that doc outgrows one sitting. This is the layer that turns implementation into transcription: everything below is written so that it can be typed into code without a decision being made along the way.

A doc set needs this file only where the hard functions are. Simple functions are not documented here — their behavior is visible in the code and in the feature doc's interface table.

## Header

```markdown
Status: confirmed
Version: v1
Owns: src/import/reader.ts
Depends on: docs/import.md
Reconciled: 2026-09-17
```

## Body

```markdown
## Exports
| Symbol | Signature | Notes |
|---|---|---|

## Invariants
- <state that holds across every call in this module>

## `readBatch(stream, schema, size) -> Promise<Row[]>`

Contract:
- pre: `size > 0`; `stream` is at a record boundary
- post: exactly `size` rows, fewer only at EOF
- invariant: never buffers more than one raw line beyond the batch

Steps:
```
rows = []
while rows.length < size:
  line = stream.next()                # raw bytes, one at a time
  if line is EOF: break
  rows.push(parseRow(line, schema))   # throws ParseError
return rows
```

| Edge case | Behavior | Test |
|---|---|---|
| quoted field spans lines | parser joins it; offset still advances per physical line | `import.multiline_field` |

Errors: `ParseError` on schema mismatch, carrying `{ line, column, expected }`.
Budget: ≤ 12 MB peak RSS per 1000-row batch.
```

## Rules

- **Signature, inputs, outputs, steps, edge cases, errors, budget.**
- **Pseudocode, not prose.** Number the steps, name the branches, show the loop bounds. Language syntax is fine when it removes ambiguity; the point is that no design decision is left for the transcriber.
- **One subsection per function that needs it.** This file exists for the hard tenth, not the whole module.
- **Reference symbols, never paste code.** The code is the transcription and the doc is the source; when they disagree, this doc is edited first.
- **Budgets are per call or per unit of work**, with the box: `≤ 12 MB peak RSS per 1000-row batch on the 4-vCPU staging box`.
