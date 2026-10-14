# Desktop thread recovery after an omitted broadcast

Verified on Windows from `ac9daca415de9ef7c0f736b122d2818dd7d28862`, built with
`npm run build`. The coordinator, persistence, IPC, isolated preload and page
renderers are real; provider effects and dictation input are the E2E fixtures.
This is an unpackaged app proof.

`window-thread-shell.spec.ts` launches an actual Owl-version entry, so the
startup `streaming-publish-cost` answer is enabled without a feature override.
It connects this computer, opens Workshop, saves a draft and receives an
assistant message. Selecting Docs produces a warm thread envelope with a
non-null base and no changed bodies. Returning to Workshop keeps the draft
and message. Reloading the renderer and reopening Threads restores both.
The message assertion checks rendered retained detail content, separately
from the benchmark's shell-only equality assertion.

The final batch passed **12 tests across seven files** in 54.0 seconds, with
native exit 0. The other six files used the unpackaged startup override
`streaming-publish-cost=1`:

- `agentControl.spec.ts`: folder creation, rejected prompts, lost
  acknowledgement without resubmission, pending approvals and explicit selection.
- `thread-sidebar-question.spec.ts`: questions and permissions stay on their
  thread until answered, including the minimum light window.
- `thread-composer-recovery.spec.ts`: composer focus and failed answers remain
  with their own thread.
- `remote-thread-opening.spec.ts`: a paired host's thread opens with its composer
  and no spurious error or permission banner.
- `thread-link-destination.spec.ts`: the chosen link destination survives restart.
- `widget-dictation.spec.ts`: dictation shows and hides the widget, delivers text,
  and starts and stops from the widget.

The reload journey captures dark and light Windows content sizes 1600x1000,
1280x800 and 820x560, with reduced motion at the minimum. All six final captures
were inspected. The assistant message, draft and composer controls remain
readable; the main region has no horizontal overflow. The header uses its
existing ellipsis at the minimum. No layout, theme or design baseline changed.
Only the two captures cited here are retained in this change:

[Owl dark after reload, 1280x800](../../artifacts/window-thread-shell/owl-dark-1280.png)

[Owl light after reload, 820x560 with reduced motion](../../artifacts/window-thread-shell/owl-light-820.png)

The focused page tests also cover failed reads, unsubscribe, command rejection,
non-publishing successful worktree previews, receipt catalog recovery and newer
broadcasts in both completion orders. Their 55 cases across the three focused
renderer files passed. Independent Standards and Spec reviews cleared the
source after the recovery findings were fixed. The final Spec reviewer exercised
16 additional ordering cases against the pinned production modules.

[ADR-0028](../adr/0028-agent-state-broadcast-omits-an-unchanged-catalog.md) records
the transport and ownership rules. The [performance note](../perf/2026-10-13-window-thread-shell.md)
reports the actual Electron coordinator measurement: six-stream improvement,
mixed lower stream counts and the additional cold/full cost. This journey
verifies behavior and rendered content; it measures no paint or frame budget.

Raw native logs and exit records are retained outside the disposable worktree
under `.zstack/perf-991-remaining/`, including `step4-build-settlement-head`,
`step4-app-final-journeys` and `step4-settlement-final-neighbors`.
