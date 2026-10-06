# Remove standalone Chats

## State

- [x] Three GPT-6.1 Sol agents mapped backend, UI and verification impacts.
- [x] Confirm that removal means standalone Chats, keeping project Threads.
- [x] Preview the existing desktop shell without Chats.
- [x] Remove chat-only UI, services, native adapter paths and bridges.
- [x] Preserve shared thread behavior and old on-disk data.
- [x] Update current documentation and the personal-chat decision.
- [x] Run relevant Electron journeys and inspect their rendered captures.
- [x] Review standards and scope separately; resolve findings.
- [x] Integrate current main and exclude unrelated inherited commits.
- [ ] Finish the full gates and refreshed design verification.
- [x] Agree the verified Electron tests and screenshots as the fallback with Zach.
- [ ] Open the PR, resolve feedback, and merge when all checks are green.

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

Confirmed retained-data policy: leave existing `personal-chat/` files and native
provider history untouched. No migration into Threads and no auto-resume.
Legacy personal request drafts must not stop thread draft recovery or cause
draft files to be replaced as corrupt. This is a feature removal, not a request
to erase historical user data.

## Verification scope

Run typecheck, lint, the two-worker test suite and notices verification. Build
and exercise shell navigation and request draft recovery in Electron. Verify
provider adapter contracts, client updates and shutdown after removing their
personal branches. Remove exclusively personal tests; retain the thread cases
from mixed suites. Current docs change; historical verification stays history.

## Delivery state

Zach subsequently requested computer use, a PR and merge after all checks
are green. Current main at `febe51a6` is integrated, including its host-lock
PID-reuse fix. The original `13c6da89` checkout contained unrelated launch-video
and Claude-label commits; those are excluded from the final product branch.
The originals remain on `backup/remove-chats-inherited-base`, and the video
working files are retained in `.cache/inherited-launch-video`.

- Typecheck, lint, notices and build pass.
- All 16 affected Electron journeys pass together on the integrated build.
- Separate GPT-6.1 Sol reviews find no remaining standards or scope issues.
- Design capture and verification each pass 10 journeys and 146 tuples.
- The full local two-worker run finished: 7,763 passed, 162 skipped, three failures in unchanged boot fixtures and the artifact-ignore setup deadline. Targeted diagnosis and final CI remain.
- Native and browser computer-use runtimes still fail at startup with
  `apply deny-read ACLs`, including after the permission change and reset.
  Native inspection is not claimed; Zach selected the verified Electron checks and screenshots as the fallback.
- The PR and merge remain pending. No release or installed-app update is part
  of this request.

The detailed evidence and test adaptations are recorded in
`docs/verification/remove-personal-chats.md`.
