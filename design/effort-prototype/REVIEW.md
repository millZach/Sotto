# Prototype review

Zach chose B, the furnace popover. The updated browser preview refines B. No production control was changed.

Inspected the existing composer capture at `artifacts/composer-selectors-prototypes/a-effort.png` and the option-chip source. The prototypes preserve a quiet composer, Figtree, a nearby model label, effort value, and permission context. The exact Codex slider was not available for visual comparison; the user's described bar is the reference for the interaction.

Chromium checks passed: all three variants reach gold, Home returns to Low and clears gold, End selects Max, ArrowLeft interrupts the melt at High, and Escape closes the furnace and returns focus. Reduced motion reaches the settled gold state immediately. No JavaScript page errors were recorded.

No horizontal overflow at 1600x1000, 1280x800, 820x560, 736px, and 320px widths. Visually inspected dark fire and gold states, the light reduced-motion furnace, and the narrow equalizer. Inspected a revised flame and intermediate melting frame after moving the coins in front of the fire. Screenshots and temporary browser checks are in the ignored `.worktrees/effort-preview/` folder. These are prototype checks, not production app gates.

The main visual is the effort bar and pixel animation; supporting composer copy is limited to the prompt, model, and permission context. Effort labels, current value, variant choices, and Play melt are essential controls or state feedback. Removed the redundant prototype heading after it overlapped the taller variants. Body text and controls are 14–16px; stop labels are 12px.

The inline preview deliberately uses a contained composer and a local variant switcher instead of adding a development route to the production Electron renderer. Animation is finite, about 3.5 seconds per change; no sounds, requests, provider calls, or saved settings. Max is a prototype label for the highest provider-supported effort, not a new provider capability. Gold roles would need a deliberate mapping into Sotto's theme system during implementation.

Open `preview.html` directly for the standalone browser preview. `effort-options.html` is the inline source; Figtree is embedded so the preview needs no network.


## Furnace refinement verification

The browser preview now opens B directly. The previous comparison is preserved in options-preview.html. During a pointer drag the slider reported 1.585, then smoothly settled to High (2) on release; the thumb and filled track share the same continuously animated position. Arrow keys move whole levels. Ultra finished gold, and lowering to Max cancelled gold. Claude stops are Low, Medium, High, Extra high, Max. Ultracode sets Extra high and restores the earlier effort when switched off. Ultrathink leaves the slider unchanged. These are local preview controls only.

Verified Escape dismissal and focus return, provider switching, light appearance, and immediate reduced-motion gold. No JavaScript errors, page overflow, or overlapping stop labels at 1600x1000, 1280x800, 820x560, and 320x720. Visually reviewed Ultra fire, Claude modes in dark appearance, and Claude in a narrow light view. The standalone browser page scrolls vertically when needed. Temporary evidence: .worktrees/effort-preview/furnace-results.json and furnace-*.png.

Capability sources, read September 19, 2026:
- https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning — supported reasoning levels include Ultra, Max, and xhigh.
- https://code.claude.com/docs/en/model-config#adjust-effort-level — Ultracode is xhigh plus dynamic workflows; Ultrathink is an in-context instruction for one prompt, with API effort unchanged.


## Effort label animation verification

Added finite per-letter animation and pixel sparks, with intensity increasing by effort. The top label turns gold using the same spread value as the bar. Ultracode uses a stepped pixel scan. There is no text scrambling; the accessible label always names the current selection.

Chromium verified every label and animation, Ultra gold reaching 100%, all animations and particles ending, replay, rapid reversal clearing old sparks and gold, the Ultracode effect, and reduced motion producing zero text animations. No page errors or overflow at 1600x1000, 1280x800, 820x560, or 320x720. Visually inspected Extra high and Ultra at 190 ms, and the settled light Max label. Temporary evidence: .worktrees/effort-preview/label-results.json and label-*.png. The browser preview and furnace.html are identical.


## Stop-word correction

Removed the extra selected-effort header. Letter animation and sparks now belong to the existing stop buttons below the bar. Ultra stays gold immediately, during the melt, afterward, and when another level is selected; its light appearance uses a darker gold for contrast. The selected word alone animates, and stop names and accessible names remain intact.

Verified High, Extra high, Max, and Ultra animation positions; no motion on unselected words; no leftover motion after settling; immediate and persistent gold; keyboard return to Low; reduced motion; and Claude mode selection without renaming Extra high. Visually inspected Ultra in motion and the narrow light view. After responsive canvas resize completed, no overflow or overlapping controls at 1600x1000, 1280x800, 820x560, or 320x720. No JavaScript errors. Evidence: .worktrees/effort-preview/stop-results.json and stop-*.png.


## Native Max-style Ultra

Inspected the installed Claude Code 2.1.278 effort picker implementation. Its selected Max label cycles colors per stationary bold character on a 100 ms cadence, with a one-character phase offset. Ultra now adapts that motion to seven gold shades on a 700 ms loop. Removed Ultra's entrance transforms and particles; all other level effects remain. This is a gold adaptation, not the native rainbow palette.

Verified changing per-letter colors with no transforms, continued cycling after the bar melt, pause while the popover is closed, restart on replay, cancellation when deselected, and zero animations with reduced motion. Fixed the browser's cached animation colors on appearance changes by rebuilding the Ultra letters. Visually inspected dark and corrected light captures; no overflow at 320 px and no runtime errors. Evidence: .worktrees/effort-preview/native-ultra-results.json and native-ultra-*.png. The served preview and furnace source agree.


## Corrected Ultra gold timing

Removed the always-gold styling and the native color-cycle experiment. Ultra and Claude Max now use the same forge entrance and text-color sequence. Both remain normal text during the token melt, then turn gold after the pile has fully melted. Gold begins at 1.9 seconds and completes with the bar at 2.85 seconds.

Verified both providers at entrance, mid-melt, and completion: text forge values were 0%, 0%, and 100%, with matching computed colors. Replay and lowering effort reset gold; reduced motion reaches the completed state with no animation. Visually inspected Ultra during melting and after completion. No runtime errors or narrow-layout overflow. Evidence: .worktrees/effort-preview/melt-text-results.json and melt-text-*.png.
