# Watcher permission modes, own changes and standing watches

October 14, 2026. Branch `feat/watcher-permission-watch`, from `b34e1d48be9e3495461fd35c847485e8906b520f`. This is the shared/main/host/phone-wire lane of Zach's October 13 brief. The approved prototype chose control A, own-change mark B and watch B. Desktop and SwiftUI view work belongs to separate lanes.

Status: the specified Windows development checks passed on source commit `0b1ec2fbba3ead07568a2ae56342cc525c5bd6b4`. The separate UI work and platform/release surfaces listed below are not verified by this lane.

## Implementation checks

Watcher uses each provider's ordinary advertised permission modes and native mappings, with widening and narrowing admitted by user controls. Codex and Claude offer four; Grok retains its ordinary three. Main remembers Watcher's mode separately, starts the first at approval-required and refuses native session/always grants. Phone settings carry an authenticated connection guard through the coordinator and each provider's native writer. The obsolete forced read-only Codex policy, Windows override and probe were removed.

Own-change detection uses successful normalized provider file-change activities with their turn/message anchors. It does not attribute a shared checkout's aggregate diff to Watcher. Successful edits accumulate as history-owned user-message metadata while a turn runs, then attach distinct paths/count and the exact reason line to its final assistant reply. Missing or ambiguous reason lines yield null (**It gave no reason**). Detector and history checks cover both history rails, a turn with over 2,000 later activities, restart before its first reply, native refresh, completed reply retention and history-off disk privacy. An exact Watcher-only Claude user anchor preserves edits before and after a folded steer; retained later-turn anchors keep replies separate after lifecycle activity eviction. Shell commands without provider file-change evidence do not supply a file list.

Standing watches are durable owning-host targets independent of request closure. Watching sends no prompt and has no watched-thread count cap; starts retain the in-flight cap. Wake-up news offers a watch identity, resolved into a fresh bounded per-Watcher-turn continuation scope. Four prompts remain the limit per target/turn and retries/stopped scopes keep their fences. User desktop, native and phone turns keep the watch and block now/queue/steer until they finish. Stop watching ends news and cancels queued automation while keeping the user's work.

Paired hosts acknowledge watches before local standing authority appears. The owner records head/generation/pause, withdrawal fences and a latest master-creation frontier including empty synchronization. Local and remote withdrawal fences cover all automatic actions, including delayed original-request Stop/settle packets, while a separately confirmed human Stop remains valid. Delayed old scopes cannot reinstall withdrawn assignments. Older hosts retain their active-request operations but receive no durable watch label and refuse explicit standing-watch requests. The phone negotiates watcher-phone-manage separately; permission widening requires Can answer at admission and again at the native writer. Exact request-ID retries return the earlier mutation outcome with fresh state and cannot undo a later choice. Unwatch removes the thread from Watcher's phone needs-you list, preserving its ordinary request card.

## Required gates

These ran sequentially in the brief's order, with source frozen at `0b1ec2fbb`. About 9.05 GiB of free RAM was available before the two-worker full suite. Every command exited zero. The source build still uses manifest version 0.1.37; no release was cut.

| Order | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` | Four TypeScript projects passed. |
| 2 | `npm run lint` | Passed. |
| 3 | `npm test -- --maxWorkers=2` | 823 files passed, 68 skipped; 10,497 tests passed, 321 skipped; 1,443.45 seconds. |
| 4 | `npm run notices:verify` | 189 components verified. |
| 5 | `npm run build` | Electron main, preload and renderer built. |
| 6 | `npm run test:socket` | 23 files passed; 492 tests passed, 10 skipped; 181.85 seconds. |
| 7 | `npm run build:host` | Plain Node host built, 216 modules. |
| 8 | `npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/watcher.spec.ts` | 17 journeys passed with one worker, 1.1 minutes. |

Earlier full runs were superseded by review corrections. The last paired-host failure was reproduced with a held admission lane: a read pruned the unrecorded operation's connection guard. Rebinding the authenticated guard in mutation admission fixed that race, with a regression asserting exactly one accepted prompt. An earlier SSH withdrawal/sign-in failure was not reproduced in five isolated retries; SSH code was unchanged. Its scenario passed in both the final full suite and the required socket suite. No deadline was shortened.

Focused closing checks also passed 75 standing/native/paired tests and 46 own-change/scripted-Claude-steer tests. The final required full suite includes these regressions. Logs remain in the worktree's ignored `.zstack/watcher/gate-*.log`; [checks.json](../../artifacts/watcher-permission-watch/checks.json) retains source, commands, counts and capture hashes.

## Independent review

Separate read-only Codex CLI reviewers used Sol (`gpt-6.1-sol`) at max reasoning. Standards found seven hard findings across the initial and correction rounds: shared prompt accounting, human Queue provenance, obsolete guide wording, retained legacy charges, failed-Send renewal, withdrawn automatic Stop and durable reply boundaries. All were corrected; correctness defects have reproducing regressions. Four optional refactoring suggestions remain deferred: standing-scope construction, metadata-preservation duplication, origin schema extraction and the Codex runtime-policy wrapper. The repeated Claude anchor lookup was simplified.

Spec found five original correctness defects: phone authority, late original/legacy delivery, background attribution, incompatible remembered mode recovery and news after settlement. The follow-up admission-lane race was also corrected. The final correction reviews pinned to `0b1ec2fbb` report zero remaining Standards violations and zero Spec findings in `25a1d686d...0b1ec2fbb`. Their memory-only probes cover fresh watch scopes, withdrawal, private guard rebinding/disconnection, takeover refusals and retained reply boundaries. The full ordered gate evidence was pending when they completed; it belongs to root's checks below.

## Surface limits

The built Electron app was exercised in disposable synthetic profiles. The actual-main journey began with the UI's first Send, created Watcher, and received the fake provider's reply through the real Codex adapter. It then checked permission widening/narrowing and watch-without-send/unwatch through the real preload/main bridge. Other room journeys use the existing seeded room stand-in. The specs check keyboard order, focus containment/return, Escape, saved drafts, disconnected/empty states, reduced motion, and bounds at 1600x1000, 1280x800 and 820x560 in light/dark Sotto and Tropic themes.

Root opened and inspected these three curated captures. Native display scaling is 1.5: filenames name the CSS viewport, while PNG pixels are 1920x1200 or 1230x840. The main room fits with readable messages and controls; stable hides Watcher and its saved history; Owl preserves its saved history and navigation. Long ordinary titles truncate deliberately at the minimum, with no visible overflow.

| Capture | Provenance |
| --- | --- |
| [Main room, dark, 1280x800](../../artifacts/watcher-permission-watch/room-main-sotto-dark-1280x800.png) | Actual preload/main over the fake Codex server, after mode/watch checks. |
| [Stable, dark, 820x560](../../artifacts/watcher-permission-watch/stable-dark-820x560.png) | Built release-gate journey, reduced motion on. |
| [Owl, light, 820x560](../../artifacts/watcher-permission-watch/owl-light-820x560.png) | Built release-gate journey, reduced motion on. |

The main capture still shows the existing routing tag, static locked permission label and watched-count meter. The separate routing-tag and UI lanes own their replacements. This lane preserves that tag and makes no renderer or SwiftUI view edits; it does not claim to verify the new controls or own-change badge.

SottoCore decoders, optional fields, management operation builders and receipt models were written with XCTest coverage. Swift compilation/XCTest and physical iPhone/macOS behavior are not verified on this Windows machine; CI is the lead's later gate. Android keeps unknown-field tolerance and adds decoding coverage; no Android build or device journey is claimed here. Linux desktop behavior, Sotto live-provider suites, external paired hosts, installed releases and packaged apps were not checked. No push or pull request is made by this lane.
