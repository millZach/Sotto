# Tools sidebar removal and terminal recovery

Baseline: `6d970b2`, after PR #79. Request: remove the redundant collapsed right sidebar and fix the terminal startup failure shown in the user's screenshots.

## Result

- Closed Tools renders no sidebar and reserves no width. The header Tools button opens the existing panel.
- Opening, closing, selected surface, retained terminal output, file selection, and keyboard focus continue to work.
- The user's running development app can start PowerShell in the thread's project folder, execute commands, and resize. A working terminal is left open in the `test` thread after running `Get-Location`.

## Terminal cause and recovery

The public terminal API reproduced the screenshot's `unavailable` startup error. A temporary diagnostic at the existing error boundary exposed a bundled dynamic-require failure loading `conpty.node` from `node-pty`.

The old development process started September 13 at 00:04:52, before commit `28677a6` (September 13 at 19:49:31 -0700) externalized `node-pty`. It retained the previous Vite configuration across source rebuilds. Its output bundled `node-pty`; a fresh build correctly listed it as an external dependency. The native module could start a shell when loaded directly.

Restarting the development server with the current configuration restored the actual public terminal API. Verification executed a split-string marker command, read its output and the expected working directory, resized the PTY, and closed only the probe's terminal. The result was `{ok:true, marker:true, workingDirectory:true, resize:true}`. No production terminal-code or dependency changes were necessary. Temporary source diagnostics were removed.

## Verification

- 30 focused unit tests passed across terminal main, Tools panel, terminal surface, and terminal theme.
- TypeScript, ESLint, and production build passed.
- Native Electron Tools sidecar E2E passed (one comprehensive journey): real PTY input/output and file creation in an isolated fixture, browser bounds, Files/Changes, close/reopen, keyboard focus, reduced motion, three window sizes (1280x800, 1600x1000, 820x560), and dark/light themes. No collected renderer errors.
- In the user's running app, opened Threads → test → Tools → Terminal, started a new terminal, typed `Get-Location`, verified the returned project path, and closed/reopened Tools with output retained. The terminal remains open and ready.

## Visual acceptance

The supplied screenshots establish the desktop target and existing design. Header-only access was selected over another edge handle or menu because the user explicitly requested removal. Existing typography, colors, panel tabs, and motion remain intact; no replacement decoration or copy was added.

Root inspected collapsed normal/minimum-width dark captures, open normal/minimum-width dark captures, minimum-width light terminal, and the user's live light-theme window. The redundant rail and reserved strip are absent, Tools remains accessible, terminal output wraps within its panel, and controls remain usable. Representative fixture evidence is saved in [artifacts/tools-sidebar-terminal](../../artifacts/tools-sidebar-terminal/). The live screenshot stays in ignored scratch storage because it contains the user's conversation.

This verification covers the Windows development app and automated Electron fixture, not a new packaged release. No physical microphone test was repeated for this change.
