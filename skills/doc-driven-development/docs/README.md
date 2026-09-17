# Doc-Driven Development — doc set

This is the skill's own contract, written in the format the skill prescribes. It doubles as the live example: read it to calibrate how concrete a doc has to be before it authorizes code. The "code" it governs is `SKILL.md`, `REFERENCE.md`, and `FORMATS/`.

Status: `draft` · `awaiting confirmation` · `confirmed` · `implemented` · `superseded`

## Conventions

- Language: English
- Glossary: [`../CONTEXT.md`](../CONTEXT.md) · Decisions: `docs/adr/` (none yet) · Formats: [`../FORMATS/`](../FORMATS/)
- The skill's own files are the transcription: a format change lands in `FORMATS/` first, then in the files it governs.

## Docs

| Doc | Layer | Status | Ver | Owns | Depends on | Open |
|---|---|---|---|---|---|---|
| [architecture.md](architecture.md) | architecture | awaiting confirmation | v1 | `SKILL.md`, `REFERENCE.md` | — | D1 |
| [doc-set.md](doc-set.md) | design | awaiting confirmation | v1 | `FORMATS/**` | architecture.md | D8–D11 |
| `docs/adr/` (0) | decisions | — | — | — | — | — |

## Open decision points

- [ ] `architecture.md` D1 — final file tree: keep `REFERENCE.md` for procedures, or fold it into `SKILL.md`
- [ ] `doc-set.md` D8 — how a repo that already has its own `docs/` layout is taken over
- [ ] `doc-set.md` D9 — whether the verification layer is a section of the feature doc or its own file
- [ ] `doc-set.md` D10 — where one-off evidence artifacts (spike scripts, benchmark output) live
- [ ] `doc-set.md` D11 — whether the skill ships a validation script

## Reading order

1. `architecture.md` — what the skill is made of, and which file owns which fact
2. `doc-set.md` — the convention itself: layout, roster, lifecycle, the gate
3. [`../FORMATS/`](../FORMATS/) — how each doc type is written
