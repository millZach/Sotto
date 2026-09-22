# Devin product mark

Issue #224, Windows, September 22, 2026. Applies to every surface that draws a provider mark.

## What changed

Devin's mark is now the product mark from devin.ai, the path the site's header logo and `favicon.svg` draw, in place of the session icon from the installed Devin app. It is one path filled with `currentColor`, like the other three marks, so every colour rule that already names `devin` applies unchanged.

The site draws the path in a 425-unit box and leaves about a third of its width and a fifth of its height empty around it. At the 14 to 18 pixel sizes Sotto uses, that drew Devin visibly smaller than Codex, Claude Code and Grok Build, whose paths fill their boxes. `ProviderMark.tsx` crops the box to the path (`48 48 330 330`, centred on it) rather than scaling the mark in CSS, so no stylesheet needs a Devin-only size rule. The path is the site's, unchanged.

## Size and colour rules

Every rule that gives the Codex, Claude Code and Grok Build marks a colour or a size already covers Devin, so no stylesheet changed:

- `modelPicker.css`: the chip and the rail colour Devin with `--tt-provider-devin`.
- `providers.css`: the providers list and the detail header colour it the same way; the list's size rules select `.provider-mark` and so apply to every provider.
- `threadSidebar.css`: `.thread-nav__mark` colours Devin in dark and mixes it with the text colour in light, as for the others; `.provider-mark` sets the fill for all of them.
- `room.css`: the session badge takes `--tt-provider-devin` as its background.
- `tokens.css`: `--tt-provider-devin` is defined in both appearances.

## Captures

Captured from the built app at 1280x800 in dark and light with reduced motion on, over the fake Devin client (`SOTTO_E2E_DEVIN_ROOT`) with a one-off Playwright script that was not kept:

- `artifacts/devin-product-mark/providers-1280-dark.png` and `-light.png`: Settings, Providers, with Devin connected and selected. The list mark and the detail header mark sit at the same size as the other three.
- `artifacts/devin-product-mark/model-picker-1280-dark.png` and `-light.png`: the model picker from the New thread dialog, on the Devin tab of the rail.
- `artifacts/devin-product-mark/threads-1280-dark.png` and `-light.png`: a Devin thread on the Threads page, showing the mark in the pane title and the composer's model chip. Thread rows in the Threads sidebar name the provider in text and draw no mark; the sidebar mark (`.thread-nav__mark`) belongs to the personal chats list.

The design baselines `settings-providers.png` and `settings-providers-light.png` were regenerated, because they show the Devin mark in the providers list. `npm run design:capture` rewrote other captures within their noise tolerance; those were restored, so only the two affected baselines and their manifest hashes changed.
