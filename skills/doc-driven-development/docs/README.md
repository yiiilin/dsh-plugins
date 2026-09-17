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
| [architecture.md](architecture.md) | architecture | confirmed | v1 | `SKILL.md`, `REFERENCE.md`, `CONTEXT.md`, `THIRD-PARTY-NOTICES.md`, `scripts/check.mjs` | — | — |
| [features/doc-set.md](features/doc-set.md) | design | confirmed | v2 | `FORMATS/**`, `scripts/check-doc-set.mjs` | architecture.md | — |
| [verifications/design-validation.md](verifications/design-validation.md) | verification | confirmed | v1 | — | features/doc-set.md | — |
| `docs/adr/` (0) | decisions | — | — | — | — | — |

## Open decision points

None. Three of the six premises in the verification doc are still `open`, pending the pilot — that is a property of the premises, not a question waiting on anyone.

## Reading order

1. `architecture.md` — what the skill is made of, and which file owns which fact
2. `features/doc-set.md` — the convention itself: layout, roster, lifecycle, the gate
3. `verifications/design-validation.md` — what the convention's own premises rest on
4. [`../FORMATS/`](../FORMATS/) — how each doc type is written
