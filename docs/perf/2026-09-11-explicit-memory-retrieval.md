# Explicit memory retrieval — ticket #17

The coordinator now retrieves relevant, current explicit memories before intent reasoning and supervision. On the Windows PC, the production retrieval function measured **10.12 ms p95 in Electron 43.1.0**, below the spec section 9 target of 100 ms. The synthetic explicit-preference evaluation retrieved the expected evidence in 10/10 recall cases, with zero project or authority leaks in the seven labelled exclusion cases.

## Retrieval contract

`MemoryProfile.retrieve({ query, projectId?, threadId?, at? })` calls `retrieveExplicitMemories` in `src/main/memory/retrieval.mjs`. The coordinator supplies the current request and selected Sotto project/thread for intent, and the assignment instruction and assigned project/thread for supervision. Direct controls which do not invoke reasoning do not retrieve memory. `preferences(projectId?)` remains for compatibility with the profile service's earlier callers; the coordinator no longer uses that blanket list.

Scopes are searched in this order:

1. `thread:${JSON.stringify([projectId, threadId])}` for a supplied project and Sotto thread ID. Use the exported `threadMemoryScope` helper; provider session IDs are never scopes. Including the project prevents a thread identifier from crossing projects.
2. The existing raw project ID, preserving stored project memories without a migration.
3. The existing literal `global` scope.

`global` and the `thread:` prefix are reserved; a project lookup never treats a thread encoding as a raw project scope. Existing global/project records remain readable. Thread records using another previously undocumented encoding are not guessed. Questionnaire writes remain global; this ticket adds retrieval support for thread records without adding a scope editor or importer.

Only `sourceClass = explicit`, `authority = preference`, active/temporary rows with no replacement and a current validity window are candidates. The exclusive end bound is `validTo > at`. Policy and permission memories, imported/observed/inferred/agent-confirmed memories, other scopes, disputed/archived/superseded and future/expired rows are excluded in SQL before candidate limiting. Retrieval is read-only: it does not alter provenance, version history, history settings or authority. Policy records remain the only authority source. The reasoner's system guidance says the current instruction wins and preferences never authorize risky actions; conflicting saved guidance follows the supplied scope order.

Queries normalize case and diacritics, tokenize letters/numbers, remove a fixed list of common English function words, and keep at most 32 unique terms from the first 4,096 characters. FTS5 searches those terms as quoted OR literals. Each scope contributes at most 64 candidates, ranked by BM25, confirmation time and ID. A candidate must contain **at least 50% of the query's retained terms** in its content or tags. Candidates are then ordered by descending coverage within each scope. Empty/no-evidence/below-threshold results abstain. The coverage number is a deterministic lexical heuristic, not a measured recall probability. There is no embedding, synonym expansion or inference; paraphrases and long requests with weak lexical overlap can miss relevant preferences.

The returned memory context is capped at **8,000 UTF-16 characters of serialized JSON and 20 whole memories**, including IDs, topic labels, escaping and separators. Oversized memories are skipped intact so trimming cannot remove an exception or negation. This is the memory contribution budget, not a new limit on the existing host/thread input. The turn's token count remains the existing character-based estimate, not a provider tokenizer count. Only included memory IDs are recorded. Supervision now records human/done decisions as well as followup sends, so a memory-shaped attention reply has a turn record. Turn recorder history redaction continues to apply.

## Evaluation

Commands from the repository root:

```powershell
node scripts/memeval/bench-memeval.mjs --backend explicit --cases scripts/memeval/cases/explicit-v1.json
node scripts/memeval/bench-memeval.mjs --backend none --cases scripts/memeval/cases/explicit-v1.json
```

The registered `explicit` adapter opens isolated in-memory SQLite, runs the production migrations, writes only the fixture's explicitly marked `acceptedMemory` inputs, and invokes the same production retrieval function. Ordinary history is ignored: this evaluates accepted-memory retrieval, not history extraction. The optional input metadata is separate from expected answers. A test changes every answer/leak label and verifies identical retrieved IDs and text; the backend sees neither expected labels nor categories. The adapter is disposed even if a case fails.

The extractive reader returns the retrieved content verbatim, or null. It measures accessible evidence rather than LLM reply quality or end-to-end task success. `explicit-v1` has 22 hand-authored synthetic cases, all **draft / awaiting founder review**. Existing `v1` cases and the default no-memory benchmark are unchanged.

| Category | Explicit lexical | None |
| --- | ---: | ---: |
| Recall | 10/10 | 0/10 |
| Abstention | 3/3 | 3/3 |
| Temporal change | 1/1 | 0/1 |
| Expired exception | 1/1 | 0/1 |
| Project/thread leak exclusion | 3/3 | 3/3 |
| Authority/source leak exclusion | 4/4 | 4/4 |
| Total | 22/22 | 10/22 |

The recall set covers the seven questionnaire topics and project/thread preferences. Lexically matching foreign-scope distractors, permission/policy rows, imported/agent-confirmed rows, a below-threshold partial match, and expired exceptions exercise exclusions. Coordinator integration additionally checks that a stored preference claiming publishing/spending authority does not change policy or auto-answer a permission request. These controlled cases are not a claim of broad semantic recall or universal prompt-injection resistance.

Full scored reports: [explicit](evidence/issue-17-explicit-eval.json), [none](evidence/issue-17-none-eval.json).

## Warm Windows measurement

`scripts/memeval/bench-retrieval.mjs` creates a temporary disk-backed synthetic SQLite store with 10,000 rows across thread, project, global and unrelated scopes. It performs 100 warmups followed by 1,000 timed queries cycling eight fixed hit, miss, partial-match and common-term queries. Each measured duration includes query normalization, SQL, scope search, thresholding and JSON context assembly. Database creation/seeding, reasoning/network latency, startup and disk-cold retrieval are excluded. No user database, preferences, credentials or transcripts are read.

```powershell
node scripts/memeval/bench-retrieval.mjs scripts/memeval/results/retrieval-windows-node.json
$previousElectronNode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & .\node_modules\electron\dist\electron.exe scripts/memeval/bench-retrieval.mjs scripts/memeval/results/retrieval-windows-electron.json | Out-Host
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousElectronNode
}
```

Intel Core Ultra 9 275HX, Windows x64 build 26200, measured September 11, 2026 local time:

| Runtime | SQLite | p50 | p95 | p99 | Max |
| --- | --- | ---: | ---: | ---: | ---: |
| System Node 24.14.1 | 3.51.2 | 4.73 ms | 8.36 ms | 10.74 ms | 14.72 ms |
| Electron 43.1.0 / Node 24.18.0 | 3.53.1 | 5.44 ms | **10.12 ms** | 11.79 ms | 14.15 ms |

The maximum assembled context in this workload was 3,417 characters. Full environment and 1,000 individual samples: [Node](evidence/issue-17-windows-node.json), [Electron](evidence/issue-17-windows-electron.json). This uses the installed Electron runtime with checkout source, not a newly packaged application; packaging integration is a separate final-branch check. Mac, cold-store latency and larger/differently distributed stores remain unmeasured.

The initial query plan used `memories_scope_state` as the outer loop and repeatedly scanned FTS for each scoped row. A direct comparison on the synthetic store measured about 52 ms for one scope lookup versus 3 ms with FTS first. The final query uses `CROSS JOIN` to keep FTS first and perform memory rowid lookups; scope filtering still precedes the result limit. The slow initial long benchmark was stopped after this diagnosis; no incomplete percentile is reported as evidence.

## Verification

Focused retrieval/store/profile, coordinator memory/turn/authority/recovery/subscription reasoning, policy and evaluation suites passed after the final code edits: **286 tests across 11 files**. Typecheck, focused ESLint and `git diff --check` passed. Tests cover exact included IDs for intent and supervision, abstention, SQL scope and source/authority filtering, validity boundaries, whole-memory serialization limits, read-only history/provenance and deletion freshness. No full suite was run in the ticket worktree; final integration owns that run.
