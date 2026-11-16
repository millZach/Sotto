# 3D models move into Settings

Checked on Linux (forge, under xvfb at 1920x1200) on November 16, 2026, in the built app, with the Owl feature turned on
by `SOTTO_OWL_FEATURES=plugins=1`. Zach asked for the cube at the sidebar's foot to go and for the 3D models viewer to
live in Settings. His picks on the question card, from the mock-up kept as the tag `prototype/models-in-settings`, were
variant A (a Settings page of its own, **3D models**, directly below Plugins, with the same viewer), Tools › 3D models and
the line in a thread left as they were, and an amendment to ADR-0141.

The run used a throwaway journey that was not committed. It made a profile with two 3D model records in
`3d-models.json`, an oak barrel and a brass lantern, and wrote each one's GLB, USDZ and still picture into `models/` in a
project folder. Then it started the app. No Meshy account was added, so the header counts no credits. Nothing reached
Meshy.

## What was seen

- The sidebar's foot lists Usage, Settings and Help, with no cube between Usage and Settings
  (`artifacts/models-in-settings/threads-foot-1280x800.png`).
- Settings' rail reads Dictation, Cleanup, Threads, Keyboard, Git & worktrees, Watcher, Providers, Plugins, **3D models**,
  Hosts & phones, Cloud iPhone, Appearance, Application, Performance.
- **3D models** shows the page as it was: the heading with "2 3D models from 1 thread", Search, the chosen one's view with
  its details beside it, and the filmstrip below. The Right arrow on the filmstrip chose the brass lantern.
- Find a setting: "meshy glb" and Enter opened the page with focus on its heading.
- At 1600x1000, 1280x800 and 820x560, dark and light, nothing on the page reached past the window. At 820x560 the details
  go under the view and the page scrolls (`settings-models-dark-820x560.png`). The other two captures are
  `settings-models-dark-1280x800.png` and `settings-models-light-1600x1000.png`.

## What this run could not show

- xvfb on forge has no WebGL, so the view shows "Sotto cannot draw 3D models on this computer, so this is the still
  picture." in place of the turning view. The view itself is unchanged from the old page and was checked on Windows for
  `meshy-3d-models.md`.
- Show in File Explorer is named "Show in file manager" on Linux. Go to thread was not offered, because the seeded
  records name a thread this profile does not have.
- `tests/e2e/plugins-meshy-page.spec.ts` now opens Settings › 3D models instead of pressing the cube. It runs on Windows
  only. On forge it stops before the page, because adding a Meshy account fails under xvfb without a credential store
  Sotto can use. CI loads it (`e2e:list`) but does not run it.
