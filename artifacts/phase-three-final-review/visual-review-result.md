# Phase 3 final visual review: independent Opus 5 critic

- **Reviewed source:** `3a5b7420db548b89fa60bb0395f315b71fd738eb`, the commit pinned in `final-visual-ready.json`. The checkout is `.worktrees/phase3-verification`; its HEAD matches that commit, and `out/build-provenance.json` names the same source commit. Its only non-artifact changes are in `resources/runtime/*`, not `src`. Reviewer SHA `7b0aec4` was an intermediate commit and was not treated as final.
- **Scope in the ready file:** a frozen named-theme checkpoint. Root has not yet supplied the delta for durable request drafts, form context and compact Grid/Row layout. Pane and request observations below are therefore **provisional**.
- **Method:** I launched the real built Electron app (`out/main/index.js`) from the verification checkout with owned `sotto-e2e-*` profiles and fixture providers. Dictation used the deterministic E2E recorder, so no microphone was used. The native browser loaded an owned loopback server. I did not edit source, run a full suite, call paid or native providers, or touch the main `out` directory or user processes.
- **Captures:** the native WebContentsView was captured with Electron `desktopCapturer`, not `page.screenshot`. All other captures are real page or window screenshots, and I inspected every image cited here.
- **Scripts and logs:** `.worktrees/phase3-orchestration/final-visual-review-{themes,branding,chats-panes}.mjs` and their `.log` files.
- **References:** the rejected accent picker and the T3 Appearance reference (the user's two attachments), plus the pinned T3 `apps/web/src/components/settings/ThemePreviewCircles.tsx` @ `d1d15c67`.

## Scenarios and sizes inspected

| Journey | Sizes / schemes | Result |
|---|---|---|
| Fresh default profile (only `onboardingComplete`) → Appearance top and gallery | 1600×1000 dark; 1280×860 light; 820×560 system with OS light, then OS dark | Defaults are Tide for both halves, contrast 100, glass 80. Titles in order: **Sotto, Rose, Fern, Tide, Copper, Dusk**. Three 228px columns wide, 2×3 at 820. The three-mode wireframe tiles show System split, Light and Dark, and the chosen tile ring is painted. [01](01-appearance-top-1600-dark.png) [02](02-gallery-1600-dark.png) [07](07-appearance-top-1280-light.png) [08](08-gallery-1280-light.png) [09](09-appearance-top-820x560-system-light.png) [10](10-gallery-820x560-system-light.png) [11](11-gallery-820x560-system-dark.png) |
| Keyboard in gallery | 1600 dark | Tab moves from the Copper light circle to the Copper dark circle, and the focus ring is visible. Enter assigns the dark half (`ember`). [05](05-copper-card-keyboard-focus-1600-dark.png) [06](06-copper-dark-chosen-by-keyboard-1600-dark.png) |
| Theme switch → mark, Agents sphere, widget | 1280 dark (Tide, then Dusk live while dictating); light (Copper, with OS light) | The mark tile, orb colours and widget tile/border/voice dots follow each theme. Values are identical in the main window and the widget (Tide `#70b9ee`, Dusk `#9d7df2`, Copper `#ae552a`). The widget follows the OS scheme. An unsaved editor draft recolours the mark (`#2f7d32`) and Cancel restores it. [b01](b01-tide-dark-agents-room.png) [b03](b03-tide-dark-widget-listening.png) [b04](b04-dusk-dark-live-agents-room.png) [b05](b05-dusk-dark-widget-listening-live.png) [b07](b07-copper-light-agents-room.png) [b08](b08-copper-light-widget-listening.png) [b09](b09-draft-green-header-light.png) |
| Editor at the minimum size | 820×560 dark | Tested: open, accent draft with live spotlight, Advanced filter, "No matches", built-in name refused ("“Sotto” is a built-in theme…"), minimize to footer, drag as low as possible, expand, grip shrink, Create. After the low drag, expand brought the panel back to y=64, h=488 inside 560 with the actions visible. [12](12-editor-open-820x560-dark.png) [13](13-editor-simple-accent-draft-820x560-dark.png) [14](14-editor-advanced-filter-terminal-820x560-dark.png) [15](15-editor-filter-no-matches-820x560-dark.png) [16](16-editor-builtin-name-error-820x560-dark.png) [17](17-editor-minimized-threads-820x560-dark.png) [18](18-editor-minimized-dragged-low-820x560-dark.png) [19](19-editor-expanded-after-low-drag-820x560-dark.png) [20](20-editor-shrunk-820x560-dark.png) [21](21-threads-harbor-review-saved-820x560-dark.png) |
| Duplicate, cancel, Add theme, invalid JSON, Open VSX fixture install, export | 1280 dark | "Dusk copy" is prefilled. Invalid JSON explains itself. Open VSX results install as a card. The export writes `harbor-review.json` with the status "Harbor Review exported." [22](22-duplicate-dusk-editor-1280-dark.png) [23](23-add-theme-dialog-1280-dark.png) [24](24-add-theme-invalid-json-1280-dark.png) [25](25-open-vsx-results-1280-dark.png) [26](26-gallery-with-custom-and-collection-1280-dark.png) [27](27-export-status-1280-dark.png) |
| Native browser beside and under the editor (desktopCapturer) | 1280×860 and 820×560 dark | **Page visibly composed** in all visible states. One view is present before the editor; none under the expanded editor; one beside the minimized footer bar at both sizes. The view steps aside with "The page steps aside while a menu or dialog is open." when the bar is dragged over it, and is restored alive after Close. [28](28-composed-browser-1280-dark.png) [29](29-composed-expanded-editor-over-browser-1280-dark.png) [30](30-composed-browser-beside-minimized-editor-1280-dark.png) [31](31-composed-browser-beside-minimized-editor-820x560-dark.png) [32](32-composed-minimized-bar-dragged-over-browser-820x560-dark.png) [33](33-composed-expanded-again-820x560-dark.png) [34](34-composed-browser-restored-820x560-dark.png) |
| Personal chat failed send with `$brainstorm`, newer draft, recover | 1280 dark and light; 820×560 dark and light | Shows "Not sent", "Codex did not take this message." and a raw EPERM under **Details**. Edit in composer produces `Also check the weather\n\nBook the ferry with $brainstorm for Saturday`, keeps skills `["brainstorm"]`, and sends nothing again. [c01](c01-chat-skill-picker-1280-dark.png) [c03](c03-chat-not-sent-newer-draft-1280-dark.png) [c04](c04-chat-not-sent-details-1280-dark.png) [c05](c05-chat-recovered-1280-dark.png) [c06](c06-chat-recovered-1280-light.png) [c07](c07-chat-recovered-820x560-light.png) [c08](c08-chat-recovered-820x560-dark.png) |
| Four panes with a pending native permission (provisional) | 1600×1000 dark; 1280×800 dark; 820×560 dark (compact tabs); 1600 light Dusk | 2×2 grid with every composer inside its pane and Deny/Allow reachable. At 820×560 there is one pane with tabs. [1600](p-four-panes-1600-dark.png) [1280](p-four-panes-1280x800-dark.png) [820](p-four-panes-820x560-dark.png) [light](p-four-panes-1600-light-dusk-divider-focus.png) |
| Root evidence inspected, not rerun | Terminal live editor 1280 dark; edited-palette selection; diff at 820×560 | The retained terminal repaints and the selected text is readable. An open diff gets most of the short panel (about 290px). Files: `phase3-verification/artifacts/phase-three-ui-final-fixes/terminal-live-editor-1280-dark.png`, `.../tools-path-diff-820x560-dark.png`, `.../phase-three-ui-recovery/terminal-edited-selected-dark.png`. |

## Findings (severity-ranked; material only)

### 1. Medium: custom and imported theme names are cut off in the gallery at every desktop width (verified)
- **Where:** `src/renderer/src/features/settings/themes/themes.css:255-285` and `ThemeGallery.tsx:219-228`.
- **Mechanism:** the gallery columns are 228px at both 1600 and 1280. A custom card renders four icon actions (duplicate, edit, export, remove) at `opacity: 0`. They are invisible until hover but still take 112px of the footer row, which leaves the title about 89px.
- **Measured:** "Morning Harbor" has `clientWidth` 89 and `scrollWidth` 114 at both 1600 and 1280. "Harbor Review" renders as "Harbor Re…".
- **No way to read it:** the card and title `title` attribute is the mode hint ("Use for light mode only"), not the name. A pointer user cannot read their own theme's name without opening the editor.
- **Why it matters:** T3's reference shows full names, and the user asked for reference quality and functional community themes. Open VSX names such as "Catppuccin Macchiato" will always be cut.
- **Evidence:** [26](26-gallery-with-custom-and-collection-1280-dark.png), [b10-1600](b10-custom-title-1600-light.png), [b10-1280](b10-custom-title-1280-light.png).

### 2. Medium: the light and dark preview circles overlap, so the two selected-half markers collide (verified against pinned T3)
- **Where:** `themes.css:180`, `.theme-circle + .theme-circle { margin-left: -12px; }`.
- **T3 reference:** `ThemePreviewCircles.tsx` at `d1d15c67` lays out 68px buttons with `gap-2.5` (10px), so each ball has its own ring and badge. The attached reference shows Ocean's two rings separate.
- **In Sotto:** the circles overlap by 12px (log: Tide x-extents `[615,675]` and `[663,723]`). When both halves are chosen, the rings intersect and the light half's sun badge sits on top of the dark orb.
- **Result:** it is hard to see which half each marker belongs to. This is the "selected half markers" the user asked to match.
- **Not documented:** the file header lists the deviations from T3 (no environment themes, collection chips), and this overlap is not among them.
- **Evidence:** [03](03-tide-card-selected-halves-1600-dark.png), [02](02-gallery-1600-dark.png), [10](10-gallery-820x560-system-light.png).

### 3. Low: the minimized editor bar covers the footer status line and cuts it off mid-word (verified)
- **Where:** `ThemeEditor.tsx:118-127`, `minimizedThemeEditorDock`, which deliberately docks the bar over the status line.
- **What happens:** the status stays in layout under the bar with no ellipsis. At 820×560 it reads "Nothing is running. Say “H" or "…Say" ([17](17-editor-minimized-threads-820x560-dark.png), [31](31-composed-browser-beside-minimized-editor-820x560-dark.png)). At 1280 it reads "…Say “Hey S" ([30](30-composed-browser-beside-minimized-editor-1280-dark.png)), and the same happens in root's terminal capture.
- **Why it matters:** this is the agent state feedback. It does not block Send or the footer links.

### 4. Low (provisional, pending the layout/request delta): the request composer states the same instruction twice
- In a pane waiting on a permission, the disabled composer shows "Allow or deny the request above to continue." as its placeholder and again as the hint line under the model picker.
- Seen at 1600 light, 1280×800 and 820×560: [1280](p-four-panes-1280x800-dark.png), [820](p-four-panes-820x560-dark.png).
- At 1280×800 in a 2×2 grid, the request card's heading is also scrolled above the short transcript viewport, while Deny/Allow stay visible.

No other material defects were found in the journeys above. Specifically:
- The gallery is a balanced 3×2 (2×3 at 820).
- The three-mode previews, chosen ring and keyboard focus render correctly.
- The six Sotto names show, with T3 attribution kept in source headers.
- The mark, sphere and widget use one palette.
- The editor controls, errors, duplicate, import, Open VSX and export work.
- The glass panels stay readable over white wireframe tiles.
- The composed native browser behaves correctly beside, under and after the editor.
- Chat recovery keeps the draft and the skill.

## Not verified, or verified only in part

- **Request/layout delta:** the corrections for durable structured answer drafts, private answer identities, compact Grid/Row switching and native form explanation/context were not in the pinned build. They are unreviewed, and the pane/request notes above are provisional.
- **Reduced motion:** my pixel-diff probe of the orb canvas and widget bars showed 0% change even *without* reduced motion, because E2E levels are deterministic. That probe cannot show live animation stopping. I verified only that the theme-orb CSS transition goes to 0.001s under `reduce`. The terminal cursor and theme transitions under reduced motion rest on root's tests.
- **Terminal and diff:** retained same-mode terminal palette changes, selected-text contrast, and working-copy header/diff height were checked from root captures of the same build, not rerun by me.
- **Not captured:** the minimized editor in light or system scheme, and 3-pane or ≥5-pane layouts (only 4 panes).
- **Harness artifact, not a finding:** my own chat script typed before asserting focus after clicking New chat, and its first character ("P") was lost. The E2E spec asserts focus first, and I did not pursue it.
- **Out of scope for this checkpoint:** display scaling other than 100%, macOS, real providers and microphone, and Windows-level system theme switching (emulated through `prefers-color-scheme`).
