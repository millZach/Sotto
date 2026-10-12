# Codex terminal completion (#950)

Verified on forge, Omarchy, October 12, 2026, with installed `codex-cli 0.162.1` and GPT-6-Luna at low effort. Both the built desktop app and a separately packaged Linux app returned from Working to Idle after the synthetic prompt “Say hi” and reply “Hi!”. The pane no longer showed the Codex compatibility warning. No state, copy or layout was added.

## Cause

Codex terminal state comes from the run-only notify helper and the live screen, not the app-server thread adapter. Notify supplies completion and provider identity; screen rules establish current work, readiness and requests. This follows ADR-0066 and the distinction in [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

Two screen compatibility gaps combined here. Sotto admitted only Codex 0.162.0, so installed 0.162.1 was rejected. Its ready-screen rule also required the last row to end at “? for shortcuts” or the context percentage. The actual CLI can show the default model/effort/folder footer instead, or put `⚠ 1 warning · f2 to view` beside the shortcuts hint. The nested GUI reproduced a completed reply remaining Working when that combined footer was not recognised. Known work cannot end merely through silence, and a Codex callback during a current work frame cannot independently establish readiness.

This is not specific to Linux. Windows and Linux use the same version table, screen rules and state reducer; the Windows notify launcher only differs in argument quoting. Regression cases cover the default footer with both POSIX and Windows folder paths. Windows live CLI compatibility and the Windows-only terminal Playwright journey were not exercised on forge. CI runs the shared state regressions on Windows.

The fix admits the two exact checked versions, 0.162.0 and 0.162.1, and recognises the observed ready footers. The Bug Bot review caught bare home and root folders missing from the model-footer rule; the independent Spec review then caught the same folders with a terminal-title suffix. The folder grammar now covers `~`, `/`, `C:\` and `C:/`, with or without a title. Unchecked versions remain on the existing output-activity fallback. Native working chrome still outranks readiness. Drafts, fenced or quoted examples and permission screens do not become idle evidence. Hooks still grant no authority and no settings outside the disposable profile are changed.

## Real desktop journey

`scripts/verify-codex-terminal-state.mjs` is the repeatable lever. It runs only under the owned nested Hyprland wrapper. It creates an isolated HOME, CODEX_HOME and profile inside this worktree's `.cache/`, makes the disposable HOME the scratch Git project so Codex displays `~`, copies sign-in into that private profile, and deletes it after the run. It connects the production Codex adapter for the model catalogue, then drives Terminal mode's New terminal dialog, selects GPT-6-Luna and low effort, and types into the real native terminal. It sends one synthetic model turn per invocation. It asserts Idle → Working → Idle, available detection, the absence of Working rows and the absence of Sotto's version warning. Working captures wait for native work and the rendered sidebar row; completion captures wait for the actual reply as well as Idle. The packaged run also compares its bundled main hash with the built main before launch.

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/codex-terminal-state/nested node scripts/verify-codex-terminal-state.mjs
mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/codex-terminal-state/nested-packaged node scripts/verify-codex-terminal-state.mjs .cache/codex-terminal-state/package/linux-unpacked/sotto
```

The packaged executable reported Sotto 0.1.37 and `app.isPackaged = true`; the unpackaged bootstrap reported Electron 43.1.0. Both used the same built main. Both runs had zero renderer page errors. Every owned app and compositor process stopped; the live desktop was untouched.

| Evidence | What it shows |
| --- | --- |
| [Built Working](../../artifacts/codex-terminal-state/built-working.png) and [packaged Working](../../artifacts/codex-terminal-state/packaged-working.png) | The submitted native turn in the Working group. |
| [Built 1600×1000 dark](../../artifacts/codex-terminal-state/built-idle-1600x1000-dark.png), [1280×800 dark](../../artifacts/codex-terminal-state/built-idle-1280x800-dark.png), [820×560 light](../../artifacts/codex-terminal-state/built-idle-820x560-light.png) | The completed reply, ready composer and idle row. |
| [Packaged 1600×1000 dark](../../artifacts/codex-terminal-state/packaged-idle-1600x1000-dark.png), [1280×800 dark](../../artifacts/codex-terminal-state/packaged-idle-1280x800-dark.png), [820×560 light](../../artifacts/codex-terminal-state/packaged-idle-820x560-light.png) | The same completed journey in the packaged app, with reduced motion on. |
| [Built metadata](../../artifacts/codex-terminal-state/built-result.json), [packaged metadata](../../artifacts/codex-terminal-state/packaged-result.json) | Version, final state, detection and renderer error assertions. |

The retained PNGs were visually inspected at original resolution. The minimum-size view remains usable and the native warning badge remains visible without preventing Idle. An initial packaged run captured an early Idle frame before the reply; the proof now waits for native Working and checks the actual reply through terminal Search before closing Search and capturing completion. Searching the rendered buffer also avoids treating split incremental PTY writes as a missing reply. Captures use Electron's native window capture, as the existing Linux proof scripts do. No design baselines were regenerated.

## Checks

The reproducing state-machine test failed before the fix with `expected 'working' to be 'idle'` for both Codex versions. The state suite now passes 142 cases, including unseen completion, viewing, quiet known work, stale callbacks, native permissions, drafts, quoted/fenced text and rejecting 0.162.2. The 16 bare-folder regressions failed before their corresponding corrections: eight bare folders, then eight folders with titles. The neighbouring workspace and real helper integration suites pass 70 cases with one Windows-only skip.

Local test temporary files are stored in `.cache/t`. For tests that discover checkout identity, that directory is mounted as `/tmp` inside a private Bubblewrap namespace: no files are written to forge's real `/tmp`. Putting fixtures directly below the worktree caused fake empty `.git` markers to inherit Sotto's real parent checkout and made an unrelated capacity test fail. The same test passes with the isolated mount. The first full run's namespace also exposed `/` with an unmapped owner, which correctly made the unrelated dictation runtime checks refuse it; a namespace root owned by this test run restores the intended fixture environment. Production code and those assertions were left intact.

Typecheck, lint, notices verification (189 components), build, release assets and the external-dependency allowlist pass. The terminal Playwright spec reports one Windows-only skip on forge; the real Codex GUI script above supplies the Linux native proof.

The independent Standards and Spec reviews found no remaining findings. Standards caught a cleanup gap in the proof script: setup and shutdown failures could retain its private sign-in copy. Setup now lives inside the cleanup scope, with directory removal in a finally around app shutdown. A deliberately missing package failed before launch and left no private profile or owned process behind. Reviewers used the inherited session model and effort, as the user's crew routing directs.

The corrected namespace run passed all 9,862 test assertions but reported two unhandled errors from Tiptap's deferred editor destruction after `promptEditor.test.tsx` lost its jsdom document. The isolated file passed, but a temporary teardown assertion proved all ten editors remained alive immediately after Testing Library cleanup. The fixture now registers for the editor's destroy event before unmounting, awaits it and verifies `isDestroyed`. Its ten cases pass, and both reviewers found no issue with the cleanup change. No production prompt-editor behavior changed.

The initial clean `npm test -- --maxWorkers=2` run in the corrected namespace passed: 784 files and 9,862 tests, with 55 files / 194 tests skipped, no unhandled errors and exit status zero (578.63 seconds). After the folder review fix, the final full run passed 784 files and 9,878 tests, with the same skips, no failures or unhandled errors and exit status zero (609.85 seconds). All four local gates are green.
