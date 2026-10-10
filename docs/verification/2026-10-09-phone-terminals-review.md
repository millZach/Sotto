# Phone terminal review

Two independent Codex CLI reviewers used Sol (`gpt-6.1-sol`) at max reasoning with a read-only workspace. They reviewed `d3cf86b0eb5c768bcd63566079fbb9d30b19d2d1...02a1165dc`, the two implementation commits for issue #884. Windows shell sandbox setup failed inside both reviewers; they completed the reads through the available Node tool instead. Both reviews completed successfully. Corrections below were applied after that fixed review point.

## Standards

Three documented-standard findings:

- **P1: A question screen could review an outstanding tool permission.** ADR-0066 keeps structured questions in the native CLI. Screen evidence now distinguishes permissions from questions; only permission evidence yields an answerable preview. The real socket regression changes a live permission to question chrome and verifies no preview, no answer binding and no hook dispatch.
- **P2: Changed screens left stale previews enabled.** CONTEXT requires preview withdrawal on changed words or incomplete redraw. Rows now carry only an opaque current preview fingerprint. Changes or withdrawal publish metadata, clear the iPhone cache and trigger a new review; no screen text enters a push. Protocol and native model regressions cover this path.
- **P2: A withheld binding could discard an unacknowledged answer.** ADR-0033 requires receipt reconciliation. Commit `62b5112cd` preserves the marker while a terminal still Needs you without a binding; only a confirming hook receipt or positive departure evidence clears it. The native regression scripts pending then confirmed receipts and verifies exactly one send.

One heuristic, **possible Duplicated Code**, remains: the thread and terminal answer paths repeat generation checks, refusals and receipt following. Their domain commands and result types differ. A shared transport refactor would change asynchronous receipt ownership across both paths, so it is deferred to a macOS-verified change rather than expand this uncompiled Swift patch. This is a judgement call, not a documented-standard breach.

Native verification remains incomplete: Windows cannot compile Swift, execute XCTest or produce simulator evidence. Electron and HTML captures do not satisfy the native verification requirement.

## Spec

Three findings:

- **P2: Starting agents appeared in Recent.** Approved variant B puts Starting under Working. The iPhone now shares a work-in-progress classification for Starting and Working in placement and counts, with model and simulator checks written for it.
- **P2: Reconnecting could discard an unacknowledged answer.** The reviewer reproduced the same receipt issue as Standards and observed its correction in `62b5112cd` while the review ran.
- **P3: The guide said terminals were outside the iPhone app.** The old sentence now limits terminal input, file contents and voice; terminal rows and approval cards have their own instructions. Desktop unread and answer wording was also updated for paired phones.

The issue's simulator screenshots and green macOS compile/test job remain follow-ups. Android was left untouched under the lead's explicit no-JDK exception.

## Follow-up review

Two further independent Sol (`gpt-6.1-sol`) reviewers at max reasoning reviewed `02a1165dc...d05deeff181935223252c250407a6115ab91abc0`, including the review corrections and exact file-identity fix. Both completed read-only after the same Windows shell setup failure, using Node to read the pinned Git objects. Neither ran builds or tests.

**Standards:** one documented P1 finding remained: a Yes/No structured question titled “Do you want to proceed?” matched the permission branch before the question branch. The question footer's “esc to cancel” made it look like permission evidence. Commit `e2ffe8ea2` recognizes questions first and excludes question footers from permission evidence, including incomplete question choices. The exact reproducer failed three assertions before the fix; all 132 focused screen and phone cases passed afterwards. A new possible duplication heuristic identified the same restoration decision in the terminal detail and list. Commit `a6806472f` moves it into `AppModel.shouldRestoreTerminalApproval`, preserving copy, timing and receipt handling; a native rejection/redraw test is written but unrun here.

**Spec:** the same P1 overlap was the only actionable finding. The reviewer confirmed the bigint helper preserves exact identities through its callers. The question correction now prevents both a preview and hook dispatch against that screen.

Standards: four documented findings corrected across both passes, one new UI heuristic corrected, one transport heuristic deferred, native verification pending. Spec: four findings corrected across both passes, native verification pending. The exact executed Windows gate results are in [the verification note](2026-10-09-phone-terminals.md).

## Finishing review

The supplied final review found delayed thread selection after terminal withdrawal (Standards), busy terminal operations refusing visibility withdrawal (Spec), and missing native evidence (Spec and Design). Commits `f1446a4ae` and `0bf0d9642` move local selection before network cleanup, guard canceled or superseded navigation, apply visibility outside the eight-operation terminal limit, and retry failures against current selection and connection generation. The saturated-withdrawal socket regression failed before the fix and passed afterwards. Commit `e8969f10c` corrects the design pass's empty-list copy for computers without terminal support, using the approved variant B layout. Commit `83c555829` enables the existing gates and native simulator job for the stacked pull request's `feat/terminal-agent-states` base; the previous main-only filter would have skipped that PR.

Two independent read-only Sol (`gpt-6.1-sol`) reviewers at max reasoning then reviewed `d3cf86b0e...d3f393b9d`. Both completed through their Node tool after the Windows shell sandbox helper failed. They ran no gates. Standards found that overlapping hooks could leave the surviving request bound to another permission's screen. Commit `ea399c165` withholds previews for every overlapping request until it closes, including after a redraw, then allows a later unambiguous request. Its exact socket regression failed before and passed after the correction. Spec found that many approval cards could burst beyond the host's 32 outstanding-operation limit. Commit `2c864d4d5` queues preview reads at two per connection generation and adds a forty-card held-reply native regression. The native regression awaits macOS execution.

Standards repeated the transport duplication heuristic already recorded above. It is deferred: thread and terminal answers have different target bindings and acceptance receipts, and changing shared asynchronous receipt ownership would expand this correctness patch. This is a judgment call, not a standard breach. The design suggestions to show request/work timestamps and offer native choices remain outside the available protocol and ADR-0066: `openedAt` records creation alone, and persistent choices belong in the computer's native CLI. Android remains the issue's permitted follow-up. These decisions must be named in the pull request.

Native verification is still pending. Both independent read-only Sol reviewers completed the focused follow-up of `d3f393b9d...ea399c165` at max reasoning. Standards reported no new documented breach or smell. Spec reported no new actionable finding or scope creep. Both confirmed the preview queue is connection-generation scoped and rejects obsolete work, and that overlap taint survives closure and redraw while a later unambiguous request can recover. Neither executed a gate. The final full suite and native evidence are recorded in the verification note.

The rebuilt approval journey then exposed delayed submission metadata invalidating a current permission screen. A failing in-memory trace showed one live hook, a reliable permission screen and freshness incorrectly withdrawn. Two ordering regressions failed before commit `6f59b2866`; the corrected reducer binds that locally submitted turn while preserving its current screen. A permission hook binds its own turn, and a different submitted turn still invalidates the preview. The original uninstrumented built journey passed after the correction. Both Sol reviewers independently found that this turn binding could hide a second live hook from the overlap guard. Commit `3499423c7` records every live blocking hook independently of state turn admission and taints the complete live set. Both distinct-turn socket regressions failed before and passed after that change, including refused stale answers and recovery on a fresh request. All 139 focused state and phone protocol cases passed. Temporary probes were removed.

Commit `66492cf2c` checks actual terminal text pixels in the same full-page PNG it retains. The earlier metadata-only capture could save a blank GPU frame even after the phone protocol was ready. The retained corrected capture was opened and visually inspected. A final narrow two-axis review of `6f59b2866...66492cf2c` precedes the completed full suite.

Both final read-only Sol reviewers completed that pinned review at max reasoning. Standards reported no new documented-standard breach or actionable baseline smell. Spec reported no new actionable issue. Both confirmed the complete live-hook map closes the turn-admission bypass, overlap taint survives closure and redraw, and the capture retains the same PNG it validates. Neither ran a gate; native CI and simulator evidence remain pending.
