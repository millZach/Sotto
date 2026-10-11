# Omarchy muted text on painted surfaces

October 11, 2026. Follow-up to [#840](https://github.com/millZach/Sotto/issues/840), [#906](https://github.com/millZach/Sotto/pull/906), and ADR-0070. Base: `73e4f8c8` on `origin/main`. Branch: `fix/omarchy-muted-surfaces`.

The audit found a real omission in Changes: its 22% selection image sits over the existing 12% added or removed tint. With the shipped guard, muted line numbers on selected added lines fell to 3.2904:1 in Tokyo Night. Selected thread rows, hovered thread rows and message bubbles already passed for Omarchy. The guard now covers the layered Changes surfaces too. Body text, code text and the signs are included, because muted text needs a readable target and the signs paint on the same rows.

## Which surfaces were measured

The search covered 597 `color:` rules using `--tt-text-muted`, `--tt-text-2`, `--tt-text-faint` or `--tt-sidebar-text-muted` across the renderer stylesheets. Thread timestamps and message timestamps use `--tt-text-muted`, the 85% muted-foreground / 15% body-text mix in `tokens.css`. `--tt-sidebar-text-muted` is defined but has no `color:` use in these stylesheets. The actual hovered thread row is `--tt-hover` composited over `--tt-sidebar`; the opaque `sidebarRowHover` role alone is not its background.

The 36 measured background cases include the room, sidebar, selection, hover, bubbles, cards, fields, menus, code, every Changes state, glass, status notices and the Owl header. Main and widget role/token coverage remains in `omarchyThemes.test.ts`; the added assertions explicitly cover visible timestamps, body/code text and line numbers/signs on the layered Changes rows.

Computed CSS measurements use default Contrast 100%, Glass 80%, and no frost. They resolve the real token stylesheet, retain alpha through compositing and use WCAG relative luminance. The 22 stock Omarchy outputs are Omarchy-rendered fixtures. All twelve built-in halves are measured as shipped. These are default-setting measurements, not a guarantee after the user lowers Contrast.

## Minimum contrast for muted and secondary text

| Surface | Omarchy, after this guard | Built-in minimum | Built-in half |
| --- | ---: | ---: | --- |
| Room | 7.4991:1 | 6.2804:1 | Nocturne light |
| Sidebar | 6.5714:1 | 5.4925:1 | Nocturne light |
| Selected sidebar row | 5.8536:1 | 4.0388:1 | Hush dark |
| Hovered sidebar row | 6.3462:1 | 4.6513:1 | Linen dark |
| Message bubble | 6.5714:1 | 3.7259:1 | Hush dark |
| Cards and fields | 7.1829:1 | 5.9938:1 | Nocturne light |
| Raised cards | 6.8084:1 | 5.4033:1 | Nocturne light |
| Overlay | 6.5066:1 | 5.0011:1 | Nocturne light |
| Sunken cards | 6.9919:1 | 5.4432:1 | Linen dark |
| Secondary controls | 6.8707:1 | 4.7603:1 | Linen dark |
| Sidebar controls | 6.1048:1 | 4.7262:1 | Linen dark |
| Strong hover | 6.2100:1 | 4.2152:1 | Linen dark |
| Code | 6.9919:1 | 5.6650:1 | Nocturne light |
| Changes hunk (secondary text) | 5.9347:1 | 6.7142:1 | Linen dark |
| Changes added | 5.8653:1 | 4.6093:1 | Linen dark |
| Changes removed | 5.7001:1 | 4.5647:1 | Nocturne light |
| Changes context hovered | 6.4729:1 | 4.6994:1 | Linen dark |
| Changes added hovered | 6.1320:1 | 4.3368:1 | Hush dark |
| Changes removed hovered | 6.1193:1 | 4.4433:1 | Linen dark |
| Changes context selected | 5.3400:1 | 3.4355:1 | Citrine dark |
| Changes added selected | 4.5045:1 | 2.7300:1 | Citrine dark |
| Changes removed selected | 4.5045:1 | 2.9077:1 | Citrine dark |
| Error card | 6.2778:1 | 5.4032:1 | Linen dark |
| Warning card | 6.8532:1 | 4.8238:1 | Linen dark |
| Update card | 6.2100:1 | 4.0737:1 | Hush dark |
| Glass over room | 6.6981:1 | 5.2425:1 | Nocturne light |
| Glass over sidebar | 6.5195:1 | 5.0971:1 | Nocturne light |
| Composer glass | 7.2454:1 | 6.0504:1 | Nocturne light |
| Accent wash | 6.3278:1 | 4.7379:1 | Citrine dark |
| Owl header | 6.7151:1 | 5.6393:1 | Nocturne light |
| Owl mode control | 6.9919:1 | 5.4247:1 | Hush dark |
| Owl search field | 7.1829:1 | 5.9938:1 | Nocturne light |
| History warning | 6.6220:1 | 5.4032:1 | Linen dark |
| Working copy warning | 6.5289:1 | 5.2812:1 | Linen dark |
| Success notice | 6.2272:1 | 4.6276:1 | Hush dark |
| Table stripe | 7.1742:1 | 5.9200:1 | Nocturne light |

Of 2,414 computed muted and secondary pairs (35 surfaces × 34 palettes × two text tokens, plus 34 hunk secondary-text pairs), all 1,562 Omarchy pairs pass. Hunk headers use `--tt-text-2` on the 14% accent wash over the code background; their existing unit assertion already passes for all 22 stock themes. The full values and limiting themes are in [measurements.json](../../artifacts/omarchy-muted/measurements.json).

## Faint labels and placeholders

The separate `--tt-text-faint` role is measured on the 17 surfaces in the existing stylesheet inventory. That inventory is conservative and includes roles inherited by icons; disabled controls are not contrast assertions. All 374 Omarchy pairs pass. These 578 additional readings are retained separately in the same JSON.

| Surface token | Omarchy minimum | Built-in minimum |
| --- | ---: | ---: |
| `canvas` | 5.5669:1 | 4.8889:1 |
| `surface` | 5.3322:1 | 4.9853:1 |
| `surface-elevated` | 5.0542:1 | 4.5619:1 |
| `surface-overlay` | 4.8301:1 | 4.2203:1 |
| `surface-sunken` | 5.1904:1 | 4.4065:1 |
| `field` | 5.3322:1 | 4.9853:1 |
| `secondary` | 5.1005:1 | 3.8792:1 |
| `kbd` | 5.1005:1 | 3.8792:1 |
| `selected` | 4.5017:1 | 3.3043:1 |
| `hover-strong` | 4.7668:1 | 3.4403:1 |
| `sidebar` | 4.8783:1 | 4.5650:1 |
| `sidebar-control` | 4.5120:1 | 3.8573:1 |
| `sidebar-row-hover` | 4.6034:1 | 4.1496:1 |
| `sidebar-row-active` | 4.8625:1 | 3.5976:1 |
| `sidebar-row-selected` | 4.5017:1 | 3.3043:1 |
| `bubble` | 4.8783:1 | 3.0483:1 |
| `code-bg` | 5.1904:1 | 4.6350:1 |

## Each built-in half

The built-ins and `tokens.css` are unchanged, pinned by SHA-256 assertions in the Windows and macOS cases; the stylesheet pin normalizes CRLF to LF. A follow-up checked both line endings against the expected hash without changing the stylesheet. No Windows design capture was regenerated.

| Palette | Mode | Selected sidebar row | Hovered sidebar row | Bubble |
| --- | --- | ---: | ---: | ---: |
| Sotto | light | 5.2801:1 | 5.8671:1 | 5.7830:1 |
| Sotto | dark | 5.0654:1 | 6.4029:1 | 8.3470:1 |
| Hush | light | 4.6688:1 | 5.1261:1 | 4.6688:1 |
| Hush | dark | 4.0388:1 | 4.6556:1 | 3.7259:1 |
| Linen | light | 4.6685:1 | 5.1294:1 | 4.6685:1 |
| Linen | dark | 4.0758:1 | 4.6513:1 | 3.7726:1 |
| Nocturne | light | 4.6280:1 | 5.0846:1 | 4.6280:1 |
| Nocturne | dark | 4.1351:1 | 4.7284:1 | 3.8317:1 |
| Tropic | light | 4.7043:1 | 5.2107:1 | 4.7043:1 |
| Tropic | dark | 4.1861:1 | 4.7687:1 | 3.8363:1 |
| Citrine | light | 4.6936:1 | 5.1545:1 | 4.6936:1 |
| Citrine | dark | 4.3115:1 | 4.8618:1 | 3.9619:1 |

## Running-app proof

The upgrade regression stores all 22 palettes produced by the guard at `73e4f8c8` in `tests/fixtures/omarchy-theme-cache-v0070.json`. Five old palettes (Catppuccin Latte, Everforest, Gruvbox, Kanagawa and Rose Pine) cannot derive the newly required green without rechecking the cache. `readCachedAppearance` now repairs the Linux Omarchy hint before first paint, and its existing fallback handles an unreadable cache. All 22 first-paint cases, the fallback, and Windows/macOS ignoring the cache pass in the focused unit run (105 tests across three files).

The check launches the built Electron 43.1.0 app through the owned nested Hyprland wrapper. It uses an isolated HOME, config, state, data, cache and TMPDIR; its private D-Bus configuration has no service directories, so no portal can activate. Real UI input creates a user message and opens a real temporary Git diff. The app first reloads with the base-version Everforest cache and verifies the room mounts without a page error. The Appearance choice is driven once, then the owned Omarchy file is replaced through all 22 stock themes. The built-ins are compared in the same app.

The content window is 880×980, inside the nested compositor’s 941×1030 output; every measured element must be in the viewport. This prevents an oversized Wayland resize request from leaving measurable DOM outside the captured output. The browser waits for finite transitions to finish before measuring text and the composited ancestor backgrounds. Changes selection is exercised by clicking actual context, added and removed lines. On the narrow nested output, Tools hides the sidebar: the check closes Tools to measure visible thread rows and bubbles, then opens it to measure Changes. Captures use `grim` on the nested output. No input or portal capture reaches the live session.

Build SHA-256 (`out/main/index.js`): `8f95a569313fab2bbd770478a5c0a6ca5f017211e00b2bf012cf5032f0c89671`. Main renderer (`out/renderer/assets/main-CQ362Kk8.js`): `a5d84281edf2aee24561555fd444030cef48ac1c39d61ed4037972ff45fd59c4`.

The running-app spec passed (47.1 seconds): all 198 Omarchy samples are at least 4.5:1, with a minimum of 4.5103:1 on selected Changes add in Nord. It also retained 108 built-in samples and reported no page errors. Each selected Changes sample asserts that its computed image contains the 22% selection alpha after the pointer moves away; the more specific hover selector otherwise hides that wash.

Computed CSS and browser readings differ slightly because the browser probe samples the ink and final background as sRGB pixels. For built-ins, the browser minima were 3.9899:1 on selected rows, 4.5992:1 on hovered rows, and 3.6916:1 on bubbles. The tables above retain the reproducible fractional token measurements.

The final local gates passed under mise Node 24.21.0: typecheck, lint, 773 test files / 9,685 tests (54 files / 192 tests skipped) with `--maxWorkers=2`, notices (189 packages), build, and the build-output external dependency allowlist. Suites ran one at a time. The owned nested runner's cleanup lists no remaining processes or cgroup members. The live session was untouched.

Retained captures:

- [Tokyo Night](../../artifacts/omarchy-muted/changes-tokyo-night.png)
- [Catppuccin Latte](../../artifacts/omarchy-muted/changes-catppuccin-latte.png)
- [Browser colours and layers](../../artifacts/omarchy-muted/browser-measurements.json)

## Repeat the checks

```sh
mise exec node@24.21.0 -- npm run typecheck
mise exec node@24.21.0 -- npm run lint
mise exec node@24.21.0 -- npm test -- --maxWorkers=2
mise exec node@24.21.0 -- npm run notices:verify
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node tools/measure-omarchy-muted-surfaces.mjs /tmp/omarchy-muted-measurements.json
mise exec node@24.21.0 -- node tools/verify-omarchy-muted-surfaces.mjs
```

Run the build-output allowlist check with `verifyExternalDependencyInventories` from `scripts/release-external-dependencies.mjs`, using the current packaged roots: `zod`, `node-pty`, `sherpa-onnx-node` (Electron is exempted by the verifier). The template, role definitions, built-in palettes, token stylesheet and runtime dependencies are unchanged.
