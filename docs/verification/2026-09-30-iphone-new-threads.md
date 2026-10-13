# Create a thread from iPhone

September 30, 2026. Source branch `feat/iphone-new-threads`, based on `77d24f8d`.

Zach chose the guided prototype B, then asked to browse a folder not already active in Sotto. The native flow chooses a computer, a known project or an existing folder on it, then that computer’s model, effort and permissions. It opens a manual thread in the shared project folder. Work starts on the computer when the user sends the first message.

The fixture prototype is archived separately on `prototype/iphone-new-thread` (`f63aec91`). Browser inspection covered the chosen computer, another folder, options, and opening the empty conversation; the earlier variants were inspected in dark and light and at 375 points wide. This is design evidence, not native or remote execution evidence.

## Checks

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- --maxWorkers=2`: 480 files passed, 39 skipped; 6,364 tests passed, 153 skipped.
- Windows CI at `0be9d2aa`: all gates passed; 482 files passed, 39 skipped; 6,401 tests passed, 150 skipped. Linux socket/archive checks also passed.
- `npm run notices:verify`: passed, 174 components.
- `git diff --check`: passed.
- After review fixes: `workspaceControl.test.ts` passed all 9 tests; the built Electron project/thread journey passed.
- Swift package tests and the unsigned simulator build passed at `0be9d2aa`: 95 tests, 1 skipped, no failures. There is no local Swift/Xcode on this Windows machine; the configured Forge SSH host is Linux and has neither tool.
- [CI at `0be9d2aa`](https://github.com/millZach/Sotto/actions/runs/36775288168): Windows, Linux and macOS all passed. Native UI: 5 journeys passed on each of iPhone SE (3rd generation) and iPhone 16 Pro Max, iOS 26.5; no failures or skips.

## Native journeys inspected

- [x] Existing project on both phones: offline computer disabled, selected computer/project preserved, open thread to its conversation.
- [x] New project folder on both phones: browse and filter on the chosen computer, dismiss the keyboard with Done, use an existing folder, select options and open the conversation.
- [x] Both small and large simulator displays; dark and light; larger text. The script confirmed accessibility-large on the large phone and enabled reduced motion before boot. No new custom animation was introduced; static captures do not independently prove animation behavior.
- [x] Model and command tests for host routing and the first message, unsupported choices, permission refusal, missing folder, unknown registration, lost acknowledgement, restart and backgrounding.

At `898b5e58`, the small-device folder journey failed after filtering with the keyboard open. Its capture and accessibility hierarchy showed the test's drag starting below the scroll content, on the keyboard/pinned action area. The folder filter now has a Done key that clears focus, and the native journey uses it before choosing the matching folder. The rerun at `0be9d2aa` passed on both phones. It also checks host-declared path separators when matching existing projects, preserving case for POSIX folder names containing a colon.

The native captures use debug-only, in-memory computer data. Primary inspection and a separate visual critic found no material layout issues at either size. The options explanation continues below the viewport in a ScrollView; its primary action remains pinned. The fixture leaves existing reply actions disabled, so its empty conversation is evidence of navigation, not provider delivery. The real AppModel's scripted first-message test verifies the exact computer/thread/draft delivery separately.

Selected captures, all from that successful run:

- [Small phone, computer choice and offline state](../../artifacts/iphone-new-threads/small-computers-dark.png).
- [Small phone, model/effort/permissions](../../artifacts/iphone-new-threads/small-options-dark.png).
- [Small phone, matching folder after Done](../../artifacts/iphone-new-threads/small-folders-filtered-light.png).
- [Large phone, selected existing folder](../../artifacts/iphone-new-threads/large-folders-selected-light.png).
- [Large phone, new-project options](../../artifacts/iphone-new-threads/large-options-light.png).
- [Large phone, opened conversation](../../artifacts/iphone-new-threads/large-conversation-dark.png).

No live paired iPhone/PC execution or TestFlight delivery has been claimed. The host protocol and desktop layout are unchanged. The coordinator now refuses an existing-folder registration when the folder has disappeared, rather than recreating it; its regression test passes. The built Add project journey also passed, checking neighboring desktop behavior.

## Standards

Reviewed independently by gpt-6.1-sol at high reasoning using the exact diff and numbered source packet after the read-only CLI hit a Windows ACL process failure. Two findings:

- Command errors lost the computer’s explanation. Fixed by retaining it in creation feedback alongside any uncertainty message; a scripted registration-error test covers it.
- Possible incorrect UNC matching. Not applicable to this flow: `src/main/agents/hostFolders.ts` rejects UNC/device paths before listing them, and the phone revalidates a browsed folder before matching it. No network-share support was added.

## Spec

Reviewed independently by gpt-6.1-sol at high reasoning against the plan and Zach’s original request and choice B. Two findings:

- First-message fixture lacked the provider delivery confirmation. Fixed: the fixture now records the exact accepted thread/draft delivery separately from the completed command receipt.
- A folder deleted after browsing could be recreated during registration. Fixed in the host’s existing-folder path, with a real filesystem integration check that the missing folder remains absent and no provider command runs.

Original review: Standards 2 findings (1 fixed, 1 dismissed with source evidence); Spec 2 findings (both fixed). No unresolved review finding remains. The native checks above are separate evidence.

The new surfaces use the existing native theme roles. Measured contrast from the asset catalog (light/dark): Ink on Canvas 15.66/19.51, Muted on Canvas 5.64/8.21, Muted on Surface 5.84/7.98, Accent on Canvas 4.70/8.44, Warning on Canvas 4.92/11.83, and ActionInk on Action 4.87/8.02. Folder-field placeholders now use Muted explicitly, as the existing Threads search does.
