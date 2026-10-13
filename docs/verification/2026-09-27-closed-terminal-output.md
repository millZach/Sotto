# Closed terminal rows and output

Issue #384. Terminal mode keeps every Closed row until Sotto quits, while its 64-terminal limit counts only open terminals. Explicit Close releases main and renderer output; Stop, natural exit and hiding a pane preserve it. Reopen retains the row's identity, command and folder but starts with fresh output. No new control or styling was introduced.

## Structural checks

The desired baseline regressions failed because the listing schema rejected more than 64 total rows and two overlapping opens at 63 active both succeeded. After the repair, 26 focused terminal service, IPC/preload and renderer tests pass. The listing case crosses the actual registered IPC/preload schema with 70 Closed rows and 64 active terminals, checks metadata and empty Closed output, refuses Reopen at capacity, then reopens after one slot is freed. Separate held-spawn cases cover concurrent open and distinct Closed-row reopen at 63 active. Same-row restart ownership is tracked separately in #387.

Renderer checks cover a pending old read completing after Close/Reopen, late output for a Closed row, and preservation for Stop, natural exit and pane hiding. The retained-row count is intentionally uncapped; output is released only for explicit Close.

## Native Windows journey

`terminal-closed-output.spec.ts` passed on the built app: one test, 8.3 seconds, at `4204d1ad`. It opens a real ConPTY shell through the preload bridge, closes it through the sidebar, verifies empty main output and the disabled Closed row, then inspects light/dark at 1600 by 1000, 1280 by 800 and 820 by 560 with reduced motion. It hovers the row to reveal the existing Reopen action, verifies that its center receives pointer input, focuses it, and clicks it normally. The new shell keeps the same metadata and accepts a real keyboard command that prints `SOTTO_REOPEN_READY`.

- [Closed shelf in dark appearance](../../artifacts/review-384/closed-1600-dark.png).
- [Reopened shell after real keyboard input at minimum size](../../artifacts/review-384/reopened.png).

Both captures were visually inspected. An earlier test attempt clicked the hover-only action without first hovering its row; its interception failure was corrected in the test, with no product UI change or forced click. The final capture waits for the native response and a rendered frame rather than showing the new terminal before its prompt arrives.

The neighboring `terminal-loading.spec.ts` Tools journey passed. Its workspace journey fails before opening a terminal because it searches the host snapshot for raw ID `workshop`, while those IDs are scoped. The unchanged spec fails identically against the built #385 reference, whose relevant terminal and host-identity source is unchanged from `68f7974c`; that reference also contains the unrelated attachment fix. The scoped-ID correction belongs to #395. No loading assertion was weakened here.

## Gates and review

Typecheck, lint, notices (174 components), runtime preparation and build passed before integration. Main `dcd5db86` was integrated at `3b25bbcc`, preserving all terminal source and regression files; the only conflicts were additive artifact-ignore entries. The integrated focused suites pass all 26 tests; typecheck, lint and notices pass again.

The guarded two-worker full suite at `d1c80482` finished in 963.79 seconds: 5,844 passed, 140 skipped, one failure and one unhandled rejection. The unchanged SSH password fixture's initial `vi.waitFor` hit its separate one-second default before a prompt arrived, then cleanup cancelled the still-unobserved connection promise. Issue #422 records a held-real-child reproduction: the original predicate fails, but after release the real password notification and all authentication assertions complete. It does not claim the controlled scheduling is the precise timing of the historical run. This is not a green local full gate. Main `c5f57a7e` integrated at `1d84118a` afterward, preserving every terminal source and regression file; final integrated CI remains required.

Independent native GPT-6 Astra/high Standards review of `1802871a`, Spec review through `8a4b535a`, and root production review reported no findings. A further independent Standards review of `3b25bbcc` versus `1802871a` also found none, including the hover/focus/keyboard assertions. Root inspected the final reopened and minimum Closed screenshots with no findings. No paid provider, personal profile or design-baseline regeneration was used.
