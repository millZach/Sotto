# Sotto follows the Omarchy theme

## Status

Accepted October 9, 2026 by the owner on [#840](https://github.com/millZach/Sotto/issues/840#issuecomment-6092412183). The approved specification is mapping M3 in `docs/prototypes/omarchy-theme-prototype.html` on `prototype/omarchy-theme`. This amends ADR-0011 and ADR-0024 for Linux under ADR-0062.

0069 was checked against `origin/main` at `738ba1fd` and all eight open pull-request diffs on October 9, 2026: #904, #903, #900, #896, #891, #888, #885 and #816. Main now owns 0068 for voice removal (#880), so this branch moved Omarchy from provisional 0068 to next-free 0069 and updated its citations. No audited diff claims 0069. The number remains provisional until merge, following `docs/agents/domain.md`.

## Decision

**The Omarchy theme** is a Linux-only, read-only palette from `~/.local/state/omarchy/current/theme/sotto.json`. `apps/omarchy/sotto.json.tpl` uses Omarchy's own template syntax and M3's 57-role mapping: background, foreground and accent become Sotto's room, text and accent, with surfaces shaped by the template's sRGB mixes. No renderer reads files or contacts a host. The per-user `install-theme.sh` copies the template to `~/.config/omarchy/themed/` and renders once with `omarchy-theme-set-templates`, sharing Omarchy's switch lock and using its staging directory. It needs no sudo and does not switch the desktop theme.

**The readability check** runs in shared code before a palette can paint. Each text role is measured on every surface it occupies in the main window and widget. A failing role mixes toward the theme's text by the smallest whole percentage that reaches 4.5:1. Body text, if necessary, mixes toward white in dark mode or black in light mode first. The accent button moves toward the text until its original ink reads; focus uses 3:1. An impossible palette is refused. The checks include actual overlay, selected, hover, terminal-selection, status and widget surfaces beyond the prototype's short contrast table. This can lift a role further than that table alone would. The derived success green is also repaired on its text surfaces, including Tools and tinted Changes rows, only while Omarchy paints the window. Stock Windows and macOS token definitions stay unchanged.

The template's red or yellow is kept only when its OKLCH hue means the status (red: 0–45 or 345–360 degrees; amber: 45–105; chroma at least 0.07), and at most a 35% mix toward text reads on the room, surface and sidebar. Otherwise Sotto's own red or amber takes its place, with a status surface mixed from the Omarchy room. Status text then passes the same readability check. This preserves the prototype's Hackerman and Matte Black safeguards.

Main validates the complete, opaque hex file with zod and converts it to canonical OKLCH. It watches the current directory and its theme folder, rather than a file inode. It reattaches after replacements and checks once a second to recover missing ancestors or exhausted watches. Theme switches are coalesced briefly. A missing, malformed, unresolved, oversized or unreadable file falls back to Sotto's palette and logs only a stable event name. A later valid file restores Omarchy. No theme text or file content enters a log.

**First start under Omarchy** chooses Omarchy in both halves and Match Linux, when a valid rendered file is present and no settings file exists. An existing install keeps its choices. Under Match Linux, a chosen Omarchy half follows the rendered theme's mode as well as its colours; an explicit Light or Dark choice stays explicit. The widget following the system takes the same Omarchy mode. Other selections keep the existing operating-system mode behaviour.

Both Appearance columns offer Omarchy on Linux, ahead of the six built-ins. The matching half names the current theme from Omarchy's `theme.name`; the other says “Waits for a light/dark Omarchy theme” and uses Sotto until such a theme arrives. A waiting selection survives restarts and missing files. The current palette travels through the existing settings notification and widget projection as read-only state; it is never saved in `settings.json` or the custom-theme library and cannot be patched over IPC. The runtime selection uses `__omarchy`, outside the custom-theme ID grammar; existing custom `omarchy` themes keep their IDs and choices. Create theme copies the palette actually painting the chosen appearance, including Sotto while a half waits or the file is missing.

Windows and macOS do no Omarchy reads or watching. They retain six palettes, their defaults and their gallery. The shared role tokens and design baselines do not change. The stock-theme fixtures are rendered by Omarchy itself in an isolated HOME on forge; the unit suite uses those exact outputs on Windows, and also repeats the real renderer check when Omarchy is installed.

## Consequences

The Linux verification note records real nested-session captures, live theme replacement and pixel contrast. Linux evidence is separate from the Windows design baselines (ADR-0062). No production dependency, new network host, packaging target or permission changes.
