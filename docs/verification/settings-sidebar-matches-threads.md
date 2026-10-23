# Settings draws the sidebar the way Threads does

Verification of the `fix/settings-sidebar-matches-threads` branch in the built app (`npm run build`, Electron under Playwright, macOS on Apple silicon, Node 24). The captures are in `artifacts/sidebar-crossing/`. The look was chosen by the user: the Settings column's, with the sidebar foot's hairline and contents inset from the column's edges.

## What was wrong

Going to Settings and back moved the sidebar in two ways.

- **The width.** The Threads sidebar is as wide as the user left it (260 to 480, 320 by default). The Settings column was 264, or 205 in a window under 1,100 pixels wide and 178 under 900, whatever the sidebar was. Dictate, Usage in Owl and Help already took the Threads width.
- **The foot.** The Threads sidebar drew its foot edge to edge: the hairline from 0 to 319 at the default width, the switch 6 pixels in. The Settings column drew its foot inside a padded column: the hairline from 10, the switch 16 pixels in. Under 900 pixels wide it also stood 15 pixels higher.

Not measured here, read from the stylesheets and the committed Windows captures: on Windows and Linux the padded Settings column also put its top row 16 pixels lower and 10 to the right of the Threads one (macOS already pulled it back), and a column that is not a container missed the narrow-width rules the Threads top row follows, so the mark sat 4 pixels differently on a Mac at the sidebar's narrowest.

## What changed

Every column that wears the sidebar's top row and foot is one unpadded frame, and the foot insets itself, hairline and all. The Settings column takes the Threads sidebar's remembered width and is a container as the sidebar is. The padded variant of the frame, its macOS special cases, the Settings-only foot switch and the Settings-only widths are gone. `CONTEXT.md` (Strip, Sidebar width, Sidebar foot) and the guide's Sidebar section say so.

| At 320 wide, 1280x800 | Threads before | Settings before | Both now |
| --- | --- | --- | --- |
| Column | 320 | 264 | 320 |
| Hairline | 0 to 319 | 10 to 253 | 10 to 309 |
| Switch bar | x 6, 307 wide | x 16, 231 wide | x 16, 287 wide |
| Page links | x 6 and 36 | x 16 and 46 | x 16 and 46 |
| Update control | x 283 | x 217 | x 273 |

The before numbers were read from the built app on `main` (`d4028ed1e`) with a throwaway spec that is not kept; the after numbers are what `sidebar-crossing.spec.ts` asserts and compares.

## What was checked

| Journey | Evidence | Result |
| --- | --- | --- |
| Threads, Settings, Threads again, at 1600x1000, 1280x800 and 820x560, with the sidebar saved at 260, 320 and 480, on the stable and the Owl track | `tests/e2e/sidebar-crossing.spec.ts` | The column, the brand, the foot, its hairline, every switch tab, the page links and the update control are the same boxes on all three visits. The hairline stops 10 pixels short of each edge and the switch sits 16 pixels in. It fails on the code before the change. |
| The path Windows and Linux take (the macOS class taken off the column), at 260 and 320 | the same spec | The brand is at 14 pixels, centred in the 44 pixel row, and the whole frame matches; at 260 the wordmark gives way on both pages. |
| A collapsed Threads sidebar | the same spec | Settings keeps the width the sidebar expands to (400 in the run); a rail cannot hold the sections. |
| Every Settings section beside the wider column: 12 on stable, 14 on Owl, at 820x560 with the column at the widest the window allows (470 pixels of room) and at 320, at 920x600, 1000x700, 1120x800, 1280x800 and 1600x1000 with 480 saved, with 17 pixels taken for a classic scrollbar | `tests/e2e/settings-beside-wide-sidebar.spec.ts`; `settings-820x560-dark.png`, `threads-820x560-dark.png` | No page overflow, no form overflow and no clipped control. The Windows desktop check in CI runs `settings-index.spec.ts` over the same sections at the default width. |
| The foot on both pages, dark and light, and on Owl | `threads-foot-dark.png`, `settings-foot-dark.png`, `threads-foot-light.png`, `settings-foot-light.png`, `owl-threads-foot-dark.png`, `owl-settings-foot-dark.png` (before: `before-threads-foot-dark.png`, `before-settings-foot-dark.png`) | The two feet are the same picture but for the lit page link and the lit switch tab. Colour still comes from theme roles; nothing new draws a colour. |
| The sidebar's other surfaces | `tests/e2e/thread-sidebar-resize.spec.ts`, `settings-mode-row.spec.ts`, `theme-editor-and-request-layout.spec.ts` (its first two tests), `browser-theme-editor-layout.spec.ts`, `phones.spec.ts`, `cloud-iphone.spec.ts` | Pass. Resizing, collapsing, the rail's page links, the switch labels at 12.5px and the minimised theme editor clear of the foot links hold. |

## Keyboard

The markup is unchanged, so the tab order is too: the sections, then the foot's switch, page links and update control, then the open section's panel (`settingsNavigation.test.tsx`). Nothing new takes focus.

## Gates

`npm run typecheck`, `npm run lint` and `npm run notices:verify` are clean. `npm test -- --maxWorkers=2` passed 13,961 tests and failed five on this Mac: two in `gitLauncher.test.ts` and one in `owlHost.test.mjs`, which fail on `main` here too, and `provenance.test.ts` and `phoneAccess.test.ts`, which are flaky here and pass on a rerun.

## Not checked, and why

- **Windows.** Nothing here ran on Windows. The Windows desktop check in CI runs `settings-index.spec.ts` against the wider column; the Windows and Linux top row rests on the stylesheet and on the macOS class taken off in the spec above.
- **Design baselines.** The committed captures are Windows renders, and every one that shows the sidebar foot (Threads, Dictate, Help, Usage in Owl, Settings) is now different on purpose. They were not regenerated: this Mac does not render them the way the baselines were made, and CI does not run `design:verify`. Run `npm run design:capture` on the Windows PC.
- **Five specs fail on this Mac before and after the change**, identically on `main` at the same commit: `crossing.spec.ts` (Ctrl+K on a Mac), `sotto-owl-branding.spec.ts` (expects "Windows" in Help), `sotto-owl-night-sky.spec.ts` (star count), `worker-roles.spec.ts` (a Windows-only note) and the third test of `theme-editor-and-request-layout.spec.ts` (a thread row's metadata line covers its "Open … beside" hover action; this change does not touch the rows).

## Left as it is

- The Owl night sky stays behind the Threads top row only; Settings has none (`CONTEXT.md`, Night sky).
- A collapsed Threads sidebar and Settings still differ in width, since Settings has no rail.
