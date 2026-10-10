# Sotto follows the Omarchy theme — forge verification

October 9, 2026. Ticket [#840](https://github.com/millZach/Sotto/issues/840), approved prototype M3, ADR-0070. PR [#906](https://github.com/millZach/Sotto/pull/906), branch `feat/omarchy-theme`, merges `origin/main` at `73020885bf39c484d9454b91c83043ebf7e35160` in merge commit `4d2f7be6c3e5eabd73d0e091c10670769dbc2241`. Main includes #880’s removal of voice control, #898’s release PR procedure and #891’s single cleanup model. The second-review fix is `d8b18c1a`: Windows and macOS reject the reserved selection before mutation; Linux retains waiting choices. This note and the 28 captures describe the merged app.

## Surface and isolation

Verified the built Sotto 0.1.34 app (Electron 43.1.0) on forge, Omarchy 4.0.4 and Hyprland 0.56. Node was 24.21.0 through mise. The app targeted an owned nested Hyprland through its Wayland socket and its own Xwayland display, with a fresh isolated HOME, XDG config/state/data/cache directories and profile inside this worktree. `XDG_RUNTIME_DIR` supplies only the owned nested Wayland sockets; the app’s test dictation socket stays in its owned profile. Omarchy rendered the installed template in that HOME. No live theme or Hyprland configuration was changed, and no input was sent to the locked live session.

The live compositor constrained the outer nested window, so a second owned compositor inside it supplied a 1600×1000 display at scale 1. All app inputs, resizing and captures targeted that inner instance. No nested Omarchy shell or global shell services ran. The test uses `--password-store=basic` for this disposable profile and never opens the live keyring.

The tested main build SHA-256 is `e7c3447335aa42dd77846758d4229b303839712f73ba3af39240933a35cfb434`. The merged source was built before the refreshed capture run. The final record commit changes only documents and evidence; its rebuilt main output is checked against this hash.

## Journey

The fresh profile had no settings file. Main selected Omarchy in both halves and Match Linux. The first-run setup and Threads tour were completed through their buttons. The thread “Visual gate flake” was opened through the sidebar, covering its bubble, transcript, activity, code and permission card. In Appearance, selecting Sotto switched away; selecting Omarchy returned to the desktop palette.

Omarchy’s own command rendered Tokyo Night → Hackerman → Catppuccin Latte → Rose Pine. Each replacement discarded the old theme directory, as a real switch does. The same running main window and widget repainted each time. After every switch, the journey compared all 57 main-window roles and all nine widget roles with the expected canonical colours parsed from the newly rendered file, independently for each window. It checked the gallery’s current name and selected entry. Tokyo Night → Hackerman covers a dark-to-dark switch; Catppuccin Latte → Rose Pine also keeps its mode. The other half showed its waiting copy. An unresolved file fell back to Sotto, removal kept both waiting selections, and re-rendering restored Omarchy. Restart retained the Omarchy choice. Only the IDs were saved; the projected palette was absent from `settings.json`.

The run covered normal startup and reduced motion. At each of 1600×1000, 1280×800 and 820×560, Threads and Appearance were captured in all four themes. Tokyo Night and Hackerman are dark; Catppuccin Latte and the installed Rose Pine are light. The widget was captured for each switch. The waiting copy wraps without ellipsis, including at the minimum size. The existing transcript and Settings panes scroll vertically at the minimum; there was no horizontal overflow in the theme gallery.

Hyprland adds 20 pixels to the Electron client minimum. Only the test lowered the native minimum to 800×540, allowing the actual viewport to reach Sotto’s specified 820×560. Hyprland can round a viewport by one pixel; the capture clips that extra edge so the saved raster has exactly the named dimensions. Product minimum sizes are unchanged.

## Captures and contrast

Every one of these 28 captures was opened and reviewed. `proof.json` records 1,174 measurements of actual solid text interiors and background pixels from the PNGs. The lowest measured ratio is 4.514:1, on Catppuccin Latte’s transcript author label. The check omits offscreen/clipped text and thin antialiased glyphs without a solid interior; it is not a claim about every antialias edge or inactive controls. The stock-theme checks cover 3,212 declared role/surface pairs, 4,224 main-window CSS text pairs and 352 widget CSS text pairs across all 22 themes, including success text in Tools and tinted Changes rows. A stylesheet scan accounts for every `--tt-*` used as `color:` and names the graphical exceptions; focus retains its separate 3:1 requirement. Red and amber each have real 35%/36% boundary cases.

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

The final gate head is the commit titled **“Record the final Omarchy review checks”**, whose parent is `9a65603e33935c500a110351510c5a7e058799be`. Its full SHA is resolved with `git log -1 --format=%H -- docs/verification/omarchy-theme.md`. The complete gate set and nested journey are repeated after this record commit on that exact head; the application source is identical to the verified merge commit. The ignored `artifacts/omarchy-theme/review2/final-head-results.json` records the resolved SHA and gate exits.

Commands use Node 24.21.0 through mise and an isolated HOME. Only one suite runs at a time: two Vitest workers or one Playwright worker. Vitest uses a private, user-owned bubblewrap root, read-only system mounts and this worktree’s `.t` at `/tmp`. This preserves dictation runtime ownership checks, gives Linux sockets short paths and prevents fixture folders from finding the enclosing checkout. An initial wrapper using the host root failed ownership checks; correcting the sandbox made the 119 affected tests pass without application changes. The visual journey runs directly in the owned nested session, with its isolated HOME and owned `DISPLAY`; wrapping Electron in bubblewrap left the widget unmapped. Both corrections concern the test environment only. Setup repeated `npm ci` and Electron’s installer in isolation. Main removed the voice runtime preparation script; `runtime:prepare --if-present` is consequently a no-op, and no retired runtime files are restored.

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, all three TypeScript projects |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS, 719 files and 9,042 tests; 52 files and 184 tests skipped |
| `npm run notices:verify` | PASS, 182 third-party components |
| `npm run build` | PASS; main SHA-256 matches the capture build above |
| Build external-dependency allowlist | `allowlist check: PASS` (`node-pty`, `zod`, `electron`), repeated immediately before push |
| Nested Omarchy Playwright journey, one worker | PASS, 1 test |
| Design capture manifest and hashes | PASS, all 144 exact tuples and hashes |
| `ls docs/adr \| cut -c1-4 \| sort \| uniq -d` | PASS, no output |

Main owns ADR-0068 for voice removal and ADR-0069 for the single cleanup model. The fresh audit checks `origin/main` at `73020885bf39c484d9454b91c83043ebf7e35160` and all nine open PR diffs: #906 (this branch), #905, #904, #903, #900, #896, #888, #885 and #816. Only #906 claims 0070; main and every other open PR leave it free. The duplicate-number command prints nothing. The audit is repeated immediately before push.

The active main ruleset requires an up-to-date branch, **Gates (Windows)** and **Package result**, with no bypass actors. Local forge results do not satisfy those GitHub checks. This request updates only the existing PR’s feature branch and posts no comment; both required checks must pass before PR #906 can merge.

## Merge conflicts and review

| Conflict | Resolution |
| --- | --- |
| `CONTEXT.md` | Keep the Omarchy terms and Linux default; use main’s widget and dictation wording and retain its retired voice-control entry. |
| `docs/adr/0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md` | Keep both amendments: main’s removal in ADR-0068 and the Linux gallery addition in ADR-0070. |
| `eslint.config.mjs` | Keep both sets of generated-folder exclusions, including main’s removal evidence and this branch’s sandbox. |
| `src/main/storage/settingsRepository.ts` | Keep main’s serialized writes and mutation queue; combine Linux pending-ID parsing and read-only palette projection. Parse again before serialization so neither the runtime palette nor removed settings is persisted. |
| `src/renderer/src/features/settings/themes/ThemeLivePreview.tsx` | Keep main’s idle dictation waveform. Resolve the widget’s Omarchy mode and retain its copy without restoring an orb. |
| `tests/unit/renderer/nativeSkills.test.tsx` | Keep main’s `ThreadsView` props and this branch’s mounted-editor cleanup. |

The automatic merges of `themeBranding`, the widget and onboarding’s Look step were checked against main. Their diff contains only palette and appearance resolution; none restores voice control. The Omarchy e2e fixture now uses main’s remaining agent configuration and store shape. Main’s removed voice coordinator, wake states, settings, orb and captures stay removed.

The second review’s platform finding is fixed at the settings IPC validation boundary. Four cases cover both theme fields on Windows and macOS with a valid appearance change in the same patch: the reserved selection and an unknown ID each fail without even reading settings, writing or publishing a notification. Two Linux cases accept either half with a missing palette, and the existing waiting-selection persistence coverage remains. The prior runtime-field rejection tests now run against the actual simulated platform.

The new merge of #891 had no conflicts. Cleanup, its settings/UI, documentation and main’s revised Cleanup baseline are taken from main. The branch no longer writes `llmQuality` or chooses cleanup tiers. The only remaining source mention of `llmQuality` documents that old settings discard it. No voice coordinator, wake state, control setting or orb returns.

Standards and issue review found no remaining in-scope findings. Built-in palettes, Windows/macOS token definitions, packaging and design baselines have no diff against merged main. No host, permission authority or runtime dependency was added. The retained editor cleanup changes tests only. An initial full run passed all 9,042 assertions but exited red with two unhandled `document is not defined` errors from Tiptap’s deferred teardown in `threadQueueSkills` and `composerFileMentions`. The isolated rerun passed 43 tests, exposing a suite-load cleanup race. Commit `9a65603e` owns those editors and destroys them before jsdom closes, following the existing native-skills cleanup. The three affected renderer files then passed all 52 tests without an unhandled error. No timeout, assertion or product behavior was relaxed. The complete suite is rerun on the final record head.

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
| `src/main/ipc/registerIpc.ts` | Reject the runtime field and non-Linux reserved selections before mutation. |
| `tests/integration/settingsHistoryIpc.test.ts` | Runtime-field rejection on all three platforms, both-half Windows/macOS ID rejection and Linux waiting-selection acceptance. |
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
| `tests/unit/renderer/threadQueueSkills.test.tsx` | Own and destroy mounted prompt/queue editors before jsdom closes. |
| `tests/unit/renderer/composerFileMentions.test.tsx` | Destroy the mounted prompt editor before jsdom closes. |
| `docs/adr/0070-sotto-follows-the-omarchy-theme.md` | Mapping, readability, Linux default and ADR-number audit. |
| `docs/adr/0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md` | Record the Linux gallery addition. |
| `CONTEXT.md` | Omarchy theme and readability-check terms, default and widget behaviour. |
| `README.md` | Linux theme overview. |
| `docs/guide.md` | Linux installation, selection and fallback behaviour. |
| `docs/verification/omarchy-theme.md` | This journey, results, file map, evidence and limits. |
| `.gitignore` | Keep only the named captures and proof; ignore isolated scratch and short TMPDIR. |
| `eslint.config.mjs` | Exclude the generated evidence folder and short TMPDIR. |
| `artifacts/omarchy-theme/*.png` | The 28 individually linked theme captures. |
| `artifacts/omarchy-theme/proof.json` | Per-capture pixel measurements. |

## Limits

Windows and macOS were not run on their native desktops. Package (Windows) and Gates (Windows) cannot be claimed green from forge; the workflow runs on main pushes and PRs, and this request updates only PR #906’s feature branch without waiting for its CI. Built-in palettes, shared token definitions, packaging configuration, dependencies and committed design baselines have no diff.

The committed design manifest and baseline hashes verify, and the branch has no diff in `artifacts/design` against main. Native Windows visual comparison was not run on forge; no capture baseline was regenerated.

The live Omarchy and Hyprland configuration trees, current theme state and the live shell’s long-running process identities match their pre-verification fingerprints. This workflow runs no nested Quickshell, usage collector or live refresh command. The owned compositors and their stale runtime instance folders are removed after the final journey. The quit-drain image is restored if a suite rewrites it.

## Repeat

Start an owned nested Hyprland using the forge sandbox procedure, with HOME and all XDG folders under this worktree. Set `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` to that owned instance. If Electron needs `DISPLAY`, take the display belonging to that instance’s Xwayland child. Give every owned app window a floating rule in the generated nested configuration; no live rules are changed. Give it a 1600×1000 display at scale 1; use an owned outer compositor when the locked live session constrains the nested window.

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
