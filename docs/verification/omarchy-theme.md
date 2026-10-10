# Sotto follows the Omarchy theme — forge verification

October 9, 2026. Ticket [#840](https://github.com/millZach/Sotto/issues/840), approved prototype M3, ADR-0068. Branch `feat/omarchy-theme`, originally based on `1312da73`; main through `66793b8c` was merged in `a851277c` after #901 reported MERGED.

## Surface and isolation

Verified the built Sotto 0.1.34 app (Electron 43.1.0) on forge, Omarchy 4.0.4 and Hyprland 0.56. Node was 24.21.0 through mise. The app ran on native Wayland in an owned nested Hyprland, with a fresh isolated HOME, XDG config/state/data/cache directories and profile inside this worktree. `XDG_RUNTIME_DIR` supplies only the owned nested Wayland sockets; the app’s test dictation socket stays in its owned profile. Omarchy rendered the installed template in that HOME. No live theme or Hyprland configuration was changed, and no input was sent to the locked live session.

The live compositor constrained the outer nested window, so a second owned compositor inside it supplied a 1600×1000 display at scale 1. All app inputs, resizing and captures targeted that inner instance. No nested Omarchy shell or global shell services ran. The test uses `--password-store=basic` for this disposable profile and never opens the live keyring.

The tested main build SHA-256 is `54ffc635beee51946ed1bea8d4fdf34ccc90f923724c8e7b562c9542fb62aedb`. The reviewed fixes were built before the refreshed capture run. Main’s merge changes only the composer ADR and its citation; the final build is checked against this hash.

## Journey

The fresh profile had no settings file. Main selected Omarchy in both halves and Match Linux. The first-run setup and Threads tour were completed through their buttons. The thread “Visual gate flake” was opened through the sidebar, covering its bubble, transcript, activity, code and permission card. In Appearance, selecting Sotto switched away; selecting Omarchy returned to the desktop palette.

Omarchy’s own command rendered Tokyo Night → Hackerman → Catppuccin Latte → Rose Pine. Each replacement discarded the old theme directory, as a real switch does. The same running main window and widget repainted each time. After every switch, the journey compared all 57 main-window roles and all nine widget roles with the expected canonical colours parsed from the newly rendered file, independently for each window. It checked the gallery’s current name and selected entry. Tokyo Night → Hackerman covers a dark-to-dark switch; Catppuccin Latte → Rose Pine also keeps its mode. The other half showed its waiting copy. An unresolved file fell back to Sotto, removal kept both waiting selections, and re-rendering restored Omarchy. Restart retained the Omarchy choice. Only the IDs were saved; the projected palette was absent from `settings.json`.

The run covered normal startup and reduced motion. At each of 1600×1000, 1280×800 and 820×560, Threads and Appearance were captured in all four themes. Tokyo Night and Hackerman are dark; Catppuccin Latte and the installed Rose Pine are light. The widget was captured for each switch. The waiting copy wraps without ellipsis, including at the minimum size. The existing transcript and Settings panes scroll vertically at the minimum; there was no horizontal overflow in the theme gallery.

Hyprland adds 20 pixels to the Electron client minimum. Only the test lowered the native minimum to 800×540, allowing the actual viewport to reach Sotto’s specified 820×560. Hyprland can round a viewport by one pixel; the capture clips that extra edge so the saved raster has exactly the named dimensions. Product minimum sizes are unchanged.

## Captures and contrast

Every one of these 28 captures was opened and reviewed. `proof.json` records 1,174 measurements of actual solid text interiors and background pixels from the PNGs. The lowest measured ratio is 4.514:1, on Catppuccin Latte’s transcript author label. The check omits offscreen/clipped text and thin antialiased glyphs without a solid interior; it is not a claim about every antialias edge or inactive controls. The stock-theme checks cover 3,212 declared role/surface pairs, 4,114 main-window CSS text pairs and 352 widget CSS text pairs across all 22 themes, including success text in Tools and tinted Changes rows. A stylesheet scan accounts for every `--tt-*` used as `color:` and names the graphical exceptions; focus retains its separate 3:1 requirement. Red and amber each have real 35%/36% boundary cases.

[Pixel measurements](../../artifacts/omarchy-theme/proof.json). The captures below are the retained evidence; intermediate profiles, prototype images, logs and compositor scripts are ignored.

| Theme | Size | Threads | Appearance |
| --- | --- | --- | --- |
| Tokyo Night | 1600x1000 | [Open](../../artifacts/omarchy-theme/threads-tokyo-night-1600x1000.png) | [Open](../../artifacts/omarchy-theme/appearance-tokyo-night-1600x1000.png) |
| Tokyo Night | 1280x800 | [Open](../../artifacts/omarchy-theme/threads-tokyo-night-1280x800.png) | [Open](../../artifacts/omarchy-theme/appearance-tokyo-night-1280x800.png) |
| Tokyo Night | 820x560 | [Open](../../artifacts/omarchy-theme/threads-tokyo-night-820x560.png) | [Open](../../artifacts/omarchy-theme/appearance-tokyo-night-820x560.png) |
| Catppuccin Latte | 1600x1000 | [Open](../../artifacts/omarchy-theme/threads-catppuccin-latte-1600x1000.png) | [Open](../../artifacts/omarchy-theme/appearance-catppuccin-latte-1600x1000.png) |
| Catppuccin Latte | 1280x800 | [Open](../../artifacts/omarchy-theme/threads-catppuccin-latte-1280x800.png) | [Open](../../artifacts/omarchy-theme/appearance-catppuccin-latte-1280x800.png) |
| Catppuccin Latte | 820x560 | [Open](../../artifacts/omarchy-theme/threads-catppuccin-latte-820x560.png) | [Open](../../artifacts/omarchy-theme/appearance-catppuccin-latte-820x560.png) |
| Rose Pine | 1600x1000 | [Open](../../artifacts/omarchy-theme/threads-rose-pine-1600x1000.png) | [Open](../../artifacts/omarchy-theme/appearance-rose-pine-1600x1000.png) |
| Rose Pine | 1280x800 | [Open](../../artifacts/omarchy-theme/threads-rose-pine-1280x800.png) | [Open](../../artifacts/omarchy-theme/appearance-rose-pine-1280x800.png) |
| Rose Pine | 820x560 | [Open](../../artifacts/omarchy-theme/threads-rose-pine-820x560.png) | [Open](../../artifacts/omarchy-theme/appearance-rose-pine-820x560.png) |
| Hackerman | 1600x1000 | [Open](../../artifacts/omarchy-theme/threads-hackerman-1600x1000.png) | [Open](../../artifacts/omarchy-theme/appearance-hackerman-1600x1000.png) |
| Hackerman | 1280x800 | [Open](../../artifacts/omarchy-theme/threads-hackerman-1280x800.png) | [Open](../../artifacts/omarchy-theme/appearance-hackerman-1280x800.png) |
| Hackerman | 820x560 | [Open](../../artifacts/omarchy-theme/threads-hackerman-820x560.png) | [Open](../../artifacts/omarchy-theme/appearance-hackerman-820x560.png) |

Widgets: [Tokyo Night](../../artifacts/omarchy-theme/widget-tokyo-night.png), [Catppuccin Latte](../../artifacts/omarchy-theme/widget-catppuccin-latte.png), [Rose Pine](../../artifacts/omarchy-theme/widget-rose-pine.png), [Hackerman](../../artifacts/omarchy-theme/widget-hackerman.png).

## Final gates

The final head is the commit titled **“Record the reviewed Omarchy fixes and final verification”**, which adds this record and the refreshed evidence. Resolve its full hash with `git log -1 --format=%H -- docs/verification/omarchy-theme.md`; its source parent is `a851277c`. All gates below are repeated after that evidence commit, on that final head. The earlier 9,599-test result applied to `97173df0`, before `ae101acc` restored the base’s duplicate composer ADR, and did not establish a pass on the review head.

Commands use Node 24.21.0 through mise, in the owned nested sandbox with an isolated HOME. Only one suite runs at a time: two Vitest workers or one Playwright worker. For Vitest, bubblewrap binds this worktree’s private `.t` folder as `/tmp` inside the test process, with the rest of the filesystem read-only except the worktree. This gives Linux sockets a short path and prevents plain fixture folders from discovering Sotto’s enclosing repository. The initial run without that mount failed 21 tests from those two sandbox path problems; no application or out-of-scope test fix was needed.

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, all three TypeScript projects |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS, 741 files and 9,635 tests; 52 files and 184 tests skipped |
| `npm run notices:verify` | PASS, 201 third-party components |
| `npm run build` | PASS; main SHA-256 matches the capture build above |
| Build external-dependency allowlist | `allowlist check: PASS` (`node-pty`, `zod`, `electron`), repeated immediately before push |
| Nested Omarchy Playwright journey, one worker | PASS, 1 test |

[#901](https://github.com/millZach/Sotto/pull/901) owns the composer ADR’s number. After `gh pr view 901 -R millZach/Sotto --json state` reported MERGED, `a851277c` merged `origin/main` (`66793b8c`) with a merge commit. The composer decision is now ADR-0067 and the uniqueness check passes. Omarchy remains ADR-0068. The separate `b71e3199` gate repair still makes test-owned Tiptap editors close before jsdom does; it changes no runtime behaviour.

## Review fixes

| Finding | Fix commit |
| --- | --- |
| 2. Runtime settings update | `b6c2eefb`: omit `omarchyTheme` from update requests; reject before writes or notifications on win32, darwin and linux. |
| 3. Success text and coverage | `58b246a2`: repair derived success text only for Omarchy; widen the surface inventory and pin 35%/36%. `bdbb152b` checks the widget’s own CSS projection. |
| 4. Custom ID collision | `43324b7e`: runtime `__omarchy` cannot be a custom ID; upgrades keep custom `omarchy` themes and both selections, with and without a rendered file. |
| 5. Create theme | `d4216ce2`: seed from `resolveThemeFor` for the painted appearance, including the waiting/missing fallback. `7e85b041` keeps the fixture’s settings type exact. |
| 6. Live repaint | `80bf486c`: assert the expected colours separately in both windows and the gallery name, including same-mode switches, fallback, recovery and restart. |
| 7. ADR and evidence | `2eb5afd0`: remove the obsolete renumbering inventory and leave the composer number to #901; this final evidence commit names the gate head. |
| 1. Main | `a851277c`: merge main after #901’s merge. |

Standards and issue review found no remaining in-scope findings. Built-in palettes, Windows/macOS token definitions, packaging and design baselines remain unchanged. No host, permission authority or runtime dependency was added.

## Voice-wake comparison

The same design capture case (`design-capture-voice-widget.spec.ts`, “orb and session states follow the voice and permission journeys”) ran on a clean detached `origin/main` checkout at `1312da73`, before #901 merged. It had its own `npm ci`, Electron install, runtime preparation and build (main SHA-256 `734ed9ff5c4cef8d655e0de1ca7f800c212f13cc5446a16f0a3341a226097a85`). It used the owned nested compositor and isolated HOME, with Wayland and the disposable basic password store. No tracked source was changed.

[Clean-main voice wake](../../artifacts/omarchy-theme/voice-wake-main.png) shows the teal mesh orb. **The blank orb did not reproduce on clean main in this run.** The case failed the Windows-baseline comparison because the nested Linux image was 1092×742 rather than the baseline’s dimensions; that failure is separate from the orb being visibly rendered. This observation cannot classify the earlier blank frame as a confirmed existing Linux defect or a theme regression. No voice rendering change was made. The temporary `.worktrees/voice-wake-main` checkout was removed afterwards.

## Review

Standards review: main owns file I/O; the renderer receives a validated read-only projection through the existing settings path. Palette contents, names and parse errors never enter logs. The template and colours add no host, permission authority or production dependency. Watchers close at quit. The existing owned stylesheet uses only role tokens for UI colours. No shortcut, feature gate, provider identity or packaging change was introduced.

Spec review: the template follows the approved 57-role M3 mapping. Omarchy itself rendered all 22 installed stock themes; exact rendered fixtures and their source/template hashes travel to Windows tests. Whole-percent readability, status meaning and the 35% fallback are checked. First-start selection, an existing choice, waiting IDs, missing/malformed recovery, successive directory replacements and widget mode are covered. Windows/macOS have no theme entry, file read or watch, keep six palettes and defaults, and retain existing imported themes whose ID is `omarchy`.

## Files

Paths are relative to the repository root.

| File | Change |
| --- | --- |
| `apps/omarchy/sotto.json.tpl` | Approved 57-role M3 mapping in native template syntax. |
| `apps/omarchy/install-theme.sh` | Per-user install and first render under Omarchy's switch lock. |
| `apps/omarchy/README.md` | Install, choose and remove the template. |
| `src/main/themes/omarchy.ts` | Bounded validation, directory watching, recovery and fresh-profile choice. |
| `src/main/index.ts` | Linux startup, settings notifications and watcher disposal. |
| `src/main/settings/nativeSettingsCoordinator.ts` | Publish an appearance refresh without saving or native effects. |
| `src/main/storage/repositories.ts` | Supply the Linux palette provider. |
| `src/main/storage/settingsRepository.ts` | Preserve waiting IDs and project the palette without saving it. |
| `src/shared/themes/omarchy.ts` | Strict schemas, whole-percent readability, derived success text and status safeguards. |
| `src/shared/themes/library.ts` | Resolve the matching Omarchy half, or Sotto while waiting. |
| `src/shared/settings.ts` | Read-only runtime field and Linux ID parsing. |
| `src/main/ipc/registerIpc.ts` | Reject the runtime field in update requests. |
| `tests/integration/settingsHistoryIpc.test.ts` | Rejection before writes or notifications on all three platforms. |
| `tests/fixtures/renderer/omarchyTextSurfaces.ts` | Audited text-on-surface pairs and graphical token exceptions. |
| `src/shared/themeBranding.ts` | Keep the floating widget's mode and palette together. |
| `src/renderer/src/state/appearance.ts` | Live projection, pending choices, Linux mode and startup cache. |
| `src/renderer/src/features/onboarding/LookStep.tsx` | Resolve the mode from the runtime palette. |
| `src/renderer/src/features/settings/AppearanceSettings.tsx` | Resolve the mode from the runtime palette. |
| `src/renderer/src/features/settings/themes/ThemeGallery.tsx` | Linux choices, current name, waiting copy and keyboard navigation. |
| `src/renderer/src/features/settings/themes/themes.css` | Two-line Omarchy names and a dashed waiting chord. |
| `src/renderer/src/features/settings/themes/ThemeLivePreview.tsx` | Show the widget's actual Omarchy mode. |
| `src/renderer/src/features/settings/themes/ThemeEditor.tsx` | Copy the palette painting the window, including its waiting fallback. |
| `src/renderer/src/features/settings/themes/themeLibrary.ts` | Keep the runtime ID outside the custom-theme grammar. |
| `scripts/render-omarchy-theme-fixtures.mjs` | Render stock themes in an isolated HOME with Omarchy itself. |
| `tests/fixtures/omarchy-themes.json` | Exact outputs and hashes for 22 stock themes. |
| `tests/unit/shared/omarchyThemes.test.ts` | All stock contrast pairs, guard boundaries and platform invariants. |
| `tests/unit/main/omarchyTheme.test.ts` | Real replacements, fallback, restart state, privacy and non-Linux I/O. |
| `tests/unit/renderer/omarchyTheme.test.tsx` | Gallery, names, waiting state, keyboard and unchanged non-Linux imports. |
| `tests/e2e/omarchy-theme.spec.ts` | Isolated real rendering, live main/widget repaint and PNG measurements. |
| `tests/unit/renderer/nativeSkills.test.tsx` | Destroy test editors before the DOM closes. |
| `docs/adr/0068-sotto-follows-the-omarchy-theme.md` | Mapping, readability, Linux default and ADR-number audit. |
| `docs/adr/0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md` | Record the Linux gallery addition. |
| `CONTEXT.md` | Omarchy theme and readability-check terms, default and widget behaviour. |
| `README.md` | Linux theme overview. |
| `docs/guide.md` | Linux installation, selection and fallback behaviour. |
| `docs/verification/omarchy-theme.md` | This journey, results, file map, evidence and limits. |
| `.gitignore` | Keep only the named captures and proof; ignore isolated scratch and short TMPDIR. |
| `eslint.config.mjs` | Exclude the generated evidence folder and short TMPDIR. |
| `artifacts/omarchy-theme/*.png` | The 28 individually linked theme captures and clean-main voice-wake comparison. |
| `artifacts/omarchy-theme/proof.json` | Per-capture pixel measurements. |

## Limits

Windows and macOS were not run on their native desktops. Package (Windows) and Gates (Windows) cannot be claimed green from forge; the workflow runs on main pushes and PRs, and this request publishes only a feature branch with no PR. Built-in palettes, shared token definitions, packaging configuration, dependencies and committed design baselines have no diff.

`npm run design:verify` was attempted in the owned nested session. After correcting the nested compositor's initial tiling, captures reached the baseline dimensions, but five comparisons still failed and five later cases did not run. For example, the welcome capture contains the existing Linux compositor-binding instructions where the Windows baseline contains Windows instructions, and its text rasterisation differs. The five failed images were onboarding welcome, light OpenRouter, onboarding at 100%, populated Threads and voice wake. No baseline was regenerated. The committed manifest and all 152 baseline hashes still verify. This is not Windows capture verification.

The live Omarchy, Hyprland and Omarchy state trees matched their pre-verification fingerprints. The two owned nested compositors are stopped at completion, and the quit-drain image is restored if any suite rewrites it.

## Repeat

Start an owned nested Hyprland using the forge sandbox procedure, with HOME and all XDG folders under this worktree. Set `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` to that owned instance, not the live desktop. Give it a 1600×1000 display at scale 1; use an owned outer compositor when the locked live session constrains the nested window.

```sh
mise exec node@24.21.0 -- npm run build
TMPDIR="$PWD/.t" SOTTO_OMARCHY_EVIDENCE=1 mise exec node@24.21.0 -- npx playwright test tests/e2e/omarchy-theme.spec.ts --workers=1
```

Create `.t` first and keep it private. For the full Vitest gate, mount that directory at `/tmp` only inside bubblewrap; a Git discovery ceiling alone does not stop Sotto’s filesystem-based checkout discovery. All temporary writes still land in `.t` inside this worktree, and Unix socket paths stay below Linux’s limit:

Use a user-owned sandbox root as well: an unprivileged user namespace maps the host’s root owner to an unmapped UID, which the dictation runtime correctly refuses. Prepare only this private root, then mount the system directories read-only:

```sh
OMARCHY_GATE_ROOT="$PWD/artifacts/omarchy-theme/scratch-gates/root"
mkdir -p "$OMARCHY_GATE_ROOT"/{usr,etc,dev,proc,sys,run,tmp,home,var,opt}
ln -sfn usr/bin "$OMARCHY_GATE_ROOT/bin"
ln -sfn usr/bin "$OMARCHY_GATE_ROOT/sbin"
ln -sfn usr/lib "$OMARCHY_GATE_ROOT/lib"
ln -sfn usr/lib "$OMARCHY_GATE_ROOT/lib64"
bwrap --die-with-parent --ro-bind "$OMARCHY_GATE_ROOT" / \
  --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /proc /proc --ro-bind /sys /sys \
  --ro-bind /run /run --ro-bind /home /home --ro-bind /var /var --ro-bind /opt /opt \
  --dev /dev --bind "$PWD" "$PWD" --bind "$PWD/.t" /tmp --chdir "$PWD" \
  --setenv TMPDIR /tmp --setenv GIT_CEILING_DIRECTORIES /tmp \
  mise exec node@24.21.0 -- npm test -- --maxWorkers=2
```

The journey owns and removes its isolated profile, installs/renders the template there, drives setup and the picker, switches the four themes, captures both surfaces at all sizes, measures the PNGs, checks fallback and restarts. Regenerate the stock fixture only when its installed source themes or template intentionally change:

```sh
mise exec node@24.21.0 -- node scripts/render-omarchy-theme-fixtures.mjs
```
