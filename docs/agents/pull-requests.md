# Pull request template

```markdown
## What changed

- **Short lead (#issue).** One or two sentences on the behaviour, in the glossary's words. Say what is true now, not what the code does.
- **Next surface or ticket.** Same shape. One bullet per ticket or per user-visible surface.
- **After review.** What the two-axis review changed, when it changed something a reader would notice.

## Verification

- `npm run typecheck`, `npm run lint`: clean.
- `npm test -- --maxWorkers=2`: N passed, M skipped. Name every failure. A failure that is not yours is shown to reproduce on `main` at the same commit.
- `npm run build && npx playwright test tests/e2e/<spec>`: N passed. Say which specs and why those.
- Hand test in the running app, as a checklist of journeys, unchecked until done.
- Baselines regenerated (design captures, widget images) and why.

## Out of scope

What a reader might expect and will not find, with the issue or ADR that owns it.

## Known limitation

Behaviour that ships as is, with the reason.

Closes #n, closes #m.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Why each part is there

- **What changed** is the record a future reader searches. Bullets with a bold lead let a reader stop at the one they care about. Glossary terms (`CONTEXT.md`) make the PR searchable by the words the code uses.
- **Verification** is evidence, not a promise. Exact commands and counts let the reviewer rerun them; naming every failure, including the ones you did not cause, is what makes "green" mean something. A pre-existing failure is proven pre-existing by running the same spec on `main`.
- **Out of scope** stops the reviewer asking for the thing you deliberately left out. Point at the issue or ADR that owns it.
- **Known limitation** is for behaviour that ships imperfect on purpose. A limitation without a reason is a bug report.
- `Closes #n` goes in the body, not the title.
- The generated-with line is the last line before any reviewer bot appends its own summary.

Headings may read **Summary** and **Test plan** instead when the change is one thing; the content is the same.
