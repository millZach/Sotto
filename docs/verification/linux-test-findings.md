# Linux findings from the full Omarchy test

October 13, 2026. Scope: the five fixes in the linux-release brief, based on Astra's full Omarchy report of Sotto 0.1.37 at 5bd30a52. The stale setup, removal label, update notice and terminal screenshots named there were opened before implementation.

## Result

Built and packaged Sotto 0.1.37 were driven on forge in owned nested Hyprland sessions, each with a private HOME, config, runtime and profile under this worktree's ignored `.cache/`. The live desktop and its configuration were left alone. Every recorded proof process stopped. The JSON records below name the version, packaged flag and loaded main bundle's SHA-256; the packaged-resource verifier also checks the archive and its build provenance. These are local builds of the changed worktree, not installed or published releases.

## What was checked

- Outside deletion of the keys is noticed after Back → Get started, and after focus leaves for another owned native window and returns. The real Settings tabs also recheck after Application → Dictation while the window stays focused. Unit tests cover this retained-panel path, hand-installed rows, coalesced native/DOM focus reads, stale acknowledgements and hidden progress. Native focus notifies the renderer; only a shown panel subscribes and reads. A read during an operation returns current progress without inspecting changing files. The rows are retained during inspection.
- Remove reads **Removing** in both the row and the main action, including the interval before a progress event arrives. A held private `luac` wrapper keeps the real removal visible for capture. No ownership rule was relaxed: repairing an externally removed owned key snippet requires restoring its known require line first.
- The real shell answers from a terminal, the public launcher layout, the executable in the sign-in entry written by Settings, and an absolute-display bridge environment with OMARCHY_PATH absent. For packaged launcher verification, the checked-in public wrapper is placed beside links to this worktree's extracted runtime and resources, matching the PKGBUILD layout without installing anything on forge.
- A scripted client-update reading is delivered through main's state channel. The coding-agent step keeps **Continue** fully in view and hit-testable at 1600×1000, 1280×800 and 820×560, in light and dark with reduced motion. The notice is deferred until setup finishes, then appears and can be dismissed. The built proof supplies a ready provider status; the packaged proof uses the existing scripted Claude CLI only for account/model checks and project ownership. No real account or agent turn is used. The local speech model is copied into the private profile to avoid downloading it into /tmp.
- A real bash PTY receives native shifted Equals, Plus, Minus and 0 input. Terminal size changes 13 → 14 → 15 → 14 → 13 while interface zoom stays at 1. With focus on New terminal, native Plus enlarges the interface and 0 resets it. Ctrl+click opens an HTTPS link through a stubbed external opener; ordinary click does not. The guide already required modifier-click and now also names Plus.

## Launch environment diagnosis

`omarchy-shell` requires OMARCHY_PATH and calls `qs ipc -n -p "$OMARCHY_PATH/shell"`. Its installed source says Quickshell matches instances by display. The bridge's `lib/live.mjs` assigns the absolute `s.target.display` socket path to WAYLAND_DISPLAY; Super+Space inherits the shell's relative display name. A read-only ping succeeded with `wayland-1` and failed with `/run/user/1000/wayland-1`, against the same running shell. Main now normalizes an absolute socket directly inside XDG_RUNTIME_DIR to its display name, and supplies `/usr/share/omarchy` when OMARCHY_PATH is missing. It preserves a custom install and never switches to another runtime or display.

[Launch environment comparison](../../artifacts/linux-test-findings/launch-environments.json) records only the selected session variables from the running launcher shell and the actual systemd user manager that supplies XDG autostart. Both currently use `wayland-1` and export OMARCHY_PATH. The private sign-in proof deliberately omits OMARCHY_PATH and executes the binary in the entry Settings wrote; the bridge proof also uses an absolute socket path.

Windows and Linux both retain Electron's default application menu: the caller never installs the null template. Electron [documents that default menu](https://www.electronjs.org/docs/latest/api/menu#menusetapplicationmenumenu). Both the native menu guard and renderer matcher excluded Shift, so this split also applied to Windows. The fix admits Plus/shifted Equals in both layers and keeps other native menu chords. Windows and Linux unit cases cover both Plus aliases; macOS cases preserve its existing matching rules. The shared Windows correction is explicitly requested in the brief when Windows has the same split; the existing three-surface Windows terminal interaction spec now runs in the desktop trial. The corner notice is deferred by the same onboarding condition on all three platforms.

## Evidence

- [Built results](../../artifacts/linux-test-findings/built-results.json), [packaged results](../../artifacts/linux-test-findings/packaged-results.json), [packaged resources and external dependency check](../../artifacts/linux-test-findings/packaged-resources.json).
- Outside refresh: [built, 1280×800 dark](../../artifacts/linux-test-findings/built-outside-change-1280x800-dark.png).
- Continue with an update waiting: [packaged, 1280×800 light](../../artifacts/linux-test-findings/packaged-onboarding-1280x800-light.png), [packaged, 820×560 dark](../../artifacts/linux-test-findings/packaged-onboarding-820x560-dark.png), [packaged, 820×560 light](../../artifacts/linux-test-findings/packaged-onboarding-820x560-light.png).
- Read retry after real key removal: [packaged, 820×560 light](../../artifacts/linux-test-findings/packaged-inspection-retry-820x560-light.png). Main delivers a scripted failed-inspection row, then the button performs a real read; the key snippet stays absent and focus reaches Set up the keys.
- Removing: [packaged, 1280×800 dark](../../artifacts/linux-test-findings/packaged-removing-1280x800-dark.png), [packaged, 820×560 light](../../artifacts/linux-test-findings/packaged-removing-820x560-light.png).
- Terminal: [packaged, 1280×800 dark](../../artifacts/linux-test-findings/packaged-terminal-1280x800-dark.png), [packaged, 820×560 light](../../artifacts/linux-test-findings/packaged-terminal-820x560-light.png).

The approved Omarchy prototype's A layout remains the reference. The throwaway copy, with its removal action corrected, is retained outside main on `prototype/linux-test-findings-20261013` at `bdcd1687b39a0ddbf2844728101eb43a4bcb75d3` (`docs/prototypes/linux-test-findings-throwaway.html`). No new layout or design baseline was introduced. The result records retain measurements for all sizes; only the images linked here are committed.

## Repeat

Use Node 24.21.0 through mise, with TMPDIR unset for the test suite. After building:

```sh
mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/findings-built/outer node scripts/verify-omarchy-setup.mjs --findings
mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/findings-packaged/outer node scripts/verify-omarchy-setup.mjs --findings --package
```

The second command requires a current `release/linux-unpacked` and tarball. It runs the same desktop journey plus `verify-packaged-resources.mjs`, including the external dependency allowlist, memory store, native PTY and speech module, and the extracted tarball's ordinary startup. Tests use the normal temporary folder; models and retained proof data stay in `.cache/`.

The two independent Sol reviews (gpt-6.1-sol, xhigh per the configured reviewer routing) found one Standards violation (evidence-directory overrides), one possible Standards smell (progress inferred from copy), and one Spec omission (Settings retains hidden panels). All three were fixed: the proof uses the shared evidence helper, progress carries a typed operation, and actual Settings tab visibility activates inspection. The omitted tab path and copy-independent removal labels were reproduced as failing tests before their fixes. A follow-up Standards review raised platform scope and duplicated fixture readiness. Windows is authorized explicitly by the brief; the alias changes are guarded away from macOS, with regression checks for its original behavior, and readiness is projected once in the fixture. Named Plus dictation accelerators are also checked before claiming the terminal chord. Sotto Bug Bot then found a rejected command could strand cached busy state and that native focus inspected hidden panels. Regression tests reproduced the rejected-command retry and a final inspection throwing after setup. Main now publishes idle failed rows when that inspection fails; Try again can recover cached busy state. Spec review caught removal intent being lost on failed inspection: those rows now retry only inspection, with tests for completed and interrupted removal, so checking cannot reinstall a removed piece. Native focus carries a bounded notification through preload to the visible hook, which coalesces it with DOM focus; hidden panels do not inspect. Both findings were fixed in one follow-up push. Local gates and final review results are recorded in the pull request. Native macOS desktop input was not available on forge; macOS shortcut matching is kept unchanged and covered by unit cases.

## Out of scope

Parakeet's long-transcript word substitution (#937), spacing between consecutive dictations, the side-edge pill text (#850), and Changes opening Files on a filename click.
