# Third-party notices

Original material in this skill is released under the MIT License, © 2026 yiiilin. Parts of it are adapted from other MIT-licensed work, which keeps its own copyright notice; an exact account of what came from where follows.

## mattpocock/skills

- Source: <https://github.com/mattpocock/skills>
- Commit: `5b15a47f2d7150f545fbcacbfe381787fc0230dc`
- License: MIT — Copyright (c) 2026 Matt Pocock

Adapted material:

| Here | Upstream path | What was taken |
|---|---|---|
| `FORMATS/decision-point.md` — "Escalate to an ADR when all three hold" | `skills/engineering/domain-modeling/ADR-FORMAT.md` | The three conditions for promoting a decision to an ADR, reworded |
| `CONTEXT.md` — the shape of every entry | `skills/engineering/domain-modeling/CONTEXT-FORMAT.md` | The glossary entry format: term, a one-or-two-sentence definition, and an `_Avoid_:` list of rejected synonyms |
| `docs/features/doc-set.md`, `FORMATS/index.md`, `REFERENCE.md` | `skills/engineering/domain-modeling/{SKILL.md,ADR-FORMAT.md,CONTEXT-FORMAT.md}` | The `docs/adr/` layout, and the rule that this skill cites `domain-modeling` as the owner of the glossary and ADR formats instead of redefining them |
| `REFERENCE.md` — "The writing standard" | `skills/productivity/writing-for-agents/SKILL.md` | One phrase ("the reason behind a choice") and the document-design guidance followed throughout |

Referenced but not reproduced: `domain-modeling` is cited by name as the owner of the glossary and ADR formats. Everything else in this skill — the loop, the tier table, the doc-set convention, the `FORMATS/` specs, and the skill's own `docs/` — is original to this skill.

Verified by n-gram overlap against every installed skill: an 8-gram pass over 136,121 distinct grams found no overlap at all, and 5- and 6-gram passes surfaced only the rows above plus generic English and table separators.

## MIT License

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Upstream file hash, for verification: `sha256 0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5`.
