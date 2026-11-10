# Sign in on this computer, in the running app

November 10, 2026, on forge (Linux), from `feat/sign-in-on-this-computer`. The built app (`npm run build`, `out/main/index.js`) was started outside test mode with a private, empty home folder under Xvfb, so the real clients on forge were found and none was signed in. Nothing was signed in and no sign-in page was opened.

## What was run

1. First-run setup was skipped through, and Settings › Providers opened.
2. The page was captured at 1280x800, dark and light, and at the 820x560 minimum.
3. **Sign in** was pressed on Claude Code's row. The dialog opened as "Sign in to Claude Code on This computer", ran Claude Code's own `claude auth login --claudeai`, and reached **Open sign-in page**. **Cancel** closed it; focus went back to Claude Code's row, and the row was checked again.
4. Claude Code's row was opened: the client's own sentence is under **Local connection**.

## What it showed

| Provider | Row said | Row offered |
| --- | --- | --- |
| Codex | Needs attention, with "Codex disconnected before acknowledgement." under the row | nothing new |
| Claude Code 2.1.322 | Not signed in | Sign in |
| Grok Build 1.0.77 | Not signed in | Sign in |
| Devin 3000.11.3 | Too old to use | Install guide |
| Muse | Needs attention, with its sentence under the row | nothing new |
| OpenCode 1.19.3 | Too old to use | Install guide |

Nothing was wider than the window at 820x560.

- `artifacts/sign-in-on-this-computer/providers-1280x800.png`, `providers-1280x800-light.png`: the page.
- `artifacts/sign-in-on-this-computer/providers-820x560.png`: the page at the minimum window.
- `artifacts/sign-in-on-this-computer/sign-in-dialog.png`: the dialog on Claude Code, waiting.

## Not checked here

- A sign-in carried through to Connected against a real account. The fake clients in `tests/integration/localProviderSignIn.test.ts` carry Codex, Claude Code and Grok Build through.
- Codex's row when it is signed out in a home folder of its own. In the empty home Codex reported no problem Sotto has a word for, so it read Needs attention and offered no Sign in.
- Windows and macOS.
