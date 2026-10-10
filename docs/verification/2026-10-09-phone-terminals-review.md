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

Standards: three documented findings corrected, one heuristic deferred, native verification pending. Spec: three findings corrected, native verification pending. The exact executed Windows gate results are in [the verification note](2026-10-09-phone-terminals.md).
