# Remove standalone Chats

October 9, 2026: Voice control and thread management described below are historical under [ADR-0066](../adr/0066-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

## State

- [x] Three GPT-6.1 Sol agents mapped backend, UI and verification impacts.
- [x] Confirm that removal means standalone Chats, keeping project Threads.
- [x] Preview the existing desktop shell without Chats.
- [x] Remove chat-only UI, services, native adapter paths and bridges.
- [x] Preserve shared thread behavior and honor local-history retention for old data.
- [x] Update current documentation and the personal-chat decision.
- [x] Run relevant Electron journeys and inspect their rendered captures.
- [x] Review standards and scope separately; resolve findings.
- [x] Integrate current main and exclude unrelated inherited commits.
- [x] Finish the initial CI gates and refreshed design verification.
- [x] Agree the verified Electron tests and screenshots as the fallback with Zach.
- [x] Open PR #795 and address the retained-history privacy finding.
- [x] Verify the privacy correction locally and review it independently.
- [ ] Merge when the updated PR checks are green.

## Acceptance checks

On October 6, 2026, Zach selected standalone Chats removal, keeping project
Threads and existing saved chat files. The local prototype branch
`prototype/remove-personal-chats` at `538e2c0e8e5c4740ddc5e7a8d63094b730804ce9`
holds the before/after shell in `docs/prototypes/remove-personal-chats.html`.
Open that file directly. The chosen direction removes the entry without
restyling the app; structurally different layouts would exceed that scope.

The proposed desktop UI keeps Sotto's current Figtree typography, theme tokens,
sidebar, Threads/Terminal controls, Dictate switch and window controls. Only the
Chats entry and page disappear; settings keep the reasoning controls used by
the coordinator and thread defaults. No replacement surface, restyle or new
motion is needed. Inspect dark, light and reduced motion at 1600x1000, 1280x800
and 820x560, including collapsed navigation and keyboard access to remaining
pages. Existing page content is the reference, so no new headline, supporting
copy, illustration or marketing composition is applicable.

Remove personal voice and Generate prompt with their owning feature. Preserve
Threads' provider connections, requests and approvals, saved request drafts,
skills, browser tools, images, dictation, memory gates and coordinator gates.
Remove personal provider auto-connections. Do not remove OpenRouter reasoning
or native side calls that other features use.

Confirmed retained-data policy: preserve existing chats while Keep local history
is on. After review found that retiring the service also removed its privacy
cleanup, Zach explicitly selected honoring the existing history setting. When
off, startup and Settings saves redact old transcripts and submitted answers;
unsent drafts and delivery identities remain. Invalid originals remain intact
with a visible failure notice. Native provider history stays untouched. There
is no migration into Threads or auto-resume. Legacy personal request drafts
must not interfere with thread draft recovery.

The failure notice reuses the existing recovery toast. Its minimum-size preview
is archived on `prototype/remove-chat-privacy-notice` at
`17a75ce3eb009680b9c268be55f7d938060d52ca`, in the same prototype HTML path.
The preview confirms the copy fits without proposing a new surface.

## Verification scope

Run typecheck, lint, the two-worker test suite and notices verification. Build
and exercise shell navigation and request draft recovery in Electron. Verify
provider adapter contracts, client updates and shutdown after removing their
personal branches. Remove exclusively personal tests; retain the thread cases
from mixed suites. Current docs change; historical verification stays history.

## Delivery state

Zach subsequently requested computer use, a PR and merge after all checks
are green. Current main through `6607fec5` is integrated, including its host-lock
PID-reuse fix, Thinking rows and read-before-send changes. The original `13c6da89` checkout contained unrelated launch-video
and Claude-label commits; those are excluded from the final product branch.
The originals remain on `backup/remove-chats-inherited-base`, and the video
working files are retained in `.cache/inherited-launch-video`.

- Typecheck, lint, notices and build pass.
- All 16 affected Electron journeys pass together on the integrated build.
- Separate GPT-6.1 Sol reviews find no remaining standards or scope issues.
- Design capture and verification each pass 10 journeys and 146 tuples.
- The full local two-worker run finished: 7,763 passed, 162 skipped, three failures in unchanged boot fixtures and the artifact-ignore setup deadline. The artifact deadline fix passes; 57 boot checks pass without reproducing the original failures. Initial PR CI passed with 7,810 Windows tests and the Linux host checks. The privacy correction requires fresh CI before merge.
- Final privacy correction: 120 focused unit/renderer tests, the artifact-ignore check, all five new privacy Electron journeys and eight removal/recovery neighbors pass. Typecheck, lint, notices and build pass. The failure notice fits at minimum size.
- Revision `12294d69` passed Windows CI with 7,833 tests and the Linux host/SSH checks. Main advanced during the merge attempt; four adapter/test conflicts were resolved to preserve the incoming thread behavior and Chats retirement. The combined revision requires fresh CI before merge.
- Native and browser computer-use runtimes still fail at startup with
  `apply deny-read ACLs`, including after the permission change and reset.
  A later retry again failed before reaching a window: the native kernel exited
  and the browser runtime reported the same ACL error. Native inspection is not
  claimed; Zach selected the verified Electron checks and screenshots as the fallback.
- [PR #795](https://github.com/millZach/Sotto/pull/795) is open. Merge remains pending. No release or installed-app update is part
  of this request.

The detailed evidence and test adaptations are recorded in
`docs/verification/remove-personal-chats.md`.
