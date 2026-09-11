# SottoMemEval

A backend module exports `createBackend()` returning `{ name, reset(), observe(event), answer({ question, project, asOf }) }`.
`name` identifies the backend in reports and filenames.
`reset()` clears all state before each independent case.
`observe(event)` receives each history event in file order, including its date, provider, project, role, and text. Native provider values are `claude`, `codex`, and `grok`.
`answer(query)` returns `{ answer: string | null, memoryIds: string[] }`; use `null` to abstain.
Factories and methods may be synchronous or asynchronous; the harness awaits them all.
`runMemEval` accepts an optional `createBackend(name)` factory for direct backend injection; it defaults to the registry factory.
The backend handles project scope and the query's `asOf` date; it never receives ground-truth labels.
Register the factory under its CLI name in `backends/index.mjs`; adding a backend needs no harness changes.
The `none` backend ignores history and always abstains.
Schema validation and scoring share `PATTERN_FLAGS = 'is'`: regexes ignore case and dots match newlines, including in lookaheads. Temporal and exception answers must match the current pattern without matching the stale pattern.
Leak checks accept abstention or an answer that does not match the forbidden pattern; they do not prove semantic safety or deletion from storage.

Run `npm run memeval`, or `node scripts/memeval/bench-memeval.mjs --backend none --cases scripts/memeval/cases/v1.json --out scripts/memeval/results`.
Reports go to `scripts/memeval/results/<backend>-<caseSetVersion>-<timestamp>.json` by default; `caseSet.path` is absolute, rates in JSON are fractions, printed rates are percentages, and meanMemoryIds includes failed cases.
The synthetic v1 cases track founder review through each case's `draft` or `reviewed` status. Null baseline answers pass abstention and leak checks but fail the categories in `ANSWER_CATEGORIES` (recall, temporal, and exception).
`caseSetSchema` validates runtime structure: a version, at least one case, unique ids, matching category and expected kind, per-kind fields, and 3 to 8 history events. `authoredCaseSetSchema` adds the authoring rules of 20 to 30 cases and at least one case per category; harness fixtures may be smaller.
