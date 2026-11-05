# Sotto test prune rubric

Sotto is an Electron dictation app becoming a coordinator of coding-agent threads (Codex, Claude Code, Grok, Devin).
Its CI runs about 16,000 Vitest cases on six Windows and six Linux shards. We are deleting tests that cost CI time,
flake, or add code without catching anything a real bug would cause. The model is T3 Code's PR #22557, which deleted
43% of its tests and then had to restore auth, permission, clipboard-redaction, scheduling and render-scheduler tests
its swarm had cut. Those restorations are the failure to avoid: the keep list below is firm. Outside it, delete what proves little;
T3's own rubric, which this one includes, is the bar.

You judge each test case (an `it()` / `test()` call) on its own. Read the whole test file first. Open the source
under test (`src/...`) when you need to know whether a test only mirrors the code.

## Always keep (a keep here overrides every delete category)

1. Provider adapters and protocol translation: Codex app-server, Claude Code stream-json, Grok/Devin ACP, Muse,
   OpenCode, Cursor; how native frames become Sotto events and back.
2. The host protocol and its hand-mirrored wire: socket host, frames, versions and features, paired hosts, the iPhone's
   wire, remote command allow-list, SSH launcher and launch scripts.
3. Auth, pairing, credentials and keys, permissions and approvals, policy records, sandbox and browser grants,
   anything that decides whether something is allowed. Tests that something is refused belong here.
4. Privacy: nothing secret or user-written reaches a log, a title, a file or a network call; redaction.
5. Persistence: stores, migrations, journals, atomic writes, saved records, restart and recovery, history kept or
   dropped.
6. Git and worktree safety: anything that could lose, overwrite or move a user's work; checkpoints, branches,
   worktree allocation and reclaim, bring changes back.
7. Watcher's settle and news rules, delegation outcomes, and the coordinator's orchestration of threads (who is
   working, queued, done, uncertain).
8. Deterministic race and ordering fixes: a test that holds a barrier, scripts a lost acknowledgement, or uses a fake
   clock to pin an order. Also a test that no timer stays armed on main's update and publishing path, or while a
   feature is off (those guard per-update work and leaks).
9. Zach's stated design rules: the composer has no border and keeps its look; the Watcher scene never blinks; colour
   from theme tokens; accessible names and the keyboard path (focus order, Escape closes, shortcuts).
10. Gates on features: Owl feature switches (`owlFeatures`, `useOwlFeature`) and the memory gate (`useMemoryEnabled`)
    — what shows or starts with the switch off.
11. Performance guards that count work or bytes (copies, commits, writes, reads, frame sizes) rather than time, and
    any benchmark or budget.
12. A regression test for a specific fixed bug: it names an issue (#123) or ADR, or its comment explains the bug it
    pins. Keep unless it only restates the code's own constant.
13. External formats: parsing what another program writes (JSONL rollouts, CLI output, Git output, config files,
    Markdown) and writing what another program reads.
14. The agent shell (the thread list state main publishes to the window): what it carries and leaves out, when it is
    pushed, and what it costs to build, where a test is the only written record of that behaviour.

## Delete when one of these fits and nothing above does

- `type-redundant`: checks what TypeScript or a zod schema already guarantees (a field exists, has a type, a function
  returns an object with the declared keys).
- `trivial`: trivial logic — too simple to break unnoticed: a getter, a constant equals itself, a pinned literal with
  no stated reason, a one-line pass-through or guard, an identity mapping, a default value restated, a memo returning
  the same object, a simple formatter whose output another case already shows.
- `dom-basic`: basic DOM behaviour with no Sotto logic: renders without crashing, renders nothing for empty input, a
  button exists, a click calls the prop it was given, a class name or data attribute is present, children render, a
  disclosure opens and shuts.
- `mock-mirror`: asserts that a mock was called with exactly what the code passes it, and nothing a user, file or
  other process could observe.
- `smoke`: "module loads", "exports a function", "can be constructed".
- `duplicate`: a table row or near-copy of another case that exercises the same branch with different literals. Keep
  at least one case per branch; name the case it duplicates.
- `vacuous`: passes without proving what its name says (its assertions would pass if the behaviour were broken).
- `flaky-by-design`: depends on real elapsed time — real sleeps or real timers racing real work — and is not covered
  by a keep rule above. (A keep-rule test that is flaky is kept; say so in `note`.)
- `timers`: real or fake timers — a test whose point is timer plumbing or cosmetic cadence (how often words rotate, a
  delay constant) rather than an ordering or a guard from keep rule 8.
- `wall-clock`: asserts on measured elapsed time without being gated by `SOTTO_PERF_ASSERT` or `SOTTO_PERF_BENCH`.

## How to answer

List only the cases you would delete. Every case you do not list is kept. For each deletion give the case id, one
category from the list above, and a reason of at most 20 words that names what makes it low-signal (and, for
`duplicate`, which case covers it). Do not delete a case because it is slow or long; delete it because it proves
little. If a whole file would go, list every case.
