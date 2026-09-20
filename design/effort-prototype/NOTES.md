# Effort control exploration

Question: Which placement makes a pixel fire melting gold tokens into the effort bar feel good in Sotto's composer?

Desktop target, inherited from Sotto. Three throwaway, local-only variants: A inline rail; B popover furnace; C pixel equalizer. The inline preview is the deliverable; no provider configuration or production interface changes.

Acceptance checks:
- Preserve the quiet composer, Figtree, and model/effort/permissions context. Codex reference qualities: compact horizontal effort choice and immediate selected-level feedback. Exact current Codex slider appearance remains unverified.
- Three structural alternatives; native slider works with pointer and keyboard, including Home/End. Labels always report the actual selected level.
- Progressively stronger pixel motion. Maximum: fire, visibly collapsing coin pile, molten gold spreading across bar, settled gold. Moving down cancels and resets. Reduced motion shows the final state immediately.
- Dark/light palettes, readable 14px controls, theme-role colors; contained preview fits 736px and 320px. Check desktop sizes 1600x1000, 1280x800, 820x560.
- Full-cycle visual inspection, switch variants, replay, rapid reversal, and Escape dismissal for the popover. No backend mutations.

Decision pending user comparison. Prototype not approved for production.


## Selected direction

Zach chose B, the furnace popover. Refine only this direction in furnace.html. Requested corrections: smooth continuous dragging with a short settle onto a discrete provider level; Codex includes Extra high, Max, Ultra. Claude includes its documented effort levels plus clearly distinct Ultracode (xhigh with workflows) and Ultrathink (one prompt) controls. This remains a browser prototype; provider catalogs are illustrative and production must use the connected model's reported capabilities.

Acceptance: continuous thumb/fill at intermediate pointer positions; keyboard arrows move exactly one level; Ultra triggers the Codex melt, Max triggers Claude's; interrupting a melt resets cleanly; switching providers cancels old state; Ultracode and Ultrathink never masquerade as API effort values. Verify dark/light, reduced motion, 1600x1000, 1280x800, 820x560, and narrow browser views.


## Effort text motion

Zach requested animated effort text at each level. Keep the chosen B layout and smooth slider. Add a finite per-letter progression: Low settles, Medium rises, High sparks, Extra high ripples, Max/Ultra forge into place. At the top, text turns gold in sync with the molten bar. Ultracode gets a pixel scan. Labels remain the true selected words, rapid changes cancel old animations, no per-frame screen-reader announcements, and reduced motion shows a still label. Verify peak movement fits the panel, both appearances remain readable, and replay repeats the text sequence.


## Correction: animate the stop names

Zach wants animation on the existing level names below the bar, not a second selected-effort label. Removed the visible header value and placed letter motion and pixel sparks inside the stop buttons. Ultra is gold at all times, including before the melt and while another level is selected. Keep the names, click targets, and accessible names stable; only the selected word animates.


## Native Claude Code Max reference

Zach clarified that the reference is Max in the actual Claude Code app. Read the installed Claude Code 2.1.278 effort picker rendering: selected Max uses stationary bold letters, cycles a palette per character at 100 ms, and offsets each character by its index. Adapt that motion to seven gold shades for Ultra. This replaces the Ultra bounce and particle entrance only. Cycle while selected, pause when the popover is closed, and keep reduced motion static. Earlier finite-motion notes are superseded for this selected Ultra text effect.


## Ultra follows the Max melt sequence

Latest correction supersedes the always-gold rule and native color-cycle experiment. Ultra must behave like Max in the Claude prototype: the same per-letter entrance and sparks, normal text before and during the token melt, then a gold transition after the pile has finished collapsing. Both use the same highest-level animation path. Text gold starts at 1.9 seconds (pile fully melted) and reaches full gold at 2.85 seconds with the bar. Deselecting or replaying clears gold; reduced motion shows the completed state.
