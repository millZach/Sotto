# Remove standalone Chats

October 6, 2026. Windows verification of the removal integrated with `main`
at `febe51a6`. Zach selected removal of standalone Chats, personal voice and
Generate prompt, while keeping project Threads and saved chat files.

## Behavior and preservation

The standalone route, navigation, renderer, prompt generator, preload/IPC
bridges, services, native personal methods and automatic provider connections
are removed. Settings keeps Reasoning for the coordinator and thread defaults.
Thread requests, saved answers, native adapters, Dictate, Terminal, Tools,
memory and voice gates remain.

Existing `personal-chat/` files are retained while local history is on. Native
provider history is unchanged. Legacy aliases remain parseable but cannot be observed, resumed,
sent to or reused as project Threads. A three-provider regression checks
startup and an unrelated project save, including interrupted compaction for
Codex and Claude. Personal request drafts remain in shared storage while
active personal operations are rejected, including when a later receipt
matches a retired draft. After PR review, Zach selected preserving the existing
history-off privacy policy: redact retired transcripts and submitted answers
on startup and Settings saves, preserve unsent drafts and recovery identities,
and remove submitted personal forms from the shared answer store. Thread forms
retain their separate recovery policy. Malformed originals are never reset or
backed up; a stable recovery notice reports incomplete cleanup. Only exact
abandoned atomic copies are swept after a validated primary is cleaned.

## Rendered review

The initial before/after HTML is archived on local branch
`prototype/remove-personal-chats`, commit
`538e2c0e8e5c4740ddc5e7a8d63094b730804ce9`, in
`docs/prototypes/remove-personal-chats.html`. It uses Sotto's tokens and Figtree.
The chosen direction removes the entry without restyling the shell.

Fresh Electron interaction tests on the integrated build exercised 1600x1000,
1280x800 and 820x560, dark and light, plus reduced motion at minimum size.
They checked sidebar collapse and focus, Tab to Settings, History, Help and
Dictate, the Reasoning heading, a thread question, absent chat bridges and
unchanged legacy chat file contents while history is on. Screenshots were inspected directly.
The navigation fits; the minimum-size settings surface scrolls vertically.

Retained evidence:

- [Threads, dark, 1600x1000](../../artifacts/remove-personal-chats/threads-1600x1000-dark.png)
- [Threads, light, 820x560](../../artifacts/remove-personal-chats/threads-820x560-light.png)
- [Reasoning, light, reduced motion](../../artifacts/remove-personal-chats/settings-820x560-light-reduced-motion.png)
- [Thread question, light, reduced motion](../../artifacts/remove-personal-chats/question-820x560-light-reduced-motion.png)
- [Incomplete privacy cleanup, 820x560](../../artifacts/remove-personal-chats/privacy-cleanup-notice-820x560.png)

Native computer use was requested separately. Both native and browser
computer-use runtimes exit before initialization with
`windows sandbox failed: helper_unknown_error: apply deny-read ACLs`.
Resetting and retrying after access was changed produced the same error.
The Electron checks and image inspection above are not a completed native
computer-use journey. Zach explicitly selected those verified checks as the
accepted fallback before PR delivery and merge.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run notices:verify` and the
  Electron build passed. Notices verified 174 components.
- All 16 affected Electron checks passed in one run: removal (1), request
  recovery/restart (7), sidebar resize/collapse (2), retained mixed Tools,
  terminal, browser, form and layout journeys (6).
- Focused merged runtime tests passed 222 cases; voice/mute/release and
  request-restart renderer checks passed 20. Claude safety passed 51;
  Codex process isolation passed 5; legacy aliases, newest-turn, MCP cleanup,
  Grok processes and Claude updates passed 33 other targeted cases.
- Design capture and a fresh design verification each passed 10 journeys and
  146 exact deterministic tuples. The baselines intentionally reflect the
  missing Chats navigation and shortened Reasoning heading.
- The complete local two-worker run finished with 7,763 passed, 162 skipped
  and three failures: two unchanged host boot-fixture startup cases and the
  artifact-ignore configuration-load deadline. The latter now has a documented
  60-second deadline with its assertions unchanged and passes in isolation.
  The complete boot suite passes separately (33 passed, one platform skip);
  both previously failing cases also passed 12 repetitions each. Their loaded-
  run startup failures remain unreproduced; no boot code or deadline changed.
  Final GitHub CI must pass before merge.

The earlier host-lock gate failure came from the starting checkout. Current
main already fixes Windows reuse of the synthetic dead PID; that fix is
included unchanged. The Codex process-isolation test now waits for the native
turn-completed notification after observing the separate reply notification.
It retains the original deadline and idle-state assertion.

Mixed Electron fixtures use host-qualified identities and explicitly expand
collapsed diff files. The layout test waits for its draft to be saved before
rearranging panes, retaining both preservation assertions. Its earlier
immediate-unsaved-draft failure was reproduced on the unchanged `13c6da89`
starting checkout. This removal changes no production draft behavior.
Historical screenshots generated by these tests were restored from main.
Only the selected evidence images and intentional design baselines remain.

Separate GPT-6.1 Sol standards and spec reviews found no remaining actionable
findings after integration. An earlier finding that Claude mutated retired
compaction state was fixed and covered by the legacy-alias regression.
Unrelated launch-video and Claude-label commits inherited from the starting
checkout are excluded from the PR; the original commits remain on a backup
branch and the launch-video working files remain under `.cache`.

No live provider account, macOS build or release was exercised. Final CI and merge evidence is recorded in the pull request.

After this verification, main at `3bc5efa1` merged cleanly. Its host connection
changes overlap only separate documentation hunks; the product removal and
design baseline changes are preserved. Typecheck, lint, notices, build and the
removal journey passed again on that integrated revision before publishing.

The initial PR revision `6756ec67` passed Windows CI with 7,810 tests passed and
159 skipped, and passed the Linux host/archive and real SSH checks
([run 37532940326](https://github.com/millZach/Sotto/actions/runs/37532940326)).
The iOS job was correctly skipped for the changed paths. The later privacy
correction is independently covered by 115 focused unit/renderer tests, fresh
typecheck, lint, notices and build, plus the artifact-ignore check. Eight removal
and answer-recovery Electron checks passed again. Four new Electron journeys
prove exact history-on startup retention, the actual Settings history toggle,
history-off startup redaction, and an invalid original preserved with a visible
notice while shared answer cleanup still completes. The notice is readable at
820x560, and the document has no overflow after native resize settles. Separate
GPT-6.1 Sol Standards and Spec reviews of this correction found no actionable
issues. Its full CI remains a merge requirement.

The existing recovery-toast copy was previewed at minimum size on local branch
`prototype/remove-chat-privacy-notice`, commit
`c0f7e2145963b52e167ee157c2e7a60ee8320752`. A later computer-use retry still
failed before reaching a window: the native kernel exited and the browser
runtime reported the same ACL error. The accepted verification fallback remains
Electron interaction tests and direct screenshot inspection.
