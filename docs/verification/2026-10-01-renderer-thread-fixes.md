# Renderer thread fixes

Package pkg-35 covers #567, #568, #591 and #592. No visual design changed.

The chooser regression reproduced three create-thread commands from repeated choices before the guard. The rename regressions reproduced focus falling to the page after Enter and Escape in the sidebar and pane. The cache regression reproduced the first shell remaining cached after the final update and the two-second interval. These tests pass after the fixes. Privacy disclosure coverage checks the owner-directed retention wording, while cache tests confirm the actual excerpts and permission context remain until history is off.

The Windows Electron journeys in `thread-creation.spec.ts`, `workspace-projects.spec.ts` and `thread-workspace.spec.ts` passed all 12 cases. `thread-rename-focus.spec.ts` passed sidebar and pane Enter/Escape focus restoration in light and dark at 1600×1000, 1280×800 and 820×560 with reduced motion. Its first attempt missed the renderer reload after setup and timed out; adding that setup step resolved it. The single case covers six window/theme combinations and has a generous orchestration deadline.

The six generated focus captures were visually inspected: the restored focus ring is visible, the title and composer remain readable, and the minimum window does not clip its controls. Incidental captures were restored or removed as required by this package's brief; no design baseline was regenerated. Playwright retains focus screenshots under its ignored test results directory. A small throwaway interaction prototype also confirmed single creation and keyboard focus return; it is excluded from the implementation.

Separate standards and spec reviews found no blocking issues. The spec review requested coverage for keeping the user's chosen focus destination on blur; that regression now passes. Provider behavior was exercised through fixtures, without paid or live-provider turns.
