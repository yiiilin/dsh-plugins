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
| [features/doc-set.md](features/doc-set.md) | design | awaiting confirmation | v2 | `FORMATS/**` | architecture.md | D8 |
| [verifications/design-validation.md](verifications/design-validation.md) | verification | awaiting confirmation | v1 | — | doc-set.md | — |
| `docs/adr/` (0) | decisions | — | — | — | — | — |

## Open decision points

- [ ] `architecture.md` D1 — final file tree: keep `REFERENCE.md` for procedures, or fold it into `SKILL.md`
- [ ] `features/doc-set.md` D8 — how a repo that already has its own `docs/` layout is taken over

## Reading order

1. `architecture.md` — what the skill is made of, and which file owns which fact
2. `features/doc-set.md` — the convention itself: layout, roster, lifecycle, the gate
3. `verifications/design-validation.md` — what the convention's own premises rest on
4. [`../FORMATS/`](../FORMATS/) — how each doc type is written
