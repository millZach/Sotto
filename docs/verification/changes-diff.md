# Changes as T3's diff (#268)

Proved in the built app on September 23, 2026, on Windows, with `tests/e2e/tools-sidecar.spec.ts`. The images named here are in `artifacts/changes-diff/`; the whole run writes to `artifacts/tools-rail-run/`, which is not committed.

## What the run shows

- **Every Git scope through the Tools matrix.** The first test walks Working tree and Branch changes at 1600x1000, 1280x800 and 820x560, at the normal, minimum and wide panel widths, dark and light, with the file tree open. Each capture checks that nothing scrolls sideways, the line of chrome stays one line under 46 pixels, no control on the chrome, the bar or a file's head is clipped, the tree sits beside the files when the panel's body is 640 pixels or wider and above them otherwise, and every text on the chrome, Changes' scope, counts, base and file names included, reads at 4.5:1 on what it sits on. `changes-working-1600x1000-wide-dark.png`, `changes-branch-1280x800-normal-light.png`, `changes-working-820x560-minimum-dark.png`.
- **Branch changes** uses the automatic base (`main` in the fixture) and shows only what the feature branch committed, not the uncommitted work.
- **Turns from checkpoints.** The second test sends three turns to a fixture Codex thread, editing files during each; the first also stages a file, so its checkpoint is unavailable. The scope menu lists Latest turn, Turn 3, Turn 2 and Turn 1 (unavailable). Working tree, Branch changes, Latest turn, Turn 2 and the unavailable Turn 1 are each captured at the three window sizes in both appearances with the same overflow and clipping checks. `changes-scope-latest-turn-1280x800-dark.png`, `changes-scope-turn-1-unavailable-820x560-light.png`.
- **Split view** lines up both sides of `src/app.ts`. `changes-split-1280-dark.png`.
- **The shortcut.** Ctrl+D with Changes showing closes Tools and returns focus to the Tools toggle; Ctrl+D again opens Tools on Changes with focus on its rail tab.
- **Reduced motion.** Nothing on the Changes surface keeps moving with reduced motion on.

## What I worked out

In a panel narrower than 560 pixels the line of chrome has no room beside the window's own controls for the comparison's `+adds −dels`, so they move to the head of the view bar; the spec checks that exactly one copy shows for every scope at every size. The design capture matrix (`npm run design:verify`) has no Changes tuple, so no baseline there changed; its one failure, `settings-application-privacy.png`, reproduces on the base commit `820b4864` and is not from this work.
