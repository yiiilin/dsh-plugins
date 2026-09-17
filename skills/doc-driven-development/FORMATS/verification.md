# Verification doc format — `docs/verifications/<method>.md`

One file per verification: a premise the design rests on, the cheapest way to test it, and what came back. It lives apart from the design doc because a premise usually outlives the unit that raised it — the answer to "does this library stream?" serves the next feature too.

The design doc links here; this doc names the design docs it serves.

## Header

```markdown
Status: implemented
Version: v1
Verifies: docs/import.md
Verdict: holds
Date: 2026-09-12
```

| Field | Rule |
|---|---|
| Status | the same five states as any doc |
| Verifies | the design doc whose premises this settles — the reverse of that doc's link |
| Verdict | `holds` · `fails` · `open`, restated from the body so a reader settles it from the header |
| Date | when the evidence was collected |

## Body

```markdown
## Question
Does `csv-parse` stream, or does it buffer the whole file?

Why it matters: a buffering parser puts the 5M-row import outside the memory budget.

## Method
A 20-line spike reading a 1 GB file through the parser, sampling RSS every 100 ms.

## Evidence
```
$ node stream-rss.mjs data/1gb.csv
peak RSS 48 MB, flat after the first 2 MB
```
Run 2026-09-12 on the 4-vCPU staging box.

## If it fails
Fall back to a line-oriented splitter with an explicit record buffer.
```

## Rules

- **Name the premise, not the feature.** "the parser streams" is a premise; "import works" is not.
- **One file per verification, not per premise** — a single method that settles three questions is one doc.
- **The cheapest test that settles it, first**: read the dependency's source, a 20-line spike, a benchmark, the vendor's docs, one question to the human.
- **Evidence is a command and a result, with a date.** "Tested" is not evidence.
- **Keep the script beside this doc** when the result would be expensive to reproduce; otherwise the command in the Evidence block is enough.
- **A failed premise goes back to the design doc** as a decision point. Implementing on an `open` premise needs the human's explicit acceptance, recorded there.
- **This is not the reconcile record.** Reconcile evidence lives in the design doc and answers a different question: does the shipped code match that doc, item by item.
