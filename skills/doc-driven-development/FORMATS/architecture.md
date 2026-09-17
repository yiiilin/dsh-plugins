# Architecture format — `docs/architecture.md`

The architecture doc answers *why the system is shaped this way*. It changes rarely, it is read first, and it is the only doc that spans features.

One file until it covers more than one deployable or roughly five modules; then split per subsystem and let the index carry a row for each.

## Header

```markdown
Status: confirmed
Version: v2
Owns: —
Depends on: —
Reconciled: 2026-09-17
```

## Sections

1. **Purpose and scope** — what this system is for, and the boundary around it.
2. **Context** — the systems outside the boundary and what crosses it (calls, events, files, humans).
3. **Modules and responsibilities** — table of `module | responsibility | may depend on`. One row per module; the responsibility is one line. **This table names the domains**: `docs/domains/<domain>/` mirrors these rows, so adding a row here means adding a directory there.
4. **Dependency direction** — the rule, and how it is enforced: `src/api may import src/core, never the reverse — enforced by <check>`.
5. **Data flow** — the end-to-end paths, numbered, one line per hop. The three or four paths that matter, not every path.
6. **Data ownership** — table of `store | owner | who may write`. Name the single writer for every piece of state.
7. **Cross-cutting concerns** — configuration, logging, errors, auth, i18n: where each lives and what the rule is.
8. **Budgets** — the numbers the design is held to.
9. **Decision points** — see `decision-point.md`.
10. **Change log** — one line per version.

## Rules

- **Every claim is checkable.** "Layered architecture" is not architecture. "`src/api` may import `src/core`, never the reverse, enforced by `depcruise`" is.
- **Budgets are numbers with the box they were measured on**: `P99 ≤ 120 ms at 500 rps on the 4-vCPU staging box`. A budget without a box is a wish.
- **No interfaces here.** Signatures belong to the feature doc that owns them; architecture names boundaries, not symbols.
- **Rejected alternatives stay visible** in the decision points, one line each — that is what stops a future session from re-litigating the shape of the system.
- **This doc is not a tour of the code.** If a reader can get it from the directory listing, it does not belong here; keep the reasons and the rules.
