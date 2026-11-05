# Dynamic threads on real tasks

November 4 and 5, 2026, on forge (Linux), in the Owl build of #2191's head (`b5797ad8e`) over the real Claude Code, Codex, Grok Build and Muse clients. This is Part 7 of `docs/plans/dynamic-threads.md`, the comparison Zach asked for before deciding on stable or on Part 8.

## How it ran

Five open issues, picked by size: #690 (small), #2133 and #1586 (medium), #678 and #683 (larger). Each ran twice from a fresh clone of `main` at `518619f9f`, the commit before any of them was fixed:

- **Dynamic.** An Opus 5.5 thread with Dynamic on, allowed all four providers, Highest effort at Extra high and Workers at once at four.
- **Roles.** An Opus 5.5 thread following Zach's own role cards: building and UI on Opus at High, code review on GPT-6.1 Sol at Extra high, research on Haiku at Extra high and computer use on GPT-6.1 Terra at High.

Both sides got the same message: the issue's text, then that nobody was there to answer, that there was no pull request or push, that another model should review the change once, forge's memory limits, and to commit on the checked-out branch. Each thread had Full access on a shared checkout. A small driver outside the repository ran the app with Playwright, refused any permission and answered any question with "Nobody is here to answer". None came up. A run was finished after two quiet minutes. Time when Sotto was holding a worker's turn that had ended with work still running counted as busy, up to the twenty minutes Sotto waits before telling the overseer. The driver then ran typecheck, lint on the changed files and the changed test files.

Tokens come from the Claude Code and Codex session records of each run's threads: output, fresh input and cached input. The limits Usage reads are whole percents of a week, shared with every other session on the same accounts, so a run's change in them is noise. Tokens are the measure here. A record that began before its run started belongs to a set-aside attempt in the same folder, and is left out. Grok Build and Muse did no work in any run.

## Results, task by task

| Task | Side | Time | Building | Review | Output | Fresh input | Cached input |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #690 small | Dynamic | 4.3 min | Terra, Medium | Sonnet, Medium | 12k | 144k | 1.53M |
|  | Roles | 3.0 min | Opus itself | Sol, Extra high | 10k | 202k | 1.45M |
| #2133 medium | Dynamic | 7.0 min | Terra, High | Sonnet, High | 24k | 174k | 2.55M |
|  | Roles | 7.3 min | Opus itself | Sol, Extra high | 29k | 275k | 2.72M |
| #1586 medium | Dynamic | 9.0 min | Terra, High | Sonnet, High | 20k | 200k | 2.94M |
|  | Roles | 5.7 min | Opus itself | Sol, Extra high | 24k | 260k | 2.05M |
| #678 larger | Dynamic | 31.0 min | Sol, High | Opus, High | 104k | 450k | 11.79M |
|  | Roles | 11.7 min | Opus itself | Sol, Extra high | 57k | 499k | 7.97M |
| #683 larger | Dynamic | 27.4 min | Opus, High | Sol, High | 113k | 683k | 22.52M |
|  | Roles | 23.0 min | Opus itself | Sol, Extra high | 87k | 611k | 18.02M |

Every fix passed typecheck, lint and its tests on both sides. Each does what its issue asks, with one departure on #683:

- **#690.** Both change the advice to "Try again." Dynamic's test also proves a retry clears the notice.
- **#2133.** Both skip an over-long command before it takes a slot and read a failed settings read as no summary. Roles also amended ADR-0185's text.
- **#1586.** Both record the old and new keys. Roles changed the comparison itself and covered more cases; Dynamic added a branch for the host change.
- **#678.** Both read the Git status, with no fetch, when the menu opens or its button is pressed, and the smoke journey waits for Commit. Dynamic added a new bridge method from the renderer to the host: 186 changed lines of source across 20 files and 407 of tests. Roles reused an existing thread command: 90 lines across 11 files and 172 of tests.
- **#683.** Both do all four items: the retry, the launch pass, the kept error and the comment. They part on the issue's own scenario, a store that would not open at start. Dynamic reopens it on the retry once storage is back, keeps what that start could not read in `workspace.json` until the next start, and has the test the issue asks for. Its Sol review found three real faults, the worst that a crash during a history-off pass could leave pictures and videos on disk, and the builder fixed them with a new saved mark in `agents.json`. Roles reopens only a store that history being turned back on had closed. For one that never opened at start, it says to restart at once, reasoning that writing to a store the run never read could cover saved history, so it does not do the test the issue asked for. Dynamic changed 149 lines of source across 6 files and 168 of tests; roles 114 across 7 files and 145 of tests.

## What the overseer did

- **Its picks.** On the first four tasks, with Claude at 76% to 89% of its week and Codex at 20% to 21%, it sent every build to Codex, Terra on the smaller tasks and Sol on #678, each time saying Codex had the most limit left. On #683, after Zach's Claude accounts had switched, Claude stood at 10% and Codex at 22%, and it turned round: Opus built, saying Claude had the most room left. A switch of accounts reads to it as room, as it should. Every review went to the other provider from its builder, saying a different model family gives an independent read: Sonnet on the smaller tasks, Opus on #678 and Sol on #683.
- **Its own maker.** 5 of 10 picks were Anthropic's: the four reviews on the first four tasks and #683's build. Each gave limits, or a different family from the builder, as its reason.
- **Grok Build and Muse.** Both were allowed and neither was picked. Before the comparison, a check of this build showed a real overseer starting a worker on each, and both answered.
- **Its own work.** It edited no file and ran no changing command in any run. Every tool call in its Claude Code session records was a read (`git status`, `git show`, `sed -n`, `grep`, the file reader) or a delegation tool. Each roles thread did the building itself, editing through short Python scripts in its shell rather than the edit tool, so a count of edit-tool calls alone would have missed it.
- **Pieces moved.** None. No worker stopped at a limit, and no start named `replaces`.
- **Effort.** Nothing went past Highest effort, so nothing was held.

## Against the bar

The plan's bar, which Zach kept on November 4: Dynamic goes on if it uses no more limit than roles on the larger tasks and he overrules fewer than one pick in five.

- **Overrules: passes.** Zach read every pick with its reason and overruled none of the 10 ("Those sound good" and "That sounds good", November 5).
- **Limit on the larger tasks: fails, on both.** On #678 Dynamic used 104k output tokens against 57k and 11.79M cached against 7.97M, with less fresh input (450k against 499k), and took 31.0 minutes against 11.7. On #683 it used more of all three, 113k against 87k output, 683k against 611k fresh and 22.52M against 18.02M cached, and took 27.4 minutes against 23.0. The overseer itself is the smaller part, 11k output and 0.59M cached on #678 and 7k and 0.55M on #683. The rest is its workers doing more: on #678 Sol built a larger change than roles' Opus did, and on #683 the Opus builder spent 91k output against the roles thread's 54k for building it and answering three reviews.

On the smaller tasks Dynamic used less fresh input than roles on all three, less output on two and less cached input on one. Those tasks are not part of the bar.

**Zach's decision, November 5.** He read that the limit half failed on both larger tasks and chose to go on to Part 8 anyway. Dynamic stays an Owl feature, and stable is still his to decide.

## Found on the way

Two faults that only real clients showed, fixed in #2191 before the runs counted:

- A Grok Build worker's first brief was refused as the user's own turn, because Grok Build reports a prompt as running before its send returns.
- An overseer on a freshly started app read every provider's limits as not read, because nothing had asked for them yet.

forge ran short of memory twice during #683's Dynamic run, and both times earlyoom closed the app: 21 minutes in while the worker ran tests, and 2 minutes in while another session's Playwright run held memory. Zach chose to run #683 again on both sides. The runs counted here started only after forge had had 6 GB free and no other heavy job for two minutes. A third Dynamic attempt was cut short by the driver itself. Its worker ended a turn with work still running, which Sotto holds as background, and the driver closed the app two quiet minutes later with the fix uncommitted. The driver now waits through that hold. None of the three attempts is in the table.

The numbers for each run, its picks with their reasons, and its checks are in `artifacts/dynamic-threads-comparison/results.json`.

## Not checked

- Windows and macOS. Everything here ran on forge.
- The end-to-end journeys each fix touched. The driver ran typecheck, lint and the changed unit and integration tests only.
- Work on Grok Build or Muse in a real task, since the overseer never picked them.
- A task that needs a UI check or computer use.
- Five tasks is a small sample, so this note gives each task on its own and claims no average.
