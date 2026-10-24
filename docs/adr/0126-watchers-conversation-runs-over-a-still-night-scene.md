# Watcher's conversation runs over a still night scene

## Status

Accepted October 23, 2026. The user picked D, "still scene, glow", of `docs/prototypes/watcher-floating-composer-prototype.html`, which replaced the gaps round each line picked earlier that day (A of `docs/prototypes/watcher-column-scene-prototype.html`). Part of Watcher (ADR-0073), which follows Watcher's own gate. Amends [ADR-0084](0084-the-window-and-its-surfaces-are-always-solid.md) for Watcher's composer. **Number provisional until merge** (docs/agents/domain.md).

## Context

Watcher's night scene drew its sky and hills under the conversation's column at 35% by night and 20% by day, with a soft gap kept round each line of words. The gaps followed the words, so as the conversation scrolled the characters round every line shifted and distorted, which is what the user objected to. The column also read as a black panel, and Watcher's composer stood as a solid block over the foot of the scene.

## Decision

**1. The composer floats over the conversation, as a thread's does.** Watcher's pane is a thread pane and takes the same float rule (#1391); it did not float before because that rule was invalid CSS until the fix the slim composer builds on. The floating switch keeps its band below the pane, so the composer never covers it.

**2. The composer is frosted glass.** The card's colour at 72%, with `backdrop-filter: blur(14px) saturate(1.1)` and a faint hairline at rest, so the scene and the words passing under it show through, blurred. Its running and highest-effort edges are the Threads composer's. Asking the system for less transparency makes it solid. This is the one surface over the room that is not solid; the window and everything else stay as ADR-0084 has them.

**3. The scene runs under the column at 85%, by day and by night, and never moves for the words.** The per-line gaps are gone, and with them the scene's measuring of the conversation on every scroll and streamed word. The scene keeps nothing clear but the words that stand still (the header, what stands on the composer and the line under it) and runs on under the glass composer. Trees, owls and ripples stay in the margins. Each word in the conversation carries a soft glow of the canvas, `0 0 3px`, `0 0 7px` and `0 0 12px` of `--tt-canvas`; what draws its own surface keeps its text plain.

**4. Words keep 4.5:1 without the glow, by an ink ceiling in the column.** A glyph's core is its ink at full strength, and at 85% the scene's ink would take the conversation's words well under 4.5:1 (at the strength the ground draws at, about 3:1 for the text colour and under 1.5:1 for its muted tier by night, and close to 1:1 by day, where the ink is made stronger). Rather than lower the share, the scene stops each ink in the column at the highest step at which the text colour and its muted tier, which the conversation's names and times are written in, both keep 4.6:1 (4.5:1 and a little for rounding) against the ink laid over the surface. The ceiling is worked out from the theme's own colours each time they change, so every theme, a saved one included, holds. The share still decides which glyphs are drawn and how dense they read; the ceiling only flattens the darkest of them.

## Consequences

- Measured on the built app at 1600x1000 and 1280x800 in all six built-in themes (`tests/e2e/watcher-column.spec.ts`), the lowest contrast of any word against any pixel the scene draws in the column is 4.70:1 by night (Sotto) and 4.76:1 by day (Hush); the composer's words against the glass over the brightest of the scene, unblurred, 4.53:1 (Sotto, by day). `docs/verification/watcher-floating-composer.md` has every theme's numbers.
- Because the muted tier sits about 6.3 to 9.5:1 on the canvas, the ceiling leaves the scene in the column faint, most of all by day: the hills there read as dotted lines rather than at the margins' strength. Writing the conversation's names and times in the secondary tier instead of the muted one would roughly double how strong the column's ink could go; that is a separate pick.
- The scene no longer measures the conversation, so a scroll or a streamed word costs it nothing.
