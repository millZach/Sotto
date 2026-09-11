# SottoMemEval

A backend module exports `createBackend()` returning `{ name, reset(), observe(event), answer({ question, project, asOf }) }`.
`name` identifies the backend in reports and filenames.
`reset()` clears all state before each independent case.
`observe(event)` receives each history event in file order, including its date, agent, project, role, and text.
`answer(query)` returns `{ answer: string | null, memoryIds: string[] }`; use `null` to abstain.
Factories and methods may be synchronous or asynchronous; the harness awaits them all.
The backend handles project scope and the query's `asOf` date; it never receives ground-truth labels.
Register the factory under its CLI name in `backends/index.mjs`; adding a backend needs no harness changes.
The `none` backend ignores history and always abstains.
Scoring uses case-insensitive regexes; temporal and exception answers must match the current pattern without matching the stale pattern.
Leak checks accept abstention or an answer that does not match the forbidden pattern; they do not prove semantic safety or deletion from storage.

Run `npm run memeval`, or `node scripts/memeval/bench-memeval.mjs --backend none --cases scripts/memeval/cases/v1.json --out scripts/memeval/results`.
Reports go to `scripts/memeval/results/<backend>-<caseSetVersion>-<timestamp>.json` by default; rates in JSON are fractions, printed rates are percentages, and meanMemoryIds includes failed cases.
All 24 v1 cases are synthetic drafts awaiting founder review. Null baseline answers pass abstention and leak checks but fail recall, temporal, and exception checks.
