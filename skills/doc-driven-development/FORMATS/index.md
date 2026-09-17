# Index format — `docs/README.md`

The index is the only map of the doc set and the first thing any session reads. It answers three questions: which docs exist, what state each is in, and what is waiting on the human.

## Skeleton

```markdown
# <Project> doc set

The contract for this repo: docs define what gets built, code is the transcription.
Status: `draft` · `awaiting confirmation` · `confirmed` · `implemented` · `superseded`

## Conventions
- Language: <the language docs are written in>
- Glossary: `CONTEXT.md` · Decisions: `docs/adr/` · Formats: the `doc-driven-development` skill
- Source files name their doc: `// doc: docs/features/import.md`

## Docs

| Doc | Layer | Status | Ver | Owns | Depends on | Open |
|---|---|---|---|---|---|---|
| [architecture.md](architecture.md) | architecture | confirmed | v2 | — | — | — |
| [features/import.md](features/import.md) | design | awaiting confirmation | v1 | `src/import/**` | architecture.md | D2, ⚠D5 |
| `docs/adr/` (4) | decisions | — | — | — | — | — |

## Open decision points

- [ ] `features/import.md` D2 — eviction policy; recommend in-process LRU
- [ ] ⚠ `features/import.md` D5 — drop the legacy `mode` column; needs an explicit answer

## Reading order
1. `architecture.md` — why the system is shaped this way
2. the feature doc that owns the code you are about to touch
```

## Rules

- **One row per live doc**, plus one row for the whole `docs/adr/` directory with its count. ADRs are append-only history, found by number; they do not each need a row. A live doc that is not in the index does not exist.
- **The root holds two files and typed directories**: `README.md` (this index), `architecture.md`, and `features/`, `modules/`, `verifications/`, `adr/`. A document type that has no directory yet gets one when its second file appears — never put a pile of one type loose in `docs/`.
- **One index for ADRs.** If the repo keeps its own `docs/adr/README.md` (the `architecture-decision-records` convention), point the row at it and list nothing else — the same decisions never appear in two indexes.
- **The conventions block is filled once and obeyed afterwards** — including the doc language, so no session re-asks and no session switches language mid-repo.
- **Status and version here match the doc's own header.** The same fact in two places: when they disagree, the doc wins and the row is fixed. A stale row is drift.
- **Open decision points are duplicated here on purpose.** The index is the human's single review surface; clear a line the moment it is decided.
- **Reading order is not decoration.** It is how a new session knows what to read before touching code.
