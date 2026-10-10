# Sotto follows the Omarchy theme — forge verification

October 9, 2026. Ticket [#840](https://github.com/millZach/Sotto/issues/840), approved prototype M3, ADR-0068. Branch `feat/omarchy-theme`, based on `1312da73`.

## Surface and isolation

Verified the built Sotto 0.1.34 app (Electron 43.1.0) on forge, Omarchy 4.0.4 and Hyprland 0.56. Node was 24.21.0 through mise. The app ran on native Wayland in an owned nested Hyprland, with a fresh isolated HOME, XDG directories and profile inside this worktree. Omarchy rendered the installed template in that HOME. No live theme or Hyprland configuration was changed, and no input was sent to the locked live session.

The live compositor constrained the outer nested window, so a second owned compositor inside it supplied a 1600×1000 display at scale 1. All app inputs, resizing and captures targeted that inner instance. No nested Omarchy shell or global shell services ran. The test uses `--password-store=basic` for this disposable profile and never opens the live keyring.

The tested main build SHA-256 is `7105176ecf0c987245caf19de109965ddda0e6cfb008aa355dff735fd64e0a17`. The source was built before the final capture run; subsequent design verification rebuilt the same main hash.

## Journey

The fresh profile had no settings file. Main selected Omarchy in both halves and Match Linux. The first-run setup and Threads tour were completed through their buttons. The thread “Visual gate flake” was opened through the sidebar, covering its bubble, transcript, activity, code and permission card. In Appearance, selecting Sotto switched away; selecting Omarchy returned to the desktop palette.

Omarchy’s own command rendered Tokyo Night → Catppuccin Latte → Rose Pine → Hackerman. Each replacement discarded the old theme directory, as a real switch does. The same running main window and widget repainted each time. Both windows agreed on the mode and canvas colour; the picker named the current theme and showed the other half waiting. An unresolved file fell back to Sotto, removal kept both waiting selections, and re-rendering restored Omarchy. Restart retained the Omarchy choice. Only the IDs were saved; the projected palette was absent from `settings.json`.

The run covered normal startup and reduced motion. At each of 1600×1000, 1280×800 and 820×560, Threads and Appearance were captured in all four themes. Tokyo Night and Hackerman are dark; Catppuccin Latte and the installed Rose Pine are light. The widget was captured for each switch. The waiting copy wraps without ellipsis, including at the minimum size. The existing transcript and Settings panes scroll vertically at the minimum; there was no horizontal overflow in the theme gallery.

Hyprland adds 20 pixels to the Electron client minimum. Only the test lowered the native minimum to 800×540, allowing the actual viewport to reach Sotto’s specified 820×560. Hyprland can round a viewport by one pixel; the capture clips that extra edge so the saved raster has exactly the named dimensions. Product minimum sizes are unchanged.

## Captures and contrast

Every one of these 28 captures was opened and reviewed. `proof.json` records 1,174 measurements of actual solid text interiors and background pixels from the PNGs. The lowest measured ratio is 4.514:1, on Catppuccin Latte’s selected-sidebar status. The check omits offscreen/clipped text and thin antialiased glyphs without a solid interior; it is not a claim about every antialias edge or inactive controls. The separate unit check measures every mapped foreground pair and the resolved CSS text tokens for all 22 stock themes, including focus at 3:1.

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

## Gates

Commands used Node 24.21.0 through mise. Only one test suite ran at a time, with at most two Vitest workers or one Playwright worker.

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, all three TypeScript projects |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS: 741 files, 9,599 tests; 52 files / 184 tests skipped; no unhandled errors (510.89 seconds) |
| `npm run notices:verify` | PASS, 201 third-party components |
| `npm run build` | PASS |
| Build external-dependency allowlist | `allowlist check: PASS` (`node-pty`, `zod`, `electron`) |
| Focused unit/integration run, two workers | 4 files, 81 tests passed |
| Nested Omarchy Playwright journey, one worker | 1 passed (18.1 seconds) |
| Committed design manifest verification | 152 exact deterministic tuples verified |
| `npm run design:verify`, owned nested session | FAIL on Linux: 5 failed, 5 did not run; committed baselines unchanged |

The gate exposed an existing duplicate ADR 0065 at the base commit. After checking main and all open PR diffs, the existing Tiptap decision and its citation were moved to free number 0069, in a separate gate repair. Omarchy uses 0068. Another gate repair makes the native-skill test destroy its mounted Tiptap editors before jsdom closes; deferred destruction otherwise raised an unhandled `document` error after all assertions passed. Both repairs passed their focused checks (2 files, 10 tests). The Omarchy unit tests account for 44 of the 81 focused tests; the other 37 cover the host-service contract, including cancellation.

Both owned nested compositors were stopped after capture review. The quit-drain `before-quit.png` artifact was restored. No live desktop input or configuration change was made.

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
| `src/shared/themes/omarchy.ts` | Strict schemas, whole-percent readability and status safeguards. |
| `src/shared/themes/library.ts` | Resolve the matching Omarchy half, or Sotto while waiting. |
| `src/shared/settings.ts` | Read-only runtime field and Linux ID parsing. |
| `src/shared/themeBranding.ts` | Keep the floating widget's mode and palette together. |
| `src/renderer/src/state/appearance.ts` | Live projection, pending choices, Linux mode and startup cache. |
| `src/renderer/src/features/onboarding/LookStep.tsx` | Resolve the mode from the runtime palette. |
| `src/renderer/src/features/settings/AppearanceSettings.tsx` | Resolve the mode from the runtime palette. |
| `src/renderer/src/features/settings/themes/ThemeGallery.tsx` | Linux choices, current name, waiting copy and keyboard navigation. |
| `src/renderer/src/features/settings/themes/themes.css` | Two-line Omarchy names and a dashed waiting chord. |
| `src/renderer/src/features/settings/themes/ThemeLivePreview.tsx` | Show the widget's actual Omarchy mode. |
| `src/renderer/src/features/settings/themes/ThemeEditor.tsx` | Allow Create theme to copy the runtime palette. |
| `src/renderer/src/features/settings/themes/themeLibrary.ts` | Reserve the runtime ID only on Linux. |
| `scripts/render-omarchy-theme-fixtures.mjs` | Render stock themes in an isolated HOME with Omarchy itself. |
| `tests/fixtures/omarchy-themes.json` | Exact outputs and hashes for 22 stock themes. |
| `tests/unit/shared/omarchyThemes.test.ts` | All stock contrast pairs, guard boundaries and platform invariants. |
| `tests/unit/main/omarchyTheme.test.ts` | Real replacements, fallback, restart state, privacy and non-Linux I/O. |
| `tests/unit/renderer/omarchyTheme.test.tsx` | Gallery, names, waiting state, keyboard and unchanged non-Linux imports. |
| `tests/e2e/omarchy-theme.spec.ts` | Isolated real rendering, live main/widget repaint and PNG measurements. |
| `tests/unit/renderer/nativeSkills.test.tsx` | Destroy test editors before the DOM closes. |
| `docs/adr/0068-sotto-follows-the-omarchy-theme.md` | Mapping, readability, Linux default and ADR-number audit. |
| `docs/adr/0069-the-thread-composer-is-a-tiptap-field.md` | Rename the existing duplicate 0065 composer decision; contents unchanged. |
| `docs/verification/tiptap-skill-composer.md` | Point its citation to 0069. |
| `docs/adr/0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md` | Record the Linux gallery addition. |
| `CONTEXT.md` | Omarchy theme and readability-check terms, default and widget behaviour. |
| `README.md` | Linux theme overview. |
| `docs/guide.md` | Linux installation, selection and fallback behaviour. |
| `docs/verification/omarchy-theme.md` | This journey, results, file map, evidence and limits. |
| `.gitignore` | Keep only the named captures and proof; ignore isolated scratch and short TMPDIR. |
| `eslint.config.mjs` | Exclude the generated evidence folder and short TMPDIR. |
| `artifacts/omarchy-theme/*.png` | The 28 individually linked captures above. |
| `artifacts/omarchy-theme/proof.json` | Per-capture pixel measurements. |

## Limits

Windows and macOS were not run on their native desktops. Package (Windows) and Gates (Windows) cannot be claimed green from forge; the workflow runs on main pushes and PRs, and this request publishes only a feature branch with no PR. Palettes, shared tokens, packaging configuration, dependencies and committed design baselines have no diff.

`npm run design:verify` was attempted in the owned nested session. After correcting the nested compositor's initial tiling, captures reached the baseline dimensions, but five comparisons still failed and five later cases did not run. For example, the welcome capture contains the existing Linux compositor-binding instructions where the Windows baseline contains Windows instructions, and its text rasterisation differs. The five failed images were onboarding welcome, light OpenRouter, onboarding at 100%, populated Threads and voice wake. No baseline was regenerated. The committed manifest and all 152 baseline hashes still verify. This is not Windows capture verification.

## Repeat

Start an owned nested Hyprland using the forge sandbox procedure, with HOME and all XDG folders under this worktree. Set `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` to that owned instance, not the live desktop. Give it a 1600×1000 display at scale 1; use an owned outer compositor when the locked live session constrains the nested window.

```sh
mise exec node@24.21.0 -- npm run build
TMPDIR="$PWD/.t" SOTTO_OMARCHY_EVIDENCE=1 mise exec node@24.21.0 -- npx playwright test tests/e2e/omarchy-theme.spec.ts --workers=1
```

Create `.t` first. The journey owns and removes its isolated profile, installs/renders the template there, drives setup and the picker, switches the four themes, captures both surfaces at all sizes, measures the PNGs, checks fallback and restarts. Regenerate the stock fixture only when its installed source themes or template intentionally change:

```sh
mise exec node@24.21.0 -- node scripts/render-omarchy-theme-fixtures.mjs
```
