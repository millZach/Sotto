# Branch input repairs

Package pkg-25 fixes #520, #541 and #542. The review rework completes the Settings copy callers, composition guards and recovery advice. It follows ADR-0011, ADR-0014, ADR-0018, ADR-0027, ADR-0033 and ADR-0035. No permission record, setting, provider, host or glossary term changed. The guide names the restored copy behavior.

## Regression evidence

The four original copy cases cover branch names, pull request links, phone addresses and terminal selections with browser clipboard writes denied. Four more cases exercise the actual Settings buttons: client update commands, provider sign-in codes, Devin's sign-in command and setup fix commands. Each reaches main's copy-only output bridge. The renderer audit finds browser clipboard access only in `richActions.ts`, as its fallback for a window without the preload bridge; production uses main's serialized output path from #637.

Both `isComposing` and keyCode 229 leave Enter actions untouched in branch search, project choice, thread renaming, new-folder naming, the phone computer name, host rename, connection fields and theme names. SSH answers and pasted provider sign-in codes use the same guard. A separate Enter still completes each action. Composing Escape stays inside branch search instead of bubbling to picker dismissal; ordinary Escape still closes it.

The original search tests cover clearing the search, editing after a pending Enter, current-thread state, late responses and switching threads while an Enter waits. The repairs remain intact after merging main.

Terminal copying keeps the selection while main answers and after a failure. A successful retry clears its copy advice. Each terminal store clears only the matching copy feedback, so a newer input failure stays visible. The error says that the selection is kept and asks for another Ctrl+C. A whitespace-only selection neither writes to the clipboard nor interrupts the command; it says to select text first. Branch copy failures give manual-copy advice. Pull request failures direct the user to Open on GitHub and copy the browser address, and the test verifies that action opens the correct URL.

The focused renderer run passed 161 tests in eight files. Before the repairs, tests reproduced all four Settings clipboard failures, both composition signals in the four missed Settings fields, both composing Escape cases and both terminal selection defects. The theme regression waits for the asynchronous save, so it catches the premature action.

## Built Windows app

The selected specs were `thread-worktrees.spec.ts`, `phones.spec.ts`, `host-folder-browser.spec.ts`, `pull-request-surface.spec.ts` and `terminal-display.spec.ts`. Eight distinct journeys passed across the run and reruns: all five worktree journeys, Phones, Pull request and Terminal. The pull request fixture now follows instant thread creation; the terminal fixture uses the current Sotto thread ID after host qualification. Neither assertion nor deadline was weakened.

The shared-checkout branch journey passed again after rebuilding, including main-owned copying, clearing the search, both composition signals for Enter and Escape, switching and creating branches, Git refusal, workspace choices and keyboard focus. The picker was captured at 1600x1000, 1280x800 and 820x560 CSS pixels in dark and light with reduced motion enabled. Search and the restored main ref remain in the viewport, with no document overflow. These inspected captures are retained outside the test's generated output:

- [Minimum size, dark](../../artifacts/branch-input-repairs/pkg25-branch-820x560-dark.png)
- [Minimum size, light](../../artifacts/branch-input-repairs/pkg25-branch-820x560-light.png)
- [1280x800, dark](../../artifacts/branch-input-repairs/pkg25-branch-1280x800-dark.png)

The test continues writing scratch captures under the ignored `artifacts/new-thread-setup/`. None of its `pkg25-branch-*.png` files is tracked there. Rerunning it cannot overwrite these retained captures. No design baseline was regenerated.

The folder-browser journey fails when Use this folder is pressed for a newly named folder: "That folder no longer exists. Nothing was added. Choose another folder." Add project always sends `useExisting: true`, and main now refuses a missing folder. The same journey and refusal were reproduced against an archived source build of main at `af69ca9e18caa0f7aeb9e0a69694f64b649d69b4`, under this worktree's ignored `out/` directory. The original main spec failed at the same assertion; a second run with only the test's improved diagnostic assertion confirmed the identical words. This inherited folder-creation failure is outside the copy/composition/search repairs and remains visible in the results.

IME verification uses browser keyboard events, not a hands-on operating-system IME session. The copy-feedback state prototype was driven and inspected in Chromium and retained on local branch `prototype/pkg25-copy-recovery`; it confirmed selection retention and recovery feedback without proposing a new layout. The shipped changes use the existing components and theme roles.

## Review and gates

Independent standards and spec reviews used gpt-6.1-sol at high reasoning. Both identified the same recovery defect: the pull request URL is not selectable in this surface. The advice now names the existing Open on GitHub action, and regression coverage clicks it and verifies the URL. Both reviewers then reported no remaining implementation findings.

All issue comments, pull request reviews and inline review comments were read through the three GitHub API endpoints. The initial feedback consisted only of Cursor's usage-limit notice and Greptile's credit-limit notice; there were no actionable online points. A later review by millZach identified a queued terminal copy clearing a newer selection. The fix records selection revisions, invalidates them from the start of pointer and mouse gestures, and ignores completion after disposal. Deferred regressions first reproduced the failures, then passed for changed text, a new range with identical text, dragging before xterm emits selection changes, and success or failure after disposal. Every actionable online point and every repair item in the resumed rework brief was accepted and addressed. Code, capture relocation and this note are separate commits.

The initial current-main integration at `af69ca9e` passed all four required local gates: typecheck, lint, `npm test -- --maxWorkers=2` (6,659 passed, 153 skipped, no failures), and notices verification (174 components). Build also passed.

A subsequent fetch brought in main at `081d9afadd45307c13a24d3732a20285e5a7e8bd`. It merged without conflicts. The integrated revision passed typecheck, lint, notices and build, followed by every changed non-Electron test file plus the package's affected tests: 1,529 passed and 12 skipped across 95 files. Nine Electron journeys passed on this revision: all five worktree journeys, Phones, Pull request, Terminal and the new thread-composer recovery journey. The retained captures were refreshed and inspected after this integration. The inherited folder-creation failure described above remains the only selected Electron failure.

The final recovery review caught stale terminal copy advice after success and an unconditional clear that could hide a newer input failure. Both were reproduced by failing regressions and repaired in separate commits. All 51 terminal tests passed, and both review axes reported no remaining material findings. Main at `6d96806f` was also integrated; the guide conflict was resolved by retaining both the copy instructions and main's unsupported-file guidance.

The latest nine-journey Electron rerun exposed an ambiguous composer recovery alert locator: both the workspace error and recovery status contain the refusal words. The test now selects the full recovery message; its draft and thread-ownership assertions are unchanged.

After the final drag and disposal fixes, typecheck, lint, notices (174 components) and build passed again. All nine selected Electron journeys passed on the rebuilt app. The three branch captures were refreshed and visually inspected in dark/light at the minimum and 1280x800, then committed separately from this note.

The complete final local suite on the integrated revision passed with the required `npm test -- --maxWorkers=2`: 6,722 passed, 154 skipped, no failures; 502 test files passed and 39 were skipped. All four required local gates are green.

Windows CI passed on `55a383c9` in run `36813285374`. The required post-green fetch then integrated main at `906776d0f54696768ee6a47215d377ec2ea895c5`. The Phones test conflict retained both the composition regression and the new cleanup cases; the component keeps main-owned copying and its composition guard. A final deferred regression also reproduced copying during an active drag before the range expands. Copy completion now compares an independent range snapshot as well as the revision, gesture-start and disposal guards. All 52 terminal tests passed and both reviewers cleared this correction.

The post-green integration passed typecheck, lint, notices (174 components), build and all nine selected Electron journeys. The three cited branch captures were refreshed and inspected again, then committed separately from this note. No design baseline was regenerated.

The first complete suite after integrating `906776d0` exposed one adapter-contract timing failure: 6,758 tests passed, 154 were skipped, and the Codex completed-reply subscription assertion failed. A direct snapshot can report idle before Codex publishes the completed reply to subscribers: state changes precede an awaited persistence write and publication. Twelve isolated ordinary runs passed, but a temporary real-fixture wrapper that held that publication until after the idle read reproduced the exact failure twice. Polling for the same completed reply in the subscribed snapshots made that controlled reproduction pass. The temporary wrapper was removed; no sleep, deadline, provider behavior or assertion predicate changed. Both review axes cleared the correction. The shared contracts then passed for all five providers: 142 passed, 39 skipped. The adapter and socket-host contracts also passed together: 69 passed, 25 skipped.

The final complete rerun on `906776d0` with the range and publication corrections passed all four required local gates: typecheck, lint, notices (174 components), and `npm test -- --maxWorkers=2` (6,759 passed, 154 skipped, no failures; 502 files passed and 39 were skipped). The publication correction is a separate test commit, and this evidence update is a separate note commit. All three PR feedback endpoints were reread; the terminal-selection race is the only actionable online finding and is addressed.
