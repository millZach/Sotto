# Copy code on the Teams tab

November 11, 2026. Local verification on Windows 11 of the fix for Zach's report that the copy button on the Teams tab does nothing.

## Cause

The Teams tab has one copy button: Copy code, under Link with a code in setup (and under Link another teammate once linked). It called `navigator.clipboard.writeText` from the window. The main window's permission policy (`src/main/app/bootstrap.ts`) allows the microphone and refuses everything else, the clipboard included, so the write was refused. The refusal was dropped, nothing reached the clipboard, and the button never said Copied.

Every other copy button goes through `writeClipboard` in `richActions.ts`, which asks main to copy. Copy code now does too. Nothing looks different.

## Checks

- `tests/unit/renderer/teamsCopyCode.test.tsx`: with the window's clipboard refusing, a press copies the code through main and says Copied; when main cannot copy, the button keeps saying Copy code. Both cases fail on the old code and pass with the fix.
- `tests/e2e/teams.spec.ts` on the built app on this laptop, with the real permission policy: after Make a code, Copy code says Copied and main's clipboard (the test build's stand-in for the desktop one) holds the code. On the old code the step fails waiting for Copied; with the fix the whole spec passes.

After a press on this branch, the button says Copied ([dark, 1280x800](../../artifacts/teams-copy-code/tab-code-copied-dark-1280x800.png)). On the old code it keeps saying Copy code.
