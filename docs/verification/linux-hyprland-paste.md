# Hyprland dictation paste

October 9, 2026. Ticket [#838](https://github.com/millZach/Sotto/issues/838), under the Linux desktop [map #833](https://github.com/millZach/Sotto/issues/833). Built on forge from `feat/linux-hyprland-paste`, based on `634d0147`. Electron 43.1.0, Node 24.21.0, Hyprland 0.56.2 (`efb50993780079460b0cbed1363e2166a2de1d9f`), Omarchy's installed Lua clipboard bindings.

**Real paste is verified in a nested Hyprland, on October 9, by the lead.** A key event never reached forge's live session, which stayed locked throughout. Sotto's real output path pasted into a terminal (`foot`, tagged `terminal`, through Shift+Insert) and into an app (a Chromium text box, through Ctrl+V), and each received the exact transcript; see "Real paste in a nested Hyprland" below. Not tried: Alacritty, and physical modifier release on a real keyboard.

## What changed

Linux output uses `wl-copy` with transcript bytes on stdin, argument arrays and no shell. Its stdout and stderr are ignored: the clipboard owner forks and must not hold a pipe open. The async output queue waits for the parent to finish before hiding the widget and starting the saved paste delay. `wl-paste --no-newline` reads exact clipboard text through the same adapter. There is no existing clipboard restoration on Windows or macOS, so Linux does not restore the previous selection either. Successful output leaves the transcript copied.

An unavailable wl-clipboard falls back to Electron, publishes a stable recovery notice with plain words and skips automatic paste. Skipping matters: Electron may only update its own selection, so pasting could otherwise insert the old desktop clipboard. A failed Electron fallback uses the existing completed-text recovery. Transcripts, previous clipboard text and process error bodies are never logged by these adapters.

The Linux paste adapter checks that Hyprland reports an unlocked session, waits up to 300 ms in 25 ms intervals for held Super, Ctrl, Shift and Alt keys, then queries `hyprctl activewindow -j`. A `terminal` or dynamic `terminal*` tag selects Shift+Insert; otherwise it selects Ctrl+V. It sends a Lua dispatcher with key-down and then key-up after 50 ms. It always attempts key-up after a dispatched down, including a lost acknowledgement or rejected command. Process failures, malformed query replies, held modifiers and failed Lua replies leave a copied outcome. Paste commands never contain transcript text. Windows and macOS keep their commands, permission handling and warm-helper choices.

Settings, onboarding, Dictate, Help and the widget explain automatic paste on Hyprland. Super+V is the manual fallback, Omarchy's universal paste in apps and terminals. README, the guide and the bindings instructions say the same. No domain term was added, and no CONTEXT entry needed changing. This follows the staged Hyprland paste decision in ADR-0062 on `origin/feat/linux-desktop-adr`; it adds no platform target, host or dependency.

## API evidence

Read `/usr/share/omarchy/default/hypr/bindings/clipboard.lua` and `/usr/share/hypr/stubs/hl.meta.lua` on forge. The installed Omarchy binding selects the terminal tag (stripping a trailing `*`), uses `hl.dsp.send_key_state` and splits down/up by a 50 ms timer. It omits a window target to reach the focused surface.

The matching [Hyprland 0.56.2 dispatcher implementation](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/lua/bindings/LuaBindingsDispatchers.cpp) accepts the `mods`, `key`, `state` table. The [IPC implementation](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/debug/HyprCtl.cpp) wraps `hyprctl dispatch` as `hl.dispatch(...)` and exposes the read-only `locked` command. Exit code alone is insufficient: Lua errors can be returned as text, so Sotto requires an `ok` reply.

A modifier query **does exist**. The [Lua top-level binding](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/lua/bindings/LuaBindingsToplevel.cpp) exposes `hl.is_key_down`, reading the compositor's pressed-key list. [The Lua evaluator](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/lua/ConfigManager.cpp) returns values through `repl`; `eval` returns only `ok`. A real read-only query on forge returned `false` for Super_L/Super_R. `hyprctl locked -j` returned `{"locked":true}`. The held/released transitions are verified in unit tests, not by physical keys while locked. Omarchy's unmodified F9 push-to-talk binding and transcription time also reduce the chance of a key remaining held.

## Real clipboard proof

Reproduce after `mise exec node@24.21.0 -- npm run build` with:

```sh
mise exec node@24.21.0 -- node scripts/verify-hyprland-paste.mjs
```

The script takes the session environment from Quickshell, uses a fresh profile inside this worktree, removes e2e overrides, starts the built app with main inspector port 9345, hides its windows and invokes `window.sotto.deliverOutput`. This traverses the real preload bridge, IPC validation, output queue and Wayland adapter. It does not substitute an Electron clipboard or e2e clipboard. Only `hyprctl` is a recording stub. No transcription request or provider account is used.

Verbatim [clipboard evidence](../../artifacts/linux-hyprland-paste/clipboard-proof.txt):

```text
session locked (read-only query): true
wl-paste before: "before-hyprland-paste-proof"
Sotto focused: false
real output result: "copied"
wl-paste after real output: "Sotto Wayland output while unfocused — café 🚀\nSecond line."
wl-paste after settle (no automatic restore): "Sotto Wayland output while unfocused — café 🚀\nSecond line."
stubbed app output result: "pasted"
stubbed terminal output result: "pasted"
real key dispatch: "NOT VERIFIED — screen locked; every dispatch used a recording stub"
```

There is no product clipboard restore to prove. The sentinel preceding this output is deliberately replaced by the transcript. The proof stops Electron and its final wl-copy selection owner by PID; that clears the synthetic clipboard selection during cleanup.

Verbatim [recording stub arguments](../../artifacts/linux-hyprland-paste/hyprctl-arguments.jsonl), first an app, then a dynamic terminal tag:

```jsonl
["locked","-j"]
["repl","return hl.is_key_down(\"Super_L\") or hl.is_key_down(\"Super_R\") or hl.is_key_down(\"Control_L\") or hl.is_key_down(\"Control_R\") or hl.is_key_down(\"Shift_L\") or hl.is_key_down(\"Shift_R\") or hl.is_key_down(\"Alt_L\") or hl.is_key_down(\"Alt_R\")"]
["activewindow","-j"]
["dispatch","hl.dsp.send_key_state({ mods = \"CTRL\", key = \"V\", state = \"down\" })"]
["dispatch","hl.dsp.send_key_state({ mods = \"CTRL\", key = \"V\", state = \"up\" })"]
["locked","-j"]
["repl","return hl.is_key_down(\"Super_L\") or hl.is_key_down(\"Super_R\") or hl.is_key_down(\"Control_L\") or hl.is_key_down(\"Control_R\") or hl.is_key_down(\"Shift_L\") or hl.is_key_down(\"Shift_R\") or hl.is_key_down(\"Alt_L\") or hl.is_key_down(\"Alt_R\")"]
["activewindow","-j"]
["dispatch","hl.dsp.send_key_state({ mods = \"SHIFT\", key = \"Insert\", state = \"down\" })"]
["dispatch","hl.dsp.send_key_state({ mods = \"SHIFT\", key = \"Insert\", state = \"up\" })"]
```

The final proof cleanup stopped Electron PID 3719000 and wl-copy PID 3719346 and removed its isolated profile. The earlier successful proof stopped Electron PID 3557570 and wl-copy PID 3557806; earlier inspector startup attempts also stopped their owned PIDs. No service, watcher or proof process was left running. The tool retries the inspector's transient startup-context errors before the renderer is ready.

## Gates and running renderer

The builder ran the gates inside a local Bubblewrap wrapper that kept scratch writes in its worktree. The wrapper is not part of this change; the gates pass the same way without it.

The two Linux Playwright specs passed all three tests in 13.7 seconds with the Hyprland session environment exported from Quickshell. They use Sotto's e2e transcription, clipboard and paste adapters, so they verify renderer behavior and compositor commands, not real OS paste. The real clipboard path is proved separately above. The failed-paste scenario checks the exact widget title **Copied — paste manually**, its Super+V detail and the retained transcript.

The compositor-command journey checks 1600×1000, 1280×800 and 820×560 in light and dark with reduced motion on. It checks onboarding, the Dictation and Output settings and the Dictate hint for visibility and overflow; Finish setup is also exercised from the keyboard. Opened and inspected these captures from the built renderer:

- [Onboarding, light, 820×560](../../artifacts/linux-hyprland-paste/onboarding-820x560-light.png): automatic paste and the universal fallback fit, and Finish setup stays reachable.
- [Output settings, dark, 820×560](../../artifacts/linux-hyprland-paste/settings-820x560-dark.png): the paste description wraps without clipping and all output controls fit.
- [Dictate, light, 820×560](../../artifacts/linux-hyprland-paste/dictate-820x560-light.png): the action and longer hint fit beside the sidebar. No stylesheet, theme role or Windows/macOS copy changed.

Reviewed the diff against AGENTS.md and against #838 separately. The clipboard never becomes a command argument; process errors stay private; the fallback cannot paste a stale desktop selection; all dispatched downs get an up attempt; and Linux chooses its chord after the saved delay. No review finding remains in scope. The real-window and physical held-key checks above remain unverified.

Final local CI gates, all under Node 24.21.0:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed all three TypeScript projects. |
| `npm run lint` | Passed with no errors or warnings. |
| `npm test -- --maxWorkers=2` | 622 files passed, 50 skipped (672); 9,158 tests passed, 182 skipped (9,340). No failures. 686.27 seconds. |
| `npm run notices:verify` | Verified 174 third-party notice components. |
| `npx playwright test tests/e2e/linux-platform-profile.spec.ts tests/e2e/linux-dictation-command.spec.ts --workers=1` | All three tests passed, 13.7 seconds. Hyprland session environment exported. |

The full suite first caught a stale explicit list in the recovery-notice schema test after adding the clipboard notice. Updated that list; the notice schema and flow checks passed all 18 tests, then the entire two-worker suite passed above. No production fix was needed for that test failure. The local Linux gates do not claim a Windows CI run or physical Windows/macOS paste verification.

## Real paste in a nested Hyprland

forge's live session was locked, and a synthetic key there would have gone into the lock screen's password field. So the lead ran a second Hyprland nested inside it, with its own socket, instance and clipboard. It loaded Omarchy's helper and terminal-tag rules from `/usr/share/omarchy/default/hypr/`. Inside it ran `foot` (with `cat` in raw mode writing to a file), a Chromium text box, and this branch's Sotto build pointed at the nested instance. `scripts/verify-hyprland-paste-nested.mjs` repeats it.

| Target | Active window tags | Chord Sotto sent | Received |
|---|---|---|---|
| foot | `terminal*` | Shift+Insert | `Sotto pasted into a terminal — café 🚀` |
| Chromium text box | none | Ctrl+V | `Sotto pasted into an app — naïve façade ✓` |

`deliverOutput` returned `pasted` for both. [Screenshot of the nested screen](../../artifacts/linux-hyprland-paste/nested-paste-real.png) and [results](../../artifacts/linux-hyprland-paste/nested-paste-results.json). Every process was stopped by PID, the nested instance's runtime folder was removed, and the live session's instance was untouched.

